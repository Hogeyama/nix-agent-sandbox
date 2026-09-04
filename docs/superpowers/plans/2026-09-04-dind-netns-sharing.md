# DinD Network Namespace Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the agent container join the DinD sidecar's network namespace so the Docker daemon answers on `127.0.0.1:2375` and containers the agent starts publish their ports on the agent's own loopback.

**Architecture:** `NetworkAttachment` becomes a discriminated union so `ContainerPlan` can express `--network container:<name>`. DindStage overrides the agent's attachment. Because container network mode rejects `--add-host`, the host mapping ProxyStage produces moves onto `ContainerPlan` as data and is expanded by whichever container owns the namespace. `nas container clean` learns to resolve namespace joiners to their owners before judging a sidecar unused, and `docker.shared` is retired.

**Tech Stack:** Bun, TypeScript (strict), Effect, Docker CLI, Pkl config schema.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-04-dind-netns-sharing-design.md`. Read it before Task 1.
- Read `.claude/skills/effect-separation/SKILL.md`. Stages orchestrate; they never call `docker.*`, `fs.*`, `proc.*` directly. New I/O goes behind a service method. Inside services, a function either calls one primitive (D1) or composes other effects (D2) — never both.
- Read `.claude/skills/test-policy/SKILL.md`. Unit tests are `*_test.ts` and must not reach a live Docker daemon. Integration tests end in `integration_test.ts`, guard with `test.skipIf`, and clean up in `finally`. Never create or delete fixed-name production resources; generate names.
- Read `.claude/skills/security-constraints/SKILL.md` before Task 4 and Task 10.
- `docs/architecture/data-flow.md` describes the process and store topology.
- Runtime is Bun with `bun:test`. There is no Deno API in this repository.
- While iterating, run single unit test files (`bun test <path>`) and `bun run check`. Run `bun run test` exactly once, at the end of Task 9. Do not run integration test files repeatedly — each distinct `bun test <args>` invocation is a separate hostexec capability and multiplies approval prompts.
- Commit message format follows the `git-commit` skill. One fix per commit.
- Each task adds imports for the symbols it introduces: `ExtraHost` from `../../pipeline/state.ts` in Tasks 2 and 4, `DIND_ROOTLESS_SOCKET_PATH` from `../../docker/dind.ts` in Task 6, `LOCAL_PROXY_PORT` from `../../network/ports.ts` in Task 7, `containerNameForSession` from `../../docker/nas_resources.ts` in Task 5. The compiler will say so, but do not go looking for a different symbol when it does.
- Do not commit `.nas/config.pkl` changes that are unrelated to this work

## Task Order

Tasks run in number order. Four dependencies are load-bearing:

- **1 → 2 → 4.** Task 4 overrides an attachment Task 1 defines and forwards a field Task 2 adds.
- **3 → 4.** `nas container clean` must recognize namespace joiners before the wiring creates any. Shipping these in the other order leaves a window in which cleaning removes the sidecars of live sessions, including the proxy every session shares.
- **4 → 6.** Task 6's snippet edits the `buildContainerState` body Task 4 rewrites, and Task 6 uses the `makeDindInput` helper Task 4 adds.
- **4 → 8.** Task 8 works by test name rather than line number precisely because Task 4 moves them.

Every task ends with the unit lane green. If you finish a task and `bun run check` or the tests it names are red, that task is not done — do not start the next one.

---

### Task 1: NetworkAttachment discriminated union

Makes `ContainerPlan` able to express container network mode. No behavior changes: ProxyStage still produces a network-mode attachment and LaunchStage still emits the same flags.

**Files:**
- Modify: `src/pipeline/state.ts:135-139`
- Modify: `src/stages/launch/stage.ts:99-104`
- Modify: `src/stages/proxy/stage.ts:568`
- Test: `src/stages/launch/stage_test.ts`
- Test (mechanical updates): `src/pipeline/types_test.ts:282`, `src/pipeline/container_plan_test.ts:124-133`, `src/stages/dind/stage_test.ts:274`, `:305`, `src/stages/launch/stage_test.ts:29`, `:67`, `:275`, `:285`, `:296`, `:327`, `src/stages/proxy/stage_test.ts:797-799`, `:880-882`

**Interfaces:**
- Produces: `type NetworkAttachment = { mode: "network"; name: string; alias?: string } | { mode: "container"; containerName: string }` exported from `src/pipeline/state.ts`. Tasks 2 and 4 consume it.

- [ ] **Step 1: Write the failing test**

Add to `src/stages/launch/stage_test.ts`:

```typescript
test("compileLaunchOpts: container network mode emits --network container:<name>", () => {
  const plan = makeBasePlan({
    network: { mode: "container", containerName: "nas-dind-abc12345" },
  });

  const opts = compileLaunchOpts(plan, "nas-agent-sess_abc12345");

  expect(opts.args).toContain("--network");
  expect(opts.args).toContain("container:nas-dind-abc12345");
  expect(opts.args).not.toContain("--network-alias");
});
```

`makeBasePlan` already exists in that file. If its `network` default is a bare `{ name }` literal, update it to `{ mode: "network", name: ... }` in this step.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/stages/launch/stage_test.ts`
Expected: FAIL — a type error on `mode`, or the assertion on `container:nas-dind-abc12345` not being present.

- [ ] **Step 3: Change the type**

In `src/pipeline/state.ts`, replace lines 135-139:

```typescript
/**
 * Container network attachment.
 *
 * `network` mode joins a named Docker network. `container` mode joins another
 * container's network namespace (`--network container:<name>`), which Docker
 * rejects in combination with `--add-host`, `--hostname` and
 * `--network-alias`; those flags belong to the container that owns the
 * namespace.
 */
export type NetworkAttachment =
  | { readonly mode: "network"; readonly name: string; readonly alias?: string }
  | { readonly mode: "container"; readonly containerName: string };
```

- [ ] **Step 4: Render the new mode**

In `src/stages/launch/stage.ts`, replace lines 99-104:

```typescript
  if (plan.network) {
    if (plan.network.mode === "container") {
      args.push("--network", `container:${plan.network.containerName}`);
    } else {
      args.push("--network", plan.network.name);
      if (plan.network.alias) {
        args.push("--network-alias", plan.network.alias);
      }
    }
  }
```

- [ ] **Step 5: Tag the producer**

In `src/stages/proxy/stage.ts:568`, change:

```typescript
    network: { name: config.sessionNetworkName },
```

to:

```typescript
    network: { mode: "network", name: config.sessionNetworkName },
```

- [ ] **Step 6: Fix every remaining construction site**

Run: `bun run check`

Every error is a `network: { name: ... }` literal that needs `mode: "network"` added. Work through the compiler output until it is clean. Do not widen the type or add optional fields to silence an error.

The `toEqual({ name: ... })` assertions at `src/stages/proxy/stage_test.ts:797-799` and `:880-882` do **not** appear in the compiler output — `toEqual` takes an unconstrained argument, so they fail at runtime instead. Add `mode: "network"` to both by hand.

- [ ] **Step 7: Run the affected unit tests**

Run: `bun test src/stages/launch/stage_test.ts src/pipeline/container_plan_test.ts src/pipeline/types_test.ts src/stages/proxy/stage_test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/pipeline/state.ts src/stages/launch/stage.ts src/stages/proxy/stage.ts src/pipeline/types_test.ts src/pipeline/container_plan_test.ts src/stages/dind/stage_test.ts src/stages/launch/stage_test.ts src/stages/proxy/stage_test.ts
git commit -F - <<'EOF'
refactor(pipeline): model container network mode in NetworkAttachment

Docker's container network mode is a different kind of attachment from a
named network, not a differently-named one: it rejects --network-alias,
--hostname and --add-host. Representing both as a bare {name, alias?} would
let the launch compiler emit a flag the mode refuses.

A discriminated union makes the compiler reject that combination instead,
which is why the `mode` discriminant is required rather than optional --
every construction site had to be visited, and the type now says which flags
are legal at each one.

No behavior changes: the only producer still builds a network-mode
attachment.
EOF
```

---

### Task 2: Extra hosts as container plan data

