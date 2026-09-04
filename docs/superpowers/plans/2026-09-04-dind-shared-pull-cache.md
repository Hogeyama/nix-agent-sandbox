# DinD Session Data and Shared Pull Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate every DinD daemon's mutable state while sharing public Docker Hub pulls through session-scoped Distribution mirrors backed by one persistent registry cache volume.

**Architecture:** Every DinD sidecar mounts `nas-dind-data-<sessionId>` at Docker's rootless data directory; no containerd database is shared. A per-session `registry:2` pull-through mirror runs only on that session's internal network and uses that session's token-bearing proxy, while all mirror instances share `nas-registry-cache` as registry storage.

**Tech Stack:** Bun, TypeScript strict mode, Effect, Docker CLI, `docker:dind-rootless`, Docker Distribution `registry:2`, `bun:test`.

## Global Constraints

- Read `docs/superpowers/specs/2026-09-04-dind-shared-pull-cache-design.md` before Task 1.
- Mutable DinD/containerd state is session-local; never mount `nas-registry-cache` at `DIND_DATA_DIR`.
- The DinD data volume is mandatory. A test-only cache switch may suppress the registry mirror, never the data volume.
- The registry mirror caches anonymous public Docker Hub content only. Do not add Docker Hub credentials or mount Docker client configuration.
- A mirror starts directly on the internal session network. It must never receive a default-bridge attachment, even transiently.
- Every mirror cache miss uses the session's token-bearing proxy URL. Never interpolate that URL or a caught `docker run` error containing it into logs.
- Mount only the proxy CA certificate file. Never mount its parent directory, which also contains the CA private key (`security-constraints` C1).
- `nas-registry-cache` is persistent and excluded from normal teardown and `nas container clean`.
- Unit tests use injected dependencies/Fake Layers and never invoke Docker. Docker coverage stays in `src/stages/dind/integration_test.ts`.
- During iteration run focused unit files and `bun run test:unit`. Run `bun run test` exactly once, at the end of Task 5, per `AGENTS.md` and `test-policy`.
- Tests import repository modules by relative path.
- The stage remains an orchestration boundary: `stage.ts` calls the pure planner and `DindService`; Docker operations stay behind the service/runtime helpers.

---

### Task 1: Classify mirror and volume lifetimes

Teach cleanup and the settings UI which new resources are sidecars, which
volumes are ephemeral, and which cache must persist. This lands before any code
creates the resources, so destructive classification is reviewed first.

**Files:**
- Modify: `src/docker/nas_resources.ts`
- Modify: `src/docker/nas_resources_test.ts`
- Modify: `src/container_clean.ts`
- Modify: `src/container_clean_test.ts`
- Modify: `src/ui/frontend/src/components/settings/sidecarRowView.ts`
- Modify: `src/ui/frontend/src/components/settings/sidecarRowView_test.ts`

**Interfaces:**
- Produces: `NAS_KIND_DIND_DATA`, `NAS_KIND_REGISTRY_MIRROR`, and `NAS_KIND_REGISTRY_CACHE` string constants.
- Produces: `isNasManagedEphemeralVolume(labels, name): boolean`, replacing `isNasManagedTmpVolume` as the cleaner predicate.
- Produces: frontend `SidecarKind = "dind" | "proxy" | "registry-mirror"`.

- [ ] **Step 1: Write classifier tests that distinguish session state from the persistent cache**

In `src/docker/nas_resources_test.ts`, update imports and replace the tmp-only
volume section with:

```typescript
import {
  containerNameForSession,
  isLegacyNasEphemeralVolumeName,
  isLegacyNasSidecarName,
  isNasManagedEphemeralVolume,
  isNasManagedAgent,
  isNasManagedContainer,
  isNasManagedLabel,
  isNasManagedNetwork,
  isNasManagedSidecar,
  NAS_KIND_AGENT,
  NAS_KIND_DIND,
  NAS_KIND_DIND_DATA,
  NAS_KIND_DIND_NETWORK,
  NAS_KIND_DIND_TMP,
  NAS_KIND_LABEL,
  NAS_KIND_PROXY,
  NAS_KIND_PROXY_NETWORK,
  NAS_KIND_REGISTRY_CACHE,
  NAS_KIND_REGISTRY_MIRROR,
  NAS_KIND_SESSION_NETWORK,
  NAS_MANAGED_LABEL,
  NAS_MANAGED_VALUE,
} from "./nas_resources.ts";

test("isNasManagedSidecar: registry mirror is a managed sidecar", () => {
  expect(
    isNasManagedSidecar(
      {
        [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
        [NAS_KIND_LABEL]: NAS_KIND_REGISTRY_MIRROR,
      },
      "nas-registry-mirror-session-a",
    ),
  ).toBe(true);
});

test("isNasManagedEphemeralVolume: dind tmp and data are removable", () => {
  for (const kind of [NAS_KIND_DIND_TMP, NAS_KIND_DIND_DATA]) {
    expect(
      isNasManagedEphemeralVolume(
        {
          [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
          [NAS_KIND_LABEL]: kind,
        },
        "any",
      ),
    ).toBe(true);
  }
});

test("isNasManagedEphemeralVolume: registry cache is persistent", () => {
  expect(
    isNasManagedEphemeralVolume(
      {
        [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
        [NAS_KIND_LABEL]: NAS_KIND_REGISTRY_CACHE,
      },
      "nas-registry-cache",
    ),
  ).toBe(false);
});

test("isNasManagedEphemeralVolume: unused legacy global dind cache is retired", () => {
  expect(isNasManagedEphemeralVolume({}, "nas-docker-cache")).toBe(true);
  expect(isLegacyNasEphemeralVolumeName("nas-docker-cache")).toBe(true);
});
```

Keep the existing legacy tmp assertions, but point them at
`isNasManagedEphemeralVolume`.

- [ ] **Step 2: Write cleaner tests for an active mirror and persistent cache**

Add the new constants to `src/container_clean_test.ts` imports and add:

