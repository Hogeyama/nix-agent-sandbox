# nas Approval Routing into VS Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** nas の Dev Container セッションの承認要求 (hostexec/network) を VS Code ウィンドウ内で通知・回答できるようにする。

**Architecture:** `extensionKind: ["ui"]` のローカル拡張が `nas devcontainer status` でセッションを解決し、`nas <domain> watch --session` を spawn して pending を購読する。通知は status bar + toast (件数のみ)、回答は nas ui 準拠のカード型 Webview で `nas approve/deny` を spawn する。

**Tech Stack:** 素の JavaScript (CommonJS、依存ゼロ、ビルドなし)、VS Code Extension API、bun:test。

**Spec:** `docs/superpowers/specs/2026-09-18-vscode-approval-design.md`

## Global Constraints

- 拡張は nas 管理の Dev Container ウィンドウでのみ有効:
  `vscode.env.remoteName === "dev-container"` かつ
  `nas devcontainer status --json` が非 null を返す workspace。
- 拡張のコードは CommonJS (`require` / `module.exports`)、ランタイム依存ゼロ。
  `vscode` モジュールを require するのは `extension.js` と `lib/webview.js` のみ
  (`lib/` の純粋モジュールは bun:test で直接 import できること)。
- Webview は `var(--vscode-*)` テーマ変数のみ使用。外部リソースなし。
  CSP は `default-src 'none'` ベースで nonce 付き script のみ許可。
- sessionId / requestId / scope を spawn argv に入れる前に
  `/^[A-Za-z0-9_-]+$/` で検証する (`-` 始まりの値がフラグ解釈されるのを塞ぐ)。
- テストファイルは `*_test.js` をソースと同じディレクトリに置く
  (リポジトリ規約は `*_test.ts` colocated; contrib は JS のため `_test.js`)。
- コミットは Conventional Commits (`feat(...)`, `test(...)`, `docs(...)`)。

---

### Task 1: hostexec `structured` payload の拡充

拡張のカード描画に必要な `integrityChanged` / `defaultScope` / `capability` を
`toHostExecPendingItem` の `structured` に追加する。pending エントリは
これらを既に保持しており、後方互換 (追加のみ)。

**Files:**
- Modify: `src/cli/hostexec.ts` (toHostExecPendingItem, lines 34-54)
- Test: `src/cli/hostexec_test.ts`

**Interfaces:**
- Produces: `structured` に `integrityChanged?: boolean`, `defaultScope?: "once"|"capability"`,
  `capability?: ResolvedExecutionCapability` が optional フィールドとして乗る。
  `watch` の `added` イベントの `entry` と `pending --format json` の両方に反映される。

- [ ] **Step 1: 失敗するテストを書く**

`src/cli/hostexec_test.ts` に追加:

```ts
test("toHostExecPendingItem carries capability metadata for card UIs", () => {
  const capability = {
    ruleId: "gcloud",
    argv0: "gcloud",
    normalizedArgv: ["gcloud", "auth", "print-access-token"],
    normalizedCwd: "/home/u/proj",
    envBindings: [{ key: "GCLOUD_TOKEN", source: "op://x/y" }],
    inheritEnv: { mode: "minimal" as const, keys: ["HOME"] },
  };
  const item = toHostExecPendingItem(
    entry({ integrityChanged: true, defaultScope: "capability", capability }),
  );
  expect(item.structured).toMatchObject({
    integrityChanged: true,
    defaultScope: "capability",
    capability,
  });
});
```

`HostExecPendingEntry` の `capability` の型は
`ResolvedExecutionCapability` (`src/hostexec/types.ts`) であり、
web UI 側の `HostExecCapabilityLike` (`src/ui/frontend/src/stores/types.ts:126`)
と同じフィールド構成 (`ruleId`, `argv0`, `normalizedArgv`, `normalizedCwd`,
`envBindings`, `inheritEnv`)。テストの capability オブジェクトのフィールドが
`ResolvedExecutionCapability` とずれる場合は型に合わせて調整する。

- [ ] **Step 2: テストが失敗することを確認**

Run: `bun test src/cli/hostexec_test.ts`
Expected: FAIL (`toMatchObject` で `integrityChanged` 等が undefined)

- [ ] **Step 3: 実装**

`src/cli/hostexec.ts` の `structured` に追加:

```ts
    structured: {
      sessionId: entry.sessionId,
      requestId: entry.requestId,
      ruleId: entry.ruleId,
      cwd: entry.cwd,
      argv0: entry.argv0,
      args: entry.args,
      createdAt: entry.createdAt,
      ...(entry.integrityChanged !== undefined
        ? { integrityChanged: entry.integrityChanged }
        : {}),
      ...(entry.defaultScope !== undefined
        ? { defaultScope: entry.defaultScope }
        : {}),
      ...(entry.capability !== undefined
        ? { capability: entry.capability }
        : {}),
    },
```

- [ ] **Step 4: テスト通過 + 既存テストの維持**

`entry()` のデフォルトでは新フィールドを持たないため、
既存の `toEqual` テスト (line 24-34) はそのまま通るはず。

Run: `bun test src/cli/hostexec_test.ts`
Expected: PASS (全件)

- [ ] **Step 5: Commit**

```bash
git add src/cli/hostexec.ts src/cli/hostexec_test.ts
git commit -m "feat(hostexec): expose capability metadata in pending structured payload"
```

---

