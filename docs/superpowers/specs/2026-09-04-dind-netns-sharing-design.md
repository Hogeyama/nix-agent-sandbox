# DinD Network Namespace Sharing

**Status:** Draft

**Date:** 2026-09-04

## Purpose

`docker.enable = true` hands the agent an isolated Docker daemon through a
`docker:dind-rootless` sidecar, reachable at `DOCKER_HOST=tcp://<sidecar>:2375`.
The sidecar has its own network namespace, so a container the agent starts
publishes its ports on the sidecar's interfaces rather than on the agent's
loopback. Tooling that assumes a local daemon — Testcontainers most visibly —
either needs per-project reconfiguration or breaks outright.

This design makes the agent container join the sidecar's network namespace
(`--network container:<sidecar>`). The daemon then answers on
`tcp://127.0.0.1:2375`, and every port a container publishes appears on the
agent's own loopback, which is what a locally installed Docker would do.

## Scope

The change covers the agent-to-daemon wiring: the network attachment, the
`DOCKER_HOST` value, the relocation of `--add-host` to whichever container owns
the namespace, the repair of `nas container clean` under the new wiring, the
removal of `docker.shared`, and one Testcontainers-specific environment
variable.

It deliberately excludes:

- bind-mount transparency beyond the existing `/tmp/nas-shared` volume;
- restricting the daemon's listener to loopback (see Recorded, Not Fixed below);
- nested rootless `dockerd` inside the agent container; and
- any change to how the sidecar reaches the network proxy.

## Verified Behavior

The design rests on properties of Docker's container network mode and of
`docker:dind-rootless` that were measured on the development host (Docker
29.6.1, Debian kernel 6.1) rather than assumed.

| Property | Result |
|---|---|
| Joiner reaches the daemon at `127.0.0.1:2375` | Reachable |
| Port published by an inner container appears on the joiner's `127.0.0.1` | Appears |
| Bridge-to-internal network swap while a joiner is attached | Succeeds; loopback services survive |
| Joiner's outbound traffic on an internal network | Blocked |
| `--add-host` on the joining container | Rejected: `conflicting options: custom host-to-IP mapping and the network mode` |
| `--hostname` on the joining container | Rejected |
| `--network-alias` on the joining container | Rejected |
| `--add-host` on the namespace owner | Propagates to the joiner's `/etc/hosts` |
| Joiner's hostname and `/etc/resolv.conf` | Inherited from the namespace owner |
| Joiner's membership in the owner's networks | None; the joiner appears in no `docker network inspect` output |
| Inner container reaching the shared namespace's loopback | Blocked (`rootlesskit --disable-host-loopback`) |
| Inner container reaching a `0.0.0.0` listener in the shared namespace | Reachable via the namespace's external address |
| Binding `/run/user/1000/docker.sock` into an inner container | Succeeds; the API answers over it |
| Binding `/var/run/docker.sock` into an inner container | Yields an empty directory; the path does not exist |

The bridge-to-internal swap was measured with a joiner already attached, but the
pipeline completes that swap inside `ensureDindSidecar` before LaunchStage runs
(`src/docker/dind.ts:274-295`), so the design does not depend on it.

## Design

### Network attachment becomes a discriminated union

`NetworkAttachment` (`src/pipeline/state.ts:136`) currently carries a network
name and an optional alias. Container network mode is a different kind of
attachment, not a differently-named network, and conflating the two would let
`compileLaunchOpts` emit `--network-alias` alongside a mode that rejects it.

```ts
export type NetworkAttachment =
  | { readonly mode: "network"; readonly name: string; readonly alias?: string }
  | { readonly mode: "container"; readonly containerName: string };
```

The field has three touch points outside its definition:
`src/stages/proxy/stage.ts:568` constructs the session-network attachment,
`src/pipeline/container_plan.ts` merges it, and
`src/stages/launch/stage.ts:99-102` renders it into flags. `compileLaunchOpts`
branches on `mode` and emits `--network container:<name>` for the container
case.

### DindStage overrides the attachment

DindStage already runs after ProxyStage and already patches the agent's
container plan. It replaces the attachment with
`{ mode: "container", containerName }` and sets
`DOCKER_HOST=tcp://127.0.0.1:2375`. `mergeContainerPlan` gives the patch
precedence (`container_plan.ts:91`), so no ordering change is needed.

