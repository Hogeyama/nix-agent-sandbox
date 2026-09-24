# エージェント認証情報のホスト管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude の OAuth credential をホスト側の broker が保持・更新し、proxy が `api.anthropic.com` / `mcp-proxy.anthropic.com` への許可済み request にだけ注入する。container にはダミーの `.credentials.json` だけを見せる。

**Architecture:** 設定 `agentState.auth` をエージェントごとの既定値つきで解決する。解決結果が `"proxy"` のとき、mount stage はダミーの `.credentials.json` を作って `~/.claude/.credentials.json` に被せる。proxy stage は session broker に credential source を渡し、broker は許可した request の判定結果に `Authorization` の注入と `x-api-key` の削除を載せる。addon は `removeHeaders` を解釈する。

**Tech Stack:** Bun + TypeScript（Effect）、Pkl、mitmproxy addon（Python）

**Spec:** `docs/superpowers/specs/2026-09-24-agent-credentials-proxy-design.md`

## Global Constraints

- 実装者・レビュアーは次の skill を読んでから作業する: `effect-separation`（`.claude/skills/effect-separation/SKILL.md`）、`security-constraints`（`.claude/skills/security-constraints/SKILL.md`）、`test-policy`（`.claude/skills/test-policy/SKILL.md`）。
- 設定キーは `agentState.auth`、値は `"proxy"` と `"shared"`。未指定時の既定値は Claude が `"proxy"`、それ以外が `"shared"`。
- 注入対象のホストは `api.anthropic.com` と `mcp-proxy.anthropic.com` の2つだけ。注入する header は `Authorization: Bearer <access token>`、削除する header は `x-api-key`。
- container からの `POST https://platform.claude.com/v1/oauth/token` は policy の評価より前に deny し、理由は `credential-refresh-owned-by-host` とする。
- refresh の request は `POST https://platform.claude.com/v1/oauth/token`、JSON body は `{"grant_type": "refresh_token", "refresh_token": ..., "client_id": ..., "scope": ...}`。`client_id` の既定値は `9d1c250a-e61b-44d9-88ed-5944d1962f5e`。
- ロックは `~/.claude/.oauth_refresh.lock` と `<realpath(~/.claude)>.lock` の2つ。mkdir で取得し、5秒ごとに mtime を更新し、60秒以上更新されていないものは stale として奪う。
- ホストの `.credentials.json` への書き戻しは同じ inode への上書きで行い、rename しない。
- 期限の5分前に更新を始め、失敗したら30秒後にやり直す。
- unit test は Docker に触れない（`*_test.ts`）。Docker や実ソケットを使うテストは `*integration_test.ts` に置く。
- コメントは6か月後にファイル全体を読む人向けに書く。変更履歴やこの計画・spec への参照をコードに書かない。周囲のコードのコメント密度と言語（このリポジトリは日本語と英語が混在する。触るファイルの既存の言語に合わせる）に合わせる。
- 最終確認は `bun run check` と `bun run test:unit`。`bun test src/` は使わない。

---

### Task 1: 設定 `agentState.auth` と検証

**Files:**
- Modify: `src/config/Schema.pkl`（`class AgentStateConfig`）
- Modify: `src/config/types.ts:212-223`
- Create: `src/agents/credentials.ts`
- Create: `src/agents/credentials_test.ts`
- Modify: `src/config/validate.ts`（`validateProfile`、56行目付近）
- Modify: `src/config/validate_test.ts`
- Modify: `src/config/load_integration_test.ts`

**Interfaces:**
- Produces:
  - `export type AgentCredentialsMode = "proxy" | "shared";`（`src/config/types.ts`）
  - `AgentStateConfig.auth?: AgentCredentialsMode`
  - `export function resolveAgentCredentials(agent: AgentType, configured: AgentCredentialsMode | undefined): AgentCredentialsMode`（`src/agents/credentials.ts`）
  - `export function supportsProxiedCredentials(agent: AgentType): boolean`（同上）

- [ ] **Step 1: 解決関数の failing test を書く**

`src/agents/credentials_test.ts`:

```ts
import { expect, test } from "bun:test";
import {
  resolveAgentCredentials,
  supportsProxiedCredentials,
} from "./credentials.ts";

test("resolveAgentCredentials: Claude defaults to proxy", () => {
  expect(resolveAgentCredentials("claude", undefined)).toBe("proxy");
});

test("resolveAgentCredentials: other agents default to shared", () => {
  expect(resolveAgentCredentials("codex", undefined)).toBe("shared");
  expect(resolveAgentCredentials("copilot", undefined)).toBe("shared");
});

test("resolveAgentCredentials: an explicit value wins over the default", () => {
  expect(resolveAgentCredentials("claude", "shared")).toBe("shared");
  expect(resolveAgentCredentials("codex", "proxy")).toBe("proxy");
});

test("supportsProxiedCredentials: only Claude is implemented", () => {
  expect(supportsProxiedCredentials("claude")).toBe(true);
  expect(supportsProxiedCredentials("codex")).toBe(false);
  expect(supportsProxiedCredentials("copilot")).toBe(false);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `bun test src/agents/credentials_test.ts`
Expected: FAIL（`./credentials.ts` が存在しない）

- [ ] **Step 3: 型と解決関数を実装する**

`src/config/types.ts` の `AgentStateConfig` を次に置き換える（`DEFAULT_AGENT_STATE_CONFIG` は変更しない）:

```ts
/** エージェント自身のログイン情報の扱い */
export type AgentCredentialsMode = "proxy" | "shared";

/** ホストのエージェント状態ディレクトリ (`~/.claude` 等) の扱い */
export interface AgentStateConfig {
  /**
   * Claude は設定類を RO、認証・履歴・プロジェクト状態を RW 共有する。
   * Codex / Copilot は実在する設定ファイルを RO で上乗せする。
   */
  protectSettings: boolean;
  /**
   * 未指定ならエージェントごとの既定値 (`resolveAgentCredentials`) に従う。
   * Pkl は null のプロパティを JSON に出力しないので、未指定は undefined になる。
   */
  auth?: AgentCredentialsMode;
}
```

`src/agents/credentials.ts`:

```ts
import type { AgentCredentialsMode } from "../config/types.ts";
import type { AgentType } from "./types.ts";

/** ホスト側で認証情報を保持し proxy で注入する方式を実装済みのエージェントか。 */
export function supportsProxiedCredentials(agent: AgentType): boolean {
  return agent === "claude";
}

/**
 * `agentState.auth` の実効値。未指定なら、実装済みのエージェントは
 * `"proxy"`、それ以外は従来どおり `"shared"` になる。
 */