### Task 2: 拡張のスキャッフォールド + watch 状態の純粋ロジック

`contrib/vscode-nas-approval/` を作り、マニフェストと、watch イベントを
件数・カード元データに畳む純粋モジュールを置く。リポジトリの test/lint
スクリプトに contrib を加える。

**Files:**
- Create: `contrib/vscode-nas-approval/package.json`
- Create: `contrib/vscode-nas-approval/.vscodeignore`
- Create: `contrib/vscode-nas-approval/README.md`
- Create: `contrib/vscode-nas-approval/lib/ids.js`
- Create: `contrib/vscode-nas-approval/lib/watchState.js`
- Create: `contrib/vscode-nas-approval/lib/session.js`
- Test: `contrib/vscode-nas-approval/lib/watchState_test.js`
- Test: `contrib/vscode-nas-approval/lib/session_test.js`
- Modify: `package.json` (test/test:unit/lint スクリプト)

**Interfaces:**
- Produces (後続タスクが使う):
  - `isValidId(id: unknown): boolean` — `/^[A-Za-z0-9_-]+$/`
  - `makeWatchState(): { hostexec: Map<string, object>, network: Map<string, object> }`
  - `applyWatchEvent(state, event): boolean` — 変化があれば true
  - `pendingCount(state): number`
  - `parseDevcontainerStatus(stdout: string): { phase: string, sessionId: string | null } | null`
  - `readySessionId(status): string | null` — phase === "ready" かつ id 正当なら sessionId

- [ ] **Step 1: 失敗するテストを書く**

`contrib/vscode-nas-approval/lib/watchState_test.js`:

```js
import { expect, test } from "bun:test";
import {
  applyWatchEvent,
  makeWatchState,
  pendingCount,
} from "./watchState.js";

const added = (domain, sessionId, requestId) => ({
  event: "added",
  domain,
  entry: { sessionId, requestId, host: "example.com" },
});
const removed = (domain, sessionId, requestId) => ({
  event: "removed",
  domain,
  sessionId,
  requestId,
});

test("added/removed change the count", () => {
  const s = makeWatchState();
  expect(applyWatchEvent(s, added("hostexec", "s1", "r1"))).toBe(true);
  expect(applyWatchEvent(s, added("network", "s1", "r2"))).toBe(true);
  expect(pendingCount(s)).toBe(2);
  expect(applyWatchEvent(s, removed("hostexec", "s1", "r1"))).toBe(true);
  expect(pendingCount(s)).toBe(1);
});

test("duplicate added is a no-op", () => {
  const s = makeWatchState();
  applyWatchEvent(s, added("hostexec", "s1", "r1"));
  expect(applyWatchEvent(s, added("hostexec", "s1", "r1"))).toBe(false);
  expect(pendingCount(s)).toBe(1);
});

test("removed for unknown key is a no-op; unknown domain ignored", () => {
  const s = makeWatchState();
  expect(applyWatchEvent(s, removed("hostexec", "s1", "rx"))).toBe(false);
  expect(applyWatchEvent(s, added("other", "s1", "r1"))).toBe(false);
});
```

`contrib/vscode-nas-approval/lib/session_test.js`:

```js
import { expect, test } from "bun:test";
import { isValidId } from "./ids.js";
import { parseDevcontainerStatus, readySessionId } from "./session.js";

test("isValidId accepts nas id shape and rejects flag-like values", () => {
  expect(isValidId("sess_a1B2-c3")).toBe(true);
  expect(isValidId("--scope")).toBe(false);
  expect(isValidId("")).toBe(false);
  expect(isValidId(42)).toBe(false);
});

test("parseDevcontainerStatus returns null for uninitialized workspace", () => {
  expect(parseDevcontainerStatus("null\n")).toBeNull();
});

test("readySessionId yields id only for ready sessions", () => {
  const ready = parseDevcontainerStatus(
    JSON.stringify({ phase: "ready", sessionId: "sess_x9" }),
  );
  expect(readySessionId(ready)).toBe("sess_x9");
  const starting = parseDevcontainerStatus(
    JSON.stringify({ phase: "starting", sessionId: "sess_x9" }),
  );
  expect(readySessionId(starting)).toBeNull();
  const bad = { phase: "ready", sessionId: "--bogus" };
  expect(readySessionId(bad)).toBeNull();
});
```

- [ ] **Step 2: 失敗を確認**

Run: `bun test contrib/vscode-nas-approval/`
Expected: FAIL (モジュール不在)

- [ ] **Step 3: 実装**

`contrib/vscode-nas-approval/lib/ids.js`:

```js
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function isValidId(id) {
  return typeof id === "string" && ID_PATTERN.test(id);
}

module.exports = { isValidId };
```

`contrib/vscode-nas-approval/lib/watchState.js`:

```js
function pendingKey(sessionId, requestId) {
  return `${sessionId}/${requestId}`;
}

function makeWatchState() {
  return { hostexec: new Map(), network: new Map() };
}

// nas <domain> watch の 1 行 JSON を状態へ畳む。変化があったとき true。
function applyWatchEvent(state, event) {
  const bucket = state[event.domain];
  if (!bucket) return false;
  if (event.event === "added") {
    const key = pendingKey(event.entry.sessionId, event.entry.requestId);
    if (bucket.has(key)) return false;
    bucket.set(key, event.entry);
    return true;
  }
  if (event.event === "removed") {
    return bucket.delete(pendingKey(event.sessionId, event.requestId));
  }
  return false;
}

function pendingCount(state) {
  let n = 0;
  for (const bucket of Object.values(state)) n += bucket.size;
  return n;
}

module.exports = { applyWatchEvent, makeWatchState, pendingCount, pendingKey };
```