`--add-host` cannot ride on the joining container, so ProxyStage stops formatting the flag and records the mapping. LaunchStage expands it only in network mode. Behavior is unchanged for a session without DinD.

**Files:**
- Modify: `src/pipeline/state.ts` (add `ExtraHost`, add `ContainerPlan.extraHosts`)
- Modify: `src/pipeline/container_plan.ts:20-39`, `:46-59`, `:77-95`
- Modify: `src/stages/launch/stage.ts` (expand in network mode)
- Modify: `src/stages/proxy/stage.ts:502-514`
- Test: `src/stages/launch/stage_test.ts`, `src/pipeline/container_plan_test.ts`

**Interfaces:**
- Consumes: `NetworkAttachment` from Task 1.
- Produces: `interface ExtraHost { readonly host: string; readonly ip: string }` and `ContainerPlan.extraHosts: readonly ExtraHost[]` (required, not optional). Task 4 forwards `input.container.extraHosts` to the sidecar.

- [ ] **Step 1: Write the failing tests**

Add to `src/stages/launch/stage_test.ts`:

```typescript
test("compileLaunchOpts: network mode expands extraHosts into --add-host", () => {
  const plan = makeBasePlan({
    network: { mode: "network", name: "nas-session-net-abc12345" },
    extraHosts: [{ host: "nas-envoy", ip: "172.20.0.2" }],
  });

  const opts = compileLaunchOpts(plan, "nas-agent-sess_abc12345");

  expect(opts.args).toContain("--add-host=nas-envoy:172.20.0.2");
});

test("compileLaunchOpts: container mode does not expand extraHosts", () => {
  const plan = makeBasePlan({
    network: { mode: "container", containerName: "nas-dind-abc12345" },
    extraHosts: [{ host: "nas-envoy", ip: "172.20.0.2" }],
  });

  const opts = compileLaunchOpts(plan, "nas-agent-sess_abc12345");

  expect(opts.args.some((a) => a.startsWith("--add-host="))).toBe(false);
});
```

Add to `src/pipeline/container_plan_test.ts`:

```typescript
test("mergeContainerPlan: extraHosts append", () => {
  const base = makeBasePlan({ extraHosts: [{ host: "a", ip: "1.1.1.1" }] });
  const result = mergeContainerPlan(base, {
    extraHosts: [{ host: "b", ip: "2.2.2.2" }],
  });
  expect(result.extraHosts).toEqual([
    { host: "a", ip: "1.1.1.1" },
    { host: "b", ip: "2.2.2.2" },
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/stages/launch/stage_test.ts src/pipeline/container_plan_test.ts`
Expected: FAIL — `extraHosts` does not exist on `ContainerPlan`.

- [ ] **Step 3: Add the type**

In `src/pipeline/state.ts`, above `ContainerPlan`:

```typescript
/** A host-to-IP mapping the launched container needs in /etc/hosts. */
export interface ExtraHost {
  readonly host: string;
  readonly ip: string;
}
```

Add to `ContainerPlan` (after `network`):

```typescript
  readonly extraHosts: readonly ExtraHost[];
```

- [ ] **Step 4: Wire the merge**

In `src/pipeline/container_plan.ts`, add to `ContainerPatch` after `network`:

```typescript
  readonly extraHosts?: readonly ExtraHost[];
```

Update the merge-semantics comment at `:22-25` so `extraHosts` is listed with the appending fields. Add to `emptyContainerPlan`:

```typescript
    extraHosts: [],
```

Add to `mergeContainerPlan`, after the `network` line:

```typescript
    extraHosts:
      patch.extraHosts !== undefined
        ? [...base.extraHosts, ...patch.extraHosts]
        : base.extraHosts,
```

- [ ] **Step 5: Expand in the launch compiler**

In `src/stages/launch/stage.ts`, inside the `mode === "network"` branch added in Task 1, after the alias push:

```typescript
      for (const entry of plan.extraHosts) {
        args.push(`--add-host=${entry.host}:${entry.ip}`);
      }
```

Placing the loop inside the network branch is what keeps container mode from emitting a flag Docker rejects.

- [ ] **Step 6: Record instead of formatting in ProxyStage**

In `src/stages/proxy/stage.ts`, replace lines 502-514:

```typescript
    // 10. Record the proxy alias as a host mapping rather than formatting a
    //     --add-host flag here. Docker's embedded DNS returns SERVFAIL for
    //     internal networks on some Debian hosts, so the mapping is needed;
    //     but the agent may be launched in container network mode, which
    //     rejects the flag. Whichever container owns the network namespace
    //     expands this.
    const overrides = { ...plan.outputOverrides };
    if (proxyIp && overrides.container) {
      overrides.container = {
        ...overrides.container,
        extraHosts: [
          ...overrides.container.extraHosts,
          { host: PROXY_ALIAS, ip: proxyIp },
        ],
      };
    }
```

- [ ] **Step 7: Fix remaining construction sites**

Run: `bun run check`

Add `extraHosts: []` to every `ContainerPlan` literal the compiler flags: `src/pipeline/types_test.ts:259`, `:274`, `src/stages/launch/stage_test.ts:309`, `src/stages/observability/integration_test.ts:222`, and any others reported.

- [ ] **Step 8: Run the affected unit tests**

Run: `bun test src/stages/launch/stage_test.ts src/pipeline/container_plan_test.ts src/stages/proxy/stage_test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/pipeline/state.ts src/pipeline/container_plan.ts src/stages/launch/stage.ts src/stages/proxy/stage.ts src/pipeline/types_test.ts src/pipeline/container_plan_test.ts src/stages/launch/stage_test.ts src/stages/observability/integration_test.ts
git commit -F - <<'EOF'
refactor(pipeline): carry host mappings as data on the container plan

The proxy alias has to reach the container's /etc/hosts because Docker's
embedded DNS returns SERVFAIL for internal networks on some Debian hosts.
ProxyStage formatted that as a --add-host flag, which only works while the
agent owns its own network namespace.

Recording {host, ip} on ContainerPlan instead lets the flag be emitted by
whichever container owns the namespace. ContainerPlan is the right home
rather than ProxyState: the launch compiler takes only a ContainerPlan and
LaunchStage declares no proxy dependency, so putting it on ProxyState would
have widened LaunchStage's slice requirements to carry data describing the
container it launches.
EOF
```

---

### Task 3: Teach container clean about namespace joiners

Must land before Task 4. `isUnusedNasSidecar` judges a sidecar unused when no running non-sidecar container is a member of its networks. A container in `--network container:` mode is a member of no network, so once Task 4 flips the wiring, `nas container clean` would remove live sessions' sidecars — including `nas-proxy-shared`, which every session shares.

**Files:**
- Modify: `src/docker/client.ts:61-67`, `:532-538`
- Modify: `src/container_clean.ts:48-50`, `:89-117`
- Test: `src/container_clean_test.ts`

**Interfaces:**
- Produces: `DockerContainerDetails` gains `id: string` and `networkMode: string`. Task 5 does not use them; nothing else consumes this task.

- [ ] **Step 1: Write the failing tests**

In `src/container_clean_test.ts`, the helpers are
`createManagedContainer(name, kind, options)` (`:241`, options being
`{ running?, networks? }`) and `createManagedNetwork(name, kind, containers)`
(`:258`). Widen the container helper's options to carry the two new fields:

```typescript
function createManagedContainer(
  name: string,
  kind: string,
  options: {
    running?: boolean;
    networks?: string[];
    id?: string;
    networkMode?: string;
  } = {},
): DockerContainerDetails {
  return {
    name,
    id: options.id ?? `id-${name}`,
    running: options.running ?? true,
    labels: {
      [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
      [NAS_KIND_LABEL]: kind,
    },
    networks: [...(options.networks ?? [])],
    networkMode: options.networkMode ?? "bridge",
    startedAt: "2026-01-01T00:00:00Z",
  };
}
```

Then add three cases:

```typescript
test("isUnusedNasSidecar: a namespace joiner keeps its owner alive", () => {
  const dind = createManagedContainer("nas-dind-abc12345", "dind", {
    id: "dindid",
    networks: ["nas-session-net-abc12345"],
  });
  const agent = createManagedContainer("nas-agent-sess_abc12345", "agent", {
    id: "agentid",
    networks: [],
    networkMode: "container:dindid",
  });
  const containers = new Map([
    [dind.name, dind],
    [agent.name, agent],
  ]);
  const networks = new Map([
    [
      "nas-session-net-abc12345",
      createManagedNetwork("nas-session-net-abc12345", NAS_KIND_SESSION_NETWORK, [dind.name]),
    ],
  ]);

  expect(isUnusedNasSidecar(dind, containers, networks)).toBe(false);
});

test("isUnusedNasSidecar: a namespace joiner keeps the shared proxy alive", () => {
  const dind = createManagedContainer("nas-dind-abc12345", "dind", {
    id: "dindid",
    networks: ["nas-session-net-abc12345"],
  });
  const proxy = createManagedContainer("nas-proxy-shared", "proxy", {
    id: "proxyid",
    networks: ["nas-session-net-abc12345"],
  });
  const agent = createManagedContainer("nas-agent-sess_abc12345", "agent", {
    id: "agentid",
    networks: [],
    networkMode: "container:dindid",
  });
  const containers = new Map([
    [dind.name, dind],
    [proxy.name, proxy],
    [agent.name, agent],
  ]);
  const networks = new Map([
    [
      "nas-session-net-abc12345",
      createManagedNetwork("nas-session-net-abc12345", NAS_KIND_SESSION_NETWORK, [
        dind.name,
        proxy.name,
      ]),
    ],
  ]);

  expect(isUnusedNasSidecar(proxy, containers, networks)).toBe(false);
});

test("isUnusedNasSidecar: an orphan with no joiner is still unused", () => {
  const dind = createManagedContainer("nas-dind-shared", "dind", {
    id: "orphanid",
    networks: ["nas-session-net-old"],
  });
  const containers = new Map([[dind.name, dind]]);
  const networks = new Map([
    [
      "nas-session-net-old",
      createManagedNetwork("nas-session-net-old", NAS_KIND_SESSION_NETWORK, [
        dind.name,
      ]),
    ],
  ]);

  expect(isUnusedNasSidecar(dind, containers, networks)).toBe(true);
});
```

`NAS_KIND_SESSION_NETWORK` is the constant the neighbouring tests use
(`src/container_clean_test.ts:321`, `:345`); a bare `"session"` string would
only pass through the legacy-name fallback in `isNasManagedNetwork`
(`src/docker/nas_resources.ts:41-53`) rather than through the label check, which
is not what these cases mean to exercise.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/container_clean_test.ts`
Expected: FAIL — `networkMode` is not a field, and the first two assertions return `true`.

- [ ] **Step 3: Widen the Docker details type**

In `src/docker/client.ts`, add to `DockerContainerDetails` (`:61-67`):

```typescript
  id: string;
  networkMode: string;
```

and to the object returned by the inspect helper (`:532-538`):

```typescript
    id: String(parsed.Id ?? ""),
    networkMode: String(parsed.HostConfig?.NetworkMode ?? ""),
```

Docker records the mode as `container:<64-hex id>`, never `container:<name>`, which is why the id is needed rather than the name.

- [ ] **Step 4: Resolve joiners to owners**

In `src/container_clean.ts`, replace `isUnusedNasSidecar` (`:89-117`):

```typescript
const CONTAINER_NETWORK_MODE_PREFIX = "container:";

