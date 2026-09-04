# DinD Session Data and Shared Pull Cache

**Status:** Draft

**Date:** 2026-09-04

## Purpose

Concurrent `docker.enable = true` sessions currently mount the same Docker
named volume, `nas-docker-cache`, at
`/home/rootless/.local/share/docker` in every `docker:dind-rootless` sidecar.
That directory is not merely an image cache. It is the daemon's complete mutable
state, including containerd metadata. Two containerd processes therefore try to
open the same bbolt metadata database. bbolt takes an exclusive file lock, so
the second sidecar waits in `io.containerd.metadata.v1.bolt` until dockerd's
containerd startup deadline expires.

This design gives every DinD daemon its own state volume while preserving the
useful part of sharing: Docker Hub image pulls. Public Docker Hub content is
shared through a Distribution pull-through cache whose storage is independent
of every daemon's mutable metadata.

## Goals

- Two or more DinD sessions can start concurrently without sharing containerd
  state or contending on its metadata lock.
- DinD's data directory remains on a Docker volume so the inner overlayfs
  upper/work directories do not live in the outer container's overlay layer.
- Public Docker Hub pulls can reuse blobs and manifests fetched by another
  session.
- Cache misses continue through the requesting session's authenticated network
  proxy and its normal allow/review policy.
- No registry-mirror process remains running when no DinD session needs one.
- Normal teardown and `nas container clean` remove session-owned state without
  deleting the shared pull cache.

## Non-goals

- Sharing build cache, inner containers, containerd metadata, or other DinD
  daemon state between sessions.
- Caching private Docker Hub repositories or forwarding Docker credentials to
  the registry mirror.
- Caching registries other than Docker Hub.
- Adding a user-facing cache size, TTL, or purge setting in this change.
- Making the shared cache a security boundary. It is an optimization containing
  public, content-addressed registry data on the user's Docker host.

## Root Cause

`DIND_CACHE_VOLUME` in `src/docker/dind.ts` names one process-global volume,
and `buildDindSidecarArgs` mounts it at `DIND_DATA_DIR`. The name "cache"
obscures that Docker owns the whole directory. With containerd's image store
enabled, that includes
`containerd/daemon/io.containerd.metadata.v1.bolt/meta.db`.

containerd v2.3.3 opens that database through bbolt with no finite lock timeout.
bbolt permits multiple readers but only one read-write process and obtains an
exclusive lock when opening a writable database. The observed startup sequence
is consequently deterministic:

1. Session A's containerd opens `meta.db` and keeps it open for its lifetime.
2. Session B mounts the same volume and blocks opening the same database.
3. containerd logs `waiting for response from boltdb open` after ten seconds.
4. dockerd gives up after its containerd startup timeout and exits.

The current recovery path makes the symptom more confusing. It attempts to
remove `nas-docker-cache` while session A still uses it, suppresses the volume
removal failure, then starts the next attempt with the same volume while calling
it a "fresh cache". The eventual no-volume attempt avoids the lock but puts
DinD's overlayfs state back into the outer container overlay.

The `modprobe`, Tini, fsverity, EROFS, and `/opt/containerd` messages in the
reported log are warnings or skipped plugins. The fatal chain is the bbolt open
wait followed by `failed to start containerd: timeout waiting for containerd to
start`.

## Selected Architecture

Each DinD session owns two ephemeral volumes and one companion mirror container.
All sessions share only the registry cache volume:

```text
nas-dind-<session>                         nas-registry-mirror-<session>
  /home/rootless/.local/share/docker         /var/lib/registry
             |                                      |
  nas-dind-data-<session>                   nas-registry-cache
                                                    |
                                            session proxy + token
                                                    |
                                              Docker Hub only
```

For two concurrent sessions the data flow is:

```text
DinD A -> mirror A -> proxy A -> Docker Hub
              |
              +------ nas-registry-cache ------+
                                                |
DinD B -> mirror B -> proxy B -> Docker Hub     |
              |                                 |
              +---------------------------------+
```

There is no global registry process. A mirror container is session-scoped so a
cache miss carries that session's proxy endpoint, bearer token, CA trust, and
network policy. Distribution explicitly supports multiple pull-through caches
over one storage backend; simultaneous misses may duplicate an upstream fetch,
but the shared storage remains the cache boundary rather than a daemon database.

### Resource names and labels

| Resource | Lifetime | `nas.kind` | Name |
|---|---|---|---|
| DinD container | session | `dind` | `nas-dind-<sessionId>` |
| DinD data volume | session | `dind-data` | `nas-dind-data-<sessionId>` |
| shared tmp volume | session | `dind-tmp` | `nas-dind-tmp-<sessionId>` |
| registry mirror container | session | `registry-mirror` | `nas-registry-mirror-<sessionId>` |
| registry cache volume | persistent | `registry-cache` | `nas-registry-cache` |