`contrib/vscode-nas-approval/lib/session.js`:

```js
const { isValidId } = require("./ids.js");

// `nas devcontainer status --json` の stdout を解釈する。
// 未 init の workspace では nas が JSON の null を出力する。
function parseDevcontainerStatus(stdout) {
  const data = JSON.parse(stdout);
  if (data === null) return null;
  return {
    phase: typeof data.phase === "string" ? data.phase : "stopped",
    sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
  };
}

function readySessionId(status) {
  if (!status || status.phase !== "ready") return null;
  return isValidId(status.sessionId) ? status.sessionId : null;
}

module.exports = { parseDevcontainerStatus, readySessionId };
```

`contrib/vscode-nas-approval/package.json`:

```json
{
  "name": "nas-approval",
  "displayName": "nas approvals",
  "description": "Surface nas devcontainer approval requests (hostexec/network) inside VS Code",
  "version": "0.1.0",
  "publisher": "nas",
  "license": "MIT",
  "engines": { "vscode": "^1.90.0" },
  "extensionKind": ["ui"],
  "activationEvents": ["onStartupFinished"],
  "main": "./extension.js",
  "contributes": {
    "commands": [
      { "command": "nas-approval.review", "title": "NAS: Review Pending Approvals" },
      { "command": "nas-approval.refresh", "title": "NAS: Refresh Approval Session" }
    ],
    "configuration": {
      "title": "nas approval",
      "properties": {
        "nas-approval.nasPath": {
          "type": "string",
          "default": "nas",
          "description": "Path to the nas binary"
        }
      }
    }
  },
  "scripts": {
    "vscode:package": "vsce package --no-dependencies"
  }
}
```

`contrib/vscode-nas-approval/.vscodeignore`:

```
**/*_test.js
.git
```

`contrib/vscode-nas-approval/README.md` (導入手順 — nix / vsix / 手動配置):

```markdown
# nas-approval

Routes nas Dev Container approval requests (hostexec / network) into the
attached VS Code window. Active only when `vscode.env.remoteName` is
`dev-container` and the workspace is registered with `nas devcontainer`.

## Install (nix / home-manager)

```nix
programs.vscode.extensions = [
  (pkgs.vscode-utils.buildVscodeExtension {
    pname = "nas-approval";
    version = "0.1.0";
    src = <path to>/contrib/vscode-nas-approval;
  })
];
```

## Install (vsix)

```sh
bun x @vscode/vsce package --no-dependencies   # produces nas-approval-0.1.0.vsix
code --install-extension nas-approval-0.1.0.vsix
```

## Install (manual)

Copy this directory to
`~/.vscode/extensions/nas.nas-approval-0.1.0/` and restart VS Code.

## Settings

- `nas-approval.nasPath` — path to the `nas` binary (default: `nas`).
```

- [ ] **Step 4: テスト通過**

Run: `bun test contrib/vscode-nas-approval/`
Expected: PASS (5 tests)

- [ ] **Step 5: ルート package.json に contrib を組み込む**

`package.json` のスクリプトを更新:

```json
"test": "bun test src/ tests/ contrib/vscode-nas-approval/",
"test:unit": "bash -c 'bun test $(find src -name \"*_test.ts\" ! -name \"*integration_test.ts\") $(find contrib/vscode-nas-approval -name \"*_test.js\" 2>/dev/null)'",
"lint": "biome check src/ tests/ scripts/ contrib/vscode-nas-approval/ main.ts",
```

Run: `bun run test:unit` と `bun run lint`
Expected: 両方 PASS (biome の指摘があれば従って修正)

- [ ] **Step 6: Commit**

```bash
git add contrib/vscode-nas-approval package.json
git commit -m "feat(vscode-approval): scaffold extension with watch-state core"
```

---

### Task 3: カード view model と decision argv

watch の `entry` を Webview 描画用の view model に写す純粋モジュールと、
approve/deny の argv を組み立てる純粋モジュール。語彙は
`src/ui/frontend/src/components/pendingCardView.ts` に揃える。

**Files:**
- Create: `contrib/vscode-nas-approval/lib/cards.js`
- Create: `contrib/vscode-nas-approval/lib/decision.js`
- Test: `contrib/vscode-nas-approval/lib/cards_test.js`
- Test: `contrib/vscode-nas-approval/lib/decision_test.js`

**Interfaces:**
- Consumes: `isValidId` (Task 2)
- Produces:
  - `cardViewModel(domain: string, entry: object): object | null`
    — `{ key, domain, sessionId, requestId, title, meta: [{label,value}],
        warning: string|null, reason: {label,hint}|null,
        violations: [{label}], scopes: [{value,label}], selectedScope }`
    — unknown domain は null
  - `decisionArgv(msg: {domain, action, sessionId, requestId, scope?}): string[]`
    — 検証失敗は throw

- [ ] **Step 1: 失敗するテストを書く**

`contrib/vscode-nas-approval/lib/decision_test.js`:

```js
import { expect, test } from "bun:test";
import { decisionArgv } from "./decision.js";

const base = { domain: "hostexec", action: "approve", sessionId: "s1", requestId: "r1" };

test("approve with scope", () => {
  expect(decisionArgv({ ...base, scope: "capability" })).toEqual([
    "hostexec", "approve", "s1", "r1", "--scope", "capability",
  ]);
});

test("deny never carries a scope", () => {
  expect(decisionArgv({ ...base, action: "deny", scope: "capability" })).toEqual([
    "hostexec", "deny", "s1", "r1",
  ]);
});

test("flag-shaped ids and unknown domain are rejected", () => {
  expect(() => decisionArgv({ ...base, sessionId: "--scope" })).toThrow();
  expect(() => decisionArgv({ ...base, domain: "other" })).toThrow();
  expect(() => decisionArgv({ ...base, action: "hold" })).toThrow();
});
```

`contrib/vscode-nas-approval/lib/cards_test.js`:

```js
import { expect, test } from "bun:test";
import { cardViewModel } from "./cards.js";

test("network card keeps method/target and filters unknown scopes", () => {
  const vm = cardViewModel("network", {
    sessionId: "s1", requestId: "r1", host: "api.anthropic.com", port: 443,
    method: "post", ruleId: "anthropic.messages", askReason: "rule",
    approvalScopes: ["once", "bogus", "host-port"],
    reviewContext: { path: "/v1/messages", bodySize: 1200 },
  });
  expect(vm.title).toBe("POST api.anthropic.com:443");
  expect(vm.scopes.map((s) => s.value)).toEqual(["once", "host-port"]);
  expect(vm.reason.label).toBe("the matched rule asks for review");
});

test("network card falls back to once when scopes are empty", () => {
  const vm = cardViewModel("network", {
    sessionId: "s1", requestId: "r1", host: "h", port: 80,
    approvalScopes: [],
  });
  expect(vm.scopes.map((s) => s.value)).toEqual(["once"]);
});

test("hostexec card joins argv, surfaces integrity warning, defaults scope", () => {
  const vm = cardViewModel("hostexec", {
    sessionId: "s1", requestId: "r1", argv0: "bun", args: ["run", "test"],
    cwd: "/repo", ruleId: "dev-tools",
    integrityChanged: true, defaultScope: "capability",
  });
  expect(vm.title).toBe("bun run test");
  expect(vm.warning).toContain("changed");
  expect(vm.selectedScope).toBe("capability");
  expect(vm.scopes.map((s) => s.value)).toEqual(["once", "capability"]);
});

test("unknown domain returns null", () => {
  expect(cardViewModel("other", {})).toBeNull();
});
```

- [ ] **Step 2: 失敗を確認**

Run: `bun test contrib/vscode-nas-approval/lib/cards_test.js contrib/vscode-nas-approval/lib/decision_test.js`
Expected: FAIL

- [ ] **Step 3: 実装**

`contrib/vscode-nas-approval/lib/cards.js`:

```js
const { pendingKey } = require("./watchState.js");

const KNOWN_NETWORK_SCOPES = ["once", "rule", "host-port", "host", "violation"];

const NETWORK_SCOPE_LABELS = {
  once: "This request only",
  rule: "Same rule and target, this session",
  "host-port": "Same rule, host and port, this session",
  host: "Same rule and host, this session",
  violation: "Matching violations, this session",
};

const HOSTEXEC_SCOPES = [
  { value: "once", label: "This request only" },
  { value: "capability", label: "Matching command for this session" },
];

// src/ui/frontend/src/components/pendingCardView.ts の ASK_REASONS と同じ語彙。
const ASK_REASONS = {
  rule: {
    label: "the matched rule asks for review",
    hint: "A rule matched this request and its action for a match is review.",
  },
  indeterminate: {
    label: "the rule could not be decided on this body",
    hint: "A rule matched, but its body condition could not be settled on this request.",
  },
  "scope-fallback": {
    label: "no rule in this scope matched",
    hint: "This host has a scope, but no rule in it matched; the scope's fallback is review.",
  },
  "network-fallback": {
    label: "no scope covers this host",
    hint: "No scope claims this host; the document's fallback is review.",
  },
};

function networkCard(entry) {
  const scopes = (entry.approvalScopes ?? [])
    .filter((s) => KNOWN_NETWORK_SCOPES.includes(s))
    .map((value) => ({ value, label: NETWORK_SCOPE_LABELS[value] }));
  if (scopes.length === 0) scopes.push({ value: "once", label: NETWORK_SCOPE_LABELS.once });
  const violations = (entry.violations ?? []).map((v) => ({
    label: [v.pointer, v.value].filter(Boolean).join(" = ") || "violation",
  }));
  const meta = [];
  if (entry.reviewContext?.path) {
    meta.push({
      label: "Request",
      value: `${entry.reviewContext.path} · body ${entry.reviewContext.bodySize ?? "?"}B`,
    });
  }
  if (entry.ruleId) meta.push({ label: "Rule", value: entry.ruleId });
  return {
    key: `network:${pendingKey(entry.sessionId, entry.requestId)}`,
    domain: "network",
    sessionId: entry.sessionId,
    requestId: entry.requestId,
    title: `${(entry.method ?? "GET").toUpperCase()} ${entry.host}:${entry.port}`,
    createdAt: entry.createdAt ?? null,
    meta,
    warning: null,
    reason: entry.askReason
      ? (ASK_REASONS[entry.askReason] ?? { label: entry.askReason, hint: "" })
      : null,
    violations,
    scopes,
    selectedScope: scopes[0].value,
  };
}

function hostExecCard(entry) {
  const meta = [];
  if (entry.cwd) meta.push({ label: "Working directory", value: entry.cwd });
  if (entry.ruleId) meta.push({ label: "Rule", value: entry.ruleId });
  if (entry.capability?.envBindings?.length) {
    meta.push({
      label: "Environment bindings",
      value: entry.capability.envBindings
        .map((b) => `${b.key} ← ${b.source}`)
        .join(", "),
    });
  }
  return {
    key: `hostexec:${pendingKey(entry.sessionId, entry.requestId)}`,
    domain: "hostexec",
    sessionId: entry.sessionId,
    requestId: entry.requestId,
    title: [entry.argv0, ...(entry.args ?? [])].join(" "),
    createdAt: entry.createdAt ?? null,
    meta,
    warning: entry.integrityChanged === true
      ? "Target file changed since session start"
      : null,
    reason: null,
    violations: [],
    scopes: HOSTEXEC_SCOPES,
    selectedScope: entry.defaultScope === "capability" ? "capability" : "once",
  };
}

function cardViewModel(domain, entry) {
  if (domain === "network") return networkCard(entry);
  if (domain === "hostexec") return hostExecCard(entry);
  return null;
}

module.exports = { cardViewModel };
```