export function isUnusedNasSidecar(
  container: DockerContainerDetails,
  containers: ReadonlyMap<string, DockerContainerDetails>,
  networks: ReadonlyMap<string, DockerNetworkDetails>,
): boolean {
  if (!container.running) {
    return true;
  }

  // A container in `--network container:<id>` mode is a member of no network,
  // so membership alone would report every sidecar of a live DinD session as
  // unused -- including the shared proxy, whose only other network members are
  // sidecars too. Resolve each joiner to its owner and credit it with the
  // owner's networks before judging membership.
  const byId = new Map<string, DockerContainerDetails>();
  for (const candidate of containers.values()) {
    if (candidate.id) byId.set(candidate.id, candidate);
  }

  const virtualMembers = new Map<string, DockerContainerDetails[]>();
  for (const candidate of containers.values()) {
    if (!candidate.running) continue;
    if (isNasManagedSidecar(candidate.labels, candidate.name)) continue;
    if (!candidate.networkMode.startsWith(CONTAINER_NETWORK_MODE_PREFIX)) {
      continue;
    }
    const ownerId = candidate.networkMode.slice(
      CONTAINER_NETWORK_MODE_PREFIX.length,
    );
    const owner = byId.get(ownerId);
    if (!owner) continue;
    for (const networkName of owner.networks) {
      const existing = virtualMembers.get(networkName);
      if (existing) existing.push(candidate);
      else virtualMembers.set(networkName, [candidate]);
    }
  }

  const relevantNetworks = container.networks.filter((networkName) => {
    const network = networks.get(networkName);
    return isNasManagedNetwork(network?.labels ?? {}, networkName);
  });

  for (const networkName of relevantNetworks) {
    if ((virtualMembers.get(networkName)?.length ?? 0) > 0) {
      return false;
    }
    const network = networks.get(networkName);
    if (!network) continue;
    for (const memberName of network.containers) {
      if (memberName === container.name) continue;
      const member = containers.get(memberName);
      if (!member) continue;
      if (member.running && !isNasManagedSidecar(member.labels, member.name)) {
        return false;
      }
    }
  }

  return true;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/container_clean_test.ts`
Expected: PASS, including the pre-existing tests in that file.

- [ ] **Step 6: Fix remaining fixtures**

Run: `bun run check`

`tsconfig.json` includes `src/**/*.ts`, so test files are type-checked too. Add `id` and `networkMode` to every `DockerContainerDetails` literal the compiler flags. Known sites: the fake `inspect` default (`src/services/docker.ts:442-449`), `src/container_clean_test.ts:62-75`, `:96-108`, `:132-144`, `:313-318`, `src/services/docker_test.ts:31`, `:52`, `src/domain/container/service_test.ts:42`, `:55`, `:117`, `:213`, `src/domain/container/lifecycle_service_test.ts:57`, `src/stages/proxy/proxy_service_test.ts:121`, `:211`, `:241`. Trust the compiler over this list.

- [ ] **Step 7: Commit**

Stage every file you touched — the list below is the known set, and `git status` is the authority if the compiler sent you elsewhere.

```bash
git add src/docker/client.ts src/container_clean.ts src/container_clean_test.ts src/services/docker.ts src/services/docker_test.ts src/domain/container/service_test.ts src/domain/container/lifecycle_service_test.ts src/stages/proxy/proxy_service_test.ts
git commit -F - <<'EOF'
fix(clean): count network-namespace joiners as users of their owner

`nas container clean` decides a sidecar is unused when no running,
non-sidecar container is a member of its networks. A container launched with
`--network container:<id>` is a member of no network at all, so a sidecar
whose only consumer joined its namespace reads as unused and gets removed
while the session is live.

The shared proxy is affected the same way and worse: it is attached to every
session network, so once the only other member is a sidecar, cleaning removes
it and every session loses egress.

Resolving joiners to their owners and crediting them with the owner's
networks covers both sidecars with one rule, rather than special-casing each
kind. Matching is by container id because Docker records the mode as
`container:<64-hex id>` and never as a name.
EOF
```

---

### Task 4: Join the sidecar's network namespace

The behavior change. After this task the agent reaches the daemon at `127.0.0.1:2375` and inner containers publish onto the agent's loopback.

**Files:**
- Modify: `src/stages/dind/stage.ts:7-19`, `:220-243`
- Modify: `src/stages/dind/dind_service.ts:16-26`, `:55-66`
- Modify: `src/docker/dind.ts:66-100`, `:110-160`, `:170-232`, `:478-492`
- Modify: `src/stages/proxy/stage.ts:167-168`
- Test: `src/stages/dind/stage_test.ts` — new cases plus these existing ones, which this task breaks:
  - `:172-189` asserts the full env map including `DOCKER_HOST`, `NAS_DIND_CONTAINER_NAME` and `no_proxy`
  - `:208-217`
  - `:220-248` verifies only the `no_proxy` append and is deleted
  - `:284-308` expects a pre-existing `network: { name: "stale-net" }` to survive; DindStage now overrides it
  - `:387-390`
  - `:410-424` calls `buildDindSidecarArgs` with `{ disableCache: true }` as the second argument and breaks on the new arity
- Modify: `src/stages/dind/integration_test.ts:401-417` — asserts `NAS_DIND_CONTAINER_NAME` is a string, `network` is undefined, and `DOCKER_HOST === tcp://<name>:2375`. Update the assertions here; do not run the file (Task 9 runs the suite once).

**Interfaces:**
- Consumes: `NetworkAttachment` (Task 1), `ContainerPlan.extraHosts` (Task 2).
- Produces: `DindSidecarOpts` gains `readonly extraHosts: readonly ExtraHost[]` (import the type from `../../pipeline/state.ts`). `buildDindSidecarArgs(sharedTmpVolume, extraHosts, options?)` — the new parameter is second. Task 8 does not touch this function again; its arity changes once, here.
- `src/docker/` currently imports nothing from `src/pipeline/`. To avoid opening that direction for a two-field type, `buildDindSidecarArgs` declares its parameter structurally as `readonly { readonly host: string; readonly ip: string }[]`, which accepts `readonly ExtraHost[]` without an import.

- [ ] **Step 1: Add a plan-input helper and write the failing tests**

`src/stages/dind/stage_test.ts` has `makeProfile` (`:44`), `makeConfig` (`:70`),
`makeSharedInput` (`:78`) and `makeStageState` (`:116`), but no single helper
that builds a `planDind` argument. Add one at the top of the file; Tasks 5, 6
and 7 use it.

```typescript
function makeDindInput(opts: { dockerEnable: boolean }) {
  const profile = makeProfile({
    docker: { enable: opts.dockerEnable, shared: false },
  });
  return { ...makeSharedInput(profile), ...makeStageState() };
}
```

Then the tests:

```typescript
test("planDind: agent joins the sidecar network namespace", () => {
  const plan = planDind(makeDindInput({ dockerEnable: true }));

  expect(plan?.outputOverrides.container?.network).toEqual({
    mode: "container",
    containerName: plan?.containerName,
  });
  expect(plan?.outputOverrides.container?.env.static.DOCKER_HOST).toBe(
    "tcp://127.0.0.1:2375",
  );
});

test("planDind: no_proxy is left as ProxyStage seeded it", () => {
  const plan = planDind(makeDindInput({ dockerEnable: true }));

  expect(plan?.outputOverrides.container?.env.static.no_proxy).toBeUndefined();
  expect(
    plan?.outputOverrides.container?.env.static.NAS_DIND_CONTAINER_NAME,
  ).toBeUndefined();
});

test("buildDindSidecarArgs: expands extraHosts", () => {
  const args = buildDindSidecarArgs("nas-dind-tmp-abc12345", [
    { host: "nas-envoy", ip: "172.20.0.2" },
  ]);

  expect(args).toContain("--add-host=nas-envoy:172.20.0.2");
});
```

The second test asserts absence: DindStage no longer writes `no_proxy` or
`NAS_DIND_CONTAINER_NAME`, so ProxyStage's baseline survives untouched.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/stages/dind/stage_test.ts`
Expected: FAIL — `network` is not in the overrides, `DOCKER_HOST` still names the sidecar, `buildDindSidecarArgs` takes two arguments.

- [ ] **Step 3: Override the attachment**

In `src/stages/dind/stage.ts`, replace `buildContainerState` (`:220-243`):

```typescript
function buildContainerState(
  input: DindStageInput,
  config: {
    readonly containerName: string;
    readonly sharedTmpVolume: string;
  },
): ContainerPlan {
  // The agent joins the sidecar's network namespace, so the daemon answers on
  // loopback and every port an inner container publishes lands on the agent's
  // own 127.0.0.1 -- what a locally installed Docker would do. `no_proxy`
  // needs no addition: ProxyStage's baseline already carries 127.0.0.1.
  return mergeContainerPlan(input.container, {
    network: { mode: "container", containerName: config.containerName },
    env: {
      static: {
        DOCKER_HOST: `tcp://127.0.0.1:${DIND_INTERNAL_PORT}`,
        NAS_DIND_SHARED_TMP: SHARED_TMP_MOUNT_PATH,
      },
    },
    extraRunArgs: ["-v", `${config.sharedTmpVolume}:${SHARED_TMP_MOUNT_PATH}`],
  });
}
```

- [ ] **Step 4: Rewrite the stale header comment**

In `src/stages/dind/stage.ts:7-19`, replace the numbered startup description so it states that the agent joins the sidecar's namespace and that DindStage now sets `container.network`. Delete the sentence saying DindStage does not set the network, and the shared-mode paragraph if Task 8 has not yet removed it (it stays accurate until then; leave the shared lines alone in this task).

In `src/stages/proxy/stage.ts:167-168`, replace the comment claiming DindStage appends DinD's hostname to `no_proxy` with one stating that the loopback baseline is all that is needed.

- [ ] **Step 5: Carry extraHosts to the sidecar**

The value travels along four hops. Change all of them, in this order:

1. `src/stages/dind/stage.ts` — add `extraHosts: input.container.extraHosts` to `DindPlan` and pass it into `dind.ensureSidecar(...)` in `runDind`.
2. `src/stages/dind/dind_service.ts` — add to `DindSidecarOpts` (`:16-26`), importing `ExtraHost` from `../../pipeline/state.ts`, and forward it in the `ensureDindSidecar` call at `:58-66`.
3. `src/docker/dind.ts` — add it to `EnsureDindSidecarParams` (`:170-185`) and pass it at the `startDindSidecar` call (`:227`).
4. `src/docker/dind.ts` — add `extraHosts` as the fourth positional parameter of `startDindSidecar` and `runDindSidecar`, then expand it in `buildDindSidecarArgs`.

```typescript
export function buildDindSidecarArgs(
  sharedTmpVolume: string,
  extraHosts: readonly { readonly host: string; readonly ip: string }[],
  options: DindStageOptions = {},
): string[] {
  const args = ["--privileged"];
  if (!options.disableCache) {
    args.push("-v", `${DIND_CACHE_VOLUME}:${DIND_DATA_DIR}`);
  }
  args.push("-v", `${sharedTmpVolume}:${SHARED_TMP_MOUNT_PATH}`);
  // The agent joins this container's network namespace and so cannot carry
  // --add-host itself; Docker shares the owner's /etc/hosts with the joiner.
  for (const entry of extraHosts) {
    args.push(`--add-host=${entry.host}:${entry.ip}`);
  }
  return args;
}
```

Add `extraHosts` as a new fourth positional parameter to both
`startDindSidecar(containerName, sharedTmpVolume, proxyEndpoint, extraHosts, options?)`
and `runDindSidecar(containerName, sharedTmpVolume, proxyEndpoint, extraHosts, options?)`,
immediately before `options`. All three `runDindSidecar` call sites
(`dind.ts:91`, `:118`, `:150`) must pass it, including both cache-reset retry
paths. The comment at `dind.ts:72-75` records the same trap for
`proxyEndpoint`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test src/stages/dind/stage_test.ts`
Expected: PASS

- [ ] **Step 7: Type check and fix fallout**

Run: `bun run check`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/stages/dind/stage.ts src/stages/dind/dind_service.ts src/docker/dind.ts src/stages/proxy/stage.ts src/stages/dind/stage_test.ts src/stages/dind/integration_test.ts
git commit -F - <<'EOF'
feat(dind): run the agent in the sidecar's network namespace

Reaching the daemon over tcp://<sidecar>:2375 puts it in a different network
namespace from the agent, so a container the agent starts publishes its ports
on the sidecar's interfaces. Tooling that assumes a locally installed Docker
-- Testcontainers most visibly -- then needs per-project reconfiguration or
does not work at all.

