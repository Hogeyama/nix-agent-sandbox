# nas User Documentation Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 900-line README with a short entry point and publish a searchable, Japanese, user-focused Starlight site on GitHub Pages.

**Architecture:** Keep the public site under `docs-site/` so ADRs, TODOs, and implementation notes under `docs/` cannot enter the Pages artifact. Use Astro Starlight for the manual layout and Pagefind for Japanese search, keep dependencies in the existing root Bun package, and validate generated links, assets, and search artifacts with a small Bun unit-tested checker.

**Tech Stack:** Bun, TypeScript, Astro, Starlight, Pagefind, GitHub Pages, GitHub Actions

## Global Constraints

- Read `AGENTS.md` and `docs/superpowers/specs/2026-09-04-user-documentation-site-design.md` before changing files.
- Apply `skills/security-constraints/SKILL.md` to every statement about container, secret, socket, HostExec, DBus, and network boundaries.
- Apply `skills/test-policy/SKILL.md` to `src/docs/site_check_test.ts`; it must remain a Docker-free colocated Bun unit test.
- Follow `skills/git-commit/SKILL.md` for every task commit and record rationale that is not apparent from the diff.
- Use current code, `src/config/Schema.pkl`, and tests as the source of truth. Do not preserve obsolete README examples merely for textual continuity.
- Publish only Japanese user documentation. Do not copy `docs/adr`, `docs/todo`, `docs/superpowers`, or `docs/architecture` into `docs-site/`.
- Each feature page must explain the feature, its common use, major settings, one minimal valid example, security impact, related pages, and a link to `src/config/Schema.pkl`.
- Keep configuration examples minimal and valid under the current `network.scopes`, secret, mask, and HostExec models.
- Do not add a generated exhaustive configuration reference, blog, analytics, comments, version switcher, multilingual hierarchy, or Git-signing recipe.
- Keep secrets, machine-local paths, audit contents, and runtime data out of source and generated artifacts.
- README must end between 100 and 150 lines and remain sufficient to install nas, initialize configuration, and launch a first session.
- Use `https://hogeyama.github.io/nix-agent-sandbox/` as the published URL and `/nix-agent-sandbox` as the Astro base path.
- During iteration run only Docker-free targeted tests and `bun run test:unit`; run `bun run test` once in the final task as required by `AGENTS.md`.
- Human diffity and Forgejo review gates are intentionally omitted at the user's request. Automated task and final code review remain required.

---

### Task 1: Starlight Foundation and Onboarding Journey

**Files:**
- Modify: `package.json`
- Modify: `bun.lock`
- Create: `docs-site/astro.config.mjs`
- Create: `docs-site/src/content.config.ts`
- Create: `docs-site/src/styles/custom.css`
- Create: `docs-site/src/content/docs/index.mdx`
- Create: `docs-site/src/content/docs/getting-started/about.md`
- Create: `docs-site/src/content/docs/getting-started/installation.md`
- Create: `docs-site/src/content/docs/getting-started/quick-start.md`
- Create: `docs-site/src/content/docs/getting-started/configuration.md`

**Source checks:**
- `README.md:1-111` for the current product description, prerequisites, install commands, and quick start.
- `src/cli/usage.ts` for command ordering and current `--worktree` spelling.
- `src/config/init.ts`, `src/config/templates/config.pkl`, and `src/config/templates/eval.pkl` for generated paths and the smallest valid profile.
- `src/config/paths.ts` and `src/config/trust.ts` for global/project location and trust behavior.
- `src/config/Schema.pkl:1-112` for `default`, `ui`, `observability`, profile, worktree, session, and hook defaults.

**Interfaces:**
- Produces: `bun run docs:dev`, `bun run docs:check`, `bun run docs:build`, and `bun run docs:preview` commands rooted at `docs-site/`.
- Produces: a Starlight content collection using `docsLoader()` and `docsSchema()`.
- Produces: published routes `/`, `/getting-started/about/`, `/getting-started/installation/`, `/getting-started/quick-start/`, and `/getting-started/configuration/` under the configured base.
- Consumes: no earlier task output.

- [ ] **Step 1: Install the documentation dependencies in the root Bun package**

Run:

```bash
bun add --dev astro @astrojs/check @astrojs/starlight
```

Expected: `package.json` gains the three development dependencies and `bun.lock` records their exact resolved versions. Do not create a second lockfile or `docs-site/package.json`.

- [ ] **Step 2: Add root documentation commands**

Add these scripts to `package.json` without changing existing application scripts:

```json
{
  "docs:dev": "astro --root docs-site dev",
  "docs:check": "astro --root docs-site check",
  "docs:build": "astro --root docs-site build",
  "docs:preview": "astro --root docs-site preview"
}
```

- [ ] **Step 3: Configure the Japanese Starlight site**

Create `docs-site/astro.config.mjs` with:

```js
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://hogeyama.github.io",
  base: "/nix-agent-sandbox",
  integrations: [
    starlight({
      title: "nas",
      description: "AI コーディングエージェントを隔離して実行するためのユーザーガイド",
      locales: { root: { label: "日本語", lang: "ja" } },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/Hogeyama/nix-agent-sandbox",
        },
      ],
      editLink: {
        baseUrl:
          "https://github.com/Hogeyama/nix-agent-sandbox/edit/main/docs-site/",
      },
      lastUpdated: true,
      customCss: ["./src/styles/custom.css"],
      sidebar: [
        {
          label: "はじめに",
          items: [
            { label: "nas とは", slug: "getting-started/about" },
            { label: "インストール", slug: "getting-started/installation" },
            { label: "クイックスタート", slug: "getting-started/quick-start" },
            { label: "設定の基本", slug: "getting-started/configuration" },
          ],
        },
      ],
    }),
  ],
});
```

Create `docs-site/src/content.config.ts` with Starlight's current loader API:

```ts
import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
```

- [ ] **Step 4: Add minimal branding without replacing Starlight layout behavior**

In `docs-site/src/styles/custom.css`, define the Starlight accent scale for both themes with a muted green, use the existing system font stack, constrain screenshots to the content width, and allow tables and code blocks to scroll on narrow screens. Do not override the sidebar, search dialog, focus rings, or theme switcher structure.

Required selectors:

```css
:root {
  --sl-color-accent-low: #d9f5e7;
  --sl-color-accent: #137a55;
  --sl-color-accent-high: #123d2d;
}

:root[data-theme="dark"] {
  --sl-color-accent-low: #123d2d;
  --sl-color-accent: #75d9ad;
  --sl-color-accent-high: #d9f5e7;
}

.sl-markdown-content img {
  max-width: 100%;
  height: auto;
  border: 1px solid var(--sl-color-gray-5);
  border-radius: 0.5rem;
}
```

- [ ] **Step 5: Write the manual-first home page**

Create `index.mdx` with `title: nas を使い始める`, a one-paragraph explanation of deny-by-default isolation, a Starlight `Steps` block for install → `nas config init` → `nas`, and a `CardGrid` linking to the four onboarding pages. Use relative route links so Astro applies the Pages base correctly. The page must not use Starlight's splash template because the approved layout keeps manual navigation visible.

- [ ] **Step 6: Write the four onboarding pages from verified behavior**

Use these page responsibilities and frontmatter titles:

```yaml
# getting-started/about.md
title: nas とは
description: nas が隔離するものと、必要な権限だけを有効にする考え方

# getting-started/installation.md
title: インストール
description: 対応環境、前提ツール、GitHub Releases と Nix からの導入

# getting-started/quick-start.md
title: クイックスタート
description: 設定を作成して最初のエージェントを起動する

# getting-started/configuration.md
title: 設定の基本
description: profile、グローバル設定、プロジェクト設定の関係
```

The installation page must retain x86_64 and aarch64 release commands and state that aarch64 is unverified only if current release configuration or README still supports that claim. The configuration page must show the actual `.nas/` and XDG file layout, explain `amends "modulepath:/global.pkl"` versus `amends "Schema.pkl"`, and use the current generated config rather than the README's obsolete network example.

- [ ] **Step 7: Build and inspect the onboarding site**

Run:

```bash
bun run docs:check
bun run docs:build
```

Expected: both commands exit 0; `docs-site/dist/index.html` and the four onboarding route directories exist; `docs-site/dist/pagefind/pagefind.js` exists.

- [ ] **Step 8: Commit the working onboarding site**

Stage only the task files and commit with subject:

```text
feat(docs): add the Starlight onboarding site
```

The body should explain why the public site has its own root while dependencies remain in the root Bun lockfile.

---

### Task 2: Generated-Site Validation and PR Build Check

**Files:**
- Create: `src/docs/site_check.ts`
- Create: `src/docs/site_check_test.ts`
- Create: `scripts/check_docs.ts`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `docs-site/dist/` and `/nix-agent-sandbox` from Task 1.
- Produces: `SiteCheckOptions`, `collectSiteErrors(options): Promise<string[]>`, and a `docs:build` command that fails on broken internal HTML references or missing Pagefind artifacts.
- Produces: a PR CI step that runs `docs:check` and `docs:build` after dependencies are installed.