Appending the sidecar's name to `no_proxy` becomes unnecessary, because
`127.0.0.1` is already in the baseline that ProxyStage seeds
(`proxy/stage.ts:169`). That code is removed rather than left inert.
`NAS_DIND_CONTAINER_NAME` (`dind/stage.ts:235`) is removed in the same pass: no
reader exists for it in `src/`, including `src/docker/embed/`.

### Extra hosts live on the container plan

ProxyStage appends `--add-host=nas-envoy:<ip>` to the agent's `extraRunArgs`
(`src/stages/proxy/stage.ts:502-514`) because Docker's embedded DNS returns
SERVFAIL for internal networks on some Debian hosts. The joining container
cannot carry that flag, so it has to move to the sidecar.

Teaching ProxyStage to check `profile.docker.enable` would make it responsible
for knowing whether a DinD sidecar exists. Instead ProxyStage stops formatting
the flag and records the mapping as structured data on `ContainerPlan`, merged
by appending the way `mounts` already is:

```ts
export interface ExtraHost {
  readonly host: string;
  readonly ip: string;
}
```

`ContainerPlan` is the declarative description of the container to launch
(`state.ts:147-152`) and LaunchStage is its only compiler (`state.ts:105`), so a
host entry the agent needs belongs there. Putting it on `ProxyState` instead
would force LaunchStage to declare a `proxy` slice it does not otherwise need —
`compileLaunchOpts` takes only a `ContainerPlan` (`launch/stage.ts:84-87`) and
LaunchStage declares `needs: ["container"]` (`:131-134`).

The rule is that whichever container owns the network namespace expands
`extraHosts` into `--add-host` flags. `compileLaunchOpts` expands them when the
attachment mode is `network`; DindStage forwards `input.container.extraHosts`
to the sidecar, where `buildDindSidecarArgs` expands them. ProxyStage stays
unaware of DinD.

`proxyIp` is only known inside `runProxy` and can be `null`
(`proxy/proxy_service.ts:52`), so `extraHosts` is appended there rather than in
the pure `planProxy`. When it is empty, name resolution falls back to Docker's
embedded DNS through the sidecar's `resolv.conf`, which matches today's
behavior when `proxyIp` is absent.

All three `runDindSidecar` call sites (`docker/dind.ts:91`, `:118`, `:150`) must
pass `extraHosts`, including the two cache-reset retry paths. The comment at
`dind.ts:72-75` records the same trap for `proxyEndpoint`.

### `nas container clean` must recognize namespace joiners

`isUnusedNasSidecar` (`src/container_clean.ts:89-117`) treats a running sidecar
as in use only when a running, non-sidecar container is a *member* of a
nas-managed network the sidecar is attached to. A container in `--network
container:` mode is a member of no network, so under the new wiring a live
session's sidecar is judged unused. `nas container clean`, run from another
terminal (`src/cli/container.ts:50`) or the UI (`src/ui/routes/api.ts:381`),
would stop and remove it, taking the agent's entire network with it. Because
`removeUnusedNetworks` re-enumerates after container removal, the session
network and then `nas-proxy-shared` would follow.

The damage is not limited to the DinD sidecar. `nas-proxy-shared` carries
`nas.kind=proxy` (`proxy/proxy_service.ts:143-146`), which
`isNasManagedSidecar` also classifies as a sidecar
(`docker/nas_resources.ts:28-39`), and it is connected to every session network
(`proxy_service.ts:198-204`). Under the new wiring a DinD session's network has
exactly two members, the proxy and the DinD sidecar, and both are sidecars. So
the proxy is judged unused on the same pass. When every live session has
`docker.enable`, cleaning removes the shared proxy and every session loses
egress.

`DockerContainerDetails` (`src/docker/client.ts:61-67`, parsed at `:532-538`)
gains the container id and `HostConfig.NetworkMode`. Docker records the mode
with the full 64-character id rather than the name, which is why the id is
needed.

