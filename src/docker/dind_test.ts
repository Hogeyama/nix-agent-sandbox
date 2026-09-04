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
  type EnsureDindSidecarDeps,
  type EnsureDindSidecarParams,
  ensureDindSidecar,
  type StartDindSidecarParams,
  startDindSidecar,
  type TeardownDindSidecarParams,
  teardownDindSidecar,
} from "./dind.ts";

function teardownParams(): TeardownDindSidecarParams {
  return {
    containerName: "nas-dind-abc12345",
    dindDataVolume: "nas-dind-data-abc12345",
    sharedTmpVolume: "nas-dind-tmp-abc12345",
    registryMirrorName: "nas-registry-mirror-abc12345",
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
    ensureSharedTmpWritable: async () => {},
    networkConnect: async () => {},
    networkDisconnect: async () => {},
    stop: async () => {},
    rm: async () => {},
    volumeRemove: async () => {},
    ...overrides,
  };
}

test("ensureDindSidecar: starts mirror before dind and passes its name", async () => {
  const calls: string[] = [];
  const starts: Array<string | null> = [];
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
    }),
  );

  expect(calls.slice(0, 2)).toEqual(["mirror", "dind"]);
  expect(starts).toEqual(["nas-registry-mirror-abc12345"]);
  expect(handle.registryMirrorName).toBe("nas-registry-mirror-abc12345");
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

test("teardownDindSidecar: removes nothing while the joiner is running", async () => {
  const calls: string[] = [];
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

  await teardownDindSidecar(teardownParams(), deps);

  expect(calls).toEqual([]);
});

test("teardownDindSidecar: removes dind, mirror, and session volumes but not registry cache", async () => {
  const calls: string[] = [];
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

  await teardownDindSidecar(teardownParams(), deps);

  expect(calls).toEqual([
    "stop:nas-dind-abc12345",
    "rm:nas-dind-abc12345",
    "stop:nas-registry-mirror-abc12345",
    "rm:nas-registry-mirror-abc12345",
    "volume:nas-dind-tmp-abc12345",
    "volume:nas-dind-data-abc12345",
  ]);
  expect(calls).not.toContain("volume:nas-registry-cache");
});

test("startDindSidecar: resets only its session data after readiness failure", async () => {
  const calls: string[] = [];
  let waits = 0;
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
      waitReady: async () => {
        calls.push("wait");
        if (waits++ === 0) throw new Error("locked");
      },
      stop: async (name) => {
        calls.push(`stop:${name}`);
      },
      rm: async (name) => {
        calls.push(`rm:${name}`);
      },
      volumeRemove: async (name) => {
        calls.push(`volume-rm:${name}`);
      },
      volumeCreate: async (name) => {
        calls.push(`volume-create:${name}`);
      },
    },
  );

  expect(calls).toEqual([
    "run",
    "wait",
    "stop:nas-dind-session-a",
    "rm:nas-dind-session-a",
    "volume-rm:nas-dind-data-session-a",
    "volume-create:nas-dind-data-session-a",
    "run",
    "wait",
  ]);
  expect(calls).not.toContain("volume-rm:nas-registry-cache");
});

test("startDindSidecar: aborts retry when session data removal fails", async () => {
  const calls: string[] = [];

  await expect(
    startDindSidecar(
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
        waitReady: async () => {
          calls.push("wait");
          throw new Error("locked");
        },
        stop: async () => {},
        rm: async () => {},
        volumeRemove: async () => {
          calls.push("volume-rm");
          throw new Error("cannot remove data volume");
        },
        volumeCreate: async () => {
          calls.push("volume-create");
        },
      },
    ),
  ).rejects.toThrow("cannot remove data volume");

  expect(calls.filter((call) => call === "run")).toHaveLength(1);
  expect(calls).not.toContain("volume-create");
});

test("startDindSidecar: does not run a third time after retry readiness failure", async () => {
  const calls: string[] = [];

  await expect(
    startDindSidecar(
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
        waitReady: async () => {
          calls.push("wait");
          throw new Error("still locked");
        },
        stop: async () => {},
        rm: async () => {},
        volumeRemove: async () => {},
        volumeCreate: async () => {},
      },
    ),
  ).rejects.toThrow("DinD failed after resetting session data: still locked");

  expect(calls.filter((call) => call === "run")).toHaveLength(2);
  expect(calls.filter((call) => call === "wait")).toHaveLength(2);
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
