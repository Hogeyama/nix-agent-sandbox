import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "../../lib/fs_utils.ts";
import type { HostEnv } from "../../pipeline/types.ts";
import {
  makeDevcontainerLifecycle,
  serveDevcontainerRuntime,
} from "./lifecycle.ts";
import {
  canonicalizeWorkspace,
  resolveDevcontainerPaths,
  writeDevcontainerSession,
} from "./store.ts";
import {
  type DevcontainerRegistration,
  devcontainerWorkspaceId,
} from "./types.ts";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});

async function makeFixture(): Promise<{
  host: HostEnv;
  workspace: string;
  registration: DevcontainerRegistration;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "nas-dc-"));
  roots.push(root);
  const home = path.join(root, "home");
  const workspaceDir = path.join(root, "work");
  await mkdir(home, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  const host: HostEnv = {
    home,
    user: "tester",
    uid: 1000,
    gid: 1000,
    isWSL: false,
    env: new Map([
      ["XDG_STATE_HOME", path.join(root, "state")],
      ["XDG_RUNTIME_DIR", path.join(root, "run")],
    ]),
  };
  const workspace = await canonicalizeWorkspace(workspaceDir);
  const paths = resolveDevcontainerPaths(host, workspace);
  const registration: DevcontainerRegistration = {
    version: 1,
    workspaceId: devcontainerWorkspaceId(workspace),
    workspace,
    profileName: "claude",
    configPath: path.join(workspace, ".devcontainer", "devcontainer.json"),
    composePath: paths.composeFile,
    stateRoot: paths.stateRoot,
    command: ["nas"],
  };
  await atomicWriteFile(
    paths.registrationFile,
    `${JSON.stringify(registration)}\n`,
  );
  return { host, workspace, registration };
}

/** Stands in for the detached process: claims the session, then holds the scope. */
function makeServeSpawn(
  registration: DevcontainerRegistration,
  behaviour: {
    ready?: boolean;
    diagnostic?: string;
  } = {},
) {
  const state = {
    released: false,
    signalled: null as AbortSignal | null,
    sessionId: null as string | null,
  };
  const spawn = async (
    host: HostEnv,
    _registration: DevcontainerRegistration,
    sessionId: string,
    deadlineAt: number,
  ) => {
    state.sessionId = sessionId;
    const running = serveDevcontainerRuntime({
      host,
      workspace: registration.workspace,
      sessionId,
      deadlineAt,
      verifyRegistration: async () => registration,
      runRuntime: async (_reg, signal) => {
        if (behaviour.ready === false)
          return { ok: false, diagnostic: behaviour.diagnostic ?? "boom" };
        await atomicWriteFile(registration.composePath, "{}\n");
        await writeDevcontainerSession(host, registration.workspace, {
          version: 1,
          workspaceId: registration.workspaceId,
          sessionId,
          containerId: "container-1",
          phase: "ready",
          pid: process.pid,
          diagnostic: null,
        });
        state.signalled = signal;
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return { ok: true };
      },
    }).catch(() => undefined);
    void running.then(() => {
      state.released = true;
    });
  };
  return { spawn, state };
}

const noDocker = async () => {
  throw new Error("docker must not be used in this test");
};

const fakeDocker = (stdout: string) => async () => ({
  stdout,
  stderr: "",
});

test("up reports ready once the detached runtime publishes it", async () => {
  const { host, workspace, registration } = await makeFixture();
  const { spawn } = makeServeSpawn(registration);
  const lifecycle = makeDevcontainerLifecycle(host, {
    spawn,
    docker: fakeDocker("container-1\n") as never,
    verifyRegistration: async () => registration,
  });

  const status = await lifecycle.up(workspace);
  expect(status.phase).toBe("ready");
  expect(status.containerId).toBe("container-1");
  expect((await lifecycle.status(workspace))?.phase).toBe("ready");
});

test("up fails with the runtime's diagnostic when preparation fails", async () => {
  const { host, workspace, registration } = await makeFixture();
  const { spawn } = makeServeSpawn(registration, {
    ready: false,
    diagnostic: "proxy could not start",
  });
  const lifecycle = makeDevcontainerLifecycle(host, {
    spawn,
    docker: noDocker as never,
    verifyRegistration: async () => registration,
  });

  await expect(lifecycle.up(workspace)).rejects.toThrow(
    "proxy could not start",
  );
  const status = await lifecycle.status(workspace);
  expect(status?.phase).toBe("failed");
});