- [ ] **Step 1: Write Docker-free unit tests for generated reference validation**

Create `src/docs/site_check_test.ts` with temporary-directory tests using `mkdtemp(join(tmpdir(), "nas-docs-"))` and `rm(..., { recursive: true, force: true })` in `afterEach` or `finally`.

Test these exact behaviors:

```ts
test("accepts base-prefixed pages, assets, and fragments", async () => {});
test("reports a missing internal page", async () => {});
test("reports a missing image", async () => {});
test("reports a missing heading fragment", async () => {});
test("validates same-page fragments and ignores external, mailto, and data references", async () => {});
test("requires Pagefind JavaScript and at least one index shard", async () => {});
```

The valid fixture must include `index.html`, `guide/index.html` with a known `id`, `images/example.png`, `pagefind/pagefind.js`, and one file whose name ends in `.pf_index`.

- [ ] **Step 2: Implement the site checker**

In `src/docs/site_check.ts`, export:

```ts
export interface SiteCheckOptions {
  siteDir: string;
  basePath: string;
  readme?: { path: string; minLines: number; maxLines: number };
}

export async function collectSiteErrors(
  options: SiteCheckOptions,
): Promise<string[]>;
```

Implementation requirements:

- Recursively read generated `.html` files with `node:fs/promises`.
- Extract quoted `href` and `src` values, decode query/fragment components safely, and skip `http:`, `https:`, `mailto:`, `data:`, protocol-relative, and empty references.
- Strip the configured `/nix-agent-sandbox` base only when it is a complete leading path segment.
- Resolve root-relative and page-relative references without permitting `..` to escape `siteDir`.
- Treat directory and extensionless routes as `<route>/index.html`; treat asset extensions as exact files.
- When a nonempty fragment targets HTML, require a matching decoded `id` in the destination document. A same-page `#fragment` still checks the current page.
- Return stable, sorted error strings containing the referring HTML path and missing target.
- Require `pagefind/pagefind.js` and at least one recursively discovered `.pf_index` file.
- Implement the optional README line-range check now, but leave it unused by `scripts/check_docs.ts` until Task 8 shortens README.

- [ ] **Step 3: Run the targeted test to verify the checker passes**

Run:

```bash
bun test src/docs/site_check_test.ts
```

Expected: all six tests PASS and no Docker command is invoked.

- [ ] **Step 4: Add the CLI wrapper and make build validation mandatory**

Create `scripts/check_docs.ts`:

```ts
import { collectSiteErrors } from "../src/docs/site_check.ts";

const errors = await collectSiteErrors({
  siteDir: "docs-site/dist",
  basePath: "/nix-agent-sandbox",
});

if (errors.length > 0) {
  for (const error of errors) console.error(`[docs] ${error}`);
  process.exit(1);
}

console.log("[docs] generated site validation passed");
```

Change `docs:build` to:

```json
"docs:build": "astro --root docs-site build && bun scripts/check_docs.ts"
```

- [ ] **Step 5: Add doc checks to the existing PR CI**

After the existing dependency installation in `.github/workflows/ci.yml`, add one step that runs:

```bash
nix develop -c bun run docs:check
nix develop -c bun run docs:build
```

Keep this in the existing `check` job so a pull request cannot pass while its docs artifact is broken.

- [ ] **Step 6: Verify the unit and real generated-site paths**

Run:

```bash
bun test src/docs/site_check_test.ts
bun run docs:check
bun run docs:build
```

Expected: all commands exit 0 and the final line includes `[docs] generated site validation passed`.

- [ ] **Step 7: Commit generated-site enforcement**

Commit subject:

```text
build(docs): reject incomplete generated sites
```

The body should explain that Astro can emit visually usable output while a local asset or Pagefind index is absent, so deployment needs a post-build invariant check.

---

### Task 3: Filesystem, Secrets, Network, and HostExec Guides

**Files:**
- Modify: `docs-site/astro.config.mjs`
- Create: `docs-site/src/content/docs/features/filesystem.md`
- Create: `docs-site/src/content/docs/features/secrets.md`
- Create: `docs-site/src/content/docs/features/network.md`
- Create: `docs-site/src/content/docs/features/port-forwarding.md`
- Create: `docs-site/src/content/docs/features/hostexec.md`
- Move: `images/network-prompt.png` → `docs-site/public/images/network-prompt.png`
- Move: `images/network-prompt-ui.png` → `docs-site/public/images/network-prompt-ui.png`
- Move: `images/hostexec-prompt.png` → `docs-site/public/images/hostexec-prompt.png`
- Move: `images/hostexec-result.png` → `docs-site/public/images/hostexec-result.png`