export function resolveAgentCredentials(
  agent: AgentType,
  configured: AgentCredentialsMode | undefined,
): AgentCredentialsMode {
  if (configured !== undefined) return configured;
  return supportsProxiedCredentials(agent) ? "proxy" : "shared";
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `bun test src/agents/credentials_test.ts`
Expected: PASS

- [ ] **Step 5: 検証の failing test を書く**

`src/config/validate_test.ts` の末尾に追加する（`makeProfile` / `makeConfig` はこのファイルの既存ヘルパーを使う。名前が異なる場合はファイル内の既存ヘルパーに合わせる）:

```ts
test("validate: agentState.auth proxy is rejected for agents other than claude", () => {
  const config = makeConfig({
    profiles: {
      p: makeProfile({
        agent: "codex",
        agentState: { protectSettings: false, auth: "proxy" },
      }),
    },
  });
  expect(() => validateConfig(config)).toThrow(
    /agentState\\.auth = "proxy" currently supports only agent "claude"/,
  );
});

test("validate: proxied Claude credentials reject a static ANTHROPIC_API_KEY env", () => {
  const config = makeConfig({
    profiles: {
      p: makeProfile({
        agent: "claude",
        env: [{ key: "ANTHROPIC_API_KEY", val: "x", mode: "set" }],
      }),
    },
  });
  expect(() => validateConfig(config)).toThrow(
    /ANTHROPIC_API_KEY[\s\S]*agentState\\.auth = "shared"/,
  );
});

test("validate: proxied Claude credentials reject a static ANTHROPIC_AUTH_TOKEN env", () => {
  const config = makeConfig({
    profiles: {
      p: makeProfile({
        agent: "claude",
        env: [{ key: "ANTHROPIC_AUTH_TOKEN", val: "x", mode: "set" }],
      }),
    },
  });
  expect(() => validateConfig(config)).toThrow(/ANTHROPIC_AUTH_TOKEN/);
});

test("validate: shared Claude credentials accept an API key env", () => {
  const config = makeConfig({
    profiles: {
      p: makeProfile({
        agent: "claude",
        agentState: { protectSettings: false, auth: "shared" },
        env: [{ key: "ANTHROPIC_API_KEY", val: "x", mode: "set" }],
      }),
    },
  });
  expect(() => validateConfig(config)).not.toThrow();
});

test("validate: an API key env on codex is not checked", () => {
  const config = makeConfig({
    profiles: {
      p: makeProfile({
        agent: "codex",
        env: [{ key: "ANTHROPIC_API_KEY", val: "x", mode: "set" }],
      }),
    },
  });
  expect(() => validateConfig(config)).not.toThrow();
});
```

- [ ] **Step 6: 失敗を確認する**

Run: `bun test src/config/validate_test.ts`
Expected: 追加した5件のうち、throw を期待する3件が FAIL

- [ ] **Step 7: 検証を実装する**

`src/config/validate.ts` に import を追加する:

```ts
import {
  resolveAgentCredentials,
  supportsProxiedCredentials,
} from "../agents/credentials.ts";
```

`validateProfile` の `errors` 宣言の直後（ACP の検証ブロックより前）に追加する:

```ts
  errors.push(...validateAgentCredentials(name, profile));
```

同じファイルに関数を追加する:

```ts
// ホストの API key を container へ渡す設定は、proxy が x-api-key を削除し
// Authorization を上書きするので動かない。起動前に opt-out を案内する。
const API_KEY_ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

function validateAgentCredentials(name: string, profile: Profile): string[] {
  const errors: string[] = [];
  const configured = profile.agentState.auth;
  if (configured === "proxy" && !supportsProxiedCredentials(profile.agent)) {
    errors.push(
      `profile "${name}": agentState.auth = "proxy" currently supports only agent "claude"; use "shared" for agent "${profile.agent}"`,
    );
  }
  if (
    profile.agent === "claude" &&
    resolveAgentCredentials(profile.agent, configured) === "proxy"
  ) {
    for (const entry of profile.env) {
      // keyCmd のキー名はホストでコマンドを実行するまで決まらない。
      if (!("key" in entry) || !API_KEY_ENV_KEYS.includes(entry.key)) continue;
      errors.push(
        `profile "${name}": env ${entry.key} does not work while Claude credentials are injected by the proxy; set agentState.auth = "shared" to use an API key`,
      );
    }
  }
  return errors;
}
```

- [ ] **Step 8: テストが通ることを確認する**

Run: `bun test src/config/validate_test.ts src/agents/credentials_test.ts`
Expected: PASS

- [ ] **Step 9: Pkl schema を更新する**

`src/config/Schema.pkl` の `class AgentStateConfig` の `protectSettings` の後に追加する:

```pkl

  /// エージェント自身のログイン情報の扱い。
  ///
  /// `"proxy"` はホスト側で認証情報を保持・更新し、network proxy が許可した
  /// request にだけ注入する。container にはダミー値を見せ、ホストの認証情報
  /// ファイルは共有しない。現在は Claude だけが対応する。
  /// `"shared"` はホストの認証情報ファイルを container と共有する。
  /// API key で Claude を使う場合は `"shared"` を指定する。
  ///
  /// 未指定 (null) なら、Claude は `"proxy"`、それ以外は `"shared"`。
  auth: ("proxy"|"shared")? = null
```

1行目の `/// @version` は変更しない。リリース準備の commit でリリース版に合わせて上げる。

- [ ] **Step 10: Pkl の読み込みを確認する integration test を追加する**

`src/config/load_integration_test.ts` に、既存の `withNasConfig` と `hasPkl` のガードを使って追加する（既存テストの config 文字列の書き方に合わせる）:

```ts
test.skipIf(!hasPkl)(
  "loadConfig: agentState.auth is undefined when unset and kept when set",
  async () => {
    const configPkl = `
amends "Schema.pkl"
profiles {
  ["a"] { agent = "claude" }
  ["b"] { agent = "claude"; agentState { auth = "shared" } }
}
`;
    await withNasConfig(configPkl, async (dir) => {
      const config = await loadConfig({ startDir: dir });
      expect(config.profiles.a.agentState.auth).toBeUndefined();
      expect(config.profiles.b.agentState.auth).toBe("shared");
    });
  },
);
```

Run: `bun test src/config/load_integration_test.ts --test-name-pattern 'agentState.auth'`
Expected: PASS（pkl がない環境では skip）

- [ ] **Step 11: 型検査と unit を実行する**

Run: `bun run check && bun run test:unit`
Expected: どちらも成功

- [ ] **Step 12: Commit**

```bash
git add src/config/Schema.pkl src/config/types.ts src/agents/credentials.ts src/agents/credentials_test.ts src/config/validate.ts src/config/validate_test.ts src/config/load_integration_test.ts
git commit
```

---

### Task 2: Claude の credential ファイルの読み取りとダミー生成（pure）

**Files:**
- Create: `src/agents/claude_oauth.ts`
- Create: `src/agents/claude_oauth_test.ts`

**Interfaces:**
- Produces（すべて `src/agents/claude_oauth.ts`）:
  - `export const CLAUDE_OAUTH_DUMMY_ACCESS_TOKEN = "nas-proxy-injected-access-token";`
  - `export const CLAUDE_OAUTH_DUMMY_REFRESH_TOKEN = "nas-proxy-injected-refresh-token";`
  - `export const CLAUDE_OAUTH_DUMMY_EXPIRES_AT = 32503680000000;`（3000-01-01T00:00:00Z）
  - `export interface ClaudeOAuthTokens { readonly accessToken: string; readonly refreshToken: string; readonly expiresAt: number; readonly scopes: readonly string[]; readonly clientId?: string; }`
  - `export class ClaudeOAuthUnavailableError extends Error`
  - `export function parseClaudeOAuthTokens(text: string): ClaudeOAuthTokens`（取れなければ `ClaudeOAuthUnavailableError`）
  - `export function buildDummyClaudeCredentials(hostText: string): string`
  - `export interface RefreshedClaudeTokens { readonly accessToken: string; readonly refreshToken: string; readonly expiresAt: number; readonly refreshTokenExpiresAt?: number; }`
  - `export function applyRefreshedTokens(hostText: string, tokens: RefreshedClaudeTokens): string`

- [ ] **Step 1: failing test を書く**

`src/agents/claude_oauth_test.ts`:

```ts
import { expect, test } from "bun:test";
import {
  applyRefreshedTokens,
  buildDummyClaudeCredentials,
  CLAUDE_OAUTH_DUMMY_ACCESS_TOKEN,
  CLAUDE_OAUTH_DUMMY_EXPIRES_AT,
  CLAUDE_OAUTH_DUMMY_REFRESH_TOKEN,
  ClaudeOAuthUnavailableError,
  parseClaudeOAuthTokens,
} from "./claude_oauth.ts";

const HOST = JSON.stringify({
  claudeAiOauth: {
    accessToken: "real-access",
    refreshToken: "real-refresh",
    expiresAt: 1000,
    refreshTokenExpiresAt: 2000,
    scopes: ["user:inference", "user:profile"],
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
    unknownSecret: "must-not-be-copied",
  },
  organizationUuid: "org-1",
  otherTopLevel: "must-not-be-copied",
});

test("parseClaudeOAuthTokens: reads the OAuth tokens", () => {
  expect(parseClaudeOAuthTokens(HOST)).toEqual({
    accessToken: "real-access",
    refreshToken: "real-refresh",
    expiresAt: 1000,
    scopes: ["user:inference", "user:profile"],
  });
});

test("parseClaudeOAuthTokens: keeps clientId when present", () => {
  const text = JSON.stringify({
    claudeAiOauth: {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 1,
      scopes: [],
      clientId: "client-x",
    },
  });
  expect(parseClaudeOAuthTokens(text).clientId).toBe("client-x");
});

test("parseClaudeOAuthTokens: rejects files without OAuth tokens", () => {
  for (const text of [
    "{}",
    "not json",
    JSON.stringify({ claudeAiOauth: { accessToken: "a" } }),
    JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: "soon", scopes: [] } }),
  ]) {
    expect(() => parseClaudeOAuthTokens(text)).toThrow(
      ClaudeOAuthUnavailableError,
    );
  }
});

test("buildDummyClaudeCredentials: replaces secrets and copies only known fields", () => {
  const dummy = JSON.parse(buildDummyClaudeCredentials(HOST));
  expect(dummy).toEqual({
    claudeAiOauth: {
      accessToken: CLAUDE_OAUTH_DUMMY_ACCESS_TOKEN,
      refreshToken: CLAUDE_OAUTH_DUMMY_REFRESH_TOKEN,
      expiresAt: CLAUDE_OAUTH_DUMMY_EXPIRES_AT,
      refreshTokenExpiresAt: CLAUDE_OAUTH_DUMMY_EXPIRES_AT,
      scopes: ["user:inference", "user:profile"],
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
    },
    organizationUuid: "org-1",
  });
  expect(JSON.stringify(dummy)).not.toContain("real-");
});

test("buildDummyClaudeCredentials: fails when the host file has no OAuth tokens", () => {
  expect(() => buildDummyClaudeCredentials("{}")).toThrow(
    ClaudeOAuthUnavailableError,
  );
});

test("applyRefreshedTokens: replaces only the token fields", () => {
  const next = JSON.parse(
    applyRefreshedTokens(HOST, {
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: 5000,
      refreshTokenExpiresAt: 9000,
    }),
  );
  expect(next.claudeAiOauth.accessToken).toBe("new-access");
  expect(next.claudeAiOauth.refreshToken).toBe("new-refresh");
  expect(next.claudeAiOauth.expiresAt).toBe(5000);
  expect(next.claudeAiOauth.refreshTokenExpiresAt).toBe(9000);
  expect(next.claudeAiOauth.unknownSecret).toBe("must-not-be-copied");
  expect(next.otherTopLevel).toBe("must-not-be-copied");
});

test("applyRefreshedTokens: keeps refreshTokenExpiresAt when the response omits it", () => {
  const next = JSON.parse(
    applyRefreshedTokens(HOST, {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 1,
    }),
  );
  expect(next.claudeAiOauth.refreshTokenExpiresAt).toBe(2000);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `bun test src/agents/claude_oauth_test.ts`
Expected: FAIL（モジュールが存在しない）

- [ ] **Step 3: 実装する**

`src/agents/claude_oauth.ts`:

```ts
/**
 * Claude Code が `~/.claude/.credentials.json` に保存する OAuth credential の
 * 読み取りと組み立て。ファイル I/O は持たない。
 */

export const CLAUDE_OAUTH_DUMMY_ACCESS_TOKEN = "nas-proxy-injected-access-token";
export const CLAUDE_OAUTH_DUMMY_REFRESH_TOKEN =
  "nas-proxy-injected-refresh-token";
// Claude Code は期限が近いと自分で更新を始める。container 内で更新させない
// ために、ダミーの期限は十分遠くに置く (3000-01-01T00:00:00Z)。
export const CLAUDE_OAUTH_DUMMY_EXPIRES_AT = 32503680000000;

export interface ClaudeOAuthTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly scopes: readonly string[];
  readonly clientId?: string;
}

export interface RefreshedClaudeTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly refreshTokenExpiresAt?: number;
}

export class ClaudeOAuthUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `[nas] Claude OAuth credentials are not available on the host (${detail}). ` +
        `Run "claude /login" on the host, or set agentState.auth = "shared" to keep sharing the credentials file (required for API key use).`,
    );
    this.name = "ClaudeOAuthUnavailableError";
  }
}

// ログイン状態の判定に使われる項目だけをダミーへ写す。未知の項目は秘密を
// 含みうるので写さない。
const DUMMY_OAUTH_FIELDS = ["scopes", "subscriptionType", "rateLimitTier"];
const DUMMY_TOP_LEVEL_FIELDS = ["organizationUuid"];

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRoot(text: string): { root: JsonObject; oauth: JsonObject } {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw new ClaudeOAuthUnavailableError("the credentials file is not JSON");
  }
  if (!isObject(root) || !isObject(root.claudeAiOauth)) {
    throw new ClaudeOAuthUnavailableError("no claudeAiOauth entry");
  }
  return { root, oauth: root.claudeAiOauth };
}

export function parseClaudeOAuthTokens(text: string): ClaudeOAuthTokens {
  const { oauth } = parseRoot(text);
  const { accessToken, refreshToken, expiresAt, scopes, clientId } = oauth;
  if (
    typeof accessToken !== "string" ||
    accessToken === "" ||
    typeof refreshToken !== "string" ||
    refreshToken === "" ||
    typeof expiresAt !== "number" ||
    !Array.isArray(scopes) ||
    !scopes.every((s) => typeof s === "string")
  ) {
    throw new ClaudeOAuthUnavailableError("the OAuth entry is incomplete");
  }
  return {
    accessToken,
    refreshToken,
    expiresAt,
    scopes: scopes as string[],
    ...(typeof clientId === "string" ? { clientId } : {}),
  };
}

