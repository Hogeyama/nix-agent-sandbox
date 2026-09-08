import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type {
  ManagedForward,
  makePortBindClient,
} from "../domain/port_bind.ts";
import type { PortBindSessionEntry } from "../network/port_bind_protocol.ts";
import {
  readSessionRegistry,
  resolvePortsRuntimePaths,
  writeSessionRegistry,
} from "../network/port_bind_registry.ts";
import { runNetworkCommand } from "./network.ts";

type PortBindClient = ReturnType<typeof makePortBindClient>;

function fakePortBindClient(
  overrides: Partial<PortBindClient>,
): PortBindClient {
  const unavailable = async (): Promise<never> => {
    throw new Error("unexpected port bind client call");
  };
  return {
    list: async () => [],
    add: unavailable,
    remove: unavailable,
    bind: unavailable,
    unbindByKey: unavailable,
    candidates: unavailable,
    forward: unavailable,
    unforward: unavailable,
    ...overrides,
  };
}

function sessionWithForwards(
  sessionId: string,
  portForwards: ManagedForward[],
): PortBindSessionEntry {
  return {
    sessionId,
    pid: process.pid,
    brokerSocket: "/unused/in/fake-client",
    protocolVersion: 2,
    bindings: [],
    forwards: [],
    portForwards,
  };
}

async function captureLogs(run: () => Promise<void>): Promise<string[]> {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    await run();
    return logs;
  } finally {
    console.log = originalLog;
  }
}