**Source checks:**
- `src/config/Schema.pkl:158-566` for scopes, rules, expectations, request-body audit, secrets, injection, and the Anthropic preset.
- `src/config/Schema.pkl:632-810` for mounts, env, secret sources, masking, and HostExec.
- `src/config/validate.ts`, `src/config/validate_hostexec_test.ts`, and `src/config/validate_mask_test.ts` for cross-field failures the guide must warn about.
- `src/stages/mount/`, `src/stages/maskfs/`, and `src/services/secret_resolver.ts` for file and secret boundaries.
- `src/network/authz/`, `src/stages/proxy/`, `docs/migration/network-scopes.md`, and `docs/migration/network-review-rules.md` for the current network authorization model.
- `src/hostexec/`, `src/stages/hostexec/`, and `src/cli/hostexec.ts` for HostExec routing, approval, fallback, masking, and commands.
- `skills/security-constraints/SKILL.md` for C1-C3, S1-S2, and N1 invariants.

**Interfaces:**
- Produces: five feature routes and a `機能ガイド` sidebar group containing them.
- Consumes: Task 1 Starlight config and Task 2 build validator.

- [ ] **Step 1: Audit the current settings and record page-specific claims before drafting**

For each page, make a scratch checklist from the source files above containing only setting names, defaults, and security claims proven by code or tests. Specifically reject README-only `network.allowlist` and legacy `network.prompt` shapes. Do not commit the scratch checklist.

- [ ] **Step 2: Write filesystem and secret handling pages**

`filesystem.md` must explain overlay isolation, always/conditionally mounted paths, `extraMounts`, `ro` versus `rw`, relative destination behavior, and file-ownership consequences. Its minimal example uses one read-only cache mount and one `/dev/null` mask.

`secrets.md` must explain the named `secrets` registry, supported nonliteral `from` schemes, `required`, `mask.maskfs`, `mask.proxy`, `mask.filter`, `mask.apply`, `writePolicy`, and `env` as a separate explicit injection mechanism. It must state that secret resolution is host-side, raw values are not mounted into the agent container, HostExec env injection is rule-scoped, and missing required secrets fail startup. Include cloud/GPG configuration only as short high-risk credential-mount sections; do not recreate the removed Git-signing recipe.

- [ ] **Step 3: Write the current network authorization guide**

`network.md` must describe scopes selecting targets, rules selecting requests within a scope, `onMatch`, `onIndeterminate`, `expect`, scope/global fallback, secret disposition, header injection, approval behavior, WebSocket limits, request-body audit, and the immutable Anthropic preset. Include a minimal preset-based configuration and one custom scope example using methods and paths. Clearly distinguish target selection from request acceptance and `match` from `expect`.

The page must not claim that raw TCP is filtered like HTTP, that WebSocket messages receive per-message review, or that the old flat allowlist remains supported.

- [ ] **Step 4: Write port-forwarding and HostExec pages**

`port-forwarding.md` must show `network.proxy.forwardPorts`, the same-number container localhost mapping, reserved port 18080, per-session Unix-socket relay, and the risk of exposing unauthenticated host services.

`hostexec.md` must show a narrow `rules` example with stable `id`, exact `argv0`, anchored `argRegex`, constrained `cwd`, minimal inherited environment, prompt approval, and explicit fallback. Explain `allow` / `prompt` / `deny`, `once` / `capability`, `container` / `deny`, secret env injection, stdout/stderr masking, exec socket versus host-only control socket, and `nas hostexec test`.

- [ ] **Step 5: Add screenshots with base-safe paths and useful alt text**

Move the four listed image files into `docs-site/public/images/`. Reference them from network and HostExec pages with paths rooted at `/nix-agent-sandbox/images/...`, widths that stay within content, and Japanese text explaining what the reader should notice. Do not use screenshots as the sole explanation of a control.

- [ ] **Step 6: Add the first feature sidebar group**

Append this group to the Starlight sidebar:

```js
{
  label: "機能ガイド",
  items: [
    { label: "ファイル隔離・マウント", slug: "features/filesystem" },
    { label: "シークレット・認証情報", slug: "features/secrets" },
    { label: "ネットワーク制御", slug: "features/network" },
    { label: "localhost ポート転送", slug: "features/port-forwarding" },
    { label: "HostExec", slug: "features/hostexec" },
  ],
}
```

- [ ] **Step 7: Validate feature pages and obsolete-key removal**