export function buildDummyClaudeCredentials(hostText: string): string {
  parseClaudeOAuthTokens(hostText);
  const { root, oauth } = parseRoot(hostText);
  const dummyOAuth: JsonObject = {
    accessToken: CLAUDE_OAUTH_DUMMY_ACCESS_TOKEN,
    refreshToken: CLAUDE_OAUTH_DUMMY_REFRESH_TOKEN,
    expiresAt: CLAUDE_OAUTH_DUMMY_EXPIRES_AT,
  };
  if ("refreshTokenExpiresAt" in oauth) {
    dummyOAuth.refreshTokenExpiresAt = CLAUDE_OAUTH_DUMMY_EXPIRES_AT;
  }
  for (const field of DUMMY_OAUTH_FIELDS) {
    if (field in oauth) dummyOAuth[field] = oauth[field];
  }
  const dummy: JsonObject = { claudeAiOauth: dummyOAuth };
  for (const field of DUMMY_TOP_LEVEL_FIELDS) {
    if (field in root) dummy[field] = root[field];
  }
  return `${JSON.stringify(dummy, null, 2)}\n`;
}

export function applyRefreshedTokens(
  hostText: string,
  tokens: RefreshedClaudeTokens,
): string {
  const { root, oauth } = parseRoot(hostText);
  const next: JsonObject = {
    ...root,
    claudeAiOauth: {
      ...oauth,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      ...(tokens.refreshTokenExpiresAt !== undefined
        ? { refreshTokenExpiresAt: tokens.refreshTokenExpiresAt }
        : {}),
    },
  };
  return JSON.stringify(next);
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `bun test src/agents/claude_oauth_test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/claude_oauth.ts src/agents/claude_oauth_test.ts
git commit
```

---

### Task 3: Claude Code と互換の refresh ロック

**Files:**
- Create: `src/lib/oauth_refresh_lock.ts`
- Create: `src/lib/oauth_refresh_lock_test.ts`

**Interfaces:**
- Produces（`src/lib/oauth_refresh_lock.ts`）:
  - `export class LockContendedError extends Error`
  - `export interface HeldLock { release(): Promise<void>; }`
  - `export async function acquireDirLock(lockPath: string, options?: { now?: () => number; staleMs?: number; updateMs?: number }): Promise<HeldLock>`
  - `export async function acquireClaudeRefreshLock(claudeDir: string): Promise<HeldLock>`

- [ ] **Step 1: failing test を書く**

`src/lib/oauth_refresh_lock_test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  acquireClaudeRefreshLock,
  acquireDirLock,
  LockContendedError,
} from "./oauth_refresh_lock.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "nas-oauth-lock-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

test("acquireDirLock: creates the lock directory and removes it on release", async () => {
  const lockPath = path.join(dir, "x.lock");
  const lock = await acquireDirLock(lockPath);
  expect(await exists(lockPath)).toBe(true);
  await lock.release();
  expect(await exists(lockPath)).toBe(false);
});

test("acquireDirLock: a fresh lock held elsewhere is contended", async () => {
  const lockPath = path.join(dir, "x.lock");
  await mkdir(lockPath);
  await expect(acquireDirLock(lockPath)).rejects.toBeInstanceOf(
    LockContendedError,
  );
});

test("acquireDirLock: a stale lock is taken over", async () => {
  const lockPath = path.join(dir, "x.lock");
  await mkdir(lockPath);
  const old = new Date(Date.now() - 120_000);
  await utimes(lockPath, old, old);
  const lock = await acquireDirLock(lockPath);
  await lock.release();
});

test("acquireDirLock: refreshes the mtime while held", async () => {
  const lockPath = path.join(dir, "x.lock");
  const lock = await acquireDirLock(lockPath, { updateMs: 20 });
  const old = new Date(Date.now() - 120_000);
  await utimes(lockPath, old, old);
  await Bun.sleep(60);
  const { mtimeMs } = await stat(lockPath);
  expect(Date.now() - mtimeMs).toBeLessThan(10_000);
  await lock.release();
});

test("acquireClaudeRefreshLock: takes both the current and the legacy lock", async () => {
  const claudeDir = path.join(dir, ".claude");
  await mkdir(claudeDir);
  const lock = await acquireClaudeRefreshLock(claudeDir);
  expect(await exists(path.join(claudeDir, ".oauth_refresh.lock"))).toBe(true);
  expect(await exists(`${claudeDir}.lock`)).toBe(true);
  await lock.release();
  expect(await exists(path.join(claudeDir, ".oauth_refresh.lock"))).toBe(false);
  expect(await exists(`${claudeDir}.lock`)).toBe(false);
});

test("acquireClaudeRefreshLock: releases the first lock when the legacy lock is contended", async () => {
  const claudeDir = path.join(dir, ".claude");
  await mkdir(claudeDir);
  await mkdir(`${claudeDir}.lock`);
  await expect(acquireClaudeRefreshLock(claudeDir)).rejects.toBeInstanceOf(
    LockContendedError,
  );
  expect(await exists(path.join(claudeDir, ".oauth_refresh.lock"))).toBe(false);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `bun test src/lib/oauth_refresh_lock_test.ts`
Expected: FAIL（モジュールが存在しない）

- [ ] **Step 3: 実装する**

`src/lib/oauth_refresh_lock.ts`:

```ts
/**
 * Claude Code の OAuth 更新と同じロック。Claude Code は proper-lockfile を
 * 使い、ロックはディレクトリの mkdir で取り、保持中は mtime を定期的に
 * 更新する。mtime が一定時間更新されていないロックは持ち主が死んだものと
 * みなして奪う。同じ形式に従うことで、ホストの Claude Code と nas が同時に
 * refresh token を使わないようにする (refresh token は使うたびに入れ替わる)。
 */

import { mkdir, realpath, rm, stat, utimes } from "node:fs/promises";
import * as path from "node:path";

const STALE_MS = 60_000;
const UPDATE_MS = 5_000;

export class LockContendedError extends Error {
  constructor(lockPath: string) {
    super(`lock is held by another process: ${lockPath}`);
    this.name = "LockContendedError";
  }
}

export interface HeldLock {
  release(): Promise<void>;
}

export async function acquireDirLock(
  lockPath: string,
  options: { now?: () => number; staleMs?: number; updateMs?: number } = {},
): Promise<HeldLock> {
  const now = options.now ?? Date.now;
  const staleMs = options.staleMs ?? STALE_MS;
  try {
    await mkdir(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = await stat(lockPath).catch(() => null);
    if (info !== null && now() - info.mtimeMs <= staleMs) {
      throw new LockContendedError(lockPath);
    }
    await rm(lockPath, { recursive: true, force: true });
    try {
      await mkdir(lockPath);
    } catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code === "EEXIST") {
        throw new LockContendedError(lockPath);
      }
      throw retryError;
    }
  }
  const timer = setInterval(() => {
    const t = new Date(now());
    utimes(lockPath, t, t).catch(() => {});
  }, options.updateMs ?? UPDATE_MS);
  timer.unref?.();
  return {
    release: async () => {
      clearInterval(timer);
      await rm(lockPath, { recursive: true, force: true });
    },
  };
}

