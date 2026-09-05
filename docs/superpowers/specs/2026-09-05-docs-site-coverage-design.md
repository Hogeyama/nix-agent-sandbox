# Docs Site Coverage for Port Binding and DinD

**Status:** Approved

**Date:** 2026-09-05

## Context

The searchable user guide was introduced in `dfe70ae4`. Later changes added
container-to-host port binding and replaced shared DinD daemon state with
session-local state plus a persistent Docker Hub pull cache. The guide did not
follow those changes completely. It also retained instructions for
`docker.shared = true`, even though that combination is rejected when DinD is
enabled.

This update covers only those three confirmed gaps. It does not document the
Codex shell-environment compatibility override or Testcontainers defaults.

## Port binding documentation

Add a dedicated `features/port-bind.md` page rather than combining both traffic
directions under the existing localhost forwarding page. The two features have
different configuration and lifecycles:

- `network.proxy.forwardPorts` exposes a host loopback service to a container.
- `nas network bind` exposes a container service on host loopback at runtime.

The new page will cover CLI syntax, listing and JSON output, interactive
selection from detected listeners, UI controls, host-port selection, listener
reachability, and automatic teardown with the session. The existing forwarding
page and relevant network, UI, and security pages will link to it.

The security explanation will state that the listener is limited to
`127.0.0.1`, but content controlled by the agent is then opened under a host
loopback origin. Such content can send requests to other loopback services, so
users must not treat loopback alone as an authorization boundary.

## DinD state and pull cache documentation

Rewrite the Docker page around the current model:

- DinD daemon and mutable containerd state are session-local.
- A session-scoped `registry-mirror` sidecar serves Docker Hub pulls.
- Public Docker Hub blobs and manifests are shared through the persistent
  `nas-registry-cache` volume.
- Cache misses use the requesting session's network proxy and authorization;
  cache hits make no upstream request and therefore create no new approval.
- Session teardown and `nas container clean` remove disposable session
  resources but deliberately retain the registry cache.

The maintenance, risk, limitations, recommendations, and UI pages will use the
same lifecycle terminology. The UI page will list `registry-mirror` as a
sidecar kind.

## Deprecated shared mode

Remove all guidance that presents `docker.shared = true` as usable. Document
the field only as a deprecated compatibility field that must remain `false`
when `docker.enable = true`. Security guidance will distinguish the shared
public pull cache from the removed shared-daemon mode.

## Navigation and cleanup

Add the port-binding page next to localhost forwarding in the sidebar and add
cross-links from both direction-specific pages. Remove
`docs/todo/port-bind-docs.md` after its requirements are represented in the
user guide.

## Verification

Run `bun run docs:check` and `bun run docs:build`. Search the authored and
generated documentation for stale claims that shared DinD mode is available,
and confirm that `nas network bind`, `nas network unbind`,
`nas-registry-cache`, and `registry-mirror` appear in the generated site.