`contrib/vscode-nas-approval/lib/decision.js`:

```js
const { isValidId } = require("./ids.js");

const DOMAINS = new Set(["hostexec", "network"]);

// Webview からの決定メッセージを nas argv に変換する。検証失敗は throw。
function decisionArgv(msg) {
  if (!DOMAINS.has(msg.domain)) throw new Error(`unknown domain: ${msg.domain}`);
  if (!isValidId(msg.sessionId)) throw new Error(`bad sessionId: ${msg.sessionId}`);
  if (!isValidId(msg.requestId)) throw new Error(`bad requestId: ${msg.requestId}`);
  if (msg.action === "deny") return [msg.domain, "deny", msg.sessionId, msg.requestId];
  if (msg.action !== "approve") throw new Error(`unknown action: ${msg.action}`);
  const argv = [msg.domain, "approve", msg.sessionId, msg.requestId];
  if (msg.scope !== undefined && msg.scope !== null) {
    if (!isValidId(msg.scope)) throw new Error(`bad scope: ${msg.scope}`);
    argv.push("--scope", msg.scope);
  }
  return argv;
}

module.exports = { decisionArgv };
```

- [ ] **Step 4: テスト通過**

Run: `bun test contrib/vscode-nas-approval/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add contrib/vscode-nas-approval/lib/
git commit -m "feat(vscode-approval): add card view models and decision argv builder"
```

---

### Task 4: 拡張の配線 — activation ゲート・セッション解決・watcher・通知層

`extension.js` と `lib/nasCli.js` を書く。ここは VS Code API と spawn の
薄い接着剤で、純粋ロジックは Task 2/3 に済んでいる。
`nas-approval.review` は Task 5 の Webview が来るまで pending 一覧を
info message に出す仮実装とする。

**Files:**
- Create: `contrib/vscode-nas-approval/extension.js`
- Create: `contrib/vscode-nas-approval/lib/nasCli.js`

**Interfaces:**
- Consumes: `parseDevcontainerStatus`, `readySessionId`, `makeWatchState`,
  `applyWatchEvent`, `pendingCount` (Task 2); `cardViewModel` (Task 3)
- Produces:
  - `runNas(nasPath: string, args: string[]): Promise<string>` — stdout 解決、
    非ゼロ終了・spawn 失敗は reject (ENOENT は err.code で判別可能)
  - `spawnNasWatch(nasPath, domain, sessionId, {onLine, onError, onExit}): ChildProcess`

- [ ] **Step 1: `lib/nasCli.js`**

```js
const { spawn } = require("node:child_process");

// nas サブコマンドを実行し stdout を返す。非ゼロ終了は stderr 付きで reject。
function runNas(nasPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(nasPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error(`nas ${args.join(" ")} exited ${code}: ${err.trim()}`)),
    );
  });
}

// `nas <domain> watch --session <sid>` を spawn し、行区切りで onLine を呼ぶ。
function spawnNasWatch(nasPath, domain, sessionId, handlers) {
  const child = spawn(nasPath, [domain, "watch", "--session", sessionId], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) handlers.onLine(line);
    }
  });
  child.stderr.on("data", (d) => handlers.onError?.(String(d)));
  child.on("error", (err) => {
    handlers.onError?.(String(err));
    handlers.onExit?.(-1);
  });
  child.on("close", (code) => handlers.onExit?.(code));
  return child;
}

module.exports = { runNas, spawnNasWatch };
```

- [ ] **Step 2: `extension.js`**