Run:

```bash
rg -n 'network\.allowlist|network\.prompt' docs-site README.md
bun run docs:check
bun run docs:build
```

Expected: matches may still exist in README until Task 8, but none may exist under `docs-site/`; both build commands pass.

- [ ] **Step 8: Commit the boundary-sensitive guides**

Commit subject:

```text
docs: explain sandbox access boundaries by feature
```

The body should state why security effects are repeated next to enabling settings instead of living only in a central security chapter.

---

### Task 4: Nix, Docker, Worktree, Session, and Display Guides

**Files:**
- Modify: `docs-site/astro.config.mjs`
- Create: `docs-site/src/content/docs/features/nix.md`
- Create: `docs-site/src/content/docs/features/docker.md`
- Create: `docs-site/src/content/docs/features/worktree.md`
- Create: `docs-site/src/content/docs/features/sessions.md`
- Create: `docs-site/src/content/docs/features/display.md`

**Source checks:**
- `src/config/Schema.pkl:91-157` and `src/config/Schema.pkl:618-630` for exact settings and defaults.
- `src/stages/nix_detect/`, `src/stages/dind/`, and `src/docker/` for runtime behavior and prerequisites.
- `src/stages/worktree/`, `src/cli/worktree.ts`, and `src/cli/usage.ts` for configured and one-shot worktrees, cleanup, and branch behavior.
- `src/dtach/`, `src/cli/session.ts`, `src/sessions/`, and `src/history/cli_lifecycle.ts` for session behavior.
- `src/stages/display/`, `src/display/`, and their tests for xpra, Xvfb, cookies, WSL, and cleanup.

**Interfaces:**
- Consumes: Task 3's `機能ガイド` sidebar group.
- Produces: five additional feature routes appended to the same group.

- [ ] **Step 1: Write the Nix and Docker in Docker guides**

`nix.md` must cover `enable = "auto"`, explicit boolean enablement, `mountSocket`, `extraPackages`, host prerequisites, and the fact that a mounted host Nix daemon is a high-trust opt-in. Do not imply that Nix is required when the feature is unused.

`docker.md` must cover rootless DinD, `enable`, `shared`, sidecar lifecycle, agent-container versus privileged-sidecar boundaries, network attachment, and cleanup links. State that the host Docker socket is not passed to the agent.

- [ ] **Step 2: Write the Worktree guide**

Explain profile `worktree { base; onCreate }`, the `-b` / `--worktree` per-run option, `--no-worktree`, session branch naming, teardown choices, and the difference between session creation and the `nas worktree` management subcommand. Use a short command transcript rather than copying the README's full transcript.

- [ ] **Step 3: Write the session and notification guide**

Explain `session.multiplex`, `detachKey`, `nas session list`, `nas session attach`, concurrent attach behavior, and `hook.notify`. Include concise current hook examples for Claude Code, Copilot CLI, and Codex CLI, verifying event names and `--when` behavior from code/tests before copying them.

- [ ] **Step 4: Write the display guide**

Explain `display.sandbox = "xpra"`, `display.size`, required host tools, the detached X server, per-session cookie, socket exposure, browser automation use, cleanup, and the WSL `/tmp/.X11-unix` workaround. State that the host desktop X session is not exposed to the agent.

- [ ] **Step 5: Append the routes to the feature sidebar**

Append in this order: Nix integration, Docker in Docker, Worktree, sessions/notifications, X11/xpra. Preserve the earlier five routes and their order.

- [ ] **Step 6: Build and inspect cross-links**

Run:

```bash
bun run docs:check
bun run docs:build
```

Expected: commands exit 0; each new page links to at least one related feature or future operation/security route only after that target exists. If a future target does not exist yet, omit the link and add it in Task 7 rather than suppressing the checker.

- [ ] **Step 7: Commit runtime feature guides**

Commit subject:

```text
docs: add runtime and workflow feature guides
```

---

### Task 5: UI and Observability Guides

**Files:**
- Modify: `docs-site/astro.config.mjs`
- Create: `docs-site/src/content/docs/features/ui.md`
- Create: `docs-site/src/content/docs/features/observability.md`
- Move: `images/ui-sessions.png` → `docs-site/public/images/ui-sessions.png`
- Move: `images/ui-containers.png` → `docs-site/public/images/ui-containers.png`