async function withRuntime(
  run: (runtimeDir: string) => Promise<void>,
): Promise<void> {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-network-cli-"));
  try {
    await run(runtimeDir);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
}

const createdAt = new Date().toISOString();
const localForward: ManagedForward = {
  direction: "local",
  hostPort: 8080,
  containerPort: 3000,
  owners: ["dynamic"],
  state: "active",
  createdAt,
};
const remoteForward: ManagedForward = {
  direction: "remote",
  hostPort: 5432,
  containerPort: 15432,
  owners: ["config", "internal"],
  state: "unavailable",
  createdAt,
};

test("bind without arguments lists both directions in text and JSON", async () => {
  await withRuntime(async (runtimeDir) => {
    const portBindClient = fakePortBindClient({
      list: async () => [
        sessionWithForwards("session", [localForward, remoteForward]),
      ],
    });

    const text = await captureLogs(() =>
      runNetworkCommand(["bind", "--runtime-dir", runtimeDir], {
        portBindClient,
      }),
    );
    expect(text).toHaveLength(2);
    expect(text[0]).toContain(
      "session local host:8080 container:3000 dynamic active",
    );
    expect(text[1]).toContain(
      "session remote host:5432 container:15432 config,internal unavailable",
    );

    const json = await captureLogs(() =>
      runNetworkCommand(
        ["--format", "json", "bind", "--runtime-dir", runtimeDir],
        { portBindClient },
      ),
    );
    expect(JSON.parse(json[0])).toEqual([
      {
        sessionId: "session",
        direction: "local",
        hostPort: 8080,
        containerPort: 3000,
        owners: ["dynamic"],
        state: "active",
        age: expect.any(String),
      },
      {
        sessionId: "session",
        direction: "remote",
        hostPort: 5432,
        containerPort: 15432,
        owners: ["config", "internal"],
        state: "unavailable",
        age: expect.any(String),
      },
    ]);

    const legacyRemoteJson = await captureLogs(() =>
      runNetworkCommand(
        ["forward", "--runtime-dir", runtimeDir, "--format=json"],
        { portBindClient },
      ),
    );
    expect(JSON.parse(legacyRemoteJson[0])).toEqual([
      {
        sessionId: "session",
        containerPort: 15432,
        hostPort: 5432,
        age: expect.any(String),
      },
    ]);
  });
});

test("L and R bind syntax uses common add while legacy syntax keeps its adapter", async () => {
  await withRuntime(async (runtimeDir) => {
    const added: unknown[] = [];
    const bound: unknown[] = [];
    const portBindClient = fakePortBindClient({
      add: async (_paths, sessionId, request) => {
        added.push({ sessionId, request });
        return { entry: remoteForward, probe: "no-answer" };
      },
      bind: async (_paths, sessionId, containerPort, hostPort) => {
        bound.push({ sessionId, containerPort, hostPort });
        return { hostPort: hostPort ?? 8080, probe: "ok" };
      },
    });

    await captureLogs(() =>
      runNetworkCommand(
        ["bind", "session", "-R", "15432:5432", "--runtime-dir", runtimeDir],
        { portBindClient },
      ),
    );
    await captureLogs(() =>
      runNetworkCommand(
        ["bind", "session:3000", "8080", "--runtime-dir", runtimeDir],
        { portBindClient },
      ),
    );

    expect(added).toEqual([
      {
        sessionId: "session",
        request: {
          direction: "remote",
          containerPort: 15432,
          hostPort: 5432,
        },
      },
    ]);
    expect(bound).toEqual([
      { sessionId: "session", containerPort: 3000, hostPort: 8080 },
    ]);
  });
});

test("unbind picker removes each direction by its listen port", async () => {
  await withRuntime(async (runtimeDir) => {
    const removed: unknown[] = [];
    const portBindClient = fakePortBindClient({
      list: async () => [
        sessionWithForwards("session", [localForward, remoteForward]),
      ],
      remove: async (_paths, sessionId, selector) => {
        removed.push({ sessionId, selector });
        return selector.direction === "local"
          ? { removed: true, retainedInternal: true, listenerClosed: false }
          : { removed: true, retainedInternal: false, listenerClosed: false };
      },
    });

    const localLogs = await captureLogs(() =>
      runNetworkCommand(["unbind", "--runtime-dir", runtimeDir], {
        portBindClient,
        select: async (items) =>
          items.find((item) => item.includes(" local "))!,
      }),
    );
    const remoteLogs = await captureLogs(() =>
      runNetworkCommand(["unbind", "--runtime-dir", runtimeDir], {
        portBindClient,
        select: async (items) =>
          items.find((item) => item.includes(" remote "))!,
      }),
    );

    expect(removed).toEqual([
      {
        sessionId: "session",
        selector: { direction: "local", hostPort: 8080 },
      },
      {
        sessionId: "session",
        selector: { direction: "remote", containerPort: 15432 },
      },
    ]);
    expect(localLogs.join("\n")).toContain("retainedInternal=true");
    expect(localLogs.join("\n")).toContain("listenerClosed=false");
    expect(remoteLogs.join("\n")).toContain("listenerClosed=false");
    expect([...localLogs, ...remoteLogs].join("\n")).not.toContain(
      "閉じました",
    );
  });
});

test("explicit L unbind stays session scoped", async () => {
  await withRuntime(async (runtimeDir) => {
    const removed: unknown[] = [];
    const portBindClient = fakePortBindClient({
      remove: async (_paths, sessionId, selector) => {
        removed.push({ sessionId, selector });
        return { removed: true, retainedInternal: false, listenerClosed: true };
      },
    });

    await captureLogs(() =>
      runNetworkCommand(
        ["unbind", "session", "-L", "8080", "--runtime-dir", runtimeDir],
        { portBindClient },
      ),
    );
    expect(removed).toEqual([
      {
        sessionId: "session",
        selector: { direction: "local", hostPort: 8080 },
      },
    ]);
  });
});

test("network gc also sweeps the default ports runtime", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nas-network-cli-"));
  const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = root;
  try {
    const paths = await resolvePortsRuntimePaths();
    await writeSessionRegistry(paths, {
      sessionId: "stale",
      pid: Number.MAX_SAFE_INTEGER,
      brokerSocket: path.join(paths.brokersDir, "stale", "sock"),
      bindings: [],
    });

    await runNetworkCommand(["gc"]);

    expect(
      await readSessionRegistry<PortBindSessionEntry>(paths, "stale"),
    ).toBeNull();
  } finally {
    if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
    await rm(root, { recursive: true, force: true });
  }
});
