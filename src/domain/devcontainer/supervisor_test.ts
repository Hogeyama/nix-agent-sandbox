import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { HostEnv } from "../../pipeline/types.ts";
import {
  acquireDevcontainerLock,
  ensureProtectedDirectory,
  readDevcontainerSession,
  resolveDevcontainerPaths,
  resolveDevcontainerRuntimePaths,
  withDevcontainerOperationLock,
  writeDevcontainerSession,
  writeProtectedFile,
} from "./store.ts";
import {
  makeDevcontainerSupervisorClient,
  markSupervisorFailure,
  requestDevcontainerControl,
  serveDevcontainerSupervisor,
} from "./supervisor.ts";
import type {
  DevcontainerRegistration,
  DevcontainerSessionRecord,
} from "./types.ts";

async function fixture() {
  const root = await mkdtemp(
    path.join(tmpdir(), "nas-devcontainer-supervisor-"),
  );
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  const state = path.join(root, "state");
  const runtime = path.join(root, "run");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  const host: HostEnv = {
    home,
    user: "tester",
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
    isWSL: false,
    env: new Map([
      ["HOME", home],
      ["XDG_STATE_HOME", state],
      ["XDG_RUNTIME_DIR", runtime],
    ]),
  };
  const paths = resolveDevcontainerPaths(host, workspace);
  const runtimePaths = resolveDevcontainerRuntimePaths(host, workspace);
  const registration: DevcontainerRegistration = {
    version: 1,
    workspaceId: path.basename(paths.registrationDir),
    workspace,
    profileName: "claude",
    fingerprint: "fingerprint",
    configPath: path.join(workspace, ".devcontainer", "devcontainer.json"),
    composePath: paths.composeFile,
    stateRoot: path.dirname(paths.claudeDir),
    command: [process.execPath],
  };
  const session: DevcontainerSessionRecord = {
    version: 1,
    workspaceId: registration.workspaceId,
    fingerprint: registration.fingerprint,
    sessionId: "dc_fixture",
    containerId: null,
    phase: "preparing",
    controlSocket: runtimePaths.controlSocket,
    diagnostic: null,
  };
  await ensureProtectedDirectory(paths.registrationDir, host.uid as number);
  await writeProtectedFile(
    paths.registrationFile,
    `${JSON.stringify(registration)}\n`,
    host.uid as number,
  );
  await withDevcontainerOperationLock(host, workspace, () =>
    writeDevcontainerSession(host, workspace, session),
  );
  return {
    root,
    host,
    workspace,
    registration,
    session,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test.each([
  ["rejected runtime", async () => Promise.reject(new Error("probe failed"))],
  [
    "failure Exit projection",
    async () => ({ ok: false, diagnostic: "pipeline failed" }),
  ],
] as const)("outer supervisor records %s", async (_name, runRuntime) => {
  const f = await fixture();
  try {
    await expect(
      serveDevcontainerSupervisor({
        host: f.host,
        workspace: f.workspace,
        sessionId: f.session.sessionId,
        verifyRegistration: async () => f.registration,
        runRuntime,
      }),
    ).rejects.toThrow("devcontainer preparation failed");
    const record = await readDevcontainerSession(f.host, f.workspace);
    expect(record?.phase).toBe("failed");
    expect(record?.diagnostic).toContain(
      _name === "rejected runtime" ? "probe failed" : "pipeline failed",
    );
  } finally {
    await f.cleanup();
  }
});

test("failure fencing preserves a stopped state and a newer generation", async () => {
  const f = await fixture();
  try {
    await withDevcontainerOperationLock(f.host, f.workspace, async () => {
      await writeDevcontainerSession(
        f.host,
        f.workspace,
        { ...f.session, phase: "stopped" },
        f.session.sessionId,
      );
    });
    await markSupervisorFailure(
      f.host,
      f.registration,
      f.session,
      "late failure",
    );
    expect((await readDevcontainerSession(f.host, f.workspace))?.phase).toBe(
      "stopped",
    );

    await withDevcontainerOperationLock(f.host, f.workspace, async () => {
      await writeDevcontainerSession(f.host, f.workspace, {
        ...f.session,
        sessionId: "dc_newer",
        phase: "ready",
        containerId: "new-container",
      });
    });
    await markSupervisorFailure(
      f.host,
      f.registration,
      f.session,
      "stale failure",
    );
    expect(
      (await readDevcontainerSession(f.host, f.workspace))?.sessionId,
    ).toBe("dc_newer");
  } finally {
    await f.cleanup();
  }
});

test("concurrent up shares one generation and down is repeatable", async () => {
  const f = await fixture();
  let spawns = 0;
  let supervisor: Promise<void> | null = null;
  try {
    await withDevcontainerOperationLock(f.host, f.workspace, async () => {
      await writeDevcontainerSession(
        f.host,
        f.workspace,
        { ...f.session, phase: "stopped" },
        f.session.sessionId,
      );
    });
    const client = makeDevcontainerSupervisorClient(f.host, {
      startupTimeoutMs: 5_000,
      verify: async () => f.registration,
      inspect: async () => true,
      cleanup: async () => {},
      spawn: async (_host, registration, sessionId) => {
        spawns++;
        supervisor = serveDevcontainerSupervisor({
          host: f.host,
          workspace: f.workspace,
          sessionId,
          verifyRegistration: async () => registration,
          runRuntime: async (_owned, signal) => {
            await withDevcontainerOperationLock(
              f.host,
              f.workspace,
              async () => {
                const current = await readDevcontainerSession(
                  f.host,
                  f.workspace,
                );
                if (!current) throw new Error("missing session");
                await writeDevcontainerSession(
                  f.host,
                  f.workspace,
                  { ...current, phase: "ready", containerId: "container-id" },
                  sessionId,
                );
              },
            );
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve();
              else
                signal.addEventListener("abort", () => resolve(), {
                  once: true,
                });
            });
            await withDevcontainerOperationLock(
              f.host,
              f.workspace,
              async () => {
                const current = await readDevcontainerSession(
                  f.host,
                  f.workspace,
                );
                if (!current) throw new Error("missing session");
                await writeDevcontainerSession(
                  f.host,
                  f.workspace,
                  { ...current, phase: "stopped", containerId: null },
                  sessionId,
                );
              },
            );
            return { ok: false, diagnostic: "interrupted" };
          },
        });
      },
    });

    const [first, second] = await Promise.all([
      client.up(f.workspace),
      client.up(f.workspace),
    ]);
    expect(spawns).toBe(1);
    expect(first.sessionId).toBe(second.sessionId);
    expect(first.phase).toBe("ready");

    expect((await client.down(f.workspace))?.phase).toBe("stopped");
    await supervisor;
    expect((await client.down(f.workspace))?.phase).toBe("stopped");
    await expect(stat(f.session.controlSocket)).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await f.cleanup();
  }
});