**Source checks:**
- `src/config/Schema.pkl:26-47` for UI and observability defaults.
- `src/ui/daemon.ts`, `src/ui/launch.ts`, `src/ui/server.ts`, `src/ui/security.ts`, and their tests for lifecycle, listen behavior, and trust boundary.
- `src/ui/frontend/src/App.tsx` and page components for features visible in screenshots.
- `src/stages/observability/`, `src/history/`, `src/cli/audit.ts`, and `docs/adr/2026042901-observability-otel-history.md` for retained data and audit/history semantics.

**Interfaces:**
- Consumes: Task 4 feature sidebar.
- Produces: UI and Observability routes plus two public screenshots.

- [ ] **Step 1: Write the UI daemon guide**

Cover `ui.enable`, `ui.port`, `ui.idleTimeout`, automatic startup and idle shutdown, `nas ui`, `nas ui stop`, `--no-open`, sessions, approvals, sidecar controls, history/settings surfaces, and the current local-host security model. Preserve the warning that untrusted users sharing the host must not receive an approval surface.

- [ ] **Step 2: Write the Observability guide**

Cover `observability.enable`, retention and `null`, what history/telemetry is collected, how it appears in UI, the `nas audit` filters and JSON mode, request-body audit as a separate explicit high-sensitivity network setting, and cleanup/retention behavior. Do not claim that request bodies are captured by default.

- [ ] **Step 3: Move and embed the UI screenshots**

Move both listed files into `docs-site/public/images/`. Embed them with `/nix-agent-sandbox/images/...` URLs and explain which session/container state each screenshot demonstrates.

- [ ] **Step 4: Append UI and Observability to the feature sidebar**

Add them after X11/xpra. Keep the feature group flat and in user-task order.

- [ ] **Step 5: Validate and commit**

Run `bun run docs:check` and `bun run docs:build`; expect both to pass. Commit subject:

```text
docs: document monitoring and control surfaces
```

---

### Task 6: Recipes and Operations

**Files:**
- Modify: `docs-site/astro.config.mjs`
- Create: `docs-site/src/content/docs/recipes/mask-env.md`
- Create: `docs-site/src/content/docs/recipes/relative-hostexec.md`
- Create: `docs-site/src/content/docs/recipes/proxy-tools.md`
- Create: `docs-site/src/content/docs/recipes/codex-keyring.md`
- Create: `docs-site/src/content/docs/recipes/x11-apps.md`
- Create: `docs-site/src/content/docs/operations/maintenance.md`
- Create: `docs-site/src/content/docs/operations/approvals.md`
- Create: `docs-site/src/content/docs/operations/audit.md`

**Source checks:**
- `README.md:326-753` as recipe/operation seed text, never as sole authority.
- `src/config/Schema.pkl`, validation tests, and the related feature implementation for every copied configuration block.
- `src/cli/rebuild.ts`, `src/cli/worktree.ts`, `src/cli/container.ts`, `src/cli/network.ts`, `src/cli/hostexec.ts`, `src/cli/audit.ts`, and `src/cli/usage.ts` for accepted commands and output contracts.
- `src/stages/dbus_proxy/` and `src/dbus/` for the Codex keyring recipe's filtered DBus boundary.

**Interfaces:**
- Produces: `レシピ` and `運用` sidebar groups, with all pages cross-linked to their underlying feature guides.
- Consumes: feature routes from Tasks 3-5.

- [ ] **Step 1: Rewrite the five approved recipes**

Each recipe begins with an outcome, lists prerequisites, gives one complete current Pkl block, explains the narrow permissions granted, and links to the feature guides.

- `mask-env.md`: mask `.env`, declare named secrets, and inject only into a constrained HostExec rule.
- `relative-hostexec.md`: delegate `./gradlew` with an exact relative `argv0`, constrained cwd, and anchored arguments.
- `proxy-tools.md`: configure a tool that ignores standard proxy variables without weakening the network authorization layer.
- `codex-keyring.md`: allow only the necessary `org.freedesktop.secrets` DBus calls; explain that the service's granted authority remains reachable.
- `x11-apps.md`: enable xpra, start a headed application, and diagnose missing host prerequisites.

Do not add the removed Git-signing recipe.

- [ ] **Step 2: Write maintenance operations**

`maintenance.md` covers `nas rebuild [--force]`, `nas worktree list/clean [-f] [-B]`, `nas container list/clean`, what each removes, and what remains protected while a session is active.

- [ ] **Step 3: Write approval operations**

`approvals.md` covers pending, approve, deny, review, and network gc for both domains. Show the currently accepted network scope flags from `src/cli/network.ts` rather than README assumptions. Explain when a decision is reused and link to Network and HostExec policy pages.

- [ ] **Step 4: Write audit operations**

