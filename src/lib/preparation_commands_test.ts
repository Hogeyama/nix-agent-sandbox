import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { ownedCommand } from "../services/owned_command.ts";
import {
  runPreparationCommand,
  runPreparationTeardown,
  withPreparationCommands,
} from "./preparation_commands.ts";

async function waitForFile(file: string): Promise<string> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      const text = await readFile(file, "utf8");
      if (text) return text;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

for (const diagnostic of [true, false]) {
  test(`cancelled preparation stops resistant descendants before Scope cleanup (diagnostic=${diagnostic})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "nas-prep-descendant-"));
    const controller = new AbortController();
    let leader: number | undefined;
    let finalized = false;
    let finalizerSawStoppedWork = false;
    let running: Promise<unknown> | undefined;
    try {
      const script = `trap 'exit 0' TERM
printf '%s' "$$" > "$1/leader"
bash -c 'trap "" TERM; while :; do printf x >> "$1/heartbeat"; sleep 0.01; done' descendant "$1" >/dev/null 2>&1 &
wait`;
      const program = Effect.gen(function* () {
        yield* Effect.acquireRelease(Effect.void, () =>
          Effect.promise(async () => {
            const before = await readFile(join(dir, "heartbeat"), "utf8");
            await new Promise((resolve) => setTimeout(resolve, 100));
            const after = await readFile(join(dir, "heartbeat"), "utf8");
            finalizerSawStoppedWork = before === after;
            finalized = true;
          }),
        );
        yield* ownedCommand((signal) =>
          runPreparationCommand("bash", ["-c", script, "leader", dir], {
            signal,
            diagnostic,
            graceMs: 1000,
          }),
        );
      }).pipe(Effect.scoped);
      running = withPreparationCommands(controller.signal, () =>
        Effect.runPromiseExit(program, { signal: controller.signal }),
      );
      leader = Number(await waitForFile(join(dir, "leader")));
      await waitForFile(join(dir, "heartbeat"));
      controller.abort(new Error("client disconnected"));
      expect(
        Exit.isFailure((await running) as Exit.Exit<unknown, unknown>),
      ).toBe(true);
      expect(finalized).toBe(true);
      expect(finalizerSawStoppedWork).toBe(true);
    } finally {
      controller.abort();
      if (leader) {
        try {
          process.kill(-leader, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH")
            console.error("Failed to clean test process group", error);
        }
      }
      await running?.catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("teardown still spawns after the signal that asked for it aborted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nas-prep-teardown-"));
  const controller = new AbortController();
  try {
    const marker = join(dir, "down");
    const result = await withPreparationCommands(
      controller.signal,
      async () => {
        controller.abort(new Error("devcontainer stop requested"));
        // The same abort is what cancels startup work, which is the point: the
        // two phases must not share a signal.
        await expect(
          runPreparationCommand("bash", ["-c", "printf startup"]),
        ).rejects.toThrow("devcontainer stop requested");
        return await runPreparationTeardown(() =>
          runPreparationCommand("bash", [
            "-c",
            'printf teardown > "$1"',
            "teardown",
            marker,
          ]),
        );
      },
    );
    expect(result.exitCode).toBe(0);
    expect(await readFile(marker, "utf8")).toBe("teardown");
  } finally {
    controller.abort();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unawaited teardown child is still reaped when the scope returns", async () => {
  const controller = new AbortController();
  let child: Promise<unknown> | undefined;
  await withPreparationCommands(controller.signal, async () => {
    controller.abort(new Error("devcontainer stop requested"));
    await runPreparationTeardown(async () => {
      child = runPreparationCommand("bash", ["-c", "sleep 30"], {
        graceMs: 100,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  });
  // Escaping the shutdown signal must not mean escaping ownership: the scope
  // would hang here on its own pending set if the owner abort missed the child.
  await expect(child).rejects.toThrow();
});

test("completed preparation does not wait for the cancellation grace interval", async () => {
  const controller = new AbortController();
  const result = await withPreparationCommands(controller.signal, () =>
    runPreparationCommand("bash", ["-c", "printf done"], { graceMs: 60000 }),
  );
  expect(result.stdout).toBe("done");
  expect(result.exitCode).toBe(0);
});