/** Claude Code が OAuth 更新時に取る2つのロック (現行と旧形式) を両方取る。 */
export async function acquireClaudeRefreshLock(
  claudeDir: string,
): Promise<HeldLock> {
  const current = await acquireDirLock(
    path.join(claudeDir, ".oauth_refresh.lock"),
  );
  const resolved = await realpath(claudeDir).catch(() => claudeDir);
  let legacy: HeldLock;
  try {
    legacy = await acquireDirLock(`${resolved}.lock`);
  } catch (error) {
    await current.release();
    throw error;
  }
  return {
    release: async () => {
      await legacy.release();
      await current.release();
    },
  };
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `bun test src/lib/oauth_refresh_lock_test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/oauth_refresh_lock.ts src/lib/oauth_refresh_lock_test.ts
git commit
```

---

### Task 4: ホスト側の Claude OAuth credential source

**Files:**
- Create: `src/network/claude_oauth_source.ts`
- Create: `src/network/claude_oauth_source_test.ts`

**Interfaces:**
- Consumes: Task 2 の `parseClaudeOAuthTokens` / `applyRefreshedTokens` / `ClaudeOAuthTokens` / `RefreshedClaudeTokens`、Task 3 の `acquireClaudeRefreshLock` / `LockContendedError` / `HeldLock`
- Produces（`src/network/claude_oauth_source.ts`）:
  - `export interface AgentCredentialSource { current(): string; close(): void; }`
  - `export interface ClaudeOAuthSourceDeps { readCredentials(): Promise<string>; writeCredentials(text: string): Promise<void>; acquireLock(): Promise<HeldLock>; refresh(request: ClaudeRefreshRequest): Promise<RefreshedClaudeTokens>; now(): number; sleep(ms: number): Promise<void>; schedule(fn: () => void, delayMs: number): () => void; log(message: string): void; }`
  - `export interface ClaudeRefreshRequest { readonly refreshToken: string; readonly clientId: string; readonly scopes: readonly string[]; }`
  - `export class ClaudeOAuthCredentialSource implements AgentCredentialSource`、`static async open(deps: ClaudeOAuthSourceDeps): Promise<ClaudeOAuthCredentialSource>`、`refreshNow(): Promise<void>`
  - `export function liveClaudeOAuthSourceDeps(hostHome: string): ClaudeOAuthSourceDeps`
  - `export const CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";`
  - `export const CLAUDE_CODE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";`

`open` と `refreshNow` は deps だけを組み合わせる D2 関数であり、I/O を直接呼ばない。`liveClaudeOAuthSourceDeps` の各メソッドは1つの I/O だけを行う D1 関数とする（`effect-separation` の Composition rule）。

- [ ] **Step 1: failing test を書く**

`src/network/claude_oauth_source_test.ts`:

```ts
import { expect, test } from "bun:test";
import { LockContendedError } from "../lib/oauth_refresh_lock.ts";
import {
  CLAUDE_CODE_CLIENT_ID,
  ClaudeOAuthCredentialSource,
  type ClaudeOAuthSourceDeps,
  type ClaudeRefreshRequest,
} from "./claude_oauth_source.ts";

const MIN = 60_000;

function credentials(access: string, refresh: string, expiresAt: number) {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: access,
      refreshToken: refresh,
      expiresAt,
      scopes: ["user:inference"],
    },
  });
}

interface FakeState {
  file: string;
  now: number;
  writes: string[];
  refreshes: ClaudeRefreshRequest[];
  scheduled: { fn: () => void; delayMs: number }[];
  lockFailures: number;
  refreshError?: Error;
  onLockAttempt?: () => void;
}

function fakeDeps(state: FakeState): ClaudeOAuthSourceDeps {
  return {
    readCredentials: async () => state.file,
    writeCredentials: async (text) => {
      state.writes.push(text);
      state.file = text;
    },
    acquireLock: async () => {
      state.onLockAttempt?.();
      if (state.lockFailures > 0) {
        state.lockFailures--;
        throw new LockContendedError("/lock");
      }
      return { release: async () => {} };
    },
    refresh: async (request) => {
      state.refreshes.push(request);
      if (state.refreshError) throw state.refreshError;
      return {
        accessToken: "access-2",
        refreshToken: "refresh-2",
        expiresAt: state.now + 60 * MIN,
      };
    },
    now: () => state.now,
    sleep: async () => {},
    schedule: (fn, delayMs) => {
      state.scheduled.push({ fn, delayMs });
      return () => {};
    },
    log: () => {},
  };
}

function initial(overrides: Partial<FakeState> = {}): FakeState {
  return {
    file: credentials("access-1", "refresh-1", 60 * MIN),
    now: 0,
    writes: [],
    refreshes: [],
    scheduled: [],
    lockFailures: 0,
    ...overrides,
  };
}

test("open: serves the host access token and schedules a refresh 5 minutes before expiry", async () => {
  const state = initial();
  const source = await ClaudeOAuthCredentialSource.open(fakeDeps(state));
  expect(source.current()).toBe("access-1");
  expect(state.scheduled.at(-1)?.delayMs).toBe(55 * MIN);
});

test("open: fails when the host has no OAuth tokens", async () => {
  const state = initial({ file: "{}" });
  await expect(
    ClaudeOAuthCredentialSource.open(fakeDeps(state)),
  ).rejects.toThrow(/claude \/login/);
});

test("refreshNow: refreshes, writes back, and serves the new token", async () => {
  const state = initial({ now: 56 * MIN });
  const source = await ClaudeOAuthCredentialSource.open(fakeDeps(state));
  await source.refreshNow();
  expect(state.refreshes).toEqual([
    {
      refreshToken: "refresh-1",
      clientId: CLAUDE_CODE_CLIENT_ID,
      scopes: ["user:inference"],
    },
  ]);
  expect(source.current()).toBe("access-2");
  expect(JSON.parse(state.writes[0]).claudeAiOauth.refreshToken).toBe(
    "refresh-2",
  );
  expect(state.scheduled.at(-1)?.delayMs).toBe(55 * MIN);
});

test("refreshNow: adopts a token another process already refreshed", async () => {
  const state = initial({ now: 56 * MIN });
  const source = await ClaudeOAuthCredentialSource.open(fakeDeps(state));
  state.file = credentials("access-other", "refresh-other", 200 * MIN);
  await source.refreshNow();
  expect(state.refreshes).toEqual([]);
  expect(state.writes).toEqual([]);
  expect(source.current()).toBe("access-other");
});

test("refreshNow: keeps the old token and retries in 30 seconds when the refresh fails", async () => {
  const state = initial({ now: 56 * MIN, refreshError: new Error("offline") });
  const source = await ClaudeOAuthCredentialSource.open(fakeDeps(state));
  await source.refreshNow();
  expect(source.current()).toBe("access-1");
  expect(state.scheduled.at(-1)?.delayMs).toBe(30_000);
});

test("refreshNow: retries a contended lock and adopts the holder's result", async () => {
  const state = initial({ now: 56 * MIN, lockFailures: 1 });
  state.onLockAttempt = () => {
    if (state.lockFailures === 0) return;
    state.file = credentials("access-holder", "refresh-holder", 200 * MIN);
  };
  const source = await ClaudeOAuthCredentialSource.open(fakeDeps(state));
  await source.refreshNow();
  expect(state.refreshes).toEqual([]);
  expect(source.current()).toBe("access-holder");
});

test("refreshNow: gives up after 5 contended attempts and retries later", async () => {
  const state = initial({ now: 56 * MIN, lockFailures: 5 });
  const source = await ClaudeOAuthCredentialSource.open(fakeDeps(state));
  await source.refreshNow();
  expect(state.refreshes).toEqual([]);
  expect(source.current()).toBe("access-1");
  expect(state.scheduled.at(-1)?.delayMs).toBe(30_000);
});

test("refreshNow: uses the clientId stored in the file", async () => {
  const state = initial({
    now: 56 * MIN,
    file: JSON.stringify({
      claudeAiOauth: {
        accessToken: "a",
        refreshToken: "r",
        expiresAt: 60 * MIN,
        scopes: ["s1", "s2"],
        clientId: "client-x",
      },
    }),
  });
  const source = await ClaudeOAuthCredentialSource.open(fakeDeps(state));
  await source.refreshNow();
  expect(state.refreshes[0]).toEqual({
    refreshToken: "r",
    clientId: "client-x",
    scopes: ["s1", "s2"],
  });
});

test("close: cancels the scheduled refresh", async () => {
  const state = initial();
  let cancelled = 0;
  const deps = fakeDeps(state);
  const source = await ClaudeOAuthCredentialSource.open({
    ...deps,
    schedule: (fn, delayMs) => {
      state.scheduled.push({ fn, delayMs });
      return () => {
        cancelled++;
      };
    },
  });
  source.close();
  expect(cancelled).toBe(1);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `bun test src/network/claude_oauth_source_test.ts`
Expected: FAIL（モジュールが存在しない）

- [ ] **Step 3: 実装する**

`src/network/claude_oauth_source.ts`:

```ts
/**
 * ホスト側で Claude の OAuth credential を保持し、期限前に更新する。
 *
 * container には本物の token を渡さず、proxy が許可した request にだけ
 * `current()` の値を注入する。更新はホストの Claude Code と同じロックの下で
 * 行い、ロックを取った後にファイルを読み直して、他のプロセスが既に更新して
 * いればその値を採用する。
 */

import { open as openFile, readFile } from "node:fs/promises";
import * as path from "node:path";
import {
  applyRefreshedTokens,
  type ClaudeOAuthTokens,
  parseClaudeOAuthTokens,
  type RefreshedClaudeTokens,
} from "../agents/claude_oauth.ts";
import { logWarn } from "../log.ts";
import {
  acquireClaudeRefreshLock,
  type HeldLock,
  LockContendedError,
} from "../lib/oauth_refresh_lock.ts";

export const CLAUDE_OAUTH_TOKEN_URL =
  "https://platform.claude.com/v1/oauth/token";
export const CLAUDE_CODE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

const REFRESH_LEAD_MS = 5 * 60_000;
const RETRY_DELAY_MS = 30_000;
const LOCK_ATTEMPTS = 5;
const REFRESH_TIMEOUT_MS = 30_000;

export interface AgentCredentialSource {
  /** 上流へ送る access token。同期的に返す。 */
  current(): string;
  close(): void;
}

export interface ClaudeRefreshRequest {
  readonly refreshToken: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
}

export interface ClaudeOAuthSourceDeps {
  readCredentials(): Promise<string>;
  /** 同じ inode に上書きする。rename すると bind mount 側から見えなくなる。 */
  writeCredentials(text: string): Promise<void>;
  acquireLock(): Promise<HeldLock>;
  refresh(request: ClaudeRefreshRequest): Promise<RefreshedClaudeTokens>;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** 戻り値は予約の取り消し。 */
  schedule(fn: () => void, delayMs: number): () => void;
  log(message: string): void;
}

export class ClaudeOAuthCredentialSource implements AgentCredentialSource {
  private tokens: ClaudeOAuthTokens;
  private cancelScheduled: (() => void) | null = null;
  private closed = false;

  private constructor(
    private readonly deps: ClaudeOAuthSourceDeps,
    tokens: ClaudeOAuthTokens,
  ) {
    this.tokens = tokens;
  }

  static async open(
    deps: ClaudeOAuthSourceDeps,
  ): Promise<ClaudeOAuthCredentialSource> {
    const tokens = parseClaudeOAuthTokens(await deps.readCredentials());
    const source = new ClaudeOAuthCredentialSource(deps, tokens);
    source.scheduleBeforeExpiry();
    return source;
  }

  current(): string {
    return this.tokens.accessToken;
  }

  close(): void {
    this.closed = true;
    this.cancelScheduled?.();
    this.cancelScheduled = null;
  }

  /** 更新処理を1回行う。失敗は投げず、やり直しを予約する。 */
  async refreshNow(): Promise<void> {
    try {
      await this.refreshUnderLock();
      this.scheduleBeforeExpiry();
    } catch (error) {
      this.deps.log(
        `[nas] Claude OAuth refresh failed; retrying in ${RETRY_DELAY_MS / 1000}s: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.scheduleIn(RETRY_DELAY_MS);
    }
  }

  private async refreshUnderLock(): Promise<void> {
    const lock = await this.acquireLockOrAdopt();
    if (lock === null) return;
    try {
      const onDisk = parseClaudeOAuthTokens(await this.deps.readCredentials());
      if (onDisk.accessToken !== this.tokens.accessToken) {
        this.tokens = onDisk;
        return;
      }
      const refreshed = await this.deps.refresh({
        refreshToken: onDisk.refreshToken,
        clientId: onDisk.clientId ?? CLAUDE_CODE_CLIENT_ID,
        scopes: onDisk.scopes,
      });
      const next = applyRefreshedTokens(
        await this.deps.readCredentials(),
        refreshed,
      );
      await this.deps.writeCredentials(next);
      this.tokens = parseClaudeOAuthTokens(next);
    } finally {
      await lock.release();
    }
  }

  /**
   * ロックを取る。取れない間は読み直し、他のプロセスが更新を終えていれば
   * その値を採用して null を返す。
   */
  private async acquireLockOrAdopt(): Promise<HeldLock | null> {
    for (let attempt = 1; attempt <= LOCK_ATTEMPTS; attempt++) {
      try {
        return await this.deps.acquireLock();
      } catch (error) {
        if (!(error instanceof LockContendedError)) throw error;
        const onDisk = parseClaudeOAuthTokens(
          await this.deps.readCredentials(),
        );
        if (onDisk.accessToken !== this.tokens.accessToken) {
          this.tokens = onDisk;
          return null;
        }
        if (attempt < LOCK_ATTEMPTS) {
          await this.deps.sleep(1000 + Math.random() * 1000);
        }
      }
    }
    throw new Error("the refresh lock stayed held by another process");
  }

  private scheduleBeforeExpiry(): void {
    this.scheduleIn(
      Math.max(0, this.tokens.expiresAt - REFRESH_LEAD_MS - this.deps.now()),
    );
  }

  private scheduleIn(delayMs: number): void {
    if (this.closed) return;
    this.cancelScheduled?.();
    this.cancelScheduled = this.deps.schedule(() => {
      void this.refreshNow();
    }, delayMs);
  }
}

// ---------------------------------------------------------------------------
// Live deps: 各メソッドは I/O を1つだけ行う。
// ---------------------------------------------------------------------------

export function liveClaudeOAuthSourceDeps(
  hostHome: string,
): ClaudeOAuthSourceDeps {
  const claudeDir = path.join(hostHome, ".claude");
  const credentialsPath = path.join(claudeDir, ".credentials.json");
  return {
    readCredentials: () => readFile(credentialsPath, "utf8"),
    writeCredentials: async (text) => {
      const handle = await openFile(credentialsPath, "r+");
      try {
        await handle.truncate(0);
        await handle.write(text, 0, "utf8");
      } finally {
        await handle.close();
      }
    },
    acquireLock: () => acquireClaudeRefreshLock(claudeDir),
    refresh: postClaudeTokenRefresh,
    now: Date.now,
    sleep: (ms) => Bun.sleep(ms),
    schedule: (fn, delayMs) => {
      const timer = setTimeout(fn, delayMs);
      timer.unref?.();
      return () => clearTimeout(timer);
    },
    log: logWarn,
  };
}

async function postClaudeTokenRefresh(
  request: ClaudeRefreshRequest,
): Promise<RefreshedClaudeTokens> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REFRESH_TIMEOUT_MS);
  try {
    const res = await fetch(CLAUDE_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: request.refreshToken,
        client_id: request.clientId,
        scope: request.scopes.join(" "),
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      throw new Error(`token endpoint returned HTTP ${res.status}`);
    }
    return parseRefreshResponse(await res.json(), request.refreshToken);
  } finally {
    clearTimeout(timer);
  }
}

/** @internal Exported only for the colocated test file. */
export function parseRefreshResponse(
  body: unknown,
  previousRefreshToken: string,
  now: number = Date.now(),
): RefreshedClaudeTokens {
  const data = (body ?? {}) as Record<string, unknown>;
  if (
    typeof data.access_token !== "string" ||
    typeof data.expires_in !== "number"
  ) {
    throw new Error("token endpoint returned an unexpected body");
  }
  return {
    accessToken: data.access_token,
    refreshToken:
      typeof data.refresh_token === "string"
        ? data.refresh_token
        : previousRefreshToken,
    expiresAt: now + data.expires_in * 1000,
    ...(typeof data.refresh_token_expires_in === "number"
      ? { refreshTokenExpiresAt: now + data.refresh_token_expires_in * 1000 }
      : {}),
  };
}
```

`src/network/claude_oauth_source_test.ts` に response の解析のテストも追加する:

```ts
import { parseRefreshResponse } from "./claude_oauth_source.ts";

test("parseRefreshResponse: keeps the previous refresh token when omitted", () => {
  expect(
    parseRefreshResponse({ access_token: "a", expires_in: 60 }, "old", 1000),
  ).toEqual({ accessToken: "a", refreshToken: "old", expiresAt: 61_000 });
});

test("parseRefreshResponse: reads the rotated refresh token and its expiry", () => {
  expect(
    parseRefreshResponse(
      {
        access_token: "a",
        refresh_token: "new",
        expires_in: 60,
        refresh_token_expires_in: 120,
      },
      "old",
      1000,
    ),
  ).toEqual({
    accessToken: "a",
    refreshToken: "new",
    expiresAt: 61_000,
    refreshTokenExpiresAt: 121_000,
  });
});

test("parseRefreshResponse: rejects a body without an access token", () => {
  expect(() => parseRefreshResponse({ expires_in: 60 }, "old")).toThrow();
});
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `bun test src/network/claude_oauth_source_test.ts`
Expected: PASS

- [ ] **Step 5: 書き戻しが inode を保つことを確認するテストを追加する**

`src/network/claude_oauth_source_test.ts` に追加する（一時ディレクトリを使う unit test）:

```ts
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { liveClaudeOAuthSourceDeps } from "./claude_oauth_source.ts";

test("liveClaudeOAuthSourceDeps: writeCredentials overwrites the same inode", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "nas-oauth-source-"));
  try {
    const file = path.join(home, ".claude", ".credentials.json");
    await mkdir(path.dirname(file));
    await writeFile(file, "x".repeat(200), { mode: 0o600 });
    const before = await stat(file);
    await liveClaudeOAuthSourceDeps(home).writeCredentials("{}");
    const after = await stat(file);
    expect(after.ino).toBe(before.ino);
    expect(await Bun.file(file).text()).toBe("{}");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
```

Run: `bun test src/network/claude_oauth_source_test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/network/claude_oauth_source.ts src/network/claude_oauth_source_test.ts
git commit
```

---

### Task 5: broker による認証 header の差し替えと token 更新の拒否

**Files:**
- Create: `src/network/agent_credential.ts`
- Create: `src/network/agent_credential_test.ts`
- Modify: `src/network/protocol.ts:171`（`DecisionResponse`）
- Modify: `src/network/broker.ts`（`BrokerOptions` L75-101、コンストラクタ L237 付近、`authorize` L638-661、`decorateAllow` L1329-1351 とその4つの呼び出し元 L685 / L730 / L980 / L1058）
- Modify: `src/network/broker_integration_test.ts`

**Interfaces:**
- Consumes: Task 4 の `AgentCredentialSource`
- Produces:
  - `DecisionResponse.removeHeaders?: string[]`
  - `export const CREDENTIAL_REFRESH_DENY_REASON = "credential-refresh-owned-by-host";`（`src/network/agent_credential.ts`）
  - `export function isHostOwnedCredentialRefresh(host: string, method: string, path: string | undefined): boolean`
  - `export function applyAgentCredential(decision: DecisionResponse, host: string, accessToken: string): DecisionResponse`
  - `BrokerOptions.agentCredential?: AgentCredentialSource`

- [ ] **Step 1: pure 関数の failing test を書く**

`src/network/agent_credential_test.ts`:

```ts
import { expect, test } from "bun:test";
import {
  applyAgentCredential,
  isHostOwnedCredentialRefresh,
} from "./agent_credential.ts";
import type { DecisionResponse } from "./protocol.ts";

function allow(extra: Partial<DecisionResponse> = {}): DecisionResponse {
  return {
    version: 1,
    type: "decision",
    requestId: "r1",
    decision: "allow",
    reason: "allowed",
    ...extra,
  };
}

test("applyAgentCredential: injects the bearer token and removes x-api-key for Anthropic hosts", () => {
  for (const host of ["api.anthropic.com", "mcp-proxy.anthropic.com"]) {
    expect(applyAgentCredential(allow(), host, "tok")).toEqual(
      allow({
        injectHeaders: [{ name: "Authorization", value: "Bearer tok" }],
        removeHeaders: ["x-api-key"],
      }),
    );
  }
});

test("applyAgentCredential: replaces a user-configured Authorization inject of any case", () => {
  const result = applyAgentCredential(
    allow({
      injectHeaders: [
        { name: "authorization", value: "user" },
        { name: "x-extra", value: "kept" },
      ],
    }),
    "api.anthropic.com",
    "tok",
  );
  expect(result.injectHeaders).toEqual([
    { name: "x-extra", value: "kept" },
    { name: "Authorization", value: "Bearer tok" },
  ]);
});

test("applyAgentCredential: leaves other hosts and non-allow decisions untouched", () => {
  const other = allow();
  expect(applyAgentCredential(other, "platform.claude.com", "tok")).toBe(other);
  const denied = allow({ decision: "deny" });
  expect(applyAgentCredential(denied, "api.anthropic.com", "tok")).toBe(
    denied,
  );
});

test("isHostOwnedCredentialRefresh: matches only POST /v1/oauth/token on platform.claude.com", () => {
  expect(
    isHostOwnedCredentialRefresh("platform.claude.com", "POST", "/v1/oauth/token"),
  ).toBe(true);
  expect(
    isHostOwnedCredentialRefresh("platform.claude.com", "post", "/v1/oauth/token?x=1"),
  ).toBe(true);
  expect(
    isHostOwnedCredentialRefresh("platform.claude.com", "GET", "/v1/oauth/token"),
  ).toBe(false);
  expect(
    isHostOwnedCredentialRefresh("platform.claude.com", "POST", "/v1/oauth/other"),
  ).toBe(false);
  expect(
    isHostOwnedCredentialRefresh("api.anthropic.com", "POST", "/v1/oauth/token"),
  ).toBe(false);
  expect(
    isHostOwnedCredentialRefresh("platform.claude.com", "POST", undefined),
  ).toBe(false);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `bun test src/network/agent_credential_test.ts`
Expected: FAIL（モジュールが存在しない）

- [ ] **Step 3: `DecisionResponse` と pure 関数を実装する**

`src/network/protocol.ts` の `DecisionResponse` の `forbidValues?: string[];` の後に追加する:

```ts
  /** 上流へ送る前に削除する header 名。injectHeaders より前に適用する。 */
  removeHeaders?: string[];
```

`src/network/agent_credential.ts`:

```ts
/**
 * ホストが保持するエージェントの credential を、許可した request に載せる。
 *
 * エージェントが付けた credential を上流へ届けないために、注入先のホストでは
 * Authorization を必ずホストの値で上書きし、x-api-key は削除する。利用者の
 * 設定が同じ header を注入していても、こちらが優先する。
 */

import type { DecisionResponse, InjectHeader } from "./protocol.ts";

export const CREDENTIAL_REFRESH_DENY_REASON = "credential-refresh-owned-by-host";

const CREDENTIAL_HOSTS = new Set(["api.anthropic.com", "mcp-proxy.anthropic.com"]);
const REMOVED_HEADERS = ["x-api-key"];

/**
 * container からの token 更新か。container が持つ refresh token はダミー値で
 * あり、更新はホストが行う。
 */
export function isHostOwnedCredentialRefresh(
  host: string,
  method: string,
  path: string | undefined,
): boolean {
  if (host !== "platform.claude.com" || method.toUpperCase() !== "POST") {
    return false;
  }
  if (path === undefined) return false;
  return path.split("?")[0] === "/v1/oauth/token";
}

export function applyAgentCredential(
  decision: DecisionResponse,
  host: string,
  accessToken: string,
): DecisionResponse {
  if (decision.decision !== "allow" || !CREDENTIAL_HOSTS.has(host)) {
    return decision;
  }
  const injectHeaders: InjectHeader[] = [
    ...(decision.injectHeaders ?? []).filter(
      (header) => header.name.toLowerCase() !== "authorization",
    ),
    { name: "Authorization", value: `Bearer ${accessToken}` },
  ];
  return { ...decision, injectHeaders, removeHeaders: [...REMOVED_HEADERS] };
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `bun test src/network/agent_credential_test.ts`
Expected: PASS

- [ ] **Step 5: broker の配線の failing test を書く**

`src/network/broker_integration_test.ts` に、既存の "credential" 系テスト（`sess_cred` を使うもの、L3821 付近）と同じ構成で追加する。`post(...)` は既存ヘルパー（L3747）を使う:

```ts
test("SessionBroker: agent credential overrides Authorization on Anthropic hosts", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-agentcred-"));
  const auditDir = await mkdtemp(path.join(tmpdir(), "nas-broker-agentcred-audit-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_agentcred",
    document: resolvedDocument({
      network: {
        scopes: {
          anthropic: { targets: ["api.anthropic.com"], fallback: "allow" },
        },
      },
    }),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
    auditDir,
    agentCredential: { current: () => "host-token", close: () => {} },
  });
  const socketPath = `${paths.brokersDir}/sess_agentcred/sock`;
  await broker.start(socketPath);
  try {
    const response = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      post("sess_agentcred", "req_1", "/v1/messages", "api.anthropic.com", 443),
    );
    expect(response.decision).toBe("allow");
    expect(response.injectHeaders).toEqual([
      { name: "Authorization", value: "Bearer host-token" },
    ]);
    expect(response.removeHeaders).toEqual(["x-api-key"]);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true });
    await rm(auditDir, { recursive: true, force: true });
  }
});

test("SessionBroker: container token refresh is denied before policy evaluation", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-agentcred-"));
  const auditDir = await mkdtemp(path.join(tmpdir(), "nas-broker-agentcred-audit-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_agentcred2",
    document: resolvedDocument({
      network: {
        scopes: {
          claude: { targets: ["platform.claude.com"], fallback: "allow" },
        },
      },
    }),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
    auditDir,
    agentCredential: { current: () => "host-token", close: () => {} },
  });
  const socketPath = `${paths.brokersDir}/sess_agentcred2/sock`;
  await broker.start(socketPath);
  try {
    const response = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      post("sess_agentcred2", "req_1", "/v1/oauth/token", "platform.claude.com", 443),
    );
    expect(response.decision).toBe("deny");
    expect(response.reason).toBe("credential-refresh-owned-by-host");
    const logs = await queryAuditLogs({ domain: "network" }, auditDir);
    expect(logs.at(-1)?.reason).toBe("credential-refresh-owned-by-host");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true });
    await rm(auditDir, { recursive: true, force: true });
  }
});