```typescript
test("isUnusedNasSidecar: a namespace joiner keeps its session mirror alive", () => {
  const networkName = "nas-session-net-abc12345";
  const dind = createManagedContainer("nas-dind-abc12345", NAS_KIND_DIND, {
    id: "dindid",
    networks: [networkName],
  });
  const mirror = createManagedContainer(
    "nas-registry-mirror-abc12345",
    NAS_KIND_REGISTRY_MIRROR,
    { id: "mirrorid", networks: [networkName] },
  );
  const agent = createManagedContainer("nas-agent-sess_abc12345", "agent", {
    id: "agentid",
    networks: [],
    networkMode: "container:dindid",
  });
  const containers = new Map([
    [dind.name, dind],
    [mirror.name, mirror],
    [agent.name, agent],
  ]);
  const networks = new Map([
    [
      networkName,
      createManagedNetwork(networkName, NAS_KIND_SESSION_NETWORK, [
        dind.name,
        mirror.name,
      ]),
    ],
  ]);

  expect(
    isUnusedNasSidecar(
      mirror,
      containers,
      networks,
      buildSidecarUsageIndex(containers.values()),
    ),
  ).toBe(false);
});

test("cleanNasContainers: removes session data and legacy cache but keeps registry cache", async () => {
  const backend = new FakeBackend();
  backend.containers.set(
    "nas-registry-mirror-orphan",
    createManagedContainer(
      "nas-registry-mirror-orphan",
      NAS_KIND_REGISTRY_MIRROR,
      { running: false },
    ),
  );
  backend.volumes.set("nas-dind-data-orphan", {
    name: "nas-dind-data-orphan",
    labels: {
      [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
      [NAS_KIND_LABEL]: NAS_KIND_DIND_DATA,
    },
    containers: [],
  });
  backend.volumes.set("nas-docker-cache", {
    name: "nas-docker-cache",
    labels: {},
    containers: [],
  });
  backend.volumes.set("nas-registry-cache", {
    name: "nas-registry-cache",
    labels: {
      [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
      [NAS_KIND_LABEL]: NAS_KIND_REGISTRY_CACHE,
    },
    containers: [],
  });

  const result = await cleanNasContainers(backend);

  expect(result.removedContainers).toEqual(["nas-registry-mirror-orphan"]);
  expect(result.removedVolumes).toEqual([
    "nas-dind-data-orphan",
    "nas-docker-cache",
  ]);
  expect(backend.volumes.has("nas-registry-cache")).toBe(true);
});
```

- [ ] **Step 3: Update the frontend sidecar contract test**

In `sidecarRowView_test.ts`, change the exact declaration assertion and add a
mirror row to the sort test:

```typescript
expect(SIDECAR_KINDS).toEqual(["dind", "proxy", "registry-mirror"]);
```

The sort fixture must expect `registry-mirror` after `proxy` because the
normalizer sorts by the literal kind string.

- [ ] **Step 4: Run the focused tests and verify the new expectations fail**

Run:

```bash
bun test src/docker/nas_resources_test.ts src/container_clean_test.ts src/ui/frontend/src/components/settings/sidecarRowView_test.ts
```

Expected: FAIL because the constants and ephemeral-volume predicate do not
exist, and `SIDECAR_KINDS` lacks `registry-mirror`.

- [ ] **Step 5: Implement the resource classifiers**

In `src/docker/nas_resources.ts`, add:

```typescript
export const NAS_KIND_DIND_DATA = "dind-data";
export const NAS_KIND_REGISTRY_MIRROR = "registry-mirror";
export const NAS_KIND_REGISTRY_CACHE = "registry-cache";
```

Include `NAS_KIND_REGISTRY_MIRROR` in `isNasManagedSidecar`. Replace the
tmp-only predicate with:

```typescript
export function isNasManagedEphemeralVolume(
  labels: DockerLabels,
  name: string,
): boolean {
  if (isNasManagedLabel(labels)) {
    const kind = labels[NAS_KIND_LABEL];
    return kind === NAS_KIND_DIND_TMP || kind === NAS_KIND_DIND_DATA;
  }
  return isLegacyNasEphemeralVolumeName(name);
}

export function isLegacyNasEphemeralVolumeName(name: string): boolean {
  return (
    name === "nas-docker-cache" ||
    name === "nas-dind-shared-tmp" ||
    name.startsWith("nas-dind-tmp-")
  );
}
```

Delete `isNasManagedTmpVolume` and `isLegacyNasTmpVolumeName`; update all test
imports in the same commit.

- [ ] **Step 6: Point cleanup at the lifetime-aware predicate**

In `src/container_clean.ts`, import
`isNasManagedEphemeralVolume` and change the volume guard to:

```typescript
if (!isNasManagedEphemeralVolume(volume.labels, volume.name)) continue;
```

Do not add `registry-cache` to that predicate.

- [ ] **Step 7: Expose registry mirrors in the settings UI**

In `sidecarRowView.ts`, change only the canonical list and the nearby comments:

```typescript
export const SIDECAR_KINDS = ["dind", "proxy", "registry-mirror"] as const;
```

- [ ] **Step 8: Verify and commit**

Run:

```bash
bun test src/docker/nas_resources_test.ts src/container_clean_test.ts src/ui/frontend/src/components/settings/sidecarRowView_test.ts
bun run check
```

Expected: PASS.

Commit:

```bash
git add src/docker/nas_resources.ts src/docker/nas_resources_test.ts src/container_clean.ts src/container_clean_test.ts src/ui/frontend/src/components/settings/sidecarRowView.ts src/ui/frontend/src/components/settings/sidecarRowView_test.ts
git commit -m "$(cat <<'EOF'
refactor(dind): distinguish ephemeral state from pull cache

The container cleaner previously knew only about DinD's shared tmp volume.
Session-local daemon data now has the same disposable lifetime, while registry
content must survive after its last consumer exits. A single lifetime-aware
predicate prevents the persistent cache from being swept with session state.

The old nas-docker-cache name is safe to retire only after no container uses
it; volume inspection preserves that condition for sidecars from older builds.
EOF
)"
```

---

### Task 2: Build the Docker Hub mirror component

Add a focused runtime module for Distribution configuration and readiness. It
does not decide session lifecycle; Task 4 composes it into `DindService`.

**Files:**
- Create: `src/docker/proxy_ca_mount.ts`
- Create: `src/docker/registry_mirror.ts`
- Create: `src/docker/registry_mirror_test.ts`
- Modify: `src/docker/dind.ts`
- Modify: `src/stages/dind/stage_test.ts`

**Interfaces:**
- Produces: `PROXY_CA_MOUNT_DIR` and `proxyCaCertMount(caCertPath)` from `proxy_ca_mount.ts`.
- Produces: `REGISTRY_MIRROR_IMAGE`, `REGISTRY_CACHE_VOLUME`, `REGISTRY_DATA_DIR`, and `REGISTRY_MIRROR_PORT`.
- Produces: `RegistryMirrorStartParams`, `RegistryMirrorDeps`, `buildRegistryMirrorRunOptions`, `registryMirrorUrl`, and `startRegistryMirror`.
- Consumes later: Task 4 calls `startRegistryMirror(params)` and `registryMirrorUrl(containerName)`.

- [ ] **Step 1: Write the mirror option-builder tests**

Create `src/docker/registry_mirror_test.ts`:

```typescript
import { expect, test } from "bun:test";
import {
  buildRegistryMirrorRunOptions,
  REGISTRY_CACHE_VOLUME,
  REGISTRY_DATA_DIR,
  REGISTRY_MIRROR_IMAGE,
  registryMirrorUrl,
} from "./registry_mirror.ts";

const params = {
  containerName: "nas-registry-mirror-session-a",
  cacheVolumeName: REGISTRY_CACHE_VOLUME,
  networkName: "nas-session-net-session-a",
  proxyEndpoint: "http://session-a:secret-token@nas-proxy:8080",
  caCertPath: "/run/nas/mitmproxy-ca/mitmproxy-ca-cert.pem",
  readinessTimeoutMs: 5_000,
};

test("buildRegistryMirrorRunOptions: confines the mirror to the session network", () => {
  const opts = buildRegistryMirrorRunOptions(params);

  expect(opts.image).toBe(REGISTRY_MIRROR_IMAGE);
  expect(opts.network).toBe(params.networkName);
  expect(opts.publishedPorts).toBeUndefined();
  expect(opts.args).toEqual([]);
});

test("buildRegistryMirrorRunOptions: shares only registry storage and the CA certificate", () => {
  const opts = buildRegistryMirrorRunOptions(params);

  expect(opts.mounts).toEqual([
    {
      source: params.cacheVolumeName,
      target: REGISTRY_DATA_DIR,
      type: "volume",
    },
    {
      source: params.caCertPath,
      target: "/etc/nas-ca/nas-proxy.crt",
      mode: "ro",
      type: "bind",
    },
  ]);
  expect(opts.mounts?.some((mount) =>
    typeof mount !== "string" && mount.source === "/run/nas/mitmproxy-ca"
  )).toBe(false);
});

test("buildRegistryMirrorRunOptions: configures anonymous Docker Hub pull-through cache", () => {
  const env = buildRegistryMirrorRunOptions(params).envVars;

  expect(env.REGISTRY_PROXY_REMOTEURL).toBe("https://registry-1.docker.io");
  expect(env.REGISTRY_STORAGE_FILESYSTEM_ROOTDIRECTORY).toBe(REGISTRY_DATA_DIR);
  expect(env.HTTP_PROXY).toBe(params.proxyEndpoint);
  expect(env.HTTPS_PROXY).toBe(params.proxyEndpoint);
  expect(env.SSL_CERT_DIR).toBe("/etc/nas-ca");
  expect(env.REGISTRY_PROXY_USERNAME).toBeUndefined();
  expect(env.REGISTRY_PROXY_PASSWORD).toBeUndefined();
});

test("registryMirrorUrl: returns the internal plaintext endpoint", () => {
  expect(registryMirrorUrl(params.containerName)).toBe(
    "http://nas-registry-mirror-session-a:5000",
  );
});
```

- [ ] **Step 2: Write the injected readiness test**

Append:

```typescript
test("startRegistryMirror: labels the cache and waits for the listener", async () => {
  const calls: string[] = [];
  const deps = {
    volumeCreate: async (name: string, labels: Record<string, string>) => {
      calls.push(`volume:${name}:${labels["nas.kind"]}`);
    },
    runDetached: async () => {
      calls.push("run");
    },
    isRunning: async () => true,
    containerIpOnNetwork: async () => "172.30.0.3",
    logs: async () => "",
    canConnectTcp: async () => true,
    sleep: async () => {},
  };

  await startRegistryMirror(params, deps);

  expect(calls).toEqual([
    `volume:${REGISTRY_CACHE_VOLUME}:registry-cache`,
    "run",
  ]);
});
```

Import `startRegistryMirror` in the file.

- [ ] **Step 3: Run the new file and verify it fails**

Run:

```bash
bun test src/docker/registry_mirror_test.ts
```

Expected: FAIL because both new modules are absent.

- [ ] **Step 4: Extract the reusable certificate-only mount**

Create `src/docker/proxy_ca_mount.ts`:

```typescript
export const PROXY_CA_MOUNT_DIR = "/etc/nas-ca";

export interface ProxyCaCertMount {
  readonly source: string;
  readonly target: string;
  readonly mode: "ro";
  readonly type: "bind";
}

export function proxyCaCertMount(caCertPath: string): ProxyCaCertMount {
  return {
    source: caCertPath,
    target: `${PROXY_CA_MOUNT_DIR}/nas-proxy.crt`,
    mode: "ro",
    type: "bind",
  };
}
```

In `src/docker/dind.ts`, import these two exports, keep
`DIND_CA_MOUNT_PATH` as a compatibility alias, and delegate the existing
builder:

```typescript
export const DIND_CA_MOUNT_PATH = PROXY_CA_MOUNT_DIR;

export function buildDindSidecarMounts(
  caCertPath: string,
): ProxyCaCertMount[] {
  return [proxyCaCertMount(caCertPath)];
}
```

The existing certificate-parent-directory tests in `stage_test.ts` must remain
green without changing their assertions.

- [ ] **Step 5: Implement the mirror plan and option builder**

Create `src/docker/registry_mirror.ts` with these public definitions:

```typescript
import { createConnection } from "node:net";
import type { DockerRunDetachedOptions } from "./client.ts";
import {
  dockerContainerIpOnNetwork,
  dockerIsRunning,
  dockerLogs,
  dockerRunDetached,
  dockerVolumeCreate,
} from "./client.ts";
import {
  NAS_KIND_LABEL,
  NAS_KIND_REGISTRY_CACHE,
  NAS_KIND_REGISTRY_MIRROR,
  NAS_MANAGED_LABEL,
  NAS_MANAGED_VALUE,
} from "./nas_resources.ts";
import { PROXY_CA_MOUNT_DIR, proxyCaCertMount } from "./proxy_ca_mount.ts";

export const REGISTRY_MIRROR_IMAGE = "registry:2";
export const REGISTRY_CACHE_VOLUME = "nas-registry-cache";
export const REGISTRY_DATA_DIR = "/var/lib/registry";
export const REGISTRY_MIRROR_PORT = 5000;

export interface RegistryMirrorStartParams {
  readonly containerName: string;
  readonly cacheVolumeName: string;
  readonly networkName: string;
  readonly proxyEndpoint: string;
  readonly caCertPath: string;
  readonly readinessTimeoutMs: number;
}

export function registryMirrorUrl(containerName: string): string {
  return `http://${containerName}:${REGISTRY_MIRROR_PORT}`;
}

