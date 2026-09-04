# Proxy CA for the DinD Sidecar

**Status:** Draft

**Date:** 2026-09-04

## Purpose

With `docker.enable = true`, the DinD sidecar's daemon is pointed at the session
proxy through `HTTP_PROXY` / `HTTPS_PROXY`, so that image pulls are subject to
the same allowlist as the agent's own traffic. The proxy is mitmproxy, which
terminates TLS and presents a certificate signed by its own CA. The sidecar is
never given that CA, so every pull fails:

```
failed to do request: Head "https://registry-1.docker.io/v2/library/alpine/manifests/3.19":
tls: failed to verify certificate: x509: certificate signed by unknown authority
```

The daemon can therefore run only images already in its cache volume, which
makes `docker.enable` far less useful than it reads.

This design gives the sidecar the proxy's CA certificate, and nothing else.

## Scope

The daemon's own registry pulls. Containers started *inside* DinD keep their
present state, which is no egress at all — that confinement was verified on
2026-06-12 and is deliberate, and nothing here changes it.

Out of scope:

- trusting the CA anywhere beyond the sidecar's daemon;
- any change to which hosts the allowlist permits;
- the agent container's own CA handling, which already works.

## Root Cause

The sidecar receives the proxy's address but not its certificate authority.

`buildDindSidecarArgs` (`src/docker/dind.ts:430-446`) mounts the cache volume,
the shared tmp volume and the `--add-host` entries. `buildDindSidecarEnv`
(`:413-425`) sets `DOCKER_TLS_CERTDIR=""` and the proxy variables. Neither
carries a certificate. Read from inside a live sidecar, the daemon's environment
holds `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and `DOCKER_TLS_CERTDIR`, and no
`SSL_*` variable at all.

The agent container, by contrast, receives `caCertMount`
(`src/stages/proxy/stage.ts:208-212`) at
`/usr/local/share/ca-certificates/nas-proxy.crt`, and its entrypoint runs
`update-ca-certificates`. Inside a live agent container the file is present, is
1172 bytes with no `PRIVATE KEY` block, and carries `subject=CN=mitmproxy,
O=mitmproxy`.

The gap dates to `3e37a75c feat(proxy): wire mitmproxy in ProxyStage with CA
cert and review rules` (2026-06-29), which introduced the CA service and the
agent's mount and touches no DinD file. Before it the proxy was Envoy, which
tunnels CONNECT without terminating TLS and so needed no CA on either side; the
migration to mitmproxy fixed the agent and missed the sidecar. The "daemon pull
succeeds" verification recorded in `docs/todo/security.md` predates that commit
by seventeen days.

## The Private Key Constraint

`ensureCaCert` (`src/stages/proxy/ca_service.ts:47-89`) generates the CA by
running mitmproxy's `CertStore.from_store` against `caCertDir`. In mitmproxy
v11.0.2 that store writes the certificate alone to `mitmproxy-ca-cert.pem`,
`-ca-cert.cer` and `-ca-cert.p12`, and the certificate **together with its
private key** to `mitmproxy-ca.pem` and `mitmproxy-ca.p12`. The p12 is not
encrypted.

Mounting the directory would put those key files inside a container the agent
fully controls. That the agent can read them is not a hypothesis: from inside a
live session, `docker run -v /:/sidecar` against `DOCKER_HOST` exposes the
sidecar's entire root filesystem to a container the agent starts. The 0600 mode
`create_store` writes offers no protection either — the sidecar's `rootless`
user is uid 1000 and the host daemon runs without userns remapping, so it is the
same uid that owns the files.

`security-constraints` C1 settles it without needing a threat narrative: secrets
are not mounted into containers, and a CA private key is a secret. What the key
would additionally buy an attacker is a certificate for any host that some
client trusts — every one of this user's agent containers, for as long as the
runtime directory lives, plus the sidecar itself after this change, and the host
too if the user has ever added this CA to their own trust store for debugging.

This design mounts the certificate file and never the directory.

Note that the agent container's existing single-file mount was not chosen for
this reason. `2026-06-29-mitmproxy-replacement-design.md` and commit `3e37a75c`
give a mechanical one: `update-ca-certificates` reads `*.crt` files out of
`/usr/local/share/ca-certificates/`. Keeping the key out of the container is a
consequence of that choice rather than its motive. Here it is the motive.

## Verified Behavior

Go's `crypto/x509` reads `SSL_CERT_DIR` as a source of trust roots, and a
directory holding only the mitmproxy certificate suffices to verify a connection
the proxy has terminated. Measured with a Go binary inside a live agent
container:

| Environment | Result |
|---|---|
| `SSL_CERT_FILE=/dev/null SSL_CERT_DIR=/nonexistent` | `x509: certificate signed by unknown authority` |
| `SSL_CERT_FILE=/dev/null SSL_CERT_DIR=/usr/local/share/ca-certificates` | request succeeds |

The first row reproduces the sidecar's failure exactly, which corroborates the
root cause. The second shows one certificate in a directory is enough.

`SSL_CERT_FILE` stays unset in the sidecar, so Go continues to read the image's
own certificate bundle as well. `loadSystemRoots` (go1.26.5,
`crypto/x509/root_unix.go`) reads its file list and its directory list
independently, and `SSL_CERT_DIR` replaces only the directories; Alpine 3.24
provides both `/etc/ssl/certs/ca-certificates.crt` and `/etc/ssl/cert.pem` from
the default file list.

The sidecar runs Docker 29.6.2 with the containerd image store active
(`Storage Driver: overlayfs`, `driver-type:
io.containerd.snapshotter.v1`), so the process performing the pull may be
containerd rather than dockerd. That does not change the answer: containerd is
started by dockerd and inherits its environment, and the two processes' `environ`
read identically from inside a privileged container. Both are Go. This differs
from the 2026-06-12 environment and is worth recording.

`SSL_CERT_DIR` reaches Go programs only. OpenSSL-based tools in the sidecar —
busybox's `ssl_client`, for one — expect hash-named symlinks and will not pick
the certificate up, and setting the variable displaces OpenSSL's default
directory while leaving its default file in place. That is consistent with a
scope limited to the daemon's pulls, and nothing here should be read as making
`wget` inside the sidecar work.

## Design

### The certificate path is shared, not re-derived

`${caCertDir}/mitmproxy-ca-cert.pem` is currently spelled out twice, at
`ca_service.ts:49` and `proxy/stage.ts:209`. Publishing it on the pipeline state
would make three. A pure helper beside the other path builders in
`src/network/registry.ts` gives the file one definition, so that the file the CA
service guarantees and the file the sidecar mounts cannot drift apart.

### ProxyState carries the path

```ts
export interface ProxyState {
  readonly brokerSocket: string;
  readonly proxyEndpoint: string;
  readonly caCertPath: string;
}
```

A file path rather than the directory, deliberately. The directory holds the
private key, so exposing it on the state would let a later consumer mount it
without noticing what else comes along. What the state offers is what is safe to
pass.

`ProxyState` is the right home here, unlike the proxy alias mapping, which lives
on `ContainerPlan` (`state.ts:172`) because it describes the agent container
being launched. This path describes the session's proxy and is consumed by
DindStage, which already declares `proxy` in its `needs`
(`src/stages/dind/stage.ts:187`). `compileLaunchOpts` never reads it, so it does
not widen LaunchStage's slice requirements (`launch/stage.ts:148`) the way that
one would have.

### The mount uses `--mount`, not `-v`

This is the part that governs the shape of everything below it.

Given `-v <source>:<target>` where `<source>` does not exist, Docker does not
fail. It creates a directory at the source path and mounts that. Measured
against the live sidecar: the container saw `/etc/nas-ca/nas-proxy.crt` as a
`directory`, and an empty directory was left behind at the source.

The consequences are worse than a missing certificate. Go's `os.ReadFile` fails
on a directory, so trust would be lost silently — precisely the state that must
not be reachable without a signal. And the leftover directory would be named
`mitmproxy-ca-cert.pem`, which makes `ensureCaCert`'s existence check
(`ca_service.ts:49-52`) return true from then on, so the CA would never be
regenerated and the agent container's own mount would break with it.

`dockerRunDetached` already takes a `mounts` option
(`src/docker/client.ts:317-325`, `:340-356`) that encodes
`--mount type=bind,src=…,dst=…,readonly`. That form refuses a missing source
with `invalid mount config for type "bind": bind source path does not exist` and
exit 125. With the source present it creates the parent directory in the
container and mounts the file.

So the certificate does not travel as an entry in `buildDindSidecarArgs`. It
travels as a `mounts` entry that `runDindSidecar` (`dind.ts:385-402`) passes to
`dockerRunDetached`, and the pure surface under test is the function that builds
that entry.

### The rest of the path

`buildDindSidecarEnv` sets `SSL_CERT_DIR` to the mount's parent directory.
`DIND_CA_MOUNT_PATH` is declared beside `DIND_IMAGE` in `src/docker/dind.ts`.
The requirement on that path is that nothing else lives in it, because Go reads
every file in the directory; a path the image does not otherwise use satisfies
it.

`startDindSidecar` and `runDindSidecar` currently take `proxyEndpoint` as a
positional string. Adding `caCertPath` beside it would put two strings in a row
that no type can tell apart across the three call sites (`dind.ts:99`, `:132`,
`:165`). The two travel together and are both properties of the session's proxy,
so they become one object parameter rather than two positionals.

## Testing

Unit tests cover the pure surface: the mount entry built for a given certificate
path, and `buildDindSidecarEnv` setting `SSL_CERT_DIR` to the mount directory.

One test guards the private-key constraint, and it has to be written carefully to
mean anything. Asserting `not.toContain(dirname(caCertPath))` over an argument
array passes trivially, because `-v ${dir}:${target}` is a single joined string
that contains the directory without equalling it. The assertion instead parses
the mount specifications, extracts their sources, and requires that exactly one
source equals the certificate path and that none equals its parent directory.
This guards the mounts this code builds; a directory mount introduced through
some other channel would not be caught here.

The integration test cannot use the existing DinD harness. That file passes the
sidecar a dummy `proxyEndpoint` (`integration_test.ts:134`), stands up no proxy
container and no `nas-proxy` name, and severs the bridge — which is why it
side-loads images with `docker save | docker load` and says so at `:180-184`.
Driving a real session proxy would mean standing up mitmproxy and the token-
verifying session broker as well.

Instead the case follows the standalone `mitmdump --mode regular@8080` pattern
already used at `src/docker/mitmproxy/nas_addon_integration_test.ts:586-640`,
without the addon: start mitmproxy with a temporary directory as its `confdir`,
point the sidecar's `HTTPS_PROXY` at it, and assert that `docker pull alpine:3.19`
succeeds with the certificate mounted and fails with `x509` without it. The
negative control is what makes the positive one mean something. It lives under
the file's existing `skipIf` guard and cleans up in `finally`.

Note that `RUNNING_ON_HOST_DOCKER = !process.env.DOCKER_HOST`
(`integration_test.ts:178`) skips every Docker case in that file when the suite
runs inside a nas session, so this case runs only on the host.

The end-to-end confirmation is manual, because it needs a full session: restart
nas with `docker.enable = true` and run `docker pull alpine:3.19` inside the
agent. The spec is amended with the result.

## Files Affected

- `src/network/registry.ts` — pure `caCertFilePath(paths)` helper
- `src/stages/proxy/ca_service.ts`, `src/stages/proxy/stage.ts` — use the helper; publish `caCertPath`
- `src/pipeline/state.ts` — `ProxyState.caCertPath`
- `src/stages/dind/stage.ts` — carry it into `DindPlan`
- `src/stages/dind/dind_service.ts` — `DindSidecarOpts`
- `src/docker/dind.ts` — `DIND_CA_MOUNT_PATH`, the mount entry, `SSL_CERT_DIR`, the object parameter, the three call sites
- `README.md` — the `docker.enable` section, which currently says nothing about registry access
- `docs/todo/security.md` — record that the sidecar now holds the certificate and deliberately not the key
- Tests: `src/stages/dind/stage_test.ts`, `src/stages/proxy/stage_test.ts` (`:361`), `src/pipeline/types_test.ts` (`:210-213`, `:326-329`), `src/cli_test.ts` (`:317`, `:343`), `src/stages/dind/integration_test.ts`

The last two files hold `ProxyState` literals that a required field breaks; the
compiler is the authority on whether others exist.

## Why — なぜこのアプローチを選んだか

`SSL_CERT_DIR` needs no root, no entrypoint override and no package in an image
this project does not control, and it was measured to work before the design was
written rather than reasoned about. The change is one mount and one variable.

Mounting the certificate as a file, never the directory, is what keeps the CA's
private key out of a container the agent commands. That constraint shaped
`ProxyState.caCertPath` as much as it shaped the mount.

Using `--mount` rather than `-v` is not a stylistic preference. `-v` turns a
missing certificate into a silently untrusted daemon and a poisoned CA directory
that stops the certificate from ever being regenerated; `--mount` turns it into
an immediate, named failure.

## Why Not — なぜ他の案を選ばなかったか

- **`update-ca-certificates` inside the sidecar, as the agent container does** —
  It would cover every tool in the sidecar rather than only Go ones. Rejected
  because `docker:dind-rootless` runs as the `rootless` user and cannot write
  `/etc/ssl/certs`, which is root-owned, so it would need the container started
  as root plus a wrapper around an entrypoint this project does not own —
  brittle across image updates, in exchange for coverage the stated scope does
  not need.

- **Per-registry certificates under `/etc/docker/certs.d/<host>/ca.crt`** — The
  daemon's documented mechanism for registry TLS, and it needs no environment
  variable. Rejected because the directories are keyed by registry hostname, so
  it would need an enumerated list kept in step with `network.allowlist`, and a
  registry missing from that list fails exactly the way this bug already does.
  More configuration for less coverage.

- **Mounting the whole `caCertDir`** — The obvious shape, and the reason this
  spec says as much as it does about the private key. Rejected outright: it
  hands the agent the CA's private key.

- **Disabling certificate verification in the sidecar** — Fastest to write and
  it would make pulls work. Rejected because it would remove the guarantee that
  a pull reached the registry the daemon believes it reached, in a component
  whose whole purpose is to be confined.