`nas-registry-cache` is a named volume, not a process. It persists when the
last session exits so later sessions retain pulled content. A
`nas-registry-mirror-*` process exists only while its DinD session exists (or
while abnormal-exit cleanup has deliberately preserved the session resources).

### DinD data volume

The data volume is mandatory, including tests that disable the pull cache. It
is not described or toggled as a cache: its purpose is filesystem correctness
and session isolation. `buildDindSidecarArgs` always mounts the session-specific
volume at `DIND_DATA_DIR`.

The current `disableCache` test option is renamed to `disablePullCache`. The new
option suppresses the registry mirror only; it never suppresses the DinD data
volume. Integration tests use unique session resource names and clean them up.

If DinD cannot start with its existing session data volume, nas may stop and
remove that session's DinD container, remove and recreate only
`nas-dind-data-<sessionId>`, and retry once. Failure to remove the data volume is
fatal and is reported as such; nas must not claim the retry uses fresh state
after a suppressed removal failure. There is no fallback that runs DinD without
a data volume.

### Pull-through mirror

The companion uses the official `registry:2` image in pull-through-cache mode:

- `REGISTRY_PROXY_REMOTEURL=https://registry-1.docker.io`
- `REGISTRY_STORAGE_FILESYSTEM_ROOTDIRECTORY=/var/lib/registry`
- no `REGISTRY_PROXY_USERNAME` or `REGISTRY_PROXY_PASSWORD`
- `HTTP_PROXY` and `HTTPS_PROXY` set to the session's token-bearing proxy URL
- `NO_PROXY` limited to loopback and the mirror itself
- the proxy CA certificate mounted as a single read-only file, with
  `SSL_CERT_DIR` pointing at its mount directory
- `nas-registry-cache` mounted at `/var/lib/registry`

The mirror starts directly on the internal session network. It is never started
on the default bridge, even transiently, because that would create a direct
egress path around the session proxy. The unique container name is also its DNS
name on that network, so no global alias or port publication is required.

DinD receives:

```text
--registry-mirror=http://nas-registry-mirror-<sessionId>:5000
--insecure-registry=nas-registry-mirror-<sessionId>:5000
```

as dockerd arguments. The second flag authorizes plaintext HTTP only for the
internal mirror endpoint. The mirror's upstream leg remains HTTPS through the
session proxy. Docker's registry mirror mechanism applies only to Docker Hub;
fully qualified pulls from other registries continue directly through dockerd's
existing proxy configuration.

Pull-through mode rejects pushes, and no Docker credentials are mounted into
the mirror. A cache hit performs no external request, so it does not create a
new per-session network authorization event. This is inherent in sharing a
host-local pull cache and is accepted for public Docker Hub content.

## Lifecycle and ordering

`DindService` owns the DinD container, registry mirror, DinD data volume, and
shared tmp volume as one acquired resource. The registry cache volume is
created/ensured by that service but is not session-owned.

Acquisition order is:

1. Create or ensure the session tmp volume, session DinD data volume, and shared
   registry cache volume with their nas labels.
2. Start the per-session mirror directly on the already-created internal
   session network and wait for it to be usable.
3. Start DinD with the mirror arguments when step 2 succeeded, otherwise start
   DinD without them.
4. Wait for DinD readiness, make shared tmp writable, connect DinD to the
   session network, and sever its default bridge as today.

The mirror is an optimization, not a prerequisite for Docker. Failure to start
or ready the mirror is logged, its partial container is removed, and DinD starts
without a mirror. If a running mirror later becomes unavailable, dockerd falls
back to Docker Hub directly; that request still uses dockerd's session proxy and
CA configuration. DinD failures remain fatal.

If acquisition fails after creating any session resource, the acquisition path
removes its partial DinD and mirror containers and both session volumes. The
persistent registry cache is retained. This explicit rollback is required
because an `Effect.acquireRelease` finalizer is not registered when acquisition
itself fails.

Normal release runs after the agent exits:

1. Stop and remove DinD so it cannot issue more mirror requests.
2. Stop and remove the session mirror.
3. Remove the session tmp and DinD data volumes.
4. Leave `nas-registry-cache` untouched.

The existing abnormal-exit guard remains keyed to the joining agent container.
If that agent is still running, release preserves DinD, the mirror, and both
session volumes together. Removing only the namespace-owning DinD container
would destroy the agent's network, while removing only the mirror would change
Docker behavior mid-session. `nas container clean` collects the group after the
agent exits.

## Cleanup behavior