Joining the namespace makes the daemon answer on 127.0.0.1:2375 and puts
every published port on the agent's own loopback. Measured on Docker 29.6.1:
a joiner reaches the daemon on loopback, an inner container's published port
appears on the joiner's 127.0.0.1, and the joiner's egress stays blocked by
the internal session network.

The mode rejects --add-host, so the proxy alias mapping moves to the sidecar,
which shares its /etc/hosts with the joiner. Appending the sidecar's name to
no_proxy is no longer needed because the baseline already carries 127.0.0.1,
and NAS_DIND_CONTAINER_NAME had no reader.
EOF
```

---

### Task 5: Keep the sidecar while a joiner survives

On SIGTERM the docker client is killed but the agent container can outlive it. Tearing the sidecar down then strips the agent's namespace owner, where previously the agent merely stayed on the session network.

**Files:**
- Modify: `src/stages/dind/dind_service.ts:40-46` (`DindTeardownOpts`), `:78-80` (forwarding)
- Modify: `src/stages/dind/stage.ts` (`DindPlan`, the finalizer at `:188-207`)
- Modify: `src/docker/dind.ts:331-343` (`TeardownDindSidecarParams`), `:352` (destructuring), `:349-399` (`teardownDindSidecar`)
- Test: `src/stages/dind/stage_test.ts` — the new case plus the existing run test at `:336-404`

**Interfaces:**
- Consumes: `makeDindInput` from Task 4's Step 1.
- Produces: `DindTeardownOpts` and `TeardownDindSidecarParams` each gain `readonly joinerContainerName: string`. `teardownDindSidecar(params, deps?: TeardownDindDeps)` gains an optional second parameter whose members default to `dockerIsRunning` / `dockerStop` / `dockerRm` / `dockerVolumeRemove`, so both branches are unit-testable without a daemon.

- [ ] **Step 1: Write the failing test**

Two tests. The first asserts the wiring reaches the service rather than just
restating how the plan is built — extend the existing run test at
`src/stages/dind/stage_test.ts:336-404`, which already records `teardownCalls`
through a fake `DindService`:

```typescript
  expect(teardownCalls[0]?.joinerContainerName).toBe(
    containerNameForSession("test-session-1234"),
  );
```

Use whatever session id `makeSharedInput` defaults to in that file. The second
covers the skip branch itself, which no integration test can reach because no
agent container exists during those runs:

```typescript
test("teardownDindSidecar: removes nothing while the joiner is running", async () => {
  const calls: string[] = [];
  const deps = {
    isRunning: async () => true,
    stop: async (name: string) => { calls.push(`stop:${name}`); },
    rm: async (name: string) => { calls.push(`rm:${name}`); },
    volumeRemove: async (name: string) => { calls.push(`volume:${name}`); },
  };

  await teardownDindSidecar(teardownParams(), deps);

  expect(calls).toEqual([]);
});

test("teardownDindSidecar: removes the sidecar once the joiner is gone", async () => {
  const calls: string[] = [];
  const deps = {
    isRunning: async () => false,
    stop: async (name: string) => { calls.push(`stop:${name}`); },
    rm: async (name: string) => { calls.push(`rm:${name}`); },
    volumeRemove: async (name: string) => { calls.push(`volume:${name}`); },
  };

  await teardownDindSidecar(teardownParams(), deps);

  expect(calls).toContain("stop:nas-dind-abc12345");
  expect(calls).toContain("rm:nas-dind-abc12345");
});
```

`teardownParams()` is a local helper returning a `TeardownDindSidecarParams`
with `containerName: "nas-dind-abc12345"`,
`joinerContainerName: "nas-agent-sess_abc12345"` and the remaining fields filled
from `src/docker/dind.ts:331-343`. The second case is the control: without it
the first would pass against a function that removes nothing at all.

Place both in `src/docker/dind_test.ts`, creating the file if it does not exist.
Neither reaches a Docker daemon, which is what the injected `deps` are for.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/stages/dind/stage_test.ts`
Expected: FAIL — `joinerContainerName` is not on the plan.

- [ ] **Step 3: Derive and pass the name**

In `src/stages/dind/stage.ts`, add `joinerContainerName: containerNameForSession(input.sessionId)` to `DindPlan` (import `containerNameForSession` from `src/docker/nas_resources.ts:18-20`, the same helper LaunchStage uses at `launch/stage.ts:44`), and pass it into `teardownSidecar` in the finalizer at `:188-207`. The stage passes a name and nothing more — the effect-separation rules forbid a stage finalizer from calling `docker.isRunning` itself.

Add to `DindTeardownOpts` in `src/stages/dind/dind_service.ts`:

```typescript
  readonly joinerContainerName: string;
```

- [ ] **Step 4: Check liveness inside the service**

In `src/docker/dind.ts`, add `joinerContainerName` to `TeardownDindSidecarParams` (`:331-343`) and to the destructuring at `:352`, then guard at the top of `teardownDindSidecar` (`:349`):

```typescript
export interface TeardownDindDeps {
  isRunning?: (name: string) => Promise<boolean>;
  stop?: (name: string, opts?: { timeoutSeconds?: number }) => Promise<void>;
  rm?: (name: string) => Promise<void>;
  volumeRemove?: (name: string) => Promise<void>;
}

export async function teardownDindSidecar(
  params: TeardownDindSidecarParams,
  deps: TeardownDindDeps = {},
): Promise<void> {
  const isRunning = deps.isRunning ?? dockerIsRunning;
  const stop = deps.stop ?? dockerStop;
  const rm = deps.rm ?? dockerRm;
  const volumeRemove = deps.volumeRemove ?? dockerVolumeRemove;
  // ... existing destructuring, plus joinerContainerName

  // The agent joined this container's network namespace. If it outlived the
  // nas process -- SIGTERM kills only the docker client -- removing the
  // sidecar would strip its namespace owner and take its networking with it.
  // Leave both alive; `nas container clean` collects them once the agent
  // exits, and until then it recognizes the joiner as a user of this sidecar.
  if (await isRunning(joinerContainerName)) {
    logInfo(
      `[nas] DinD: ${joinerContainerName} still shares this namespace; skipping teardown`,
    );
    return;
  }
```

`dockerIsRunning` is already imported in that module (`:12`) and stays imported after Task 8 because `waitForDindReady` (`:509`) uses it.

Replace the existing direct calls to `dockerStop` / `dockerRm` / `dockerVolumeRemove` in the body with the local `stop` / `rm` / `volumeRemove` bindings.

The injected `deps` exist so the skip branch has a unit test that touches no Docker daemon. `teardownDindSidecar` otherwise calls Docker primitives directly, which the effect-separation rules tolerate for a D1-style function; adding a branch to it is what makes a test necessary, since a branch reachable from neither the unit lane nor an integration run is effectively untested. Injecting only `isRunning` would not be enough — the test could then assert nothing about what the function did or did not remove.