Rather than special-casing each sidecar kind, `isUnusedNasSidecar` resolves
namespace joiners to their owners first: for every running, non-sidecar
container whose `NetworkMode` is `container:<id>`, the joiner counts as a member
of every network its owner is attached to. The existing membership loop
(`container_clean.ts:104-115`) then finds the agent on the session network and
keeps both the DinD sidecar and the proxy alive, under one rule. This requires
an id-keyed index alongside the existing name-keyed map
(`container_clean.ts:48-50`).

With that judgment corrected, the network and volume passes need no change:
both re-derive their answers from the containers that survived.

### Testcontainers reaper

Testcontainers starts a Ryuk container with `/var/run/docker.sock` bind-mounted
from the daemon's filesystem. That path does not exist inside the sidecar, so
Docker creates an empty directory and Ryuk fails to connect. The rootless socket
at `/run/user/1000/docker.sock` does bind correctly and serves the API.

DindStage therefore sets `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` in the agent's
environment. The path is a property of `DIND_IMAGE`, so it is declared as a
constant beside it in `src/docker/dind.ts` rather than inline in the stage. This
is the one place where nas encodes knowledge of a specific test framework. The
alternative — documenting the variable and letting each project set it — was
rejected because the value follows from the sidecar image that nas chooses, not
from the project.

`env.static` is a key-merge in which the patch wins
(`container_plan.ts:81-85`), so DindStage would otherwise silently override a
value the user set through profile `env`. It writes the variable only when
`input.container.env.static` does not already carry one.

Whether Ryuk then runs to completion is not established by the socket
measurement alone; rootless daemons sometimes also require
`TESTCONTAINERS_RYUK_CONTAINER_PRIVILEGED`. Implementation includes one manual
end-to-end run of a Testcontainers suite against the new wiring, and the spec is
amended with the result.

### `docker.shared` is removed

A shared sidecar and a shared network namespace cannot coexist: every session
joining one sidecar's namespace would collapse the isolation between sessions.
`docker.shared` is therefore dropped rather than made conditional.

Deleting the field from `Schema.pkl` would make existing configurations fail
during pkl evaluation with a message about an unknown property, which does not
explain the cause. The field stays in the schema, marked deprecated, and
`src/config/validate.ts` rejects the combination `enable = true` with
`shared = true`. There is no docker validation there today; the check is added
to `validateProfile` (`validate.ts:48-75`). `DockerConfig` in
`src/config/types.ts:23-26` keeps the field. `src/config/Schema.pkl` and
`.nas/Schema.pkl` are byte-identical, the latter being overwritten from the
former on every init (`src/config/init.ts:176-178`), so the deprecation comment
is written to the source and propagated rather than edited twice. The rejection is narrowed to that combination because
`enable = false; shared = true` has no effect on behavior and appears in this
repository's own `baseProfile`; failing it would block configurations that never
start a sidecar.

Removing shared mode also removes `SHARED_CONTAINER_NAME`, `SHARED_TMP_VOLUME`
(`dind/stage.ts:35`), the sidecar-reuse branch in `src/docker/dind.ts:211-232`,
and the shared branches at `:261-275` and `:354-368`. Two header comments
describe behavior that stops being true and are rewritten in the same pass:
`dind/stage.ts:7-19` documents shared mode and states that DindStage does not
set the network, and `proxy/stage.ts:167-168` says DindStage appends DinD's
hostname to `no_proxy`. `NAS_SHARED_LABEL` (`docker/nas_resources.ts:3`) is written at
`dind.ts:449` and read nowhere, so it goes too. The legacy name matchers for
`nas-dind-shared` and `nas-dind-shared-tmp` (`nas_resources.ts:77-98`) stay:
they are what lets `cleanNasContainers` collect sidecars and volumes left on
hosts that ran the old mode. No extension of the clean path is needed for those
orphans, because both already carry `nas.kind=dind` and `nas.kind=dind-tmp`
labels. The shared tmp volume collapses to the per-session name that non-shared
mode already uses. This repository's own `.nas/config.pkl` sets `shared = true`
and is updated in the same change.

Dropping shared mode also retires the token-lifetime defect recorded as H7 in
`docs/todo/security.md:165-170`, where a reused sidecar keeps the proxy
credentials of the session that created it and loses the ability to pull images
once that session ends.

### Failure coupling

The agent's network now belongs to the sidecar. If the sidecar exits, the agent
loses connectivity rather than merely losing Docker.

