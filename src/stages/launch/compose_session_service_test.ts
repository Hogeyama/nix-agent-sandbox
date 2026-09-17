import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer } from "effect";
import { NAS_SESSION_ID_LABEL } from "../../docker/nas_resources.ts";
import type { DevcontainerRegistration } from "../../domain/devcontainer.ts";
import { withPreparationCommands } from "../../lib/preparation_commands.ts";
import type { ContainerPlan } from "../../pipeline/state.ts";
import type { HostEnv } from "../../pipeline/types.ts";
import {
  ComposeSessionOps,
  type ComposeSessionRequest,
  makeComposeSessionOpsLive,
  serveComposeSession,
} from "./compose_session_service.ts";

const registration: DevcontainerRegistration = {
  version: 1,
  workspaceId: "a".repeat(64),
  workspace: "/work",
  profileName: "claude",
  fingerprint: "fingerprint",
  configPath: "/work/.devcontainer/devcontainer.json",
  composePath: "/state/compose.json",
  stateRoot: "/state/workspace",
  command: ["nas"],
};

const container: ContainerPlan = {
  image: "nas-sandbox",
  workDir: "/work",
  mounts: [
    { source: "/work", target: "/work" },
    {
      source: "/work/.devcontainer",
      target: "/work/.devcontainer",
      readOnly: true,
    },
    { source: "/work/.nas", target: "/work/.nas", readOnly: true },
    {
      source: "/state/workspace/vscode",
      target: "/home/tester/.vscode-server",
    },
  ],
  env: { static: { NAS_UID: "1000", NAS_USER: "tester" }, dynamicOps: [] },
  network: { mode: "network", name: "nas-net" },
  extraHosts: [],
  extraRunArgs: [],
  command: { agentCommand: ["claude"], extraArgs: ["$literal"] },
  labels: {
    [NAS_SESSION_ID_LABEL]: "sess-1",
    "devcontainer.local_folder": "/work",
    "devcontainer.config_file": registration.configPath,
  },
};

const request: ComposeSessionRequest = {
  registration,
  sessionId: "sess-1",
  containerName: "nas-agent-sess-1",
  container,
};

interface Recorded {
  readonly calls: string[];
  readonly phases: Array<[string, string | null, string | null]>;
  compose: string | null;
}

function makeOps(
  recorded: Recorded,
  overrides: Partial<{
    composeUp: Effect.Effect<void, Error>;
    readyMarker: () => Effect.Effect<void, Error>;
    containerId: string;
    composeDown: Effect.Effect<void, Error>;
  }> = {},
) {
  return Layer.succeed(
    ComposeSessionOps,
    ComposeSessionOps.of({
      publishCompose: (_path, bytes) =>
        Effect.sync(() => {
          recorded.calls.push("publishCompose");
          recorded.compose = bytes;
        }),
      publishPhase: (_request, phase, containerId, diagnostic) =>
        Effect.sync(() => {
          recorded.calls.push(`phase:${phase}`);
          recorded.phases.push([phase, containerId, diagnostic]);
        }),
      composeUp: () =>
        Effect.sync(() => {
          recorded.calls.push("composeUp");
        }).pipe(Effect.andThen(overrides.composeUp ?? Effect.void)),
      composeContainerId: () =>
        Effect.sync(() => {
          recorded.calls.push("composeContainerId");
          return overrides.containerId ?? "container-1";
        }),
      probeReadyMarker: () =>
        Effect.sync(() => {
          recorded.calls.push("probeReadyMarker");
        }).pipe(Effect.andThen(overrides.readyMarker?.() ?? Effect.void)),
      composeDown: () =>
        Effect.sync(() => {
          recorded.calls.push("composeDown");
        }).pipe(Effect.andThen(overrides.composeDown ?? Effect.void)),
    }),
  );
}

function empty(): Recorded {
  return { calls: [], phases: [], compose: null };
}

