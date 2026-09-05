# Docs Site Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the user guide discover container-to-host port binding and accurately describe current DinD state, caching, cleanup, and deprecated shared mode.

**Architecture:** Give each traffic direction its own feature page, then connect those pages through navigation, UI guidance, and the security model. Treat DinD daemon state, session-scoped mirror processes, and the persistent public pull cache as three different lifecycle concepts everywhere they appear.

**Tech Stack:** Astro Starlight, Markdown/MDX, Bun documentation checks

## Global Constraints

- Cover only port binding, the DinD pull cache, and the incorrect `docker.shared` guidance.
- Do not add documentation for the Codex shell-environment override or Testcontainers defaults.
- Keep all user-facing prose in Japanese, matching the existing guide.
- Use `/nix-agent-sandbox/...` for root-relative documentation links.

---

### Task 1: Document container-to-host port binding

**Files:**
- Create: `docs-site/src/content/docs/features/port-bind.md`
- Modify: `docs-site/astro.config.mjs`
- Modify: `docs-site/src/content/docs/features/port-forwarding.md`
- Modify: `docs-site/src/content/docs/features/network.md`
- Modify: `docs-site/src/content/docs/features/ui.md`
- Modify: `docs-site/src/content/docs/security/model.md`
- Modify: `docs-site/src/content/docs/security/risks.md`
- Delete: `docs/todo/port-bind-docs.md`

**Interfaces:**
- Consumes: CLI behavior exposed by `nas network bind` and `nas network unbind`.
- Produces: A sidebar-visible `/features/port-bind/` route and cross-links from every adjacent concept.

- [ ] **Step 1: Confirm the missing authored coverage**

Run:

```bash
rg -n 'nas network (bind|unbind)' docs-site/src/content/docs
```

Expected: no matches.

- [ ] **Step 2: Add the dedicated feature page**

Create a Japanese page with these exact sections and facts:

```markdown
---
title: コンテナポート公開
description: コンテナ内の開発サーバーをホストの localhost で開く
---

## どんな機能？

`nas network bind` maps host `127.0.0.1:<host-port>` to a selected session's
container `127.0.0.1:<container-port>`. It is the reverse direction from
`network.proxy.forwardPorts` and requires no profile setting.

## CLI から操作する

Show explicit bind, automatic host-port selection, detected-listener selection,
list/JSON output, and both unbind key forms. Explain that an unavailable omitted
host port causes nas to try nearby ports, while an explicitly requested busy
port is an error.

## UI から操作する

Explain the selected session's `Ports · in` panel, suggestions, direct entry,
open link, and Unbind action.

## ライフサイクル

State that listeners live in the host nas process and all bindings close on
normal session teardown or process exit. Mention `nas network gc` for stale
runtime state, not as the normal close path.

## 注意点・セキュリティへの影響

State that the host listener is loopback-only, the exposed service is controlled
by the container, and browser-loaded content can send requests to other host
loopback services. State that bind has no network-approval queue; invoking the
host command from inside a container requires a separately authorized HostExec
rule.
```

- [ ] **Step 3: Add navigation and direction cross-links**

Add `{ label: "コンテナポート公開", slug: "features/port-bind" }` immediately
after localhost forwarding in `astro.config.mjs`. Add related-page links from
`features/port-forwarding.md` and `features/network.md`, explicitly labeling
the traffic directions.

- [ ] **Step 4: Add UI and security coverage**

Add the `Ports · in` panel to `features/ui.md`. Add a host-to-container relay
line to the route diagram in `security/model.md`. Add a separate risk-matrix
row with ID `port-bind`, activation `nas network bind` or UI Bind, host
`127.0.0.1:<host-port>` as the exposed resource, and the loopback-origin risk.

- [ ] **Step 5: Remove the resolved TODO and verify the route**

Delete `docs/todo/port-bind-docs.md`, then run:

```bash
bun run docs:check
bun run docs:build
```

Expected: both commands exit 0; `/features/port-bind/index.html` is generated.

- [ ] **Step 6: Commit the port-binding documentation**

```bash
git add docs-site/astro.config.mjs \
  docs-site/src/content/docs/features/port-bind.md \
  docs-site/src/content/docs/features/port-forwarding.md \
  docs-site/src/content/docs/features/network.md \
  docs-site/src/content/docs/features/ui.md \
  docs-site/src/content/docs/security/model.md \
  docs-site/src/content/docs/security/risks.md \
  docs/todo/port-bind-docs.md
git commit -m "docs(port-bind): explain container port publication"
```

