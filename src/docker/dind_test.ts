import { expect, test } from "bun:test";

/**
 * teardownDindSidecar unit tests (Docker 不要).
 *
 * Covers the joiner-liveness skip branch, which no integration test can
 * reach: integration runs never have a real agent container sharing the
 * sidecar's network namespace. See dind_stage_integration_test.ts for the
 * Docker-backed teardown paths.
 */

import {
  type DindReadinessMonitor,
  type EnsureDindSidecarDeps,
  type EnsureDindSidecarParams,
  ensureDindSidecar,
  type StartDindSidecarParams,
  startDindReadinessMonitor,
  startDindSidecar,
  type TeardownDindSidecarParams,
  teardownDindSidecar,
  type WaitForDindReadyDeps,
  waitForDindReady,
} from "./dind.ts";

function makeReadinessMonitor(
  onCancel: () => void = () => {},
): DindReadinessMonitor {
  return {
    finished: Promise.resolve(),
    cancel: onCancel,
  };
}

function teardownParams(): TeardownDindSidecarParams {
  return {
    containerName: "nas-dind-abc12345",
    dindDataVolume: "nas-dind-data-abc12345",
    sharedTmpVolume: "nas-dind-tmp-abc12345",
    registryMirrorName: "nas-registry-mirror-abc12345",
    readinessMonitor: makeReadinessMonitor(),
    joinerContainerName: "nas-agent-sess_abc12345",
  };
}

function ensureParams(): EnsureDindSidecarParams {
  return {
    containerName: "nas-dind-abc12345",
    dindDataVolume: "nas-dind-data-abc12345",
    sharedTmpVolume: "nas-dind-tmp-abc12345",
    registryMirrorName: "nas-registry-mirror-abc12345",
    registryCacheVolume: "nas-registry-cache",
    sessionNetworkName: "nas-session-net-abc12345",
    proxyEndpoint: "http://abc12345:token@nas-proxy:8080",
    caCertPath: "/run/nas/mitmproxy-ca/mitmproxy-ca-cert.pem",
    extraHosts: [],
    disablePullCache: false,
    readinessTimeoutMs: 5_000,
  };
}

function makeEnsureDeps(
  overrides: Partial<EnsureDindSidecarDeps> = {},
): EnsureDindSidecarDeps {
  return {
    volumeCreate: async () => {},
    startRegistryMirror: async () => {},
    startDind: async (_params: StartDindSidecarParams) => {},
    startReadinessMonitor: () => makeReadinessMonitor(),
    ensureSharedTmpWritable: async () => {},
    networkConnect: async () => {},
    networkDisconnect: async () => {},
    stop: async () => {},
    rm: async () => {},
    volumeRemove: async () => {},
    ...overrides,
  };
}

test("waitForDindReady: polls the daemon API directly until it succeeds", async () => {
  let now = 0;
  const execCalls: string[][] = [];
  const deps: WaitForDindReadyDeps = {
    isRunning: async () => true,
    logs: async () => "daemon logs",
    exec: async (_containerName, command) => {
      execCalls.push(command);
      return { code: execCalls.length === 1 ? 1 : 0 };
    },
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
  };

  await waitForDindReady("nas-dind-session-a", 1_000, deps);

  expect(execCalls).toEqual([
    ["docker", "-H", "tcp://127.0.0.1:2375", "info"],
    ["docker", "-H", "tcp://127.0.0.1:2375", "info"],
  ]);
  expect(now).toBe(500);
});

test("waitForDindReady: fails immediately with logs when the sidecar exits", async () => {
  let execCalls = 0;
  const deps: WaitForDindReadyDeps = {
    isRunning: async () => false,
    logs: async () => "rootlesskit failed",
    exec: async () => {
      execCalls += 1;
      return { code: 0 };
    },
    sleep: async () => {},
    now: () => 0,
  };

  await expect(
    waitForDindReady("nas-dind-session-a", 1_000, deps),
  ).rejects.toThrow(
    "DinD rootless container exited unexpectedly.\n--- container logs ---\nrootlesskit failed",
  );
  expect(execCalls).toBe(0);
});