Then forward the name in `DindServiceLive.teardownSidecar` (`dind_service.ts:78-80`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/stages/dind/stage_test.ts src/docker/dind_test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/stages/dind/stage.ts src/stages/dind/dind_service.ts src/docker/dind.ts src/docker/dind_test.ts src/stages/dind/stage_test.ts
git commit -F - <<'EOF'
fix(dind): skip sidecar teardown while the agent shares its namespace

On SIGTERM the interactive runner kills only the docker client, so the agent
container can outlive the nas process. Now that the agent borrows the
sidecar's network namespace, removing the sidecar at that point takes the
agent's networking with it. Previously the agent stayed on the session
network and `network rm` simply failed with "in use".

Discovery by filter is not available -- a joiner is a member of no network
and `docker ps --filter network=container:<id>` returns nothing -- so the
stage passes the agent's container name down and the service does the
liveness check. The check lives in the service because a stage finalizer may
not call docker primitives directly.
EOF
```

---

### Task 6: Testcontainers reaper socket

**Files:**
- Modify: `src/docker/dind.ts` (constant)
- Modify: `src/stages/dind/stage.ts` (conditional env)
- Test: `src/stages/dind/stage_test.ts`

**Interfaces:**
- Produces: `DIND_ROOTLESS_SOCKET_PATH = "/run/user/1000/docker.sock"` exported from `src/docker/dind.ts`.

- [ ] **Step 1: Write the failing tests**

```typescript
test("planDind: sets the Testcontainers socket override", () => {
  const plan = planDind(makeDindInput({ dockerEnable: true }));

  expect(
    plan?.outputOverrides.container?.env.static
      .TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE,
  ).toBe("/run/user/1000/docker.sock");
});

test("planDind: does not override a user-supplied socket path", () => {
  const input = makeDindInput({ dockerEnable: true });
  const withUserValue = {
    ...input,
    container: {
      ...input.container,
      env: {
        ...input.container.env,
        static: {
          ...input.container.env.static,
          TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE: "/custom.sock",
        },
      },
    },
  };

  const plan = planDind(withUserValue);

  expect(
    plan?.outputOverrides.container?.env.static
      .TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE,
  ).toBe("/custom.sock");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/stages/dind/stage_test.ts`
Expected: FAIL — the variable is undefined.

- [ ] **Step 3: Add the constant**

In `src/docker/dind.ts`, beside `DIND_IMAGE`:

```typescript
/**
 * Where `docker:dind-rootless` puts its Unix socket.
 *
 * Testcontainers' Ryuk reaper bind-mounts /var/run/docker.sock from the
 * daemon's filesystem, and that path does not exist inside the sidecar, so
 * Docker creates an empty directory there and Ryuk cannot connect. This path
 * is a property of DIND_IMAGE, which is why it lives here.
 */
export const DIND_ROOTLESS_SOCKET_PATH = "/run/user/1000/docker.sock";
```

- [ ] **Step 4: Set it only when unset**

In `buildContainerState` in `src/stages/dind/stage.ts`, build the static env conditionally:

```typescript
  const staticEnv: Record<string, string> = {
    DOCKER_HOST: `tcp://127.0.0.1:${DIND_INTERNAL_PORT}`,
    NAS_DIND_SHARED_TMP: SHARED_TMP_MOUNT_PATH,
  };
  // env.static is a key-merge in which the patch wins, so writing this
  // unconditionally would silently replace a value set through profile env.
  if (
    input.container.env.static.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE ===
    undefined
  ) {
    staticEnv.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE =
      DIND_ROOTLESS_SOCKET_PATH;
  }
```

and pass `staticEnv` as `env.static` in the `mergeContainerPlan` patch.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/stages/dind/stage_test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/docker/dind.ts src/stages/dind/stage.ts src/stages/dind/stage_test.ts
git commit -F - <<'EOF'
feat(dind): point Testcontainers' reaper at the rootless socket

Ryuk bind-mounts /var/run/docker.sock from the daemon's filesystem. That path
does not exist inside docker:dind-rootless, so Docker creates an empty
directory at the mount point and Ryuk fails to connect. Binding
/run/user/1000/docker.sock was measured to work and to serve the API.

The path follows from the sidecar image nas chooses rather than from the
project, which is why nas sets it instead of documenting it -- the one place
where a specific test framework is named here. A value the user already set
through profile env wins, because env.static is a key-merge in which the
stage's patch would otherwise silently replace it.
EOF
```

---

### Task 7: Warn about ports the namespace already claims

Forward-port listeners bind `127.0.0.1:<port>` in the agent's namespace and rootlesskit publishes inner containers on `0.0.0.0:<port>` in the same namespace, so publishing on a claimed port fails with `EADDRINUSE`.

**Files:**
- Create: `src/network/ports.ts`
- Modify: `src/stages/proxy/stage.ts:59` (declaration) and `:166` (use), `src/stages/proxy.ts:45` (barrel)
- Modify: `src/config/validate.ts:207-209` (drop the hardcoded 18080)
- Modify: `src/stages/dind/stage.ts`
- Test: `src/stages/dind/stage_test.ts`

**Interfaces:**
- Consumes: `makeDindInput` from Task 4's Step 1 (not used by these two cases, but the file has it).
- Produces: `LOCAL_PROXY_PORT` re-homed to `src/network/ports.ts`; `reservedNamespacePorts(forwardPortsEnv: string | undefined): number[]` exported from `src/stages/dind/stage.ts`.

`src/network/` is the home rather than `src/pipeline/` because the constant is network knowledge, sits beside `forward_port_relay.ts`, and lets `src/config/validate.ts:207-209` stop hardcoding the same number. Note that `local-proxy.mjs:18` reads `NAS_LOCAL_PROXY_PORT` from the environment, so this constant is the default rather than the only source of truth; do not add code that assumes otherwise.

- [ ] **Step 1: Write the failing test**

```typescript
test("reservedNamespacePorts: unions forwarded ports with the fixed ones", () => {
  expect(reservedNamespacePorts("8080,5432")).toEqual([
    2375, 18080, 8080, 5432,
  ]);
});

test("reservedNamespacePorts: tolerates no forwarded ports", () => {
  expect(reservedNamespacePorts(undefined)).toEqual([2375, 18080]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/stages/dind/stage_test.ts`
Expected: FAIL — `reservedNamespacePorts` is not exported.

- [ ] **Step 3: Re-home the constant**

Create `src/network/ports.ts`:

```typescript
/** Ports nas binds inside the agent's network namespace. */

/**
 * Default port of the loopback HTTP proxy the agent's traffic goes through.
 * `local-proxy.mjs` honours NAS_LOCAL_PROXY_PORT, so this is the default the
 * pipeline seeds rather than an invariant.
 */
export const LOCAL_PROXY_PORT = 18080;
```

In `src/stages/proxy/stage.ts`, delete the declaration at `:59` and add both an import and a re-export — a bare `export { X } from "..."` creates no local binding, so the use at `:166` would not resolve:

```typescript
import { LOCAL_PROXY_PORT } from "../../network/ports.ts";
export { LOCAL_PROXY_PORT };
```

That keeps the barrel at `src/stages/proxy.ts:45` and `src/stages/proxy/stage_test.ts:53` working unchanged. Replace the hardcoded `18080` in `src/config/validate.ts:207-209` with the same import. DindStage imports from `src/network/ports.ts` directly — one stage module must not import another.

- [ ] **Step 4: Implement and log**

In `src/stages/dind/stage.ts`, importing `LOCAL_PROXY_PORT` from `../../network/ports.ts`:

```typescript
/**
 * Ports already bound inside the shared network namespace.
 *
 * Reads the forwarded set from the env ProxyStage seeded rather than from the
 * profile: ProxyStage unions the profile's ports with the observability
 * receiver port before binding them, so the profile alone under-reports.
 */
export function reservedNamespacePorts(
  forwardPortsEnv: string | undefined,
): number[] {
  const forwarded = (forwardPortsEnv ?? "")
    .split(",")
    .map((part) => Number.parseInt(part, 10))
    .filter((port) => Number.isInteger(port));
  return [DIND_INTERNAL_PORT, LOCAL_PROXY_PORT, ...forwarded];
}
```

In the stage's `run`, after the plan is built, log once:

```typescript
    logInfo(
      `[nas] DinD: ports already bound in the shared namespace: ${plan.reservedPorts.join(", ")} — publishing a container on one of these fails with EADDRINUSE`,
    );
```

Store `reservedPorts: reservedNamespacePorts(input.container.env.static.NAS_FORWARD_PORTS)` on `DindPlan`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/stages/dind/stage_test.ts src/stages/proxy/stage_test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/network/ports.ts src/stages/proxy/stage.ts src/stages/proxy.ts src/config/validate.ts src/stages/dind/stage.ts src/stages/dind/stage_test.ts
git commit -F - <<'EOF'
feat(dind): report the ports the shared namespace already claims

The forward-port relay binds each forwarded port on 127.0.0.1 inside the
agent's namespace, and rootlesskit publishes inner containers' ports on
0.0.0.0 in that same namespace once it is shared. Publishing a container on a
port already forwarded now fails with EADDRINUSE, which is a new failure mode
and an opaque one at the point it bites.

The set is read from NAS_FORWARD_PORTS rather than the profile because
ProxyStage adds the observability receiver port before binding, so the
profile under-reports.

LOCAL_PROXY_PORT moves to a shared module rather than being imported from the
proxy stage, since one stage module importing another would be new coupling
between siblings.
EOF
```

---

### Task 8: Retire docker.shared

**Files:**
- Modify: `src/config/Schema.pkl:133-140`, `src/config/validate.ts:48-75`
- Unchanged on purpose: `src/config/types.ts:23-26` keeps `shared` on `DockerConfig`, because the field still exists in the schema and validation must be able to read it
- Modify: `src/docker/dind.ts:211-232`, `:261-275`, `:354-368`, `:449`
- Modify: `src/docker/nas_resources.ts:3`
- Modify: `src/stages/dind/stage.ts:7-19`, `:35`, `:95-105`
- Modify: `src/stages/dind/dind_service.ts:16-26`, `:40-46`, `:60-63`, `:78-80`
- Modify: `.nas/config.pkl`
- Test: `src/config/validate_test.ts`, `src/stages/dind/stage_test.ts:149-190`, `:208`, `:360-390`

- [ ] **Step 1: Write the failing tests**

Add to `src/config/validate_test.ts`. `validateConfig(config: Config): Config`
returns the config and throws `ConfigValidationError` on failure
(`src/config/validate.ts:21`), so these are `toThrow` assertions, matching the
neighbouring tests at `:88` and `:149`. `makeConfig` takes
`Partial<Config> & { profiles?: Record<string, Profile> }` (`:54-63`), so the
docker settings go on a profile, not on the config.

```typescript
test("validate: docker.enable with docker.shared is rejected", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({ docker: { enable: true, shared: true } }),
        },
      }),
    ),
  ).toThrow("docker.shared");
});