### Task 2: Align DinD documentation with current state and cache lifecycles

**Files:**
- Modify: `docs-site/src/content/docs/features/docker.md`
- Modify: `docs-site/src/content/docs/operations/maintenance.md`
- Modify: `docs-site/src/content/docs/security/limitations.md`
- Modify: `docs-site/src/content/docs/security/model.md`
- Modify: `docs-site/src/content/docs/security/recommendations.md`
- Modify: `docs-site/src/content/docs/security/risks.md`
- Modify: `docs-site/src/content/docs/features/ui.md`

**Interfaces:**
- Consumes: `docker.enable`, deprecated `docker.shared`, session-scoped `registry-mirror`, and persistent `nas-registry-cache` behavior.
- Produces: One consistent lifecycle description across feature, operations, UI, and security pages.

- [ ] **Step 1: Locate stale shared-mode claims**

Run:

```bash
rg -n 'docker\.shared|shared DinD|共有 sidecar|dind.*proxy.*だけ|dind.*\/.*proxy' docs-site/src/content/docs
```

Expected: matches in the Docker, risks, recommendations, limitations, model,
and UI pages.

- [ ] **Step 2: Rewrite the Docker feature page**

Make these facts explicit:

```markdown
- `docker.enable = true` starts a session-specific DinD sidecar.
- `docker.shared` is a deprecated compatibility field; `true` with DinD enabled
  fails validation and users should remove it.
- Session teardown removes the DinD sidecar, its mutable data volume, its shared
  tmp volume, and its session-scoped `registry-mirror` process.
- Public Docker Hub blobs/manifests remain in `nas-registry-cache` for reuse by
  later sessions; private registries and mutable Docker/containerd state are not
  shared by this cache.
- A cache miss uses that session's proxy and authorization. A cache hit makes no
  upstream request and produces no new network approval.
- Mirror failure falls back to the direct proxied pull path.
```

- [ ] **Step 3: Correct operations, UI, and security pages**

In `operations/maintenance.md`, state that `nas container clean` removes unused
session sidecars and ephemeral volumes but deliberately keeps
`nas-registry-cache`. In `features/ui.md`, list `registry-mirror` alongside
`dind` and `proxy`. Replace shared-daemon warnings in security pages with the
session-state/shared-public-cache distinction and remove instructions to enable
or clean a shared DinD sidecar.

- [ ] **Step 4: Verify terms and generated output**

Run:

```bash
rg -n 'nas-registry-cache|registry-mirror|docker\.shared' docs-site/src/content/docs
bun run docs:check
bun run docs:build
rg -n 'nas network bind|nas network unbind|nas-registry-cache|registry-mirror' docs-site/dist
```

Expected: authored docs mention all current terms; `docker.shared` appears only
as deprecated/unsupported guidance; both documentation commands exit 0; all
four terms appear in generated HTML or Pagefind output.

- [ ] **Step 5: Commit the DinD documentation**

```bash
git add docs-site/src/content/docs/features/docker.md \
  docs-site/src/content/docs/operations/maintenance.md \
  docs-site/src/content/docs/security/limitations.md \
  docs-site/src/content/docs/security/model.md \
  docs-site/src/content/docs/security/recommendations.md \
  docs-site/src/content/docs/security/risks.md \
  docs-site/src/content/docs/features/ui.md
git commit -m "docs(dind): describe isolated state and shared pull cache"
```

### Task 3: Final documentation audit

**Files:**
- Verify only: all files changed in Tasks 1 and 2

**Interfaces:**
- Consumes: The complete authored user-guide update.
- Produces: Evidence that the site builds, navigation resolves, and stale claims are gone.

- [ ] **Step 1: Run final generated-site validation**

```bash
bun run docs:check
bun run docs:build
```

Expected: both commands exit 0 and generated-site validation reports success.

- [ ] **Step 2: Audit authored content and working tree**

```bash
rg -n 'nas network bind|nas network unbind|nas-registry-cache|registry-mirror' docs-site/src/content/docs
rg -n 'shared = true|共有 sidecar|shared DinD sidecar' docs-site/src/content/docs
git status --short
git log -3 --oneline
```

Expected: current feature terms have authored matches; stale positive guidance
for shared DinD mode has no matches; the working tree contains only the plan
file if it was not committed earlier; the two implementation commits are at
the tip.