test("waitForDindReady: includes logs when daemon API polling times out", async () => {
  let now = 0;
  let execCalls = 0;
  const deps: WaitForDindReadyDeps = {
    isRunning: async () => true,
    logs: async () => "dockerd still starting",
    exec: async () => {
      execCalls += 1;
      return { code: 1 };
    },
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
  };

  await expect(
    waitForDindReady("nas-dind-session-a", 1_000, deps),
  ).rejects.toThrow(
    "DinD rootless failed to become ready within 1s\n--- container logs ---\ndockerd still starting",
  );
  expect(execCalls).toBe(2);
});

test("ensureDindSidecar: starts mirror before dind and passes its name", async () => {
  const calls: string[] = [];
  const starts: Array<string | null> = [];
  const readinessMonitor = makeReadinessMonitor();
  const handle = await ensureDindSidecar(
    ensureParams(),
    makeEnsureDeps({
      startRegistryMirror: async () => {
        calls.push("mirror");
      },
      startDind: async (params) => {
        calls.push("dind");
        starts.push(params.registryMirrorName);
      },
      ensureSharedTmpWritable: async () => {
        calls.push("chmod");
      },
      networkConnect: async () => {
        calls.push("connect");
      },
      networkDisconnect: async () => {
        calls.push("disconnect");
      },
      startReadinessMonitor: () => {
        calls.push("monitor");
        return readinessMonitor;
      },
    }),
  );

  expect(calls).toEqual([
    "mirror",
    "dind",
    "chmod",
    "connect",
    "disconnect",
    "monitor",
  ]);
  expect(starts).toEqual(["nas-registry-mirror-abc12345"]);
  expect(handle.registryMirrorName).toBe("nas-registry-mirror-abc12345");
  expect(handle.readinessMonitor).toBe(readinessMonitor);
});

test("ensureDindSidecar: mirror failure falls back to direct pulls", async () => {
  const starts: Array<string | null> = [];
  const handle = await ensureDindSidecar(
    ensureParams(),
    makeEnsureDeps({
      startRegistryMirror: async () => {
        throw new Error("docker run -e HTTP_PROXY=http://sid:secret@nas-proxy");
      },
      startDind: async (params) => {
        starts.push(params.registryMirrorName);
      },
    }),
  );

  expect(starts).toEqual([null]);
  expect(handle.registryMirrorName).toBeNull();
});

test("teardownDindSidecar: cancels readiness but removes nothing while the joiner is running", async () => {
  const calls: string[] = [];
  const params = teardownParams();
  params.readinessMonitor = makeReadinessMonitor(() => calls.push("cancel"));
  const deps = {
    isRunning: async () => true,
    stop: async (name: string) => {
      calls.push(`stop:${name}`);
    },
    rm: async (name: string) => {
      calls.push(`rm:${name}`);
    },
    volumeRemove: async (name: string) => {
      calls.push(`volume:${name}`);
    },
  };

  await teardownDindSidecar(params, deps);

  expect(calls).toEqual(["cancel"]);
});

test("teardownDindSidecar: removes dind, mirror, and session volumes but not registry cache", async () => {
  const calls: string[] = [];
  const params = teardownParams();
  params.readinessMonitor = makeReadinessMonitor(() => calls.push("cancel"));
  const deps = {
    isRunning: async () => false,
    stop: async (name: string) => {
      calls.push(`stop:${name}`);
    },
    rm: async (name: string) => {
      calls.push(`rm:${name}`);
    },
    volumeRemove: async (name: string) => {
      calls.push(`volume:${name}`);
    },
  };

  await teardownDindSidecar(params, deps);

  expect(calls).toEqual([
    "cancel",
    "stop:nas-dind-abc12345",
    "rm:nas-dind-abc12345",
    "stop:nas-registry-mirror-abc12345",
    "rm:nas-registry-mirror-abc12345",
    "volume:nas-dind-tmp-abc12345",
    "volume:nas-dind-data-abc12345",
  ]);
  expect(calls).not.toContain("volume:nas-registry-cache");
});