test("startup generates Compose, starts it, and checks the marker once", async () => {
  const recorded = empty();
  await Effect.runPromiseExit(
    Effect.scoped(
      serveComposeSession(request, Date.now() + 5_000).pipe(
        Effect.provide(makeOps(recorded)),
        Effect.timeout("200 millis"),
      ),
    ),
  );

  expect(recorded.calls.slice(0, 6)).toEqual([
    "publishCompose",
    "phase:starting",
    "composeUp",
    "composeContainerId",
    "probeReadyMarker",
    "phase:ready",
  ]);
  expect(recorded.calls.filter((c) => c === "probeReadyMarker")).toHaveLength(
    1,
  );
  expect(recorded.compose).toContain("nas-agent-sess-1");
});

test("serve stays alive after ready so the pipeline scope is retained", async () => {
  const recorded = empty();
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      serveComposeSession(request, Date.now() + 5_000).pipe(
        Effect.provide(makeOps(recorded)),
        Effect.timeout("200 millis"),
      ),
    ),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  expect(recorded.calls.filter((c) => c === "composeUp")).toHaveLength(1);
  // The timeout interrupts a ready session, so cleanup reports no failure.
  expect(recorded.phases.at(-1)).toEqual(["stopped", null, null]);
  expect(recorded.calls).toContain("composeDown");
});

test("a failed start tears the container down and publishes the diagnostic", async () => {
  const recorded = empty();
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      serveComposeSession(request, Date.now() + 5_000).pipe(
        Effect.provide(
          makeOps(recorded, {
            composeUp: Effect.fail(new Error("compose refused")),
          }),
        ),
      ),
    ),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  expect(recorded.calls).toContain("composeDown");
  const last = recorded.phases.at(-1);
  expect(last?.[0]).toBe("failed");
  expect(last?.[2]).toContain("compose refused");
});

test("a container that survives teardown is recorded as failed, not stopped", async () => {
  const recorded = empty();
  await Effect.runPromiseExit(
    Effect.scoped(
      serveComposeSession(request, Date.now() + 5_000).pipe(
        Effect.provide(
          makeOps(recorded, {
            composeDown: Effect.fail(new Error("docker daemon is gone")),
          }),
        ),
        Effect.timeout("200 millis"),
      ),
    ),
  );

  const last = recorded.phases.at(-1);
  expect(last?.[0]).toBe("failed");
  // The ID stays so the next up sees the leftover container.
  expect(last?.[1]).toBe("container-1");
  expect(last?.[2]).toContain("docker daemon is gone");
});

test("live compose down runs even though shutdown aborted the scope signal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nas-compose-down-"));
  const originalPath = process.env.PATH;
  try {
    const log = join(dir, "argv");
    await writeFile(
      join(dir, "docker"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${dir}:${originalPath}`;
    const host: HostEnv = {
      home: dir,
      user: "tester",
      uid: 1000,
      gid: 1000,
      isWSL: false,
      env: new Map(),
    };
    const down = Effect.gen(function* () {
      const ops = yield* ComposeSessionOps;
      yield* ops.composeDown("/state/compose.json");
    }).pipe(Effect.provide(makeComposeSessionOpsLive(host)));

    // The arrangement of the detached runtime: SIGTERM aborts the signal that
    // both interrupts the session and runs its Effect finalizers.
    const controller = new AbortController();
    await withPreparationCommands(controller.signal, async () => {
      controller.abort(new Error("devcontainer stop requested"));
      await Effect.runPromise(down);
    });

    expect(await readFile(log, "utf8")).toContain(
      "compose -f /state/compose.json down",
    );
  } finally {
    process.env.PATH = originalPath;
    await rm(dir, { recursive: true, force: true });
  }
});

test("startup fails at the deadline instead of retrying the marker forever", async () => {
  const recorded = empty();
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      serveComposeSession(request, Date.now() + 300).pipe(
        Effect.provide(
          makeOps(recorded, {
            readyMarker: () => Effect.fail(new Error("not ready")),
          }),
        ),
      ),
    ),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  expect(recorded.phases.at(-1)?.[2]).toContain("startup deadline exceeded");
});