`isNasManagedSidecar` recognizes `registry-mirror` in addition to `dind` and
`proxy`. The existing namespace-joiner usage index already credits the running
agent to every container on its DinD owner's session network. That keeps both
the shared proxy and the session mirror alive while the agent is alive. Once the
agent exits, the cleaner removes the unused DinD and mirror containers.

Volume cleanup distinguishes ephemeral nas volumes from persistent cache
volumes:

- `dind-tmp` and `dind-data` are removed when no container uses them.
- legacy `nas-docker-cache` is recognized and removed once no old sidecar uses
  it; it is never attached to a new sidecar.
- `registry-cache` is deliberately excluded from automatic cleanup.

The settings UI adds `registry-mirror` to its sidecar kinds so the new process
is visible and can be stopped consistently with existing sidecars. Stopping it
does not stop the session; subsequent Docker Hub pulls fall back to the direct
proxied path.

## Security properties

- Mutable Docker/containerd state is isolated by session.
- The registry cache contains public Docker Hub registry data only. No private
  registry credentials or proxy token are stored in its configuration volume.
- Every upstream cache miss uses the requesting session's internal network and
  authenticated proxy. The mirror has no default-bridge escape path.
- The proxy CA mount contains only the certificate file. Its sibling directory,
  which also contains the CA private key, is never mounted.
- The only plaintext registry hop is from DinD to its mirror on the internal
  session network. Upstream Docker Hub traffic remains TLS-protected and proxy
  mediated.
- Distribution verifies content digests and exposes pull-through cache behavior,
  not a writable registry. Sharing therefore does not permit a session to push
  arbitrary image content for another session to consume.

## Error reporting

Messages distinguish the three state categories:

- "DinD data volume" for `nas-dind-data-*` failures;
- "registry pull cache" for mirror/container/cache-volume failures;
- "shared tmp volume" for `nas-dind-tmp-*` failures.

No retry is called "fresh" until the old session data volume was successfully
removed and recreated. A registry-cache failure warns and falls back. A
session-data failure fails the DinD stage after its single clean retry.

## Tests

Unit coverage includes:

- sidecar arguments always mount the session data volume, regardless of
  `disablePullCache`;
- mirror dockerd flags appear only when the mirror started successfully;
- mirror environment, CA file mount, internal-network attachment, shared cache
  mount, labels, and absence of credentials;
- startup rollback removes partial session resources but keeps
  `nas-registry-cache`;
- data reset removes only `nas-dind-data-<sessionId>` and never the registry
  cache;
- teardown preserves the full DinD/mirror/session-volume group while the agent
  joiner runs and removes it after the joiner exits;
- `nas container clean` preserves an active session mirror, removes an orphaned
  mirror and data volume, retires an unused legacy `nas-docker-cache`, and never
  deletes `nas-registry-cache`;
- the settings sidecar view accepts `registry-mirror`.

Integration coverage uses unique resource names and verifies:

1. two DinD sidecars start concurrently with distinct data volumes;
2. both become ready without `boltdb open` contention;
3. the first session's public Docker Hub pull populates the shared cache;
4. the second session can pull the same image through its own mirror while
   reusing cached registry content;
5. teardown removes both session data volumes and both mirror containers but
   leaves `nas-registry-cache`.

The final repository check follows `AGENTS.md`: unit tests during iteration,
`bun run check`, then one full `bun run test` at the end.

## Alternatives considered

### Keep sharing the DinD data directory

Rejected. It shares a live database and the entire daemon state, not just
immutable image content. No startup retry can make concurrent writers safe.

### Use only per-session DinD data volumes

This is the smallest correctness fix and remains the fallback behavior, but it
does not meet the requirement that pulls be shared between sessions.

### Run one global registry mirror process

Rejected. A global process has no unambiguous requesting-session proxy token or
network-policy context for an upstream miss. Keeping one process always running
would also introduce a new daemon lifetime independent of nas sessions.

### Put DinD data in the outer container overlay

Rejected. It avoids the shared lock but nests the inner overlayfs state inside
the outer overlay layer and loses the explicit lifecycle and cleanup properties
of a named volume.

## References

- containerd v2.3.3 metadata plugin:
  <https://github.com/containerd/containerd/blob/v2.3.3/plugins/metadata/plugin.go>
- bbolt locking model: <https://github.com/etcd-io/bbolt/blob/main/README.md>
- Docker Hub pull-through cache:
  <https://docs.docker.com/docker-hub/image-library/mirror/>
- Distribution configuration:
  <https://distribution.github.io/distribution/about/configuration/>
- Docker volume lifecycle:
  <https://docs.docker.com/engine/storage/volumes/>
- `docker:dind-rootless` image definition:
  <https://github.com/docker-library/docker/blob/master/Dockerfile-dind-rootless.template>