test("control protocol rejects a stale session identity", async () => {
  const f = await fixture();
  let running: Promise<void> | null = null;
  try {
    running = serveDevcontainerSupervisor({
      host: f.host,
      workspace: f.workspace,
      sessionId: f.session.sessionId,
      verifyRegistration: async () => f.registration,
      runRuntime: async (_registration, signal) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return { ok: true };
      },
    });
    for (let i = 0; i < 100; i++) {
      try {
        await stat(f.session.controlSocket);
        break;
      } catch {
        await Bun.sleep(10);
      }
    }
    await expect(
      requestDevcontainerControl(
        f.registration,
        { ...f.session, sessionId: "dc_stale" },
        "status",
        200,
      ),
    ).rejects.toBeDefined();
    await requestDevcontainerControl(f.registration, f.session, "stop");
    await running;
  } finally {
    await f.cleanup();
  }
});

test("up replaces a stale active record after proving its lifetime lock is free", async () => {
  const f = await fixture();
  let spawnedSession: string | null = null;
  try {
    const client = makeDevcontainerSupervisorClient(f.host, {
      startupTimeoutMs: 1_000,
      verify: async () => f.registration,
      cleanup: async () => {},
      spawn: async (_host, _registration, sessionId) => {
        spawnedSession = sessionId;
      },
      request: async (_registration, session) => {
        if (session.sessionId === f.session.sessionId)
          throw new Error("stale socket");
        return { ...session, phase: "ready", containerId: "container-id" };
      },
      inspect: async () => true,
    });
    const status = await client.up(f.workspace);
    expect(spawnedSession).not.toBeNull();
    expect(status.sessionId).toBe(spawnedSession);
    expect(status.phase).toBe("ready");
  } finally {
    await f.cleanup();
  }
});

test("status never advertises ready when the live supervisor cannot answer", async () => {
  const f = await fixture();
  const lifetime = await acquireDevcontainerLock(
    resolveDevcontainerRuntimePaths(f.host, f.workspace).lifetimeLock,
    f.host.uid as number,
    0,
  );
  try {
    await withDevcontainerOperationLock(f.host, f.workspace, async () => {
      await writeDevcontainerSession(
        f.host,
        f.workspace,
        { ...f.session, phase: "ready", containerId: "container-id" },
        f.session.sessionId,
      );
    });
    const client = makeDevcontainerSupervisorClient(f.host, {
      request: async () => {
        throw new Error("unreachable socket");
      },
    });
    const status = await client.status(f.workspace);
    expect(status?.phase).toBe("failed");
    expect(status?.diagnostic).toContain("supervisor status unavailable");
  } finally {
    await lifetime.release();
    await f.cleanup();
  }
});