`audit.md` covers date/session/domain filters, JSON output, the difference between authorization audit records and optional exact request-body capture, retention, and the UI route to the same information.

- [ ] **Step 5: Add recipe and operation sidebar groups**

Use exactly the page order from the file list above. Labels should be user outcomes, not filenames; for example `.env を隠してホスト実行` and `承認キューを操作する`.

- [ ] **Step 6: Validate every configuration block against current schema**

Extract each complete Pkl example into a temporary file that amends the current schema or place the snippets in a temporary wrapper module, then evaluate with the repository's existing Pkl tooling. If direct evaluation is impossible for a deliberately partial block, compare its fields against `Schema.pkl` and the matching validation test and make the text explicitly call it partial.

Run:

```bash
bun run docs:check
bun run docs:build
```

Expected: examples contain no old flat allowlist form; both commands pass.

- [ ] **Step 7: Commit recipes and operations**

Commit subject:

```text
docs: turn common configurations into task recipes
```

The body should explain why recipes duplicate a complete minimal block while conceptual details remain linked to feature pages.

---

### Task 7: Security Model and Final Navigation

**Files:**
- Modify: `docs-site/astro.config.mjs`
- Modify: feature and recipe pages created in Tasks 3-6 when adding final cross-links
- Create: `docs-site/src/content/docs/security/model.md`
- Create: `docs-site/src/content/docs/security/risks.md`
- Create: `docs-site/src/content/docs/security/recommendations.md`
- Create: `docs-site/src/content/docs/security/limitations.md`

**Source checks:**
- `skills/security-constraints/SKILL.md` for non-negotiable invariants.
- `README.md:776-913` as an outline requiring code verification.
- `src/stages/mount/`, `src/stages/proxy/`, `src/stages/hostexec/`, `src/stages/maskfs/`, `src/stages/dbus_proxy/`, and `src/stages/display/` for actual boundaries.
- `src/ui/security.ts`, `src/config/trust.ts`, and their tests for host UI and repository trust.

**Interfaces:**
- Produces: the complete final sidebar and stable security destinations for warnings across all earlier pages.
- Consumes: all public content routes from Tasks 1 and 3-6.

- [ ] **Step 1: Write the security model page**

Describe deny-by-default operation, agent container, mounted workspace view, shared/per-session sidecars, host brokers, control versus execution sockets, proxy authorization, and opt-in host resources. Include a text diagram that distinguishes container, Unix-socket boundary, host broker, and upstream network without claiming Docker alone is a complete adversarial boundary.

- [ ] **Step 2: Write the feature risk matrix**

`risks.md` contains one row per feature: default state, settings that enable it, resource reached, and practical risk. Include Nix socket, DinD, port forwarding, HostExec, DBus, GPG agent, cloud config mounts, extra mounts, UI daemon, request-body audit, display forwarding, and observability retention. Link each row to the feature page.

- [ ] **Step 3: Write recommendations and limitations**

`recommendations.md` gives concrete least-privilege advice for mounts, HostExec regex/cwd/env, network fallback/expect rules, secret sources, approval caching, UI on shared hosts, retention, and trusted repository configuration.

`limitations.md` covers supported Linux/runtime prerequisites, standalone agent binaries, file ownership, TTY behavior, Docker requirements, Nix-specific behavior, X11 prerequisites, and architecture support. Verify every claim before retaining it.

- [ ] **Step 4: Add final warning links to earlier pages**

Every setting that broadens access must link from its local caution block to the matching risk-matrix row or security-model heading. Add reciprocal links from security pages back to feature usage pages. Do not copy long risk prose into three places.

- [ ] **Step 5: Add the security group and review the entire sidebar**

Append the four security routes as the last group. Confirm every `docs-site/src/content/docs/**/*.{md,mdx}` page except the root index appears once in the sidebar, the order matches onboarding → features → recipes → operations → security, and no internal repository document appears.

- [ ] **Step 6: Validate and commit**

Run:

```bash
bun run docs:check
bun run docs:build
```

Expected: all routes and fragments resolve; build passes. Commit subject:

```text
docs: make security boundaries navigable
```

---

### Task 8: README Cutover, Pages Deployment, and Final QA

**Files:**
- Modify: `README.md`
- Modify: `src/docs/site_check.ts`
- Modify: `src/docs/site_check_test.ts`
- Modify: `scripts/check_docs.ts`
- Create: `.github/workflows/docs-pages.yml`
- Verify: `.github/workflows/ci.yml`
- Verify: `docs-site/astro.config.mjs`