On the normal path the ordering is correct. DindStage waits for readiness before
LaunchStage runs, and `ContainerLaunchService.launch` blocks until
`docker run --rm` returns (`launch/stage.ts:146`, `docker/client.ts:127`), so
the agent has already exited by the time the pipeline's single scope
(`Effect.scoped` at `src/cli.ts:408`) closes. Finalizers then run in reverse registration
order, which puts DindStage's teardown (`dind/stage.ts:188-207`) after the agent
exits and before ProxyStage removes the session network.

The abnormal path differs from today. When the nas process receives SIGTERM,
`runInteractiveCommand` kills only the docker client (`client.ts:193-200`). If
the agent container outlives it, sidecar teardown now strips the agent's network
namespace owner, where today the agent merely stays on the session network and
`network rm` fails with "in use" (`proxy_service.ts:235-243`).

`teardownSidecar` therefore skips removal while a joiner survives. Discovery by
filter is not available — a joiner appears in no network, and
`docker ps --filter network=container:<id>` returns nothing — so DindStage
passes the agent's container name into `DindTeardownOpts`
(`dind/dind_service.ts:40-46`), deriving it from `input.sessionId` through
`containerNameForSession` (`nas_resources.ts:18-20`), the same helper LaunchStage
uses (`launch/stage.ts:44`). The liveness check itself belongs in
`teardownDindSidecar` (`docker/dind.ts:349`) behind
`DindServiceLive.teardownSidecar` (`dind_service.ts:73-86`), because the
effect-separation rules forbid a stage finalizer from calling `docker.isRunning`
directly; the stage only passes the name.

A skipped teardown leaves the sidecar and the `nas-dind-tmp-<sid>` volume alive
until the agent exits and someone runs `nas container clean`. With the joiner
rule above in place, clean keeps them for exactly as long as the agent runs.

## Remaining Non-Transparency

Sharing a namespace fixes port reachability. It does not change the daemon's
mount namespace, so bind mounts still resolve inside the sidecar.
`withFileSystemBind` and similar APIs continue to require paths under
`/tmp/nas-shared`, which is mounted at the same path in both containers.

Ports now collide where they previously could not. `local-proxy.mjs:17,204`
binds each forwarded port on `127.0.0.1` inside the agent's namespace, and
rootlesskit publishes inner containers' ports on `0.0.0.0` in that same
namespace. Publishing a container on a port that `network.proxy.forwardPorts`
already claims fails with `EADDRINUSE`; `18080` (the local proxy) and `2375`
(the daemon) are reserved the same way. This repository's own configuration
claims 8080, 5432 and 3939.

DindStage logs the reserved set at startup and the README documents the
constraint. The set is read from `input.container.env.static.NAS_FORWARD_PORTS`,
not from `profile.network.proxy.forwardPorts`: ProxyStage unions the profile's
ports with the observability receiver port before binding them
(`proxy/stage.ts:156-163`) and writes the result to that variable (`:189`), so
the profile alone under-reports. Reading the env avoids adding an
`observability` slice to DindStage's `needs` (`dind/stage.ts:152`).
`LOCAL_PROXY_PORT` currently lives in `proxy/stage.ts:59`; rather than import
one stage module from another, it moves to a shared constants module.

The agent also inherits the sidecar's hostname and `/etc/resolv.conf`, so
`hostname` inside the agent returns the sidecar's container id. Nothing in
`src/` reads the agent's hostname, but it is visible in shell prompts and in
anything that derives an identifier from it.

## Security Consequences

Namespace sharing exposes no nas-owned service to containers the agent starts.
`local-proxy.mjs` binds only `127.0.0.1`, and a loopback-bound listener in the
shared namespace was measured as unreachable from an inner container, both
through rootlesskit's disabled host loopback and through the namespace's
external address.

It does change what an agent-started listener is exposed to. A dev server the
agent runs on `0.0.0.0` is today reachable only from the session network; under
the new wiring an inner container reaches it through the sidecar's session
network address. The README's table of what each setting relaxes
(`README.md:827`) is updated for the `docker.enable` row.

## Recorded, Not Fixed