test("down stops the runtime and then clears the Compose project", async () => {
  const { host, workspace, registration } = await makeFixture();
  const { spawn, state } = makeServeSpawn(registration);
  const dockerCalls: string[][] = [];
  const signalled: number[] = [];
  const lifecycle = makeDevcontainerLifecycle(host, {
    spawn,
    verifyRegistration: async () => registration,
    readProcCmdline: async () => `nas devcontainer _serve ${state.sessionId}`,
    signalProcess: (pid) => {
      signalled.push(pid);
      state.signalled?.dispatchEvent(new Event("abort"));
    },
    docker: (async (args: readonly string[]) => {
      dockerCalls.push([...args]);
      return { stdout: "", stderr: "" };
    }) as never,
  });

  await lifecycle.up(workspace);
  const status = await lifecycle.down(workspace);

  expect(signalled).toEqual([process.pid]);
  expect(dockerCalls.at(-1)?.slice(-1)).toEqual(["down"]);
  expect(status?.phase).toBe("stopped");
  expect(state.released).toBe(true);
});

test("down leaves alone a session claimed while it was stopping", async () => {
  const { host, workspace, registration } = await makeFixture();
  await writeDevcontainerSession(host, workspace, {
    version: 1,
    workspaceId: registration.workspaceId,
    sessionId: "old",
    containerId: "container-1",
    phase: "ready",
    pid: 4242,
    diagnostic: null,
  });
  const dockerCalls: string[][] = [];
  const lifecycle = makeDevcontainerLifecycle(host, {
    verifyRegistration: async () => registration,
    // Stands in for an up that claims the workspace after down has read the
    // session it intends to stop.
    readProcCmdline: async () => {
      await writeDevcontainerSession(host, workspace, {
        version: 1,
        workspaceId: registration.workspaceId,
        sessionId: "new",
        containerId: null,
        phase: "starting",
        pid: null,
        diagnostic: null,
      });
      return null;
    },
    docker: (async (args: readonly string[]) => {
      dockerCalls.push([...args]);
      return { stdout: "", stderr: "" };
    }) as never,
  });

  const status = await lifecycle.down(workspace);

  expect(dockerCalls.some((call) => call.includes("down"))).toBe(false);
  expect(status?.phase).toBe("starting");
});

test("status is null for an unregistered workspace", async () => {
  const { host } = await makeFixture();
  const other = await mkdtemp(path.join(tmpdir(), "nas-dc-other-"));
  roots.push(other);
  const lifecycle = makeDevcontainerLifecycle(host, {
    docker: noDocker as never,
  });
  expect(await lifecycle.status(other)).toBeNull();
});

test("up refuses a failed session that still names a container", async () => {
  const { host, workspace, registration } = await makeFixture();
  await writeDevcontainerSession(host, workspace, {
    version: 1,
    workspaceId: registration.workspaceId,
    sessionId: "sess-leaked",
    containerId: "container-1",
    phase: "failed",
    pid: null,
    diagnostic: "docker compose down: devcontainer stop requested",
  });
  const lifecycle = makeDevcontainerLifecycle(host, {
    spawn: async () => {
      throw new Error("up must not start a second container over the first");
    },
    docker: noDocker as never,
    verifyRegistration: async () => registration,
  });

  await expect(lifecycle.up(workspace)).rejects.toThrow(
    "cleanup is incomplete",
  );
});

test("a ready session with no live runtime is reported as failed", async () => {
  const { host, workspace, registration } = await makeFixture();
  await writeDevcontainerSession(host, workspace, {
    version: 1,
    workspaceId: registration.workspaceId,
    sessionId: "sess-stale",
    containerId: "container-1",
    phase: "ready",
    pid: null,
    diagnostic: null,
  });
  const lifecycle = makeDevcontainerLifecycle(host, {
    docker: noDocker as never,
  });

  const status = await lifecycle.status(workspace);
  expect(status?.phase).toBe("failed");
  expect(status?.diagnostic).toContain("runtime is not running");
});