```js
const vscode = require("vscode");
const { runNas, spawnNasWatch } = require("./lib/nasCli");
const { parseDevcontainerStatus, readySessionId } = require("./lib/session");
const { makeWatchState, applyWatchEvent, pendingCount } = require("./lib/watchState");
const { cardViewModel } = require("./lib/cards");

const POLL_MS = 30_000;
const DOMAINS = ["hostexec", "network"];

function activate(context) {
  // nas Dev Container 以外 (local / SSH / WSL / web) では何もしない。
  if (vscode.env.remoteName !== "dev-container") return;

  const nasPath = () =>
    vscode.workspace.getConfiguration("nas-approval").get("nasPath", "nas");
  const output = vscode.window.createOutputChannel("nas approval");
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    10,
  );
  statusBar.command = "nas-approval.review";
  context.subscriptions.push(statusBar, output);

  // fsPath -> { sessionId, watchState, watchers, pollTimer, gaveUp }
  const folders = new Map();
  let lastTotal = 0;
  let panel = null; // Task 5 で ApprovalsPanel に差し替わる

  const collectCards = () => {
    const cards = [];
    for (const f of folders.values()) {
      for (const domain of DOMAINS) {
        for (const entry of f.watchState[domain].values()) {
          const vm = cardViewModel(domain, entry);
          if (vm) cards.push(vm);
        }
      }
    }
    return cards;
  };

  const refreshUi = () => {
    const total = [...folders.values()].reduce(
      (n, f) => n + pendingCount(f.watchState),
      0,
    );
    const watching = [...folders.values()].some((f) => f.sessionId);
    if (watching) {
      statusBar.text = total > 0 ? `$(bell-dot) nas: ${total}` : "$(shield) nas";
      statusBar.backgroundColor =
        total > 0
          ? new vscode.ThemeColor("statusBarItem.warningBackground")
          : undefined;
      statusBar.show();
    } else {
      statusBar.hide();
    }
    if (total > 0 && lastTotal === 0) {
      vscode.window
        .showWarningMessage(`nas: ${total} pending approval(s)`, "Review")
        .then((pick) => {
          if (pick === "Review")
            vscode.commands.executeCommand("nas-approval.review");
        });
    }
    lastTotal = total;
    panel?.update(collectCards());
  };

  const stopWatchers = (f) => {
    for (const w of f.watchers) w.kill("SIGTERM");
    f.watchers = [];
    f.watchState = makeWatchState();
    f.sessionId = null;
  };

  const schedulePoll = (fsPath, f) => {
    if (f.pollTimer || f.gaveUp) return;
    f.pollTimer = setTimeout(() => {
      f.pollTimer = null;
      resolveSession(fsPath, f);
    }, POLL_MS);
  };

  const startWatchers = (fsPath, f, sessionId) => {
    f.sessionId = sessionId;
    for (const domain of DOMAINS) {
      f.watchers.push(
        spawnNasWatch(nasPath(), domain, sessionId, {
          onLine: (line) => {
            try {
              if (applyWatchEvent(f.watchState, JSON.parse(line))) refreshUi();
            } catch {
              // 壊れた行は捨てる。購読自体は継続する。
            }
          },
          onError: (msg) => output.appendLine(`[${domain}] ${msg.trimEnd()}`),
          onExit: () => {
            // EOF はセッション終了。次のセッションを待つ。
            stopWatchers(f);
            refreshUi();
            schedulePoll(fsPath, f);
          },
        }),
      );
    }
  };

  const resolveSession = async (fsPath, f) => {
    let out;
    try {
      out = await runNas(nasPath(), [
        "devcontainer", "status", "--workspace", fsPath, "--json",
      ]);
    } catch (err) {
      if (err.code === "ENOENT") {
        f.gaveUp = true; // nas 不在: この folder では諦める
        return;
      }
      output.appendLine(`status failed for ${fsPath}: ${err.message}`);
      schedulePoll(fsPath, f);
      return;
    }
    let status;
    try {
      status = parseDevcontainerStatus(out);
    } catch {
      output.appendLine(`unparseable status for ${fsPath}`);
      schedulePoll(fsPath, f);
      return;
    }
    if (status === null) {
      f.gaveUp = true; // nas 管理外の workspace: 以後ポーリングしない
      return;
    }
    const sid = readySessionId(status);
    if (sid) startWatchers(fsPath, f, sid);
    else schedulePoll(fsPath, f);
    refreshUi();
  };

  const rescan = () => {
    const open = new Set(
      (vscode.workspace.workspaceFolders ?? []).map((w) => w.uri.fsPath),
    );
    for (const fsPath of open) {
      if (!folders.has(fsPath)) {
        folders.set(fsPath, {
          sessionId: null,
          watchState: makeWatchState(),
          watchers: [],
          pollTimer: null,
          gaveUp: false,
        });
      }
      const f = folders.get(fsPath);
      if (!f.sessionId && !f.pollTimer && !f.gaveUp) resolveSession(fsPath, f);
    }
    for (const [fsPath, f] of folders) {
      if (!open.has(fsPath)) {
        if (f.pollTimer) clearTimeout(f.pollTimer);
        stopWatchers(f);
        folders.delete(fsPath);
      }
    }
    refreshUi();
  };

  rescan();
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(rescan),
    vscode.commands.registerCommand("nas-approval.refresh", () => {
      for (const f of folders.values()) f.gaveUp = false;
      rescan();
    }),
    // Task 5 で Webview パネルに差し替える仮実装。
    vscode.commands.registerCommand("nas-approval.review", () => {
      const cards = collectCards();
      if (cards.length === 0) {
        vscode.window.showInformationMessage("No pending nas approvals.");
        return;
      }
      vscode.window.showInformationMessage(
        `${cards.length} pending: ${cards.map((c) => c.title).join("; ")}`,
      );
    }),
    {
      dispose: () => {
        for (const f of folders.values()) {
          if (f.pollTimer) clearTimeout(f.pollTimer);
          stopWatchers(f);
        }
      },
    },
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
```

- [ ] **Step 3: lint / test 通過を確認**