While verifying the design, the sidecar was found to publish its daemon on
`0.0.0.0:2375` inside its own namespace (`rootlesskit ... -p
0.0.0.0:2375:2375/tcp`). A container started inside DinD can therefore reach the
full Docker API at the sidecar's session-network address; listing containers
from an inner Alpine container succeeded.

This is defense-in-depth rather than an escalation. Under the threat model in
`docs/todo/security.md:53-66` the agent is the adversary, and the agent already
holds unrestricted access to the same daemon through `DOCKER_HOST`. The
containers that gain the reach are ones the agent started. It matters when the
agent runs a third-party image it does not control, and no path from the
rootless daemon to the host was demonstrated: the daemon's root maps to uid 1000
inside the sidecar, and the sidecar's outer `--privileged` does not extend to
that uid.

The finding is recorded in `docs/todo/security.md` in those terms, together with
the observation that namespace sharing permits the fix — once the agent reaches
the daemon on loopback, the publish can be narrowed to `127.0.0.1:2375:2375` and
the inner route disappears. Making that change is left to separate work so that
the verification it needs does not gate this one.

## Testing

Unit tests cover the pure surface: `compileLaunchOpts` emitting
`--network container:` and suppressing `--add-host` in that mode and expanding
`extraHosts` in network mode, `planDind` replacing the attachment and the
`DOCKER_HOST` value, `planDind` leaving a user-supplied
`TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` intact, `buildDindSidecarArgs`
expanding `extraHosts`, `isUnusedNasSidecar` treating a namespace joiner as a
user of its sidecar, and `validate` rejecting `enable = true` with
`shared = true` while accepting `enable = false` with `shared = true`.

`src/stages/dind/integration_test.ts` gains a case asserting that a container
joined to the sidecar's namespace sees a published port on `127.0.0.1`. It
follows the existing file's `skipIf` guard, which already requires Docker and
user-namespace support, and cleans up in `finally`. The existing file derives a
fixed container name from a fixed session id (`:81`, `stage.ts:101-103`),
against the test policy's rule on generated names; the new case passes a random
session id rather than extending that pattern.

## Files Affected

- `src/pipeline/state.ts` — `NetworkAttachment` union, `ContainerPlan.extraHosts`
- `src/pipeline/container_plan.ts` — union-aware merge, append-merge for `extraHosts`
- `src/stages/launch/stage.ts` — `compileLaunchOpts` branching and expansion
- `src/stages/proxy/stage.ts` — record `extraHosts` instead of formatting a flag
- `src/stages/dind/stage.ts` — attachment override, `DOCKER_HOST`, reaper env, forward `extraHosts`, drop `NAS_DIND_CONTAINER_NAME` and the `no_proxy` append
- `src/stages/dind/dind_service.ts` — drop `shared` from `DindSidecarOpts` (`:16-26`) and `DindTeardownOpts` (`:40-46`) and from the two forwarding sites (`:60-63`, `:78-80`), add `extraHosts` and the joiner name
- `src/docker/dind.ts` — `extraHosts` expansion at all three `runDindSidecar` calls, socket-path constant, shared-mode removal, joiner check in teardown
- `src/docker/nas_resources.ts` — remove `NAS_SHARED_LABEL`, keep the legacy name matchers
- `src/docker/client.ts` — expose container id and `HostConfig.NetworkMode`
- `src/container_clean.ts` — recognize namespace joiners
- a shared constants module — new home for `LOCAL_PROXY_PORT`
- `src/config/Schema.pkl`, `src/config/types.ts`, `src/config/validate.ts` — deprecate the field, reject `enable && shared`
- `.nas/config.pkl` — drop `shared = true`
- `README.md` (`:269`, `:576`, `:818`, `:827`), `docs/todo/security.md`

`src/domain/container/lifecycle_service.ts:108-111` needs no edit: its
`ContainerCleanBackend` adapter passes `DockerContainerDetails` through
untouched, as does `DockerService.inspect` (`src/services/docker.ts:152`,
`:305-309`).

The new fields on `DockerContainerDetails` and the `mode` discriminant are both
required rather than optional, so the compiler locates every construction site.
That reaches further than the production files above:

- `network: { name: ... }` literals — `src/pipeline/types_test.ts:282`,
  `src/pipeline/container_plan_test.ts:124-133`,
  `src/stages/dind/stage_test.ts:274`, `:305`,
  `src/stages/launch/stage_test.ts:29`, `:67`, `:275`, `:285`, `:296`, `:327`