test("validate: docker.shared without docker.enable is accepted", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({ docker: { enable: false, shared: true } }),
        },
      }),
    ),
  ).not.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/config/validate_test.ts`
Expected: FAIL — no error is produced.

- [ ] **Step 3: Reject the combination**

In `validateProfile` (`src/config/validate.ts:48-75`):

```typescript
  if (profile.docker.enable && profile.docker.shared) {
    errors.push(
      `profile "${name}": docker.shared is no longer supported with docker.enable. ` +
        `The agent now joins the sidecar's network namespace, and sessions sharing ` +
        `one namespace would see each other's loopback services. Remove docker.shared.`,
    );
  }
```

The rejection is narrowed to the combination on purpose: `enable = false; shared = true` has no effect on behavior and appears in this repository's own `baseProfile`, so failing it would block configurations that never start a sidecar.

- [ ] **Step 4: Mark the schema field deprecated**

In `src/config/Schema.pkl`, above `shared` in `DockerConfig`:

```pkl
  /// 非推奨。`enable` と併用すると設定エラーになる。
  /// エージェントは sidecar の network namespace に join するため、
  /// 複数セッションで sidecar を共有すると分離が失われる。
  shared: Boolean = false
```

`.nas/Schema.pkl` is overwritten from this file on every init (`src/config/init.ts:176-178`), so do not edit it by hand.

- [ ] **Step 5: Remove the shared code paths**

- `src/docker/nas_resources.ts:3` — delete `NAS_SHARED_LABEL` (written at `dind.ts:449`, read nowhere). Keep `isLegacyNasSidecarName` and `isLegacyNasTmpVolumeName` (`:77-98`) exactly as they are: they are what collects `nas-dind-shared` and `nas-dind-shared-tmp` left on hosts that ran the old mode.
- `src/docker/dind.ts` — delete `SHARED_CONTAINER_NAME`, the reuse branch at `:211-232`, and the shared branches at `:261-275` and `:354-368`.
- `src/stages/dind/stage.ts` — delete `SHARED_TMP_VOLUME` (`:35`) and the `shared` branch in `planDind` (`:95-105`), leaving the per-session names. Rewrite the header comment at `:7-19` so no shared mode is described.
- `src/stages/dind/dind_service.ts` — drop `shared` from `DindSidecarOpts` (`:16-26`), `DindTeardownOpts` (`:40-46`) and both forwarding sites (`:60-63`, `:78-80`).
- `.nas/config.pkl` — remove `shared = true` from `baseProfile`'s `docker` block. This file already carries an unrelated working-tree change to the `hostexec` `docker` rule (`approval = "allow"`, around `:258`). `git add -p` is interactive and unavailable here, so isolate your hunk instead:

```bash
git stash push -- .nas/config.pkl
# delete `shared = true` from baseProfile's docker block (around :363)
git add .nas/config.pkl
# ... commit in Step 8, then:
git stash pop
```

The two hunks are about a hundred lines apart and will not conflict.

- [ ] **Step 6: Update the shared-mode tests**

Task 4 shifted the line numbers, so work by test name. Delete or rewrite the cases named "DindStage: shared mode uses fixed names", the `p.shared` assertions inside "DindStage: non-shared mode uses session-based names", and the shared expectations in "DindStage: run calls ensureSidecar and teardownSidecar via DindService". Where a test only needed a name, switch it to the per-session name.

Also decide what to do with the code the removal orphans, and say so in the commit: `isAlreadyAttachedError` (`dind.ts:416-433`) loses its only caller with the reuse branch; `TeardownDindSidecarParams.sessionNetworkName` and `DindTeardownOpts.networkName` are read only by the shared branch; `EnsureDindSidecarResult.sidecarStarted` becomes constantly true. Delete all four — biome has no unused-symbol rule, so nothing else will catch them.

- [ ] **Step 7: Run tests and type check**

Run: `bun test src/config/validate_test.ts src/stages/dind/stage_test.ts`
Expected: PASS

Run: `bun run check`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/config/Schema.pkl src/config/validate.ts src/config/validate_test.ts src/docker/dind.ts src/docker/nas_resources.ts src/stages/dind/stage.ts src/stages/dind/dind_service.ts src/stages/dind/stage_test.ts .nas/config.pkl
git commit -F - <<'EOF'
feat(dind)!: drop shared sidecar mode

A shared sidecar and a shared network namespace cannot coexist: every session
joining one sidecar's namespace would see the others' loopback services,
which is the boundary the sandbox is built on.

The schema field stays, marked deprecated, and validation rejects it instead.
Deleting it outright would fail existing configurations during pkl evaluation
with a message about an unknown property, which does not say what to do. The
rejection covers only enable+shared, because shared alone changes no behavior
and appears in configurations that never start a sidecar.

This also retires the defect where a reused sidecar kept the proxy
credentials of the session that created it and lost the ability to pull
images once that session ended.

The legacy name matchers stay so that sidecars and volumes left by the old
mode are still collected by `nas container clean`.
EOF
```

---

### Task 9: Integration coverage and full suite

**Files:**
- Modify: `src/stages/dind/integration_test.ts`

- [ ] **Step 1: Write the integration test**

Add to `src/stages/dind/integration_test.ts`. The file already defines
everything needed except a host-side runner: `dindAvailable`,
`RUNNING_ON_HOST_DOCKER` (`:178`), `innerImageReady`, `INNER_IMAGE`
(`= "alpine:3.19"`, `:185`), `makeProfile`, `makeSharedInput`, `makeStageState`,
`forceCleanup`, `loadImageIntoSidecar`, `sidecarNetworks`, and
`dockerNetworkCreateInternal`. Note the guard polarity: these tests run only
when `RUNNING_ON_HOST_DOCKER` is true, so the condition is
`!dindAvailable || !RUNNING_ON_HOST_DOCKER || !innerImageReady`, matching
`:450`.

First add two local helpers beside `innerRun` (`:248`). Keep them local to this
file rather than sharing them, following the test policy on probes.