**Interfaces:**
- Consumes: the complete site and checker from Tasks 1-7.
- Produces: a 100-150 line README, mandatory README bounds in `docs:build`, and a least-privilege Pages deployment on `main`.

- [ ] **Step 1: Add failing README-bound tests**

Extend `src/docs/site_check_test.ts` with:

```ts
test("accepts a README within the configured inclusive line range", async () => {});
test("reports a README shorter or longer than the configured range", async () => {});
```

Use generated temporary files with exactly 99, 100, 150, and 151 newline-delimited lines. Assert boundaries are inclusive and errors report the observed count.

- [ ] **Step 2: Verify the current README fails the bound**

Temporarily call `collectSiteErrors` in the test fixture with the real README or run a one-line Bun invocation against `README.md`.

Expected: the checker reports approximately 900 lines and the 100-150 requirement. Do not change the production wrapper before shortening README, so intermediate `docs:build` remains usable.

- [ ] **Step 3: Replace README with the short standalone entry point**

Write 100-150 lines containing only:

1. Product name and two-paragraph deny-by-default overview.
2. A prominent documentation link to `https://hogeyama.github.io/nix-agent-sandbox/`.
3. Prerequisites: Linux, Docker 20.10+, and official standalone agent binary.
4. GitHub Release commands for x86_64 and aarch64 plus the local Nix install command.
5. `nas config init`, a smallest current Pkl profile, and `nas` launch.
6. A compact feature list linking to published feature pages.
7. License and inspiration attribution.

Do not retain detailed recipes, full setting blocks, operation command catalogs, screenshots, or the Git-signing recipe.

- [ ] **Step 4: Make README bounds part of generated-site validation**

Change `scripts/check_docs.ts` to pass:

```ts
readme: { path: "README.md", minLines: 100, maxLines: 150 }
```

Run `bun test src/docs/site_check_test.ts`; expect all tests to pass.

- [ ] **Step 5: Add the GitHub Pages workflow**

Create `.github/workflows/docs-pages.yml` with these properties:

- Trigger on `main` push and `workflow_dispatch`.
- Top-level permissions: `contents: read`, `pages: write`, `id-token: write`.
- Concurrency group `pages` with `cancel-in-progress: false`.
- Build job: `actions/checkout@v6`, `oven-sh/setup-bun@v2`, `actions/configure-pages@v5`, `bun install --frozen-lockfile`, `bun run docs:check`, `bun run docs:build`, and `actions/upload-pages-artifact@v4` with `docs-site/dist`.
- Deploy job: `needs: build`, `environment.name: github-pages`, environment URL from the deployment output, and `actions/deploy-pages@v5`.

Do not grant `contents: write`, do not push a `gh-pages` branch, and do not provide secrets to either job.

- [ ] **Step 6: Run documentation and standard fast verification**

Run:

```bash
wc -l README.md
bun test src/docs/site_check_test.ts
bun run docs:check
bun run docs:build
bun run test:unit
```

Expected: README is 100-150 lines, site-check tests pass, documentation commands pass, Pagefind artifacts exist, and unit tests pass.

- [ ] **Step 7: Verify generated Japanese search in a browser**

Start `bun run docs:preview -- --host 127.0.0.1` only for local automation. Use `playwright-cli` inside the same environment to open the preview, then verify:

- desktop and mobile navigation can reach onboarding, one feature, one recipe, one operation, and one security page;
- light and dark themes render without horizontal page overflow;
- searches for `ネットワーク`, `HostExec`, and `xpra` return the corresponding page or section;
- moved screenshots load with nonempty natural dimensions; and
- no browser console error appears other than a missing development-only favicon if one is not configured.

Save screenshots for inspection under ignored `.playwright-cli/`; do not commit them. Stop the preview process after inspection.

- [ ] **Step 8: Run the final repository checks once**

Apply `skills/post-change-checks/SKILL.md`, then run the required full suite exactly once:

```bash
bun run fmt
bun run lint
bun run check
bun run test
```

Expected: all commands pass. If the full suite exposes a Docker-dependent failure, diagnose that exact failure before rerunning any narrower integration test.

- [ ] **Step 9: Commit the README and deployment cutover**

Commit subject:

```text
docs: publish the user guide through GitHub Pages
```

The body should explain that README stays independently useful for first launch while detailed content moves to a searchable site, and that Pages deployment is blocked on the same artifact validation used in PRs.

- [ ] **Step 10: Record the one-time repository setting**

In the handoff, tell the user to select **Settings → Pages → Build and deployment → Source: GitHub Actions** if it is not already enabled. Do not mutate repository settings or publish from the local environment unless the user separately requests it.