export function buildRegistryMirrorRunOptions(
  params: RegistryMirrorStartParams,
): DockerRunDetachedOptions {
  return {
    name: params.containerName,
    image: REGISTRY_MIRROR_IMAGE,
    args: [],
    envVars: {
      REGISTRY_PROXY_REMOTEURL: "https://registry-1.docker.io",
      REGISTRY_STORAGE_FILESYSTEM_ROOTDIRECTORY: REGISTRY_DATA_DIR,
      HTTP_PROXY: params.proxyEndpoint,
      HTTPS_PROXY: params.proxyEndpoint,
      NO_PROXY: `localhost,127.0.0.1,${params.containerName}`,
      SSL_CERT_DIR: PROXY_CA_MOUNT_DIR,
    },
    network: params.networkName,
    mounts: [
      {
        source: params.cacheVolumeName,
        target: REGISTRY_DATA_DIR,
        type: "volume",
      },
      proxyCaCertMount(params.caCertPath),
    ],
    labels: {
      [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
      [NAS_KIND_LABEL]: NAS_KIND_REGISTRY_MIRROR,
    },
  };
}
```

- [ ] **Step 6: Implement readiness through injected primitives**

Add to `registry_mirror.ts`:

```typescript
export interface RegistryMirrorDeps {
  readonly volumeCreate: (
    name: string,
    labels: Record<string, string>,
  ) => Promise<void>;
  readonly runDetached: (opts: DockerRunDetachedOptions) => Promise<void>;
  readonly isRunning: (name: string) => Promise<boolean>;
  readonly containerIpOnNetwork: (
    container: string,
    network: string,
  ) => Promise<string | null>;
  readonly logs: (name: string) => Promise<string>;
  readonly canConnectTcp: (host: string, port: number) => Promise<boolean>;
  readonly sleep: (ms: number) => Promise<void>;
}

const liveRegistryMirrorDeps: RegistryMirrorDeps = {
  volumeCreate: (name, labels) => dockerVolumeCreate(name, labels),
  runDetached: dockerRunDetached,
  isRunning: dockerIsRunning,
  containerIpOnNetwork: dockerContainerIpOnNetwork,
  logs: (name) => dockerLogs(name, { tail: 50 }),
  canConnectTcp: (host, port) =>
    new Promise((resolve) => {
      const socket = createConnection({ host, port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => {
        socket.destroy();
        resolve(false);
      });
    }),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export async function startRegistryMirror(
  params: RegistryMirrorStartParams,
  deps: RegistryMirrorDeps = liveRegistryMirrorDeps,
): Promise<void> {
  await deps.volumeCreate(params.cacheVolumeName, {
    [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
    [NAS_KIND_LABEL]: NAS_KIND_REGISTRY_CACHE,
  });
  await deps.runDetached(buildRegistryMirrorRunOptions(params));

  const started = Date.now();
  let ip: string | null = null;
  while (Date.now() - started < params.readinessTimeoutMs) {
    if (!(await deps.isRunning(params.containerName))) {
      const logs = await deps.logs(params.containerName);
      throw new Error(`Registry mirror exited before readiness:\n${logs}`);
    }
    ip ??= await deps.containerIpOnNetwork(
      params.containerName,
      params.networkName,
    );
    if (ip && (await deps.canConnectTcp(ip, REGISTRY_MIRROR_PORT))) return;
    await deps.sleep(200);
  }
  const logs = await deps.logs(params.containerName);
  throw new Error(`Registry mirror readiness timed out:\n${logs}`);
}
```

Do not catch or log the `runDetached` error here; Docker's formatted command can
contain the token-bearing proxy environment. Task 4 catches it and emits a
constant warning with no error interpolation.

- [ ] **Step 7: Verify and commit**

Run:

```bash
bun test src/docker/registry_mirror_test.ts src/stages/dind/stage_test.ts
bun run check
```

Expected: PASS.

Commit:

```bash
git add src/docker/proxy_ca_mount.ts src/docker/registry_mirror.ts src/docker/registry_mirror_test.ts src/docker/dind.ts src/stages/dind/stage_test.ts
git commit -m "$(cat <<'EOF'
feat(dind): define a session-confined Docker Hub mirror

A global mirror cannot select the proxy token and policy belonging to the
session that caused a cache miss. The mirror plan therefore carries one
session network and proxy endpoint, while only its anonymous registry storage
is shareable.

The CA helper accepts a certificate file rather than a directory because the
sibling mitmproxy files contain the private key. Readiness uses injectable
primitives so its branching remains unit-testable without Docker.
EOF
)"
```

---

### Task 3: Replace the shared daemon directory with session data volumes

This is the core lock fix. It removes every attachment to `nas-docker-cache`,
makes the session data volume mandatory, and resets only that volume after a
failed dockerd start.

**Files:**
- Modify: `src/docker/dind.ts`
- Modify: `src/docker/dind_test.ts`
- Modify: `src/stages/dind/dind_service.ts`
- Modify: `src/stages/dind/stage.ts`
- Modify: `src/stages/dind/stage_test.ts`
- Modify: `src/stages/dind/integration_test.ts` (mechanical names and cleanup; do not run this file yet)

**Interfaces:**
- Removes: `DIND_CACHE_VOLUME` and `DindStageOptions.disableCache`.
- Produces: `DindPlan.dindDataVolume`, `DindSidecarOpts.dindDataVolume`, `EnsureDindSidecarParams.dindDataVolume`, and `TeardownDindSidecarParams.dindDataVolume`.
- Produces: `StartDindSidecarParams` object form and injectable `StartDindSidecarDeps`.
- Produces: injectable `EnsureDindSidecarDeps` for acquisition, rollback, and network wiring branches.
- Changes: `buildDindSidecarArgs(dindDataVolume, sharedTmpVolume, extraHosts)` always emits both volume mounts.

- [ ] **Step 1: Write planner and argument tests for the mandatory data volume**

In `src/stages/dind/stage_test.ts`, extend the session-name test:

```typescript
expect(p.dindDataVolume).toEqual(
  "nas-dind-data-abcdef12-3456-7890-abcd-ef1234567890",
);
```

Replace the two cache argument tests with:

```typescript
test("buildDindSidecarArgs: always mounts session data and shared tmp", () => {
  expect(
    buildDindSidecarArgs(
      "nas-dind-data-session-a",
      "nas-dind-tmp-session-a",
      [],
    ),
  ).toEqual([
    "--privileged",
    "-v",
    "nas-dind-data-session-a:/home/rootless/.local/share/docker",
    "-v",
    "nas-dind-tmp-session-a:/tmp/nas-shared",
  ]);
});
```

Update the extra-host test to pass both volume names before the host array.

- [ ] **Step 2: Write startup reset and teardown tests**

In `src/docker/dind_test.ts`, import `startDindSidecar` and add:

```typescript
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
```

Extend `teardownParams()` with `dindDataVolume`. Strengthen the joiner-gone
test:

```typescript
expect(calls).toEqual([
  "stop:nas-dind-abc12345",
  "rm:nas-dind-abc12345",
  "volume:nas-dind-tmp-abc12345",
  "volume:nas-dind-data-abc12345",
]);
```

Also add the acquisition rollback regression with injected dependencies:

```typescript
test("ensureDindSidecar: failed acquisition removes only session resources", async () => {
  const calls: string[] = [];
  const params: EnsureDindSidecarParams = {
    containerName: "nas-dind-session-a",
    dindDataVolume: "nas-dind-data-session-a",
    sharedTmpVolume: "nas-dind-tmp-session-a",
    sessionNetworkName: "nas-session-net-session-a",
    proxyEndpoint: "http://session-a:token@nas-proxy:8080",
    caCertPath: "/run/nas/mitmproxy-ca/mitmproxy-ca-cert.pem",
    extraHosts: [],
    readinessTimeoutMs: 5_000,
  };
  const deps: EnsureDindSidecarDeps = {
    volumeCreate: async (name) => {
      calls.push(`volume-create:${name}`);
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
  };

  await expect(ensureDindSidecar(params, deps)).rejects.toThrow("startup failed");
  expect(calls).toContain("volume-rm:nas-dind-tmp-session-a");
  expect(calls).toContain("volume-rm:nas-dind-data-session-a");
  expect(calls.some((call) => call.includes("nas-registry-cache"))).toBe(false);
});
```

Import `EnsureDindSidecarDeps`, `EnsureDindSidecarParams`, and
`ensureDindSidecar` in this test file.

- [ ] **Step 3: Run the unit tests and verify they fail**

Run:

```bash
bun test src/docker/dind_test.ts src/stages/dind/stage_test.ts
```

Expected: FAIL because the data-volume fields and object-form startup API do
not exist.

- [ ] **Step 4: Change the planner and service contracts**

In `src/stages/dind/stage.ts`, add `dindDataVolume` beside
`sharedTmpVolume`, derive it without truncating the session ID, and include it
in the plan:

```typescript
const dindDataVolume = `nas-dind-data-${input.sessionId}`;
```

Remove `disableCache` from `DindPlan`, `DindStagePlanOptions`, and every call.
Add `dindDataVolume` to `DindSidecarOpts` and `DindTeardownOpts` in
`dind_service.ts`; forward it to both runtime functions. The stage runner must
pass the same field on acquire and release.

- [ ] **Step 5: Make the sidecar mount its own daemon data**

In `src/docker/dind.ts`, delete `DIND_CACHE_VOLUME` and change the builder to:

```typescript
export function buildDindSidecarArgs(
  dindDataVolume: string,
  sharedTmpVolume: string,
  extraHosts: readonly { readonly host: string; readonly ip: string }[],
): string[] {
  const args = [
    "--privileged",
    "-v",
    `${dindDataVolume}:${DIND_DATA_DIR}`,
    "-v",
    `${sharedTmpVolume}:${SHARED_TMP_MOUNT_PATH}`,
  ];
  for (const entry of extraHosts) {
    args.push(`--add-host=${entry.host}:${entry.ip}`);
  }
  return args;
}
```

Change `runDindSidecar` to accept the data volume and call this signature.
There is no branch that omits it.

- [ ] **Step 6: Replace the misleading cache retry with a scoped data reset**

Introduce these types above `startDindSidecar`:

```typescript
export interface StartDindSidecarParams {
  readonly containerName: string;
  readonly dindDataVolume: string;
  readonly sharedTmpVolume: string;
  readonly proxy: { readonly proxyEndpoint: string; readonly caCertPath: string };
  readonly extraHosts: readonly { readonly host: string; readonly ip: string }[];
  readonly readinessTimeoutMs: number;
}

export interface StartDindSidecarDeps {
  readonly runSidecar: (params: StartDindSidecarParams) => Promise<void>;
  readonly waitReady: (containerName: string, timeoutMs: number) => Promise<void>;
  readonly stop: (name: string) => Promise<void>;
  readonly rm: (name: string) => Promise<void>;
  readonly volumeRemove: (name: string) => Promise<void>;
  readonly volumeCreate: (name: string, labels: Record<string, string>) => Promise<void>;
}
```

Provide live defaults using `runDindSidecar`, `waitForDindReady`, and the
existing Docker client helpers. Implement exactly one retry:

```typescript
export async function startDindSidecar(
  params: StartDindSidecarParams,
  deps: StartDindSidecarDeps = liveStartDindSidecarDeps,
): Promise<void> {
  await deps.runSidecar(params);
  try {
    await deps.waitReady(params.containerName, params.readinessTimeoutMs);
    return;
  } catch (firstError) {
    logWarn("[nas] DinD: startup failed; resetting this session's data volume and retrying...");
    await deps.stop(params.containerName).catch(() => {});
    await deps.rm(params.containerName).catch(() => {});
    await deps.volumeRemove(params.dindDataVolume);
    await deps.volumeCreate(params.dindDataVolume, {
      [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
      [NAS_KIND_LABEL]: NAS_KIND_DIND_DATA,
    });
    await deps.runSidecar(params);
    try {
      await deps.waitReady(params.containerName, params.readinessTimeoutMs);
    } catch (secondError) {
      throw new Error(
        `DinD failed after resetting session data: ${
          secondError instanceof Error ? secondError.message : String(secondError)
        }`,
        { cause: firstError },
      );
    }
  }
}
```

Do not catch `volumeRemove`: a failed removal means the next attempt is not
fresh and must not run.

- [ ] **Step 7: Create and roll back both session volumes during acquisition**

Add `dindDataVolume` to `EnsureDindSidecarParams`. Before starting DinD,
explicitly create the tmp and data volumes with labels. Use this helper so the
thrown message names the failing category:

```typescript
async function createSessionVolume(
  kindLabel: "shared tmp volume" | "DinD data volume",
  name: string,
  nasKind: string,
  deps: EnsureDindSidecarDeps,
): Promise<void> {
  try {
    await deps.volumeCreate(name, {
      [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
      [NAS_KIND_LABEL]: nasKind,
    });
  } catch (error) {
    throw new Error(
      `Failed to create ${kindLabel} ${name}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
```

Call it with `("shared tmp volume", sharedTmpVolume, NAS_KIND_DIND_TMP)` and
`("DinD data volume", dindDataVolume, NAS_KIND_DIND_DATA)` in that order.

Make the composed acquisition fakeable with this dependency surface:

```typescript
export interface EnsureDindSidecarDeps {
  readonly volumeCreate: (
    name: string,
    labels: Record<string, string>,
  ) => Promise<void>;
  readonly startDind: (params: StartDindSidecarParams) => Promise<void>;
  readonly ensureSharedTmpWritable: (containerName: string) => Promise<void>;
  readonly networkConnect: (
    networkName: string,
    containerName: string,
  ) => Promise<void>;
  readonly networkDisconnect: (
    networkName: string,
    containerName: string,
  ) => Promise<void>;
  readonly stop: (containerName: string) => Promise<void>;
  readonly rm: (containerName: string) => Promise<void>;
  readonly volumeRemove: (name: string) => Promise<void>;
}
```

`ensureDindSidecar(params, deps = liveEnsureDindSidecarDeps)` calls only these
intentful dependencies. The live object delegates one-for-one to the existing
Docker helpers and `startDindSidecar`; tests supply in-memory functions.

Wrap acquisition so every failure stops/removes the partial DinD container and
removes both session volumes before rethrowing. Keep bridge-disconnect failure
fatal. Do not remove any registry cache volume in this path.

Extend `TeardownDindSidecarParams` and its implementation so the joiner-running
branch still performs no action, while the normal branch removes tmp first and
data second after removing the DinD container.

- [ ] **Step 8: Update integration resource names and cleanup without running Docker**

In `src/stages/dind/integration_test.ts`:

- update every `buildDindSidecarArgs` call to pass a unique data volume and tmp
  volume;
- remove every `{ disableCache: true }` option;
- extend `forceCleanup` to accept and remove the data volume;
- make every `finally` remove both `plan.dindDataVolume` and
  `plan.sharedTmpVolume`;
- keep all generated test resource names unique.

The helper shape becomes:

```typescript
async function forceCleanup(
  containerName: string,
  networkName: string,
  sharedTmpVolume: string,
  dindDataVolume: string,
): Promise<void> {
  await dockerStop(containerName, { timeoutSeconds: 0 }).catch(() => {});
  await dockerRm(containerName).catch(() => {});
  await dockerNetworkRemove(networkName).catch(() => {});
  await dockerVolumeRemove(sharedTmpVolume).catch(() => {});
  await dockerVolumeRemove(dindDataVolume).catch(() => {});
}
```

- [ ] **Step 9: Verify unit behavior and commit**

Run:

```bash
bun test src/docker/dind_test.ts src/stages/dind/stage_test.ts
bun run test:unit
bun run check
```

Expected: PASS. Do not run `integration_test.ts` separately.

Commit:

```bash
git add src/docker/dind.ts src/docker/dind_test.ts src/stages/dind/dind_service.ts src/stages/dind/stage.ts src/stages/dind/stage_test.ts src/stages/dind/integration_test.ts
git commit -m "$(cat <<'EOF'
fix(dind): isolate each daemon's mutable data

The old cache volume was Docker's entire rootless data directory, including
containerd's bbolt metadata. Two live sidecars therefore opened one writable
database and the second timed out waiting for the first process's lock.

Every session now owns its data volume, and recovery can replace only that
session's state. The volume remains mandatory because omitting it would put an
inner overlayfs upper/work tree in the outer container overlay.
EOF
)"
```

---

### Task 4: Couple mirror and DinD lifecycles with direct-pull fallback

Wire the component from Task 2 into the session resource acquired by
`DindService`. Mirror failure is non-fatal; DinD and session-data failure remain
fatal.

**Files:**
- Modify: `src/docker/dind.ts`
- Modify: `src/docker/dind_test.ts`
- Modify: `src/stages/dind/dind_service.ts`
- Modify: `src/stages/dind/stage.ts`
- Modify: `src/stages/dind/stage_test.ts`
- Modify: `src/stages/dind/integration_test.ts` (set test-only mirror options; do not run yet)

**Interfaces:**
- Produces: `DindStagePlanOptions.disablePullCache?: boolean` and `registryCacheVolume?: string`.
- Produces: `DindPlan.registryMirrorName`, `registryCacheVolume`, and `disablePullCache`.
- Produces: `buildDindDaemonArgs(registryMirrorName: string | null): string[]`.
- Produces: `DindSidecarHandle { registryMirrorName: string | null }` in `src/docker/dind.ts`; the handle records whether the optional mirror actually started and is imported by `dind_service.ts`.
- Extends: acquire options with mirror name and cache volume; teardown receives the handle's nullable mirror name. The persistent cache volume is never a teardown field.

- [ ] **Step 1: Write planner and dockerd-argument tests**

In `src/stages/dind/stage_test.ts`, extend the session-name test:

```typescript
expect(p.registryMirrorName).toEqual(
  "nas-registry-mirror-abcdef12-3456-7890-abcd-ef1234567890",
);
expect(p.registryCacheVolume).toBe("nas-registry-cache");
expect(p.disablePullCache).toBe(false);
```

Add:

```typescript
test("buildDindDaemonArgs: points only at the session mirror", () => {
  expect(buildDindDaemonArgs("nas-registry-mirror-session-a")).toEqual([
    "--registry-mirror=http://nas-registry-mirror-session-a:5000",
    "--insecure-registry=nas-registry-mirror-session-a:5000",
  ]);
});

test("buildDindDaemonArgs: direct fallback has no mirror flags", () => {
  expect(buildDindDaemonArgs(null)).toEqual([]);
});
```

Import `buildDindDaemonArgs` from `stage.ts`'s re-export or directly from
`../../docker/dind.ts`, matching the file's existing helper convention.

- [ ] **Step 2: Write lifecycle tests for success, fallback, and preservation**

In `src/docker/dind_test.ts`, import `EnsureDindSidecarDeps`,
`EnsureDindSidecarParams`, `StartDindSidecarParams`, and
`ensureDindSidecar`. Add these complete fixtures:

```typescript
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
```

Task 4 adds `startRegistryMirror` to the `EnsureDindSidecarDeps` interface from
Task 3. Then add three tests:

```typescript
test("ensureDindSidecar: starts mirror before dind and passes its name", async () => {
  const calls: string[] = [];
  const starts: Array<string | null> = [];
  const handle = await ensureDindSidecar(ensureParams(), makeEnsureDeps({
    startRegistryMirror: async () => {
      calls.push("mirror");
    },
    startDind: async (params) => {
      calls.push("dind");
      starts.push(params.registryMirrorName);
    },
  }));

  expect(calls.slice(0, 2)).toEqual(["mirror", "dind"]);
  expect(starts).toEqual(["nas-registry-mirror-abc12345"]);
  expect(handle.registryMirrorName).toBe("nas-registry-mirror-abc12345");
});

test("ensureDindSidecar: mirror failure falls back to direct pulls", async () => {
  const starts: Array<string | null> = [];
  const handle = await ensureDindSidecar(ensureParams(), makeEnsureDeps({
    startRegistryMirror: async () => {
      throw new Error("docker run -e HTTP_PROXY=http://sid:secret@nas-proxy");
    },
    startDind: async (params) => {
      starts.push(params.registryMirrorName);
    },
  }));

  expect(starts).toEqual([null]);
  expect(handle.registryMirrorName).toBeNull();
});

test("teardownDindSidecar: removes dind, mirror, and session volumes but not registry cache", async () => {
  const calls: string[] = [];
  await teardownDindSidecar(teardownParams(), {
    isRunning: async () => false,
    stop: async (name) => {
      calls.push(`stop:${name}`);
    },
    rm: async (name) => {
      calls.push(`rm:${name}`);
    },
    volumeRemove: async (name) => {
      calls.push(`volume:${name}`);
    },
  });

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
```

The existing joiner-running teardown test must still expect no calls after the
mirror field is added.

- [ ] **Step 3: Run the focused units and verify they fail**

Run:

```bash
bun test src/docker/dind_test.ts src/stages/dind/stage_test.ts
```

Expected: FAIL because the mirror plan fields, daemon-argument builder, and
combined lifecycle are absent.

- [ ] **Step 4: Add mirror decisions to the pure Dind plan**

In `src/stages/dind/stage.ts`, define:

```typescript
export interface DindStagePlanOptions {
  readonly disablePullCache?: boolean;
  readonly registryCacheVolume?: string;
  readonly readinessTimeoutMs?: number;
}
```

Derive and return:

```typescript
const registryMirrorName = `nas-registry-mirror-${input.sessionId}`;
const registryCacheVolume =
  options.registryCacheVolume ?? REGISTRY_CACHE_VOLUME;
const disablePullCache = options.disablePullCache ?? false;
```

Thread all three through `DindPlan`, `DindSidecarOpts`, and the acquire call.
The production default remains the fixed `nas-registry-cache`; only integration
tests override it with a unique name.

Change the service acquisition result from `void` to the actual optional
resource handle:

```typescript
export interface DindSidecarHandle {
  readonly registryMirrorName: string | null;
}

// DindService tag member
readonly ensureSidecar: (
  opts: DindSidecarOpts,
) => Effect.Effect<DindSidecarHandle>;
```

`DindTeardownOpts.registryMirrorName` is `string | null` and comes from this
handle, not from the pure plan. Update `makeDindServiceFake` so its default
acquire succeeds with `{ registryMirrorName: null }`. In `stage_test.ts`, the
fake used by the acquire/release test returns the planned mirror explicitly:

```typescript
ensureSidecar: (opts) => {
  ensureCalls.push(opts);
  return Effect.succeed({ registryMirrorName: opts.registryMirrorName });
},
```

- [ ] **Step 5: Add mirror flags to dockerd, not Docker run**

In `src/docker/dind.ts`, import `registryMirrorUrl` and add:

```typescript
export function buildDindDaemonArgs(
  registryMirrorName: string | null,
): string[] {
  if (registryMirrorName === null) return [];
  const url = registryMirrorUrl(registryMirrorName);
  return [
    `--registry-mirror=${url}`,
    `--insecure-registry=${registryMirrorName}:5000`,
  ];
}
```

Add `registryMirrorName: string | null` to `StartDindSidecarParams` and pass
`command: buildDindDaemonArgs(params.registryMirrorName)` to
`dockerRunDetached`. These are arguments to the `docker:dind-rootless`
entrypoint, which prepends `dockerd`; do not put them in `args`, where Docker
would parse them as outer `docker run` flags.

- [ ] **Step 6: Start the mirror best-effort inside DinD acquisition**

Extend `EnsureDindSidecarParams` with:

```typescript
readonly registryMirrorName: string;
readonly registryCacheVolume: string;
readonly disablePullCache: boolean;
```

Extend the injected dependencies with:

```typescript
readonly startRegistryMirror: typeof startRegistryMirror;
```

After creating session volumes and before starting DinD:

```typescript
let activeRegistryMirrorName: string | null = null;
if (!disablePullCache) {
  try {
    await deps.startRegistryMirror({
      containerName: registryMirrorName,
      cacheVolumeName: registryCacheVolume,
      networkName: sessionNetworkName,
      proxyEndpoint,
      caCertPath,
      readinessTimeoutMs,
    });
    activeRegistryMirrorName = registryMirrorName;
  } catch {
    logWarn(
      "[nas] DinD: registry pull cache unavailable; continuing with direct Docker Hub pulls",
    );
    await deps.stop(registryMirrorName).catch(() => {});
    await deps.rm(registryMirrorName).catch(() => {});
  }
}

await deps.startDind({
  containerName,
  dindDataVolume,
  sharedTmpVolume,
  proxy: { proxyEndpoint, caCertPath },
  extraHosts,
  readinessTimeoutMs,
  registryMirrorName: activeRegistryMirrorName,
});

return { registryMirrorName: activeRegistryMirrorName };
```

The constant warning is intentional: the caught Docker error can contain the
proxy token in its rendered `-e HTTP_PROXY=...` argument.

Change `ensureDindSidecar`'s return type to `Promise<DindSidecarHandle>`. On any
later acquisition failure, stop/remove both the DinD and mirror
containers, then remove tmp and data volumes. Never remove
`registryCacheVolume`.

- [ ] **Step 7: Keep the resource group together during teardown**

Extend `TeardownDindSidecarParams` with
`registryMirrorName: string | null`. After removing DinD and before removing
volumes, stop and remove the mirror only when that field is non-null, using the
existing best-effort warning pattern. The first joiner-running guard remains
before every cleanup action so an abnormal nas exit preserves the entire group.

Update `runDind` in `stage.ts` so the acquired handle drives release:

```typescript
yield* Effect.acquireRelease(
  dind.ensureSidecar({
    containerName: plan.containerName,
    dindDataVolume: plan.dindDataVolume,
    sharedTmpVolume: plan.sharedTmpVolume,
    registryMirrorName: plan.registryMirrorName,
    registryCacheVolume: plan.registryCacheVolume,
    networkName: plan.networkName,
    proxyEndpoint: plan.proxyEndpoint,
    caCertPath: plan.caCertPath,
    extraHosts: plan.extraHosts,
    disablePullCache: plan.disablePullCache,
    readinessTimeoutMs: plan.readinessTimeoutMs,
  }),
  (handle) =>
    dind.teardownSidecar({
      containerName: plan.containerName,
      dindDataVolume: plan.dindDataVolume,
      sharedTmpVolume: plan.sharedTmpVolume,
      registryMirrorName: handle.registryMirrorName,
      joinerContainerName: plan.joinerContainerName,
    }).pipe(Effect.ignoreLogged),
);
```

- [ ] **Step 8: Keep existing Docker integrations mirror-free**

In every existing `planDind` and `createDindStageWithOptions` call in
`src/stages/dind/integration_test.ts`, add:

```typescript
disablePullCache: true,
```

This keeps existing tests focused and prevents them from creating the
production cache name. Task 5 adds the one integration that intentionally
enables the mirror with a unique cache volume.

- [ ] **Step 9: Verify and commit**

Run:

```bash
bun test src/docker/dind_test.ts src/stages/dind/stage_test.ts src/docker/registry_mirror_test.ts
bun run test:unit
bun run check
```

Expected: PASS. Do not run the Docker integration file separately.

Commit:

```bash
git add src/docker/dind.ts src/docker/dind_test.ts src/stages/dind/dind_service.ts src/stages/dind/stage.ts src/stages/dind/stage_test.ts src/stages/dind/integration_test.ts
git commit -m "$(cat <<'EOF'
feat(dind): share Docker Hub pulls through session mirrors

Cache misses need the requesting session's proxy token and network policy, so
one global mirror process cannot safely own upstream traffic. Each DinD session
gets a companion mirror on its internal network while Distribution storage is
the only shared state.

The mirror is an optimization: startup failure selects dockerd's existing
direct proxied path, and runtime loss uses Docker's normal Hub fallback. Teardown
keeps the mirror with its namespace-owning DinD process when the agent outlives
nas, but never sweeps the persistent registry cache.
EOF
)"
```

---

### Task 5: Prove concurrent startup and cross-session pull reuse

Add one Docker integration covering the original failure and the new shared
cache. It uses unique resources and is executed only through the final full
suite, so one hostexec approval covers all Docker tests.

**Files:**
- Modify: `src/stages/dind/integration_test.ts`

**Interfaces:**
- Consumes: `DindStagePlanOptions.registryCacheVolume`,
  `DindPlan.dindDataVolume`, `DindPlan.registryMirrorName`, and the production
  combined lifecycle.
- Produces: no production interface.

- [ ] **Step 1: Add unique multi-session cleanup helpers**

Import `dockerInspectVolume` and `REGISTRY_MIRROR_IMAGE`. Add:

```typescript
async function volumeExists(name: string): Promise<boolean> {
  try {
    await dockerInspectVolume(name);
    return true;
  } catch {
    return false;
  }
}

async function cleanupDindPlan(plan: NonNullable<ReturnType<typeof planDind>>) {
  await dockerStop(plan.containerName, { timeoutSeconds: 0 }).catch(() => {});
  await dockerRm(plan.containerName).catch(() => {});
  await dockerStop(plan.registryMirrorName, { timeoutSeconds: 0 }).catch(() => {});
  await dockerRm(plan.registryMirrorName).catch(() => {});
  await dockerVolumeRemove(plan.sharedTmpVolume).catch(() => {});
  await dockerVolumeRemove(plan.dindDataVolume).catch(() => {});
}
```

Extend the existing capability setup so the test is skipped unless
`REGISTRY_MIRROR_IMAGE` and `INNER_IMAGE` are available on the outer Docker
daemon. Reuse `hostPull` once at module setup:

```typescript
const registryImageReady =
  dindAvailable && RUNNING_ON_HOST_DOCKER
    ? await hostPull(REGISTRY_MIRROR_IMAGE)
    : false;
```

- [ ] **Step 2: Add the concurrent/shared-cache integration test**

Append this test using the file's existing `waitForContainerTcp`, `waitForFile`,
`pullInSidecar`, `makeStageState`, and `makeSharedInput` helpers:

```typescript
test.skipIf(
  !dindAvailable || !RUNNING_ON_HOST_DOCKER || !innerImageReady || !registryImageReady,
)(
  "DindStage: concurrent daemons isolate state and reuse the shared registry cache",
  async () => {
    const id = crypto.randomUUID();
    const cacheVolume = `nas-test-registry-cache-${id}`;
    const proxyName = `nas-test-registry-proxy-${id}`;
    const proxyConfDir = await mkdtemp(path.join(tmpdir(), "nas-registry-cache-"));
    const profile = makeProfile({ docker: { enable: true, shared: false } });
    const plans: Array<NonNullable<ReturnType<typeof planDind>>> = [];
    const scopes: Scope.Closeable[] = [];

    try {
      await chmod(proxyConfDir, 0o777);
      await dockerRunDetached({
        name: proxyName,
        image: "mitmproxy/mitmproxy:11",
        args: [],
        envVars: {},
        mounts: [{ source: proxyConfDir, target: "/nas-ca", mode: "rw" }],
        command: [
          "mitmdump",
          "--mode",
          "regular@8080",
          "--set",
          "connection_strategy=lazy",
          "--set",
          "confdir=/nas-ca",
        ],
      });
      await waitForContainerTcp(proxyName, 8080);
      const caCertPath = path.join(proxyConfDir, "mitmproxy-ca-cert.pem");
      await waitForFile(caCertPath);

      for (const suffix of ["a", "b"]) {
        const sessionId = `cache-${suffix}-${id}`;
        const networkName = `nas-session-net-${sessionId}`;
        await dockerNetworkCreateInternal(networkName);
        await dockerNetworkConnect(networkName, proxyName);
        const sharedInput = makeSharedInput(profile, sessionId);
        const state = makeStageState({
          network: { networkName, runtimeDir: "/run/user/1000/nas/network" },
          proxy: {
            brokerSocket: `/tmp/${sessionId}.sock`,
            proxyEndpoint: `http://${proxyName}:8080`,
            caCertPath,
          },
        });
        const plan = planDind(
          { ...sharedInput, ...state },
          { registryCacheVolume: cacheVolume, readinessTimeoutMs: 60_000 },
        );
        expect(plan).not.toBeNull();
        plans.push(plan!);
        const scope = Effect.runSync(Scope.make());
        scopes.push(scope);
        const stage = createDindStageWithOptions(sharedInput, {
          registryCacheVolume: cacheVolume,
          readinessTimeoutMs: 60_000,
        });
        await Effect.runPromise(
          stage.run(state).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.provide(DindServiceLive),
          ),
        );
      }

      expect(plans[0]!.dindDataVolume).not.toBe(plans[1]!.dindDataVolume);
      expect(await dockerIsRunning(plans[0]!.containerName)).toBe(true);
      expect(await dockerIsRunning(plans[1]!.containerName)).toBe(true);

      const firstPull = await pullInSidecar(plans[0]!.containerName, INNER_IMAGE);
      expect(firstPull.exitCode, firstPull.output).toBe(0);

      await dockerStop(proxyName, { timeoutSeconds: 0 });
      const secondPull = await pullInSidecar(plans[1]!.containerName, INNER_IMAGE);
      expect(
        secondPull.exitCode,
        `second pull could not use shared cache with upstream disabled:\n${secondPull.output}`,
      ).toBe(0);

      for (const scope of scopes.splice(0).reverse()) {
        await Effect.runPromise(Scope.close(scope, Exit.void));
      }
      expect(await volumeExists(cacheVolume)).toBe(true);
      for (const plan of plans) {
        expect(await dockerIsRunning(plan.containerName)).toBe(false);
        expect(await dockerIsRunning(plan.registryMirrorName)).toBe(false);
        expect(await volumeExists(plan.dindDataVolume)).toBe(false);
      }
    } finally {
      for (const scope of scopes.splice(0).reverse()) {
        await Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => {});
      }
      for (const plan of plans) await cleanupDindPlan(plan);
      await dockerStop(proxyName, { timeoutSeconds: 0 }).catch(() => {});
      await dockerRm(proxyName).catch(() => {});
      for (const plan of plans) {
        await dockerNetworkRemove(plan.networkName).catch(() => {});
      }
      await dockerVolumeRemove(cacheVolume).catch(() => {});
      await rm(proxyConfDir, { recursive: true, force: true }).catch(() => {});
    }
  },
  180_000,
);
```

Before stopping the proxy, both DinD sidecars are live concurrently. This is
the regression for the bbolt contention. Stopping upstream after the first pull
makes the second pull's success evidence of shared registry data rather than
Docker's direct fallback.

- [ ] **Step 3: Run formatting, static checks, and the safe lane**

Run:

```bash
bun run fmt
bun run check
bun run test:unit
git diff --check
```

Expected: PASS. Inspect `git diff` to ensure the formatter did not touch
unrelated files.

- [ ] **Step 4: Run the full suite exactly once**

Run:

```bash
bun run test
```

Expected: PASS, including the new Docker integration when its capability gates
are available. If the new test is skipped, report the exact missing gate; do
not claim the concurrent/cache behavior was exercised.

- [ ] **Step 5: Commit the integration proof**

```bash
git add src/stages/dind/integration_test.ts
git commit -m "$(cat <<'EOF'
test(dind): prove concurrent startup and shared pull reuse

The failure required two live containerd processes, so single-sidecar tests
could never detect the shared bbolt lock. Two distinct session data volumes now
start together in the regression.

After one session fills the registry cache, the test disables upstream access
before the other pulls. Success therefore demonstrates cache reuse rather than
Docker silently falling back to another Hub request.
EOF
)"
```

- [ ] **Step 6: Final worktree audit**

Run:

```bash
git status --short
git log --oneline --decorate -6
```

Expected: clean worktree and five implementation commits after the design and
plan commits. Report unit/check/full-suite counts, any capability skips, and the
worktree path.