```typescript
/** Start a detached inner container that publishes `port` and answers on it. */
async function innerServe(
  sidecar: string,
  image: string,
  name: string,
  port: number,
): Promise<InnerRunResult> {
  const proc = Bun.spawn(
    [
      "docker", "exec", sidecar,
      "docker", "-H", "tcp://127.0.0.1:2375", "run", "-d",
      "--name", name, "-p", `${port}:8080`, image,
      "sh", "-c",
      'while true; do printf "HTTP/1.1 200 OK\\r\\nContent-Length: 3\\r\\n\\r\\nhi\\n" | nc -l -p 8080; done',
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, output: `${stdout}\n${stderr}` };
}

/** Run a throwaway container inside `sidecar`'s network namespace. */
async function joinerRun(
  sidecar: string,
  image: string,
  shellCmd: string,
): Promise<InnerRunResult> {
  const proc = Bun.spawn(
    [
      "docker", "run", "--rm",
      "--network", `container:${sidecar}`,
      image, "sh", "-c", shellCmd,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, output: `${stdout}\n${stderr}` };
}
```

Then the test:

```typescript
test.skipIf(!dindAvailable || !RUNNING_ON_HOST_DOCKER || !innerImageReady)(
  "DindStage: a namespace joiner sees an inner container's published port on loopback",
  async () => {
    // Generated rather than the file's default `test-session-1234`, which
    // derives a fixed container name two concurrent runs would collide on.
    const sessionId = `spec-${crypto.randomUUID().slice(0, 8)}`;
    const profile = makeProfile({ docker: { enable: true, shared: false } });
    const sharedInput = makeSharedInput(profile, sessionId);
    const stageState = makeStageState({
      network: {
        networkName: `nas-session-net-${sessionId}`,
        runtimeDir: "/run/user/1000/nas/network",
      },
    });
    const plan = planDind(
      { ...sharedInput, ...stageState },
      { disableCache: true, readinessTimeoutMs: 20_000 },
    );
    expect(plan).not.toBeNull();

    const containerName = plan!.containerName;
    const innerName = `inner-pub-${crypto.randomUUID().slice(0, 8)}`;
    await forceCleanup(containerName, plan!.networkName, plan!.sharedTmpVolume);
    await dockerNetworkCreateInternal(plan!.networkName);

    const scope = Effect.runSync(Scope.make());
    try {
      const stage = createDindStageWithOptions(sharedInput, {
        disableCache: true,
        readinessTimeoutMs: 20_000,
      });
      await Effect.runPromise(
        stage
          .run(stageState)
          .pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.provide(DindServiceLive),
          ),
      );

      expect(await loadImageIntoSidecar(containerName, INNER_IMAGE)).toEqual(
        true,
      );
      const served = await innerServe(containerName, INNER_IMAGE, innerName, 18081);
      expect(
        served.exitCode,
        `inner publish failed. Output:\n${served.output}`,
      ).toEqual(0);

      // The property the design turns on: rootlesskit publishes the inner
      // container's port into the sidecar's namespace, and a joiner shares
      // that namespace, so the port is on the joiner's own loopback.
      // `docker run -d` returns once the container starts, not once `nc` is
      // listening, so a single wget races the listener. Retry for ten seconds.
      const result = await joinerRun(
        containerName,
        INNER_IMAGE,
        "for i in $(seq 1 20); do wget -qO- -T 3 http://127.0.0.1:18081/ && exit 0; sleep 0.5; done; exit 1",
      );
      expect(
        result.exitCode,
        `joiner could not reach the published port. Output:\n${result.output}`,
      ).toEqual(0);
      expect(result.output).toContain("hi");
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => {});
      await forceCleanup(containerName, plan!.networkName, plan!.sharedTmpVolume);
    }
  },
);
```

`DockerConfig.shared` stays a required field in `src/config/types.ts:23-26` even
after Task 8, so `makeProfile` always needs both keys: pass
`{ enable: true, shared: false }` regardless of task order.

`forceCleanup` in `finally` removes the sidecar, the network and the volume; the
inner container dies with the sidecar and the joiner uses `--rm`.

- [ ] **Step 2: Run the full suite once**

Run: `bun run test`
Expected: PASS. This is the only full-suite run in the plan — do not repeat it while fixing unrelated failures, and do not run individual integration files to iterate.

- [ ] **Step 3: Commit**

```bash
git add src/stages/dind/integration_test.ts
git commit -F - <<'EOF'
test(dind): cover port visibility through the shared namespace

The property the design turns on is that a container joined to the sidecar's
network namespace sees an inner container's published port on its own
loopback. Nothing in the unit tests can observe that -- it is a property of
rootlesskit's port driver, not of the plan the stage builds.

The case generates its session id rather than following the file's existing
fixed `test-session-1234`, which derives a fixed container name and can
collide with a concurrent run.
EOF
```

---

### Task 10: Documentation

**Files:**
- Modify: `README.md:269`, `:576`, `:818`, `:827`, plus the `docker.enable` prose at `:122`
- Modify: `docs/todo/security.md`

- [ ] **Step 1: Update the README**

- `:269` — remove `shared = true` from the example profile.
- `:576` — the `container clean` paragraph mentions shared DinD sidecars; reword for per-session sidecars and orphans from older versions.
- `:818` — remove the bullet about `docker.shared = true` reusing the sidecar.
- `:827` — rewrite the `docker.enable` row: the agent joins the sidecar's network namespace, so the Docker daemon answers on `127.0.0.1:2375` and inner containers publish onto the agent's loopback; a server the agent runs on `0.0.0.0` becomes reachable from containers started inside DinD; the sidecar still runs `--privileged` while the agent container stays unprivileged.
- `:122` — add the two constraints a user meets in practice: bind mounts resolve inside the sidecar, so paths must be under `/tmp/nas-shared`; and publishing a container on a port listed in `network.proxy.forwardPorts` (or on 2375 or 18080) fails with `EADDRINUSE`.

- [ ] **Step 2: Record the daemon exposure finding**

Remove H7 from all three places it appears — the priority table at `:35`, the status table at `:81`, and the entry at `:165-170` — since Task 8 made shared mode impossible. Then add to the P2 list:

```markdown
- [ ] **DinD sidecar の dockerd が namespace 内で `0.0.0.0:2375` に publish される** —
  [検証] CONFIRMED。`rootlesskit ... -p 0.0.0.0:2375:2375/tcp`（実測した起動引数）。
  DinD の内側で起動したコンテナが sidecar の session network アドレス経由で
  Docker API 全体に到達できる（内側の alpine から `/v1.44/containers/json` で
  コンテナ一覧を取得できることを確認済み）。
  権限昇格ではなく多層防御の話である。agent は `DOCKER_HOST` で既に同じデーモンへ
  無制限にアクセスでき、到達できるようになるのは agent 自身が起動したコンテナである。
  効くのは agent が自分で制御していない第三者イメージを走らせる場合に限られる。
  rootless デーモンの root は sidecar 内の uid 1000 に写像され、sidecar の外側の
  `--privileged` はその uid には及ばないため、ホストへの経路は実証されていない。
  対応: agent が `127.0.0.1:2375` で到達するようになったので、publish を
  `127.0.0.1:2375:2375` に絞れば内側からの経路は消える。
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/todo/security.md
git commit -F - <<'EOF'
docs: describe the shared network namespace and its constraints

Two constraints only bite at the point a user hits them, so they belong in
the docker.enable section rather than only in the design document: bind
mounts resolve on the daemon's filesystem and so need paths under
/tmp/nas-shared, and publishing a container on a forwarded port now collides
with the relay listener.

The isolation table gains the one thing sharing a namespace actually widens:
a server the agent runs on 0.0.0.0 becomes reachable from containers started
inside DinD.

Records the daemon's 0.0.0.0 publish as defence-in-depth rather than
escalation. The agent already holds the same daemon access through
DOCKER_HOST, and no path from the rootless daemon to the host was
demonstrated -- its root maps to uid 1000 inside the sidecar.
EOF
```

---

## Manual Verification

After Task 10, one manual check the automated suite cannot make. The socket
bind-mount was measured, but Ryuk running to completion was not, and rootless
daemons sometimes also want `TESTCONTAINERS_RYUK_CONTAINER_PRIVILEGED`.

1. Enable `docker.enable = true` in a scratch profile and start a session.
2. Run a Testcontainers suite (any language) inside it.
3. Confirm the container starts, `getHost()` resolves to localhost, and Ryuk reaps on exit.
4. Amend the spec's Testcontainers section with the result. If Ryuk needs the
   privileged flag, add it the same way the socket override is added in Task 6.