test("SessionBroker: without an agent credential the token refresh follows the policy", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-agentcred-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_agentcred3",
    document: resolvedDocument({
      network: {
        scopes: {
          claude: { targets: ["platform.claude.com"], fallback: "allow" },
        },
      },
    }),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_agentcred3/sock`;
  await broker.start(socketPath);
  try {
    const response = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      post("sess_agentcred3", "req_1", "/v1/oauth/token", "platform.claude.com", 443),
    );
    expect(response.decision).toBe("allow");
    expect(response.removeHeaders).toBeUndefined();
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
```

（`resolvedDocument` / `resolveNetworkRuntimePaths` / `sendBrokerRequest` / `queryAuditLogs` / `post` の import はファイル内の既存のものを使う。`resolveNetworkRuntimePaths` の引数の形が異なる場合は、同じファイルの既存テストの呼び方に合わせる。）

- [ ] **Step 6: 失敗を確認する**

Run: `bun test src/network/broker_integration_test.ts --test-name-pattern 'agent credential|token refresh'`
Expected: FAIL（`agentCredential` が `BrokerOptions` にない型エラー、または `removeHeaders` が undefined）

- [ ] **Step 7: broker を実装する**

`src/network/broker.ts`:

1. import を追加する:

```ts
import {
  applyAgentCredential,
  CREDENTIAL_REFRESH_DENY_REASON,
  isHostOwnedCredentialRefresh,
} from "./agent_credential.ts";
import type { AgentCredentialSource } from "./claude_oauth_source.ts";
```

2. `BrokerOptions` に追加する:

```ts
  /**
   * ホストが保持するエージェントの credential。与えられたセッションでは、
   * 注入先のホストで Authorization を上書きし、container からの token 更新を
   * 拒否する。
   */
  agentCredential?: AgentCredentialSource;
```

3. クラスのフィールドとコンストラクタに追加する（`this.secretValues = ...` の近く）:

```ts
  private readonly agentCredential: AgentCredentialSource | undefined;
```

```ts
    this.agentCredential = options.agentCredential;
```

4. `authorize` の `denyReasonForTarget` のブロックの直後に追加する:

```ts
    if (
      this.agentCredential !== undefined &&
      isHostOwnedCredentialRefresh(
        message.target.host,
        message.method,
        message.reviewContext?.path,
      )
    ) {
      await this.recordAudit(
        message,
        "deny",
        CREDENTIAL_REFRESH_DENY_REASON,
        targetStr,
        undefined,
        undefined,
        undefined,
        requestBodyAuditStatus,
      );
      return denyDecision(message.requestId, CREDENTIAL_REFRESH_DENY_REASON);
    }
```

（`message.method` の型が optional の場合は `message.method ?? ""` にする。）

5. `decorateAllow` に target を渡し、policy による装飾の後で credential を適用する:

```ts
  private decorateAllow(
    decision: DecisionResponse,
    decided: AuthzDecision | undefined,
    target: { readonly host: string },
  ): DecisionResponse {
    const decorated = this.decorateWithPolicy(decision, decided);
    if (this.agentCredential === undefined) return decorated;
    return applyAgentCredential(
      decorated,
      target.host,
      this.agentCredential.current(),
    );
  }
```

既存の `decorateAllow` の本体は、名前を `decorateWithPolicy` に変えてそのまま残す（JSDoc も残す）。4つの呼び出し元（L685 / L730 / L980 / L1058）には、そこで手に入る target を第3引数に渡す（`message.target`、`request.target`、`group.target` のうち、その場にあるもの）。

6. audit の `injectedHeaders` は、既存の呼び出しが `decision.injectHeaders?.map((h) => h.name)` を渡しているので、`decorateAllow` の戻り値から作られていれば `Authorization` が記録される。記録していない呼び出し元があれば、`decorateAllow` の後の decision から作るよう揃える。

- [ ] **Step 8: テストが通ることを確認する**

Run: `bun test src/network/broker_integration_test.ts --test-name-pattern 'agent credential|token refresh' && bun test src/network/agent_credential_test.ts`
Expected: PASS

- [ ] **Step 9: 型検査と unit を実行する**

Run: `bun run check && bun run test:unit`
Expected: どちらも成功

- [ ] **Step 10: Commit**

```bash
git add src/network/agent_credential.ts src/network/agent_credential_test.ts src/network/protocol.ts src/network/broker.ts src/network/broker_integration_test.ts
git commit
```

---

### Task 6: addon の `removeHeaders`

**Files:**
- Modify: `src/docker/mitmproxy/nas_addon.py:3810-3824`
- Modify: `src/docker/mitmproxy/nas_addon_mask_test.py`（`RequestPolicyFlowTest`、L3771 付近）

**Interfaces:**
- Consumes: Task 5 の `DecisionResponse.removeHeaders`

- [ ] **Step 1: failing test を書く**

`src/docker/mitmproxy/nas_addon_mask_test.py` の `RequestPolicyFlowTest` に追加する。`_run` は既存ヘルパーを使い、fake broker の decision に `removeHeaders` を足すため、`_run` にキーワード引数 `remove_headers=None` を追加して、`inject` と同じ場所で `decision["removeHeaders"] = remove_headers` を設定する（`remove_headers` が None のときは設定しない）:

```python
    def test_remove_headers_drop_the_named_header_before_injection(self):
        flow, _messages, _stderr = self._run(
            document=_flow_document([_models_rule()]),
            rule_id="api.models",
            method="GET",
            path="/v1/models",
            content=b"",
            headers={"x-api-key": "attacker-key"},
            inject=False,
            remove_headers=["x-api-key"],
        )
        self.assertIsNone(flow.response)
        self.assertNotIn("x-api-key", flow.request.headers)

    def test_injected_header_survives_a_removal_of_the_same_name(self):
        flow, _messages, _stderr = self._run(
            document=_flow_document([_models_rule()]),
            rule_id="api.models",
            method="GET",
            path="/v1/models",
            content=b"",
            headers={"x-api-key": "attacker-key"},
            inject=True,
            remove_headers=["x-api-key"],
        )
        self.assertIsNone(flow.response)
        self.assertEqual(self._injected(flow), "injected-value")
```

（`FakeHeaders` は header 名を大文字小文字で区別するので、テストでは request と同じ小文字の `x-api-key` を使う。`_run` が `headers` を受け取らない場合は、既存の `headers` 引数の扱いに合わせる。）

- [ ] **Step 2: 失敗を確認する**

Run: `bun test src/docker/mitmproxy/nas_addon_test.ts`
Expected: 追加した1件目が FAIL（`x-api-key` が残る）。`vendor` が未生成なら先に `bun run vendor` を実行する。

- [ ] **Step 3: 実装する**

`src/docker/mitmproxy/nas_addon.py` の `inject_headers = decision.get("injectHeaders", [])` の直前に追加する:

```python
        # Drop headers the broker names before injecting, so an agent-supplied
        # credential never reaches upstream and an injected value is never
        # removed by its own removal.
        for name in decision.get("removeHeaders", []):
            if name in flow.request.headers:
                del flow.request.headers[name]
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `bun test src/docker/mitmproxy/nas_addon_test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/docker/mitmproxy/nas_addon.py src/docker/mitmproxy/nas_addon_mask_test.py
git commit
```

---

### Task 7: proxy stage から broker へ credential source を渡す

**Files:**
- Modify: `src/stages/proxy/session_broker_service.ts`（`SessionBrokerConfig` L28-45、`SessionBrokerServiceLive` L74-155）
- Modify: `src/stages/proxy/stage.ts`（`ProxyPlan` L67-100、`planProxy` L111-228、`runProxy` の `sessionBrokerService.start` L373-393）
- Modify: `src/stages/proxy/stage_test.ts`（存在しない場合は `planProxy` の既存テストのあるファイル。`grep -rln "planProxy" src/stages/proxy` で探す）

**Interfaces:**
- Consumes: Task 1 の `resolveAgentCredentials`、Task 4 の `ClaudeOAuthCredentialSource` / `liveClaudeOAuthSourceDeps`、Task 5 の `BrokerOptions.agentCredential`
- Produces:
  - `SessionBrokerConfig.agentCredential?: { readonly kind: "claude-oauth"; readonly hostHome: string }`
  - `ProxyPlan.agentCredential?: { readonly kind: "claude-oauth"; readonly hostHome: string }`

- [ ] **Step 1: planner の failing test を書く**

`planProxy` の既存テストと同じ入力の作り方で追加する:

```ts
test("planProxy: Claude with default credentials asks for the host OAuth source", () => {
  const plan = planProxy(makeProxyInput({ profile: { agent: "claude" } }));
  expect(plan.agentCredential).toEqual({
    kind: "claude-oauth",
    hostHome: expect.any(String),
  });
});

test("planProxy: shared credentials do not start a host OAuth source", () => {
  const plan = planProxy(
    makeProxyInput({
      profile: {
        agent: "claude",
        agentState: { protectSettings: false, auth: "shared" },
      },
    }),
  );
  expect(plan.agentCredential).toBeUndefined();
});

test("planProxy: other agents do not start a host OAuth source", () => {
  const plan = planProxy(makeProxyInput({ profile: { agent: "codex" } }));
  expect(plan.agentCredential).toBeUndefined();
});
```

（`makeProxyInput` はそのファイルの既存の入力ヘルパーに置き換える。profile の上書きの渡し方も既存ヘルパーに合わせる。）

- [ ] **Step 2: 失敗を確認する**

Run: `bun test src/stages/proxy/stage_test.ts --test-name-pattern 'OAuth source'`
Expected: FAIL（`agentCredential` が plan にない）

- [ ] **Step 3: planner と broker service を実装する**

`src/stages/proxy/stage.ts`:

- import に `resolveAgentCredentials`（`../../agents/credentials.ts`）を追加する。
- `ProxyPlan` に `readonly agentCredential?: { readonly kind: "claude-oauth"; readonly hostHome: string };` を追加する。
- `planProxy` の return の前に:

```ts
  const agentCredential =
    input.profile.agent === "claude" &&
    resolveAgentCredentials(
      input.profile.agent,
      input.profile.agentState.auth,
    ) === "proxy"
      ? { kind: "claude-oauth" as const, hostHome: input.host.home }
      : undefined;
```

  return するオブジェクトに `...(agentCredential ? { agentCredential } : {}),` を追加する。
- `sessionBrokerService.start({...})` に `agentCredential: plan.agentCredential,` を追加する。

`src/stages/proxy/session_broker_service.ts`:

- `SessionBrokerConfig` に追加する:

```ts
  /**
   * ホストが保持するエージェントの credential を broker に持たせる。
   * 取得できなければ start が失敗し、セッションを開始しない。
   */
  readonly agentCredential?: {
    readonly kind: "claude-oauth";
    readonly hostHome: string;
  };
```

- import を追加する:

```ts
import {
  type AgentCredentialSource,
  ClaudeOAuthCredentialSource,
  liveClaudeOAuthSourceDeps,
} from "../../network/claude_oauth_source.ts";
```

- `SessionBrokerServiceLive.start` の `try` の先頭で source を開き、broker に渡し、失敗経路と `close` で閉じる:

```ts
            const agentCredential: AgentCredentialSource | undefined =
              config.agentCredential
                ? await ClaudeOAuthCredentialSource.open(
                    liveClaudeOAuthSourceDeps(config.agentCredential.hostHome),
                  )
                : undefined;
            const broker = new SessionBroker({
              // ... 既存のフィールド ...
              agentCredential,
            });
            try {
              await broker.start(config.socketPath);
            } catch (error) {
              agentCredential?.close();
              throw error;
            }
```

  既存の registry 書き込み失敗時の `catch` にも `agentCredential?.close();` を加える。`handle.close` の `try` の先頭（`await broker.close();` の後）に `agentCredential?.close();` を加える。

- [ ] **Step 4: テストが通ることを確認する**

Run: `bun test src/stages/proxy/stage_test.ts`
Expected: PASS

- [ ] **Step 5: 型検査と unit を実行する**

Run: `bun run check && bun run test:unit`
Expected: どちらも成功

- [ ] **Step 6: Commit**

```bash
git add src/stages/proxy/session_broker_service.ts src/stages/proxy/stage.ts src/stages/proxy/stage_test.ts
git commit
```

---

### Task 8: container にダミーの `.credentials.json` を見せる

**Files:**
- Modify: `src/stages/mount/claude_state_fs.ts`（`CLAUDE_SHARED_FILES` L14-18、`prepareProtectedClaudeState` L76-104）
- Create: `src/stages/mount/claude_credentials_fs.ts`
- Modify: `src/stages/mount/mount_setup_service.ts`（Tag L31-41、Live L47-70、Fake L85-97）
- Modify: `src/stages/mount/stage.ts`（`createMountStage.run` L105-117、`planMount` L151 と L494-508）
- Modify: `src/agents/types.ts`（`AgentConfigInput` L45-61）
- Modify: `src/agents/registry.ts:29-40`
- Modify: `src/agents/claude.ts`（`ClaudeConfigInput` L60-71、3つの return L111 / L151 / L174）
- Modify: `src/agents/claude_test.ts`
- Modify: `src/stages/mount/claude_state_fs_test.ts`
- Modify: `src/stages/mount/stage_test.ts`

**Interfaces:**
- Consumes: Task 1 の `resolveAgentCredentials`、Task 2 の `buildDummyClaudeCredentials`
- Produces:
  - `export async function prepareDummyClaudeCredentials(hostHome: string): Promise<DummyClaudeCredentials>`、`export interface DummyClaudeCredentials { readonly dir: string; readonly file: string }`、`export async function removeDummyClaudeCredentials(state: DummyClaudeCredentials): Promise<void>`（`claude_credentials_fs.ts`）
  - `MountSetupService.prepareClaudeCredentials: (hostHome: string) => Effect.Effect<string, unknown, Scope.Scope>`（ダミーファイルのパスを返す）
  - `prepareProtectedClaudeState(hostHome: string, options?: { shareCredentials?: boolean })`
  - `AgentConfigInput.claudeCredentialsFile?: string`、`ClaudeConfigInput.claudeCredentialsFile?: string`
  - `planMount(input, probes, devcontainer?, protectedClaudeState?, claudeCredentialsFile?)`

- [ ] **Step 1: `configureClaude` の failing test を書く**

`src/agents/claude_test.ts` に追加する（既存の `input` / `protectedState` fixture を使う）:

```ts
test("configureClaude: a dummy credentials file is mounted last in plain CLI mode", () => {
  const result = configureClaude({
    ...input,
    claudeCredentialsFile: "/private/dummy/.credentials.json",
  });
  expect(result.mounts?.at(-1)).toEqual({
    source: "/private/dummy/.credentials.json",
    target: "/home/nas/.claude/.credentials.json",
  });
});

test("configureClaude: a dummy credentials file is mounted last in protected mode", () => {
  const result = configureClaude({
    ...input,
    protectSettings: true,
    protectedClaudeState: protectedState,
    claudeCredentialsFile: "/private/dummy/.credentials.json",
  });
  expect(result.mounts?.at(-1)).toEqual({
    source: "/private/dummy/.credentials.json",
    target: "/home/nas/.claude/.credentials.json",
  });
});

test("configureClaude: a dummy credentials file is mounted last with dedicated state", () => {
  const result = configureClaude({
    ...input,
    claudeState: {
      claudeDir: "/host/home/.claude",
      claudeJson: "/host/home/.claude.json",
    },
    claudeCredentialsFile: "/private/dummy/.credentials.json",
  });
  expect(result.mounts?.at(-1)).toEqual({
    source: "/private/dummy/.credentials.json",
    target: "/home/nas/.claude/.credentials.json",
  });
});

test("configureClaude: ACP also mounts the dummy credentials file last", () => {
  const result = configureClaude({
    ...input,
    mode: "acp",
    claudeCredentialsFile: "/private/dummy/.credentials.json",
  });
  expect(result.mounts?.at(-1)).toEqual({
    source: "/private/dummy/.credentials.json",
    target: "/home/nas/.claude/.credentials.json",
  });
});

test("configureClaude: without a dummy file no credentials mount is added", () => {
  const result = configureClaude(input);
  expect(
    (result.mounts ?? []).some((m) => m.target.endsWith(".credentials.json")),
  ).toBe(false);
});
```

（`input` の `containerHome` が `/home/nas` でない場合は、既存 fixture の値に合わせる。ACP のテストが host の binary を要求する既存の制約に当たる場合は、既存の ACP テストの fixture を使う。）

- [ ] **Step 2: 失敗を確認する**

Run: `bun test src/agents/claude_test.ts`
Expected: 追加した最初の4件が FAIL

- [ ] **Step 3: `configureClaude` を実装する**

`src/agents/types.ts` の `AgentConfigInput` と `src/agents/claude.ts` の `ClaudeConfigInput` に追加する:

```ts
  /**
   * container の `~/.claude/.credentials.json` に被せるダミーファイル。
   * ホストの credential を proxy で注入するときに渡す。
   */
  readonly claudeCredentialsFile?: string;
```

`src/agents/registry.ts` の `configureClaude` 呼び出しに `claudeCredentialsFile: input.claudeCredentialsFile,` を追加する。

`src/agents/claude.ts` の `configureClaude` の冒頭（`stateMounts` の定義の後）に次を置き、3つの return の `mounts` をそれぞれ `withCredentials(...)` で包む:

```ts
  // ~/.claude のディレクトリのマウントより後に置き、同じ位置のファイルを隠す。
  const credentialsMount: MountSpec[] = input.claudeCredentialsFile
    ? [
        {
          source: input.claudeCredentialsFile,
          target: `${containerHome}/.claude/.credentials.json`,
        },
      ]
    : [];
  const withCredentials = (
    mounts: readonly MountSpec[] | undefined,
  ): MountSpec[] | undefined =>
    mounts === undefined && credentialsMount.length === 0
      ? undefined
      : [...(mounts ?? []), ...credentialsMount];
```

- L111 の return: `mounts: withCredentials(stateMounts ?? [ ...既存の2件... ]),`
- L151 の return: `mounts: withCredentials(stateMounts),`
- L174 の return: `mounts: withCredentials(stateMounts),`

（`MountSpec` の import がなければ、`AgentConfigResult` と同じ場所から import する。plain CLI mode の `~/.claude` は `dockerArgs` の `-v` で渡され、mount stage で `mounts` より前に並ぶので、末尾に足すだけで順序が保たれる。）

- [ ] **Step 4: テストが通ることを確認する**

Run: `bun test src/agents/claude_test.ts`
Expected: PASS

- [ ] **Step 5: protected state とダミーファイルの failing test を書く**

`src/stages/mount/claude_state_fs_test.ts` に追加する（既存の `withHome` ヘルパーを使う）:

```ts
test("protected state does not share credentials when they are injected by the proxy", async () => {
  await withHome(async (home) => {
    const state = await prepareProtectedClaudeState(home, {
      shareCredentials: false,
    });
    try {
      expect(state.entries.some((e) => e.name === ".credentials.json")).toBe(
        false,
      );
    } finally {
      await removeProtectedClaudeState(state);
    }
  });
});
```

`src/stages/mount/claude_credentials_fs_test.ts` を作る:

```ts
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { CLAUDE_OAUTH_DUMMY_ACCESS_TOKEN } from "../../agents/claude_oauth.ts";
import {
  prepareDummyClaudeCredentials,
  removeDummyClaudeCredentials,
} from "./claude_credentials_fs.ts";

async function withHome(fn: (home: string) => Promise<void>) {
  const home = await mkdtemp(path.join(tmpdir(), "nas-claude-creds-"));
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("prepareDummyClaudeCredentials: writes a private dummy file", async () => {
  await withHome(async (home) => {
    await mkdir(path.join(home, ".claude"));
    await writeFile(
      path.join(home, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "real",
          refreshToken: "real-r",
          expiresAt: 1,
          scopes: [],
        },
      }),
    );
    const dummy = await prepareDummyClaudeCredentials(home);
    try {
      const text = await Bun.file(dummy.file).text();
      expect(text).toContain(CLAUDE_OAUTH_DUMMY_ACCESS_TOKEN);
      expect(text).not.toContain("real");
      expect((await stat(dummy.file)).mode & 0o777).toBe(0o600);
    } finally {
      await removeDummyClaudeCredentials(dummy);
    }
    expect(await stat(dummy.dir).catch(() => null)).toBeNull();
  });
});