- `toEqual({ name: ... })` assertions — `src/stages/proxy/stage_test.ts:797-799`, `:880-882`
- `ContainerPlan` literals gaining `extraHosts` — `emptyContainerPlan`
  (`src/pipeline/container_plan.ts:46-59`), `ContainerPatch` and its
  merge-semantics comment (`:22-39`), `types_test.ts:259`, `:274`,
  `launch/stage_test.ts:309`, `src/stages/observability/integration_test.ts:222`
- `DockerContainerDetails` fixtures — the fake `inspect` default
  (`src/services/docker.ts:442-449`), the helpers in
  `src/container_clean_test.ts` (`createManagedContainer` at `:241`,
  `createManagedNetwork` at `:258`), and any of
  `src/domain/container/service_test.ts`,
  `src/domain/container/lifecycle_service_test.ts`,
  `src/stages/proxy/proxy_service_test.ts`, `src/ui/data_test.ts` that build the
  type — the implementer resolves these from compiler output rather than from
  this list
- shared-mode and DinD tests — `src/stages/dind/stage_test.ts:149-190`, `:208`,
  `:360-390`, `src/stages/dind/integration_test.ts:405-416`

`src/cli/pipeline_state.ts:15` spreads `emptyContainerPlan` and needs no edit.

## Why — なぜこのアプローチを選んだか

Testcontainers breaks in three places under the current wiring: mapped ports
live on the sidecar's hostname rather than localhost, the Ryuk reaper cannot
find a Docker socket to mount, and bind mounts resolve on the daemon's
filesystem. Namespace sharing is the only one of the considered options that
fixes the first — the structural one — without weakening the agent container's
own confinement, and it does so with a change contained to the pipeline's
network wiring. The measurement pass confirmed each load-bearing assumption
before the design was written, including the two that would have invalidated it
(`--add-host` propagation and port visibility on the joiner's loopback).

The `extraHosts` refactor is included because relocating the flag is
unavoidable. The `container clean` repair is included because the new wiring
breaks its only signal for whether a sidecar is in use, and shipping the two
apart would leave a window in which cleaning removes live sessions.

## Why Not — なぜ他の案を選ばなかったか

- **Nested rootless dockerd inside the agent container** — This is the most
  transparent option, since the daemon would share the agent's mount namespace
  and fix bind mounts too. It requires unprivileged user namespaces in the agent
  container, which the default seccomp profile blocks: `unshare(CLONE_NEWUSER)`
  returns EPERM under `Seccomp: 2` with AppArmor `docker-default` enforcing.
  Enabling it means running the agent container with relaxed seccomp and
  AppArmor, which weakens the confinement of the exact process nas exists to
  sandbox. Rejected on that trade alone.

- **Environment-variable compatibility layer only** — Setting
  `TESTCONTAINERS_HOST_OVERRIDE` and the socket override, and documenting
  `/tmp/nas-shared`, would make Testcontainers usable without touching the
  network wiring. It was rejected because it addresses one framework by name
  while leaving every other tool that assumes a local daemon broken, and because
  it leaves `getHost()` returning a hostname that only resolves inside the
  session network. The socket override survives into this design; the rest does
  not.

- **`extraHosts` on `ProxyState`** — Reads as the natural home for something
  ProxyStage produces, and was the first choice. Rejected because
  `compileLaunchOpts` receives only a `ContainerPlan` and LaunchStage declares
  no `proxy` dependency, so it would have widened LaunchStage's slice
  requirements to carry data that describes the container being launched.

- **Keeping `docker.shared` alongside namespace sharing** — Rejected as
  incoherent rather than merely awkward. Sessions sharing one namespace would
  see each other's loopback services, which is the isolation boundary the
  sandbox is built on.

- **Exposing the daemon over a Unix socket instead of TCP** — This would suit
  tools that expect `unix:///var/run/docker.sock`. `rootlesskit --copy-up=/run`
  places the socket in its own mount namespace, so publishing it to the agent
  requires machinery that namespace sharing makes unnecessary: with the daemon on
  loopback, `tcp://127.0.0.1:2375` already behaves like a local endpoint.