Run: `bun run lint && bun run test:unit`
Expected: PASS (biome の指摘は従って修正)

- [ ] **Step 4: Commit**

```bash
git add contrib/vscode-nas-approval/extension.js contrib/vscode-nas-approval/lib/nasCli.js
git commit -m "feat(vscode-approval): session resolution, watchers, status bar and toast"
```

---

### Task 5: Webview カード UI と決定送信

nas ui の pending カードに倣った Webview パネルを実装し、
`nas-approval.review` を本実装に差し替える。

**Files:**
- Create: `contrib/vscode-nas-approval/lib/webview.js`
- Create: `contrib/vscode-nas-approval/lib/webviewHtml.js`
- Test: `contrib/vscode-nas-approval/lib/webviewHtml_test.js`
- Modify: `contrib/vscode-nas-approval/extension.js` (review コマンド差し替え)

**Interfaces:**
- Consumes: `cardViewModel` の view model (Task 3)、`decisionArgv` (Task 3)、
  `runNas` (Task 4)
- Produces:
  - `ApprovalsPanel.show(context, {getCards, onDecision})` — シングルトン panel、
    `update(cards)` と `postError(key, message)` を持つ
  - `renderShell(nonce): string` — CSP/スタイル/描画スクリプト入り HTML (純粋関数)

- [ ] **Step 1: `webviewHtml.js` のテストを書く**

`contrib/vscode-nas-approval/lib/webviewHtml_test.js`:

```js
import { expect, test } from "bun:test";
import { renderShell } from "./webviewHtml.js";

test("shell carries a nonce-scoped CSP and no remote resources", () => {
  const html = renderShell("NONCE123");
  expect(html).toContain("default-src 'none'");
  expect(html).toContain("script-src 'nonce-NONCE123'");
  expect(html).toContain('nonce="NONCE123"');
  expect(html).not.toContain("http://");
  expect(html).not.toContain("https://");
});

test("shell script posts ready and decides on click", () => {
  const html = renderShell("N");
  expect(html).toContain('vscode.postMessage({ type: "ready" })');
  expect(html).toContain('type: "decide"');
});
```

- [ ] **Step 2: 失敗を確認**

Run: `bun test contrib/vscode-nas-approval/lib/webviewHtml_test.js`
Expected: FAIL

- [ ] **Step 3: `webviewHtml.js` を実装**

```js
// Webview の骨格 HTML を返す純粋関数。カードの view model は
// extension 側から postMessage で届き、インラインスクリプトが DOM を描く。
function renderShell(nonce) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         padding: 12px; }
  .card { border: 1px solid var(--vscode-panel-border);
          border-radius: 6px; padding: 10px 12px; margin-bottom: 10px; }
  .title { font-weight: 600; word-break: break-all; }
  .meta, .reason, .viol { font-size: 0.9em; opacity: 0.85; margin-top: 4px; }
  .warning { color: var(--vscode-editorWarning-foreground); margin-top: 4px; }
  .err { color: var(--vscode-errorForeground); margin-top: 4px; }
  .row { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
  select, button { font: inherit; color: var(--vscode-button-secondaryForeground);
                   background: var(--vscode-button-secondaryBackground);
                   border: 1px solid var(--vscode-button-border, transparent);
                   border-radius: 4px; padding: 3px 8px; }
  button.primary { color: var(--vscode-button-foreground);
                   background: var(--vscode-button-background); }
  button[disabled] { opacity: 0.5; }
  .empty { opacity: 0.7; }
</style>
</head>
<body>
<div id="root"><p class="empty">No pending approvals.</p></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");
  const esc = (s) => String(s).replace(/[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function render(cards) {
    if (!cards.length) {
      root.innerHTML = '<p class="empty">No pending approvals.</p>';
      return;
    }
    root.innerHTML = cards.map((c) => {
      const opts = c.scopes.map((s) =>
        '<option value="' + esc(s.value) + '"' +
        (s.value === c.selectedScope ? " selected" : "") + ">" +
        esc(s.label) + "</option>").join("");
      const meta = c.meta.map((m) =>
        '<div class="meta"><b>' + esc(m.label) + ":</b> " + esc(m.value) +
        "</div>").join("");
      const reason = c.reason
        ? '<div class="reason">' + esc(c.reason.label) +
          (c.reason.hint ? " — " + esc(c.reason.hint) : "") + "</div>" : "";
      const viol = c.violations.length
        ? '<div class="viol">violations: ' +
          c.violations.map((v) => esc(v.label)).join("; ") + "</div>" : "";
      const warn = c.warning
        ? '<div class="warning">&#9888; ' + esc(c.warning) + "</div>" : "";
      return '<div class="card" data-key="' + esc(c.key) + '">' +
        '<div class="title">' + esc(c.title) + "</div>" +
        meta + reason + viol + warn +
        '<div class="row"><select>' + opts + "</select>" +
        '<button class="primary" data-act="approve">Approve</button>' +
        '<button data-act="deny">Deny</button></div>' +
        '<div class="err"></div></div>';
    }).join("");
  }

  root.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const cardEl = btn.closest(".card");
    const key = cardEl.dataset.key;
    const card = lastCards.find((c) => c.key === key);
    if (!card) return;
    for (const b of cardEl.querySelectorAll("button")) b.disabled = true;
    vscode.postMessage({
      type: "decide",
      key,
      domain: card.domain,
      action: btn.dataset.act,
      sessionId: card.sessionId,
      requestId: card.requestId,
      scope: cardEl.querySelector("select").value,
    });
  });

  let lastCards = [];
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "state") { lastCards = m.cards; render(m.cards); }
    if (m.type === "error") {
      const el = document.querySelector(
        '.card[data-key="' + CSS.escape(m.key) + '"] .err');
      if (el) {
        el.textContent = m.message;
        for (const b of el.closest(".card").querySelectorAll("button"))
          b.disabled = false;
      }
    }
  });
  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}

module.exports = { renderShell };
```