test("prepareDummyClaudeCredentials: fails when the host is not logged in", async () => {
  await withHome(async (home) => {
    await expect(prepareDummyClaudeCredentials(home)).rejects.toThrow(
      /claude \/login/,
    );
  });
});
```

- [ ] **Step 6: 失敗を確認する**

Run: `bun test src/stages/mount/claude_state_fs_test.ts src/stages/mount/claude_credentials_fs_test.ts`
Expected: FAIL

- [ ] **Step 7: 実装する**

`src/stages/mount/claude_state_fs.ts`:
- `prepareProtectedClaudeState(hostHome: string, options: { shareCredentials?: boolean } = {})` に変更する。
- 関数内で共有ファイルの集合を作る:

```ts
  const sharedFiles = CLAUDE_SHARED_FILES.filter(
    (name) => options.shareCredentials !== false || name !== ".credentials.json",
  );
```

  `for (const name of CLAUDE_SHARED_FILES)` と `writable` の集合の作成を `sharedFiles` に置き換える。`entries` の作成で、`shareCredentials === false` のときは `.credentials.json` を除く（`.filter((name) => options.shareCredentials !== false || name !== ".credentials.json")` を `PRIVATE_ENTRIES` の filter の後に足す）。

`src/stages/mount/claude_credentials_fs.ts`:

```ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  buildDummyClaudeCredentials,
  ClaudeOAuthUnavailableError,
} from "../../agents/claude_oauth.ts";