test("startDindSidecar: starts the container without probing readiness", async () => {
  const calls: string[] = [];
  await startDindSidecar(
    {
      containerName: "nas-dind-session-a",
      dindDataVolume: "nas-dind-data-session-a",
      sharedTmpVolume: "nas-dind-tmp-session-a",
      proxy: {
        proxyEndpoint: "http://session-a:token@nas-proxy:8080",
        caCertPath: "/run/nas/mitmproxy-ca/mitmproxy-ca-cert.pem",
      },
      extraHosts: [],
      registryMirrorName: null,
      readinessTimeoutMs: 1,
    },
    {
      runSidecar: async () => {
        calls.push("run");
      },
    },
  );

  expect(calls).toEqual(["run"]);
});

test("startDindReadinessMonitor: returns while readiness is pending", async () => {
  let resolveReadiness: () => void = () => {};
  const readiness = new Promise<void>((resolve) => {
    resolveReadiness = resolve;
  });
  let readyCalls = 0;
  const monitor = startDindReadinessMonitor("nas-dind-session-a", 1_000, {
    waitReady: async () => readiness,
    ready: () => {
      readyCalls += 1;
    },
    failed: () => {},
  });

  expect(readyCalls).toBe(0);
  resolveReadiness();
  await monitor.finished;
  expect(readyCalls).toBe(1);
});

test("startDindReadinessMonitor: reports one terminal error", async () => {
  const failures: string[] = [];
  const monitor = startDindReadinessMonitor("nas-dind-session-a", 1_000, {
    waitReady: async () => {
      throw new Error("dockerd failed");
    },
    ready: () => {},
    failed: (message) => failures.push(message),
  });

  await monitor.finished;

  expect(failures).toEqual([
    "[nas] DinD: daemon failed to become ready: dockerd failed",
  ]);
});

test("startDindReadinessMonitor: cancellation suppresses completion output", async () => {
  let rejectReadiness: (error: Error) => void = () => {};
  const readiness = new Promise<void>((_resolve, reject) => {
    rejectReadiness = reject;
  });
  const output: string[] = [];
  const monitor = startDindReadinessMonitor("nas-dind-session-a", 1_000, {
    waitReady: async () => readiness,
    ready: () => output.push("ready"),
    failed: (message) => output.push(message),
  });

  monitor.cancel();
  rejectReadiness(new Error("removed during teardown"));
  await monitor.finished;

  expect(output).toEqual([]);
});

test("ensureDindSidecar: failed dind acquisition removes mirror and only session volumes", async () => {
  const calls: string[] = [];
  const deps = makeEnsureDeps({
    volumeCreate: async (name) => {
      calls.push(`volume-create:${name}`);
    },
    startRegistryMirror: async () => {
      calls.push("start-mirror");
    },
    startDind: async () => {
      calls.push("start-dind");
      throw new Error("startup failed");
    },
    ensureSharedTmpWritable: async () => {},
    networkConnect: async () => {},
    networkDisconnect: async () => {},
    stop: async (name) => {
      calls.push(`stop:${name}`);
    },
    rm: async (name) => {
      calls.push(`rm:${name}`);
    },
    volumeRemove: async (name) => {
      calls.push(`volume-rm:${name}`);
    },
  });

  await expect(ensureDindSidecar(ensureParams(), deps)).rejects.toThrow(
    "startup failed",
  );
  expect(calls).toContain("stop:nas-registry-mirror-abc12345");
  expect(calls).toContain("rm:nas-registry-mirror-abc12345");
  expect(calls).toContain("volume-rm:nas-dind-tmp-abc12345");
  expect(calls).toContain("volume-rm:nas-dind-data-abc12345");
  expect(calls.some((call) => call.includes("nas-registry-cache"))).toBe(false);
});
