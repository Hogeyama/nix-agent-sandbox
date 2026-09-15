import { expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { Effect, Exit } from "effect";
import { AcpConnection } from "../docker/acp_connection.ts";
import { withPreparationCommands } from "../lib/preparation_commands.ts";
import { DockerService, DockerServiceLive } from "./docker.ts";

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      await access(file);
      return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "nas-acp-prep-"));
  const oldPath = process.env.PATH;
  await writeFile(
    join(dir, "docker"),
    `#!/bin/bash
case "$1" in
  build|pull)
    trap 'echo stopped >"$NAS_TEST_PREP_DIR/stopped"' EXIT
    trap 'exit 0' TERM
    echo $$ >"$NAS_TEST_PREP_DIR/ready"
    while :; do sleep 1; done
    ;;
  run)
    echo ready >"$NAS_TEST_PREP_DIR/ready"
    cat
    ;;
  rm) exit 0 ;;
  *) exit 99 ;;
esac
`,
    { mode: 0o700 },
  );
  process.env.PATH = `${dir}:${oldPath}`;
  const oldDir = process.env.NAS_TEST_PREP_DIR;
  process.env.NAS_TEST_PREP_DIR = dir;
  return {
    dir,
    close: async () => {
      process.env.PATH = oldPath;
      if (oldDir === undefined) delete process.env.NAS_TEST_PREP_DIR;
      else process.env.NAS_TEST_PREP_DIR = oldDir;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

for (const operation of ["build", "pull"] as const) {
  for (const disconnect of ["stdin", "stdout"] as const) {
    test(`ACP ${disconnect} closure cancels an owned ${operation} before Scope cleanup and launch`, async () => {
      const { dir, close } = await fixture();
      const input = new PassThrough();
      const output = new PassThrough();
      const connection = new AcpConnection(input, output);
      let launched = false;
      let finalized = false;
      let stoppedBeforeFinalizer = false;
      let running: Promise<unknown> | undefined;
      try {
        const program = Effect.gen(function* () {
          yield* Effect.acquireRelease(Effect.void, () =>
            Effect.promise(async () => {
              finalized = true;
              try {
                await access(join(dir, "stopped"));
                stoppedBeforeFinalizer = true;
              } catch {}
            }),
          );
          const docker = yield* DockerService;
          if (operation === "build")
            yield* docker.build("context", "image", {});
          else yield* docker.ensureImage("image");
          yield* Effect.sync(() => {
            launched = true;
          });
          yield* docker.runInteractive({
            mode: "acp",
            image: "image",
            name: "test-session",
            args: [],
            envVars: {},
            command: ["adapter"],
          });
        }).pipe(Effect.scoped, Effect.provide(DockerServiceLive));
        running = connection.run(() =>
          withPreparationCommands(connection.controller.signal, () =>
            Effect.runPromiseExit(program, {
              signal: connection.controller.signal,
            }),
          ),
        );
        await waitForFile(join(dir, "ready"));
        if (disconnect === "stdin") input.end();
        else output.destroy();
        const exit = await running;
        expect(Exit.isFailure(exit as Exit.Exit<unknown, unknown>)).toBe(true);
        expect(launched).toBe(false);
        expect(finalized).toBe(true);
        expect(stoppedBeforeFinalizer).toBe(true);
        const pid = Number(await readFile(join(dir, "ready"), "utf8"));
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        connection.cancel();
        await running?.catch(() => {});
        connection.dispose();
        await close();
      }
    });
  }
}

test("ACP buffer reaches Docker transport across the live Effect service boundary", async () => {
  const { dir, close } = await fixture();
  const input = new PassThrough();
  const chunks: Buffer[] = [];
  const output = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
  });
  const connection = new AcpConnection(input, output, 16);
  let running: Promise<unknown> | undefined;
  try {
    input.write("startup\n");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const program = Effect.gen(function* () {
      const docker = yield* DockerService;
      yield* docker.runInteractive({
        mode: "acp",
        image: "image",
        name: "test-session",
        args: [],
        envVars: {},
        command: ["adapter"],
      });
    }).pipe(Effect.provide(DockerServiceLive));
    running = connection.run(() =>
      withPreparationCommands(connection.controller.signal, () =>
        Effect.runPromiseExit(program, {
          signal: connection.controller.signal,
        }),
      ),
    );
    await waitForFile(join(dir, "ready"));
    input.end("later input exceeds preparation limit\n");
    expect(Exit.isSuccess((await running) as Exit.Exit<unknown, unknown>)).toBe(
      true,
    );
    expect(Buffer.concat(chunks).toString()).toBe(
      "startup\nlater input exceeds preparation limit\n",
    );
    expect(connection.controller.signal.aborted).toBe(false);
  } finally {
    connection.cancel();
    await running?.catch(() => {});
    connection.dispose();
    await close();
  }
});