- [ ] **Step 4: テスト通過**

Run: `bun test contrib/vscode-nas-approval/lib/webviewHtml_test.js`
Expected: PASS

- [ ] **Step 5: `lib/webview.js` を実装**

```js
const crypto = require("node:crypto");
const vscode = require("vscode");
const { renderShell } = require("./webviewHtml.js");

class ApprovalsPanel {
  // getCards(): view model 配列を返す関数。onDecision(msg): decide を処理。
  static show(context, { getCards, onDecision }) {
    if (ApprovalsPanel.current) {
      ApprovalsPanel.current.panel.reveal();
      ApprovalsPanel.current.update(getCards());
      return ApprovalsPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      "nasApprovals",
      "nas approvals",
      vscode.ViewColumn.Active,
      { enableScripts: true },
    );
    const instance = new ApprovalsPanel(panel, getCards, onDecision);
    ApprovalsPanel.current = instance;
    panel.onDidDispose(() => {
      ApprovalsPanel.current = null;
    });
    return instance;
  }

  constructor(panel, getCards, onDecision) {
    this.panel = panel;
    const nonce = crypto.randomBytes(16).toString("hex");
    panel.webview.html = renderShell(nonce);
    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === "ready") this.update(getCards());
      if (msg?.type === "decide") {
        try {
          await onDecision(msg);
        } catch (err) {
          this.postError(msg.key, String(err?.message ?? err));
        }
      }
    });
  }

  update(cards) {
    this.panel.webview.postMessage({ type: "state", cards });
  }

  postError(key, message) {
    this.panel.webview.postMessage({ type: "error", key, message });
  }
}

module.exports = { ApprovalsPanel };
```

- [ ] **Step 6: review コマンドを本実装に差し替え**

`extension.js` の `nas-approval.review` 登録部分を以下に置き換える
(`decisionArgv` と `ApprovalsPanel` の import も追加):

```js
const { decisionArgv } = require("./lib/decision");
const { ApprovalsPanel } = require("./lib/webview");
```

```js
    vscode.commands.registerCommand("nas-approval.review", () => {
      const cards = collectCards();
      if (cards.length === 0) {
        vscode.window.showInformationMessage("No pending nas approvals.");
        return;
      }
      panel = ApprovalsPanel.show(context, {
        getCards: collectCards,
        onDecision: async (msg) => {
          const argv = decisionArgv(msg); // 検証失敗は throw → カードにエラー表示
          await runNas(nasPath(), argv);
        },
      });
      panel.update(cards);
    }),
```

- [ ] **Step 7: lint / test / vsce パッケージ確認**

Run: `bun run lint && bun run test:unit`
Expected: PASS

Run: `cd contrib/vscode-nas-approval && bun x @vscode/vsce package --no-dependencies`
Expected: `nas-approval-0.1.0.vsix` が生成される
(生成された vsix は gitignore 相当の成果物なので削除するか commit しない)

- [ ] **Step 8: Commit**

```bash
git add contrib/vscode-nas-approval/
git commit -m "feat(vscode-approval): webview approval cards wired to nas approve/deny"
```

---

### Task 6: 実機検証

spec の完了条件。コード変更なし、結果を記録する。

- [ ] **Step 1: 拡張のインストール**

`bun x @vscode/vsce package --no-dependencies` → `code --install-extension`、
または `~/.vscode/extensions/nas.nas-approval-0.1.0/` へ配置。

- [ ] **Step 2: チェックリストの実施**

- nas devcontainer ウィンドウで hostexec 要求 (profile の approval ルールに
  掛かるコマンド) と network 要求 (未許可ホストへの fetch) を起こす
- status bar に件数、toast が 0→N で1回だけ出ること
- Review → カード表示 → scope 選択 → Approve/Deny で要求が消え、
  エージェント側が続行/失敗すること
- `nas devcontainer down` → `up` → Reopen で新セッションに追随すること
- ローカルウィンドウ・自作 devcontainer で拡張が何もしないこと
  (status bar 非表示・OutputChannel にエラーなし)

- [ ] **Step 3: 結果を spec の状態行に反映**

`docs/superpowers/specs/2026-09-18-vscode-approval-design.md` の
「状態」行を実機確認の結果で更新する。未確認の項目は正直に残す。

```bash
git add docs/superpowers/specs/2026-09-18-vscode-approval-design.md
git commit -m "docs(devcontainer): record real-machine verification of approval routing"
```

---

## Self-Review メモ

- Spec coverage: activation ゲート / 購読 / 通知 / Webview / nas 側変更 /
  配布 / テスト方針 — すべて Task 1-6 に対応あり。
- `createTerminal` を介した fzf review は採用せず、決定は
  `nas approve|deny` の argv spawn (Task 5)。
- Webview の optimistic UI はしない: カードが消えるのは watch の
  `removed` のみ。ボタン無効化は busy 表示。