export interface DummyClaudeCredentials {
  readonly dir: string;
  readonly file: string;
}

/**
 * ホストの Claude の credential からダミーを作り、セッション専用の
 * ディレクトリに置く。Dev Container は bind 元が実在しないと起動しないので、
 * マウント前に必ず作っておく。
 */
export async function prepareDummyClaudeCredentials(
  hostHome: string,
): Promise<DummyClaudeCredentials> {
  let hostText: string;
  try {
    hostText = await readFile(
      path.join(hostHome, ".claude", ".credentials.json"),
      "utf8",
    );
  } catch {
    throw new ClaudeOAuthUnavailableError("no credentials file");
  }
  const dummy = buildDummyClaudeCredentials(hostText);
  const dir = await mkdtemp(path.join(tmpdir(), "nas-claude-credentials-"));
  const file = path.join(dir, ".credentials.json");
  try {
    await writeFile(file, dummy, { mode: 0o600 });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return { dir, file };
}

export async function removeDummyClaudeCredentials(
  state: DummyClaudeCredentials,
): Promise<void> {
  await rm(state.dir, { recursive: true, force: true });
}
```

`src/stages/mount/mount_setup_service.ts`:
- Tag に `readonly prepareClaudeCredentials: (hostHome: string) => Effect.Effect<string, unknown, Scope.Scope>;` を追加する。
- `prepareClaudeState` の型を `(hostHome: string, options?: { shareCredentials?: boolean }) => ...` に変え、Live で `prepareProtectedClaudeState(hostHome, options)` に渡す。
- Live に追加する:

```ts
    prepareClaudeCredentials: (hostHome) =>
      Effect.acquireRelease(
        Effect.tryPromise(() => prepareDummyClaudeCredentials(hostHome)),
        (state) => Effect.promise(() => removeDummyClaudeCredentials(state)),
      ).pipe(Effect.map((state) => state.file)),
```

- Fake の設定型に `prepareClaudeCredentials?` を追加し、未指定なら `Effect.die("prepareClaudeCredentials fake is required")` にする（`prepareClaudeState` の既存の既定と同じ形）。

- [ ] **Step 8: テストが通ることを確認する**

Run: `bun test src/stages/mount/claude_state_fs_test.ts src/stages/mount/claude_credentials_fs_test.ts`
Expected: PASS

- [ ] **Step 9: mount stage の failing test を書く**

`src/stages/mount/stage_test.ts` に、既存の "MountStage run(): prepares protected Claude state ..."（L1832）と同じ fake の形で追加する:

```ts
test("MountStage run(): proxied Claude credentials mount a dummy file", async () => {
  const events: string[] = [];
  const layer = makeMountSetupServiceFake({
    prepareClaudeCredentials: () =>
      Effect.acquireRelease(
        Effect.sync(() => {
          events.push("prepare-credentials");
          return "/private/dummy/.credentials.json";
        }),
        () =>
          Effect.sync(() => {
            events.push("release-credentials");
          }),
      ),
    ensureDirectories: () => Effect.void,
  });
  // sharedInput / mountProbes / slices は既存テストと同じ作り方で、
  // profile を makeProfile({ agent: "claude" }) にする。
  const result = await Effect.runPromise(
    Effect.scoped(
      createMountStage(sharedInput, mountProbes).run(slices),
    ).pipe(Effect.provide(layer)),
  );
  expect(
    result.container?.mounts?.some(
      (m) =>
        m.source === "/private/dummy/.credentials.json" &&
        m.target.endsWith("/.claude/.credentials.json"),
    ),
  ).toBe(true);
  expect(events).toEqual(["prepare-credentials", "release-credentials"]);
});

test("MountStage run(): shared Claude credentials do not prepare a dummy file", async () => {
  const layer = makeMountSetupServiceFake({
    ensureDirectories: () => Effect.void,
  });
  // profile を makeProfile({ agent: "claude", agentState: { protectSettings: false, auth: "shared" } }) にする。
  // prepareClaudeCredentials の fake がないので、呼ばれれば die して失敗する。
  await Effect.runPromise(
    Effect.scoped(
      createMountStage(sharedInput, mountProbes).run(slices),
    ).pipe(Effect.provide(layer)),
  );
});
```

（`result.container?.mounts` は、stage の戻り値で mounts を持つ実際のフィールドに合わせる。既存テストが mounts を検査している書き方を踏襲する。）

- [ ] **Step 10: 失敗を確認する**

Run: `bun test src/stages/mount/stage_test.ts --test-name-pattern 'Claude credentials'`
Expected: FAIL

- [ ] **Step 11: mount stage を実装する**

`src/stages/mount/stage.ts`:
- import に `resolveAgentCredentials`（`../../agents/credentials.ts`）を追加する。
- `createMountStage.run` の `protectedState` の計算を次に置き換える:

```ts
      const proxiedClaudeCredentials =
        shared.profile.agent === "claude" &&
        resolveAgentCredentials(
          shared.profile.agent,
          shared.profile.agentState.auth,
        ) === "proxy";
      const protectedState =
        shared.profile.agent === "claude" &&
        shared.profile.agentState.protectSettings
          ? yield* mountSetupService.prepareClaudeState(shared.host.home, {
              shareCredentials: !proxiedClaudeCredentials,
            })
          : undefined;
      const claudeCredentialsFile = proxiedClaudeCredentials
        ? yield* mountSetupService.prepareClaudeCredentials(shared.host.home)
        : undefined;
      const plan = planMount(
        stageInput,
        mountProbes,
        devcontainer,
        protectedState,
        claudeCredentialsFile,
      );
```

- `planMount` に第5引数 `claudeCredentialsFile?: string` を追加し、`configureAgent({...})` に `claudeCredentialsFile,` を渡す。

`stage_test.ts` の既存テストのうち、`makeMountSetupServiceFake` に `prepareClaudeCredentials` を与えずに Claude の profile で `run()` するものは、既定の `"proxy"` で die する。それらには `prepareClaudeCredentials: () => Effect.succeed("/private/dummy/.credentials.json")` を追加するか、profile に `auth: "shared"` を指定する（テストの意図が認証情報と無関係なら後者）。

- [ ] **Step 12: テストが通ることを確認する**

Run: `bun test src/stages/mount/stage_test.ts src/agents/claude_test.ts src/stages/mount/claude_state_fs_test.ts`
Expected: PASS

- [ ] **Step 13: 型検査と unit を実行する**

Run: `bun run check && bun run test:unit`
Expected: どちらも成功。`claude_state_fs_test.ts` の既存テスト "protected state shares only credentials and history writable" は `shareCredentials` を指定しない呼び出しなので、従来どおり `.credentials.json` を含む。

- [ ] **Step 14: Commit**

```bash
git add src/stages/mount/claude_state_fs.ts src/stages/mount/claude_credentials_fs.ts src/stages/mount/claude_credentials_fs_test.ts src/stages/mount/mount_setup_service.ts src/stages/mount/stage.ts src/stages/mount/stage_test.ts src/stages/mount/claude_state_fs_test.ts src/agents/types.ts src/agents/registry.ts src/agents/claude.ts src/agents/claude_test.ts
git commit
```

---

### Task 9: 利用者向けの説明

**Files:**
- Modify: `src/domain/devcontainer/disclosure.ts:44-53`
- Modify: `src/domain/devcontainer/disclosure_test.ts`
- Modify: `docs-site/src/content/docs/configuration/authentication.md:41-60`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Task 1 の `resolveAgentCredentials`

- [ ] **Step 1: disclosure の failing test を書く**

`src/domain/devcontainer/disclosure_test.ts` の既存テスト（L116 / L161 付近）の形で追加する:

```ts
test("describeDevcontainerSharing: proxied Claude credentials are not described as shared", () => {
  const lines = describeDevcontainerSharing(
    makeProfile({ agent: "claude" }),
  );
  const text = JSON.stringify(lines);
  expect(text).not.toMatch(/Claude credentials[^"]*read-write/);
  expect(text).toMatch(/injected by the proxy/);
});
```

（`makeProfile` と戻り値の形は既存テストに合わせる。）

- [ ] **Step 2: 失敗を確認する**

Run: `bun test src/domain/devcontainer/disclosure_test.ts`
Expected: FAIL

- [ ] **Step 3: disclosure を実装する**

`describeDevcontainerSharing` の Claude の分岐で、`resolveAgentCredentials(profile.agent, profile.agentState.auth) === "proxy"` のときは、「host Claude credentials ... shared read-write」の代わりに「Claude credentials stay on the host and are injected by the proxy; the container sees a dummy credentials file」を出す。history と projects の共有の記述は変えない。

- [ ] **Step 4: テストが通ることを確認する**

Run: `bun test src/domain/devcontainer/disclosure_test.ts`
Expected: PASS

- [ ] **Step 5: ドキュメントを更新する**

`docs-site/src/content/docs/configuration/authentication.md` の「エージェント設定ファイルの保護」の近くに節を足す:
- `agentState.auth` の2つの値と既定値（Claude は `"proxy"`）。
- `"proxy"` では、ホストの `~/.claude/.credentials.json` を container と共有せず、ダミーを見せること。token の更新はホストの nas が行うこと。
- API key で Claude を使う場合は `auth = "shared"` が必要なこと。
- ログインはホストで行うこと（container 内の `/login` は、そのセッションのダミーファイルにしか残らない）。
- 表の `~/.claude/.credentials.json` の行を、`"proxy"` のときはダミー、`"shared"` のときは read-write 共有、に書き分ける。

`CHANGELOG.md` の未リリースの節（なければ先頭に `## Unreleased` を作る）に追加する:
- Claude の既定で、OAuth の credential をホストで保持し proxy で注入するようになったこと。
- API key を使う profile は `agentState.auth = "shared"` を指定する必要があること。

- [ ] **Step 6: 型検査と unit を実行する**

Run: `bun run check && bun run test:unit`
Expected: どちらも成功

- [ ] **Step 7: Commit**

```bash
git add src/domain/devcontainer/disclosure.ts src/domain/devcontainer/disclosure_test.ts docs-site/src/content/docs/configuration/authentication.md CHANGELOG.md
git commit
```
