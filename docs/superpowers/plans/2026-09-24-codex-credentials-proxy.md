# Codex 認証情報のホスト管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Codex の ChatGPT OAuth credential をホスト側の broker が保持・更新し、proxy が `chatgpt.com` への許可済み request にだけ注入する。container にはダミーの `auth.json` だけを見せ、ホストの `~/.codex` のそれ以外は今と同じく共有する。

**Architecture:** `agentState.auth` をエージェントごと（起動するエージェントと `extraAgents`）に解決し、Codex の既定値も `"proxy"` にする（Dev Container では `"shared"`）。Claude の OAuth 更新処理をエージェント非依存の `HostOAuthCredentialSource` に切り出し、Claude と Codex の両方がそれを使う。broker は複数の `AgentCredential` を持ち、宛先のホストで使い分ける。mount stage はダミーの `auth.json` をホストの `~/.codex` の mount の上に被せ、ホスト側ではその `auth.json` の inode を監視して、消えるか置き換わったらセッションの container を止める。

**Tech Stack:** Bun + TypeScript（Effect）、Pkl

**Spec:** `docs/superpowers/specs/2026-09-24-codex-credentials-proxy-design.md`

## Global Constraints

- 実装者・レビュアーは次の skill を読んでから作業する: `effect-separation`（`.claude/skills/effect-separation/SKILL.md`）、`security-constraints`（`.claude/skills/security-constraints/SKILL.md`）、`test-policy`（`.claude/skills/test-policy/SKILL.md`）。
- 設定キーは `agentState.auth`、値は `"proxy"` と `"shared"`。未指定時の既定値は Claude と Codex が `"proxy"`、Copilot が `"shared"`。Dev Container の Codex は `"shared"`。
- `"proxy"` に対応するのは Claude と Codex。`"proxy"` を明示しても、Copilot は `"shared"` として扱う。起動するエージェントも `extraAgents` も対応していないときだけ設定エラーにする。
- Codex の注入対象のホストは `chatgpt.com` だけ。注入する header は `Authorization: Bearer <access token>` と `chatgpt-account-id: <account id>`。削除する header はない。
- container からの `POST https://auth.openai.com/oauth/token` は policy の評価より前に deny し、理由は `credential-refresh-owned-by-host` とする。ホストの `auth.json` が置き換わった後の `chatgpt.com` への request は deny し、理由は `credential-revoked-on-host` とする。
- Codex の refresh の request は `POST https://auth.openai.com/oauth/token`、JSON body は `{"client_id": ..., "grant_type": "refresh_token", "refresh_token": ...}`。`client_id` はホストの access token の `client_id` claim、なければ `app_EMoamEEZ73f0CkXaXp7hrann`。
- Codex の更新は access token の `exp` の2分前に始め、失敗したら30秒後にやり直す（Claude は従来どおり5分前）。
- Codex の更新のロックは `$XDG_STATE_HOME/nas/locks/codex-oauth-<sha256(realpath(~/.codex)) の先頭16桁>.lock`（`XDG_STATE_HOME` がなければ `~/.local/state`）。container から見える `~/.codex` には置かない。
- ホストの `auth.json` への書き戻しは、同じ inode への上書き（truncate して書く）で行い、rename しない。ファイルが無ければ作らずに失敗する。
- ホストの `auth.json` の監視は、`fs.watch` のイベントと5秒ごとの確認の両方で inode（device と inode 番号）を比べる。
- ダミーの `auth.json` のうち、id token と access token は `<base64url({"alg":"none","typ":"JWT"})>.<base64url(payload)>.nas-proxy-injected` の形の JWT とする。access token の `exp` は `32503680000`（3000-01-01T00:00:00Z、秒）。refresh token は `nas-proxy-injected-refresh-token`。
- unit test は Docker に触れない（`*_test.ts`）。Docker や実ソケットを使うテストは `*integration_test.ts` に置く。
- コメントは6か月後にファイル全体を読む人向けに書く。変更履歴やこの計画・spec への参照をコードに書かない。触るファイルの既存のコメントの言語に合わせる。
- 最終確認は `bun run check` と `bun run test:unit`。`bun test src/` は使わない。

## File Structure

| ファイル | 責務 |
| --- | --- |
| `src/agents/credentials.ts`（変更） | `agentState.auth` をエージェントごとに解決する |
| `src/config/validate.ts`（変更） | `agentState.auth` と API key の env の検証 |
| `src/domain/devcontainer/policy.ts`（変更） | Dev Container の Codex で `"proxy"` の明示を拒否する |
| `src/agents/codex_oauth.ts`（新規） | Codex の `auth.json` の解析、ダミーの生成、refresh の結果の反映。I/O なし |
| `src/network/host_oauth_source.ts`（新規） | エージェント非依存の OAuth 更新処理（Claude の実装から切り出す） |
| `src/network/claude_oauth_source.ts`（変更） | Claude 固有の部分だけを残す |
| `src/network/codex_oauth_source.ts`（新規） | Codex 固有の更新処理と live deps |
| `src/lib/oauth_refresh_lock.ts`（変更） | Codex 用のロックの取得を足す |
| `src/network/codex_auth_watch.ts`（新規） | ホストの `auth.json` の置き換えの検知 |
| `src/network/agent_credential.ts`（変更） | エージェントごとの注入先・header・更新の request の定義と、判定結果への適用 |
| `src/network/broker.ts`（変更） | 複数の credential と、置き換え後の deny |
| `src/stages/proxy/session_broker_service.ts`（変更） | credential の起動・停止と、置き換え時の container の停止 |
| `src/stages/proxy/stage.ts`（変更） | どの credential を起動するかの計画 |
| `src/pipeline/cli_builder.ts`（変更） | proxy stage に Dev Container かどうかを渡す |
| `src/stages/mount/codex_credentials_fs.ts`（新規） | ダミーの `auth.json` をセッション専用のディレクトリに作る |
| `src/stages/mount/mount_setup_service.ts`（変更） | ダミーの `auth.json` の寿命をセッションに合わせる |
| `src/agents/codex.ts`・`src/agents/registry.ts`・`src/agents/types.ts`（変更） | ダミーの `auth.json` の mount |
| `src/stages/mount/stage.ts`（変更） | ダミーの準備と、`extraAgents` への credential の受け渡し |
| docs・`src/config/Schema.pkl`・`CHANGELOG.md`（変更） | 利用者向けの説明 |

---

### Task 1: `agentState.auth` のエージェントごとの解決と検証

**Files:**
- Modify: `src/agents/credentials.ts`
- Modify: `src/agents/credentials_test.ts`
- Modify: `src/config/validate.ts`（`validateAgentCredentials`）
- Modify: `src/config/validate_test.ts`（`agentState.auth` の節）
- Modify: `src/domain/devcontainer/policy.ts`
- Modify: `src/domain/devcontainer/policy_test.ts`
- Modify: `src/config/Schema.pkl`（`AgentStateConfig.auth` の doc comment）

**Interfaces:**
- Produces:
  - `interface CredentialsContext { readonly devcontainer?: boolean }`
  - `supportsProxiedCredentials(agent: AgentType): boolean`（Claude と Codex で true）
  - `resolveAgentCredentials(agent: AgentType, configured: AgentCredentialsMode | undefined, context?: CredentialsContext): AgentCredentialsMode`
  - `type CredentialsProfile = Pick<Profile, "agent" | "agentState"> & { readonly extraAgents?: readonly AgentType[] }`
  - `usesProxiedCredentials(profile: CredentialsProfile, agent: AgentType, context?: CredentialsContext): boolean`
  - `usesProxiedClaudeCredentials(profile: CredentialsProfile): boolean`（`extraAgents` の Claude も含むようになる）
  - `usesProxiedCodexCredentials(profile: CredentialsProfile, context?: CredentialsContext): boolean`

- [ ] **Step 1: 解決の test を書き換える**

`src/agents/credentials_test.ts` の全体を次にする。

```ts
import { expect, test } from "bun:test";
import {
  resolveAgentCredentials,
  supportsProxiedCredentials,
  usesProxiedClaudeCredentials,
  usesProxiedCodexCredentials,
} from "./credentials.ts";

test("resolveAgentCredentials: Claude and Codex default to proxy", () => {
  expect(resolveAgentCredentials("claude", undefined)).toBe("proxy");
  expect(resolveAgentCredentials("codex", undefined)).toBe("proxy");
});

test("resolveAgentCredentials: Copilot defaults to shared", () => {
  expect(resolveAgentCredentials("copilot", undefined)).toBe("shared");
});

test("resolveAgentCredentials: an explicit value wins for supported agents", () => {
  expect(resolveAgentCredentials("claude", "shared")).toBe("shared");
  expect(resolveAgentCredentials("codex", "shared")).toBe("shared");
  expect(resolveAgentCredentials("codex", "proxy")).toBe("proxy");
});

// Copilot の token は ~/.copilot に無いので、proxy を明示しても共有に
// 落として保護が弱まることはない。
test("resolveAgentCredentials: Copilot stays shared even when proxy is explicit", () => {
  expect(resolveAgentCredentials("copilot", "proxy")).toBe("shared");
});

test("resolveAgentCredentials: Dev Container Codex defaults to shared", () => {
  expect(
    resolveAgentCredentials("codex", undefined, { devcontainer: true }),
  ).toBe("shared");
  expect(
    resolveAgentCredentials("claude", undefined, { devcontainer: true }),
  ).toBe("proxy");
});

test("supportsProxiedCredentials: Claude and Codex are implemented", () => {
  expect(supportsProxiedCredentials("claude")).toBe(true);
  expect(supportsProxiedCredentials("codex")).toBe(true);
  expect(supportsProxiedCredentials("copilot")).toBe(false);
});

test("usesProxiedClaudeCredentials: Claude with auth unset or proxy", () => {
  for (const auth of [undefined, "proxy"] as const) {
    expect(
      usesProxiedClaudeCredentials({
        agent: "claude",
        agentState: { protectSettings: false, auth },
      }),
    ).toBe(true);
  }
});

test("usesProxiedClaudeCredentials: Claude with auth shared", () => {
  expect(
    usesProxiedClaudeCredentials({
      agent: "claude",
      agentState: { protectSettings: true, auth: "shared" },
    }),
  ).toBe(false);
});

test("usesProxiedClaudeCredentials: Claude listed in extraAgents", () => {
  expect(
    usesProxiedClaudeCredentials({
      agent: "codex",
      extraAgents: ["claude"],
      agentState: { protectSettings: false, auth: undefined },
    }),
  ).toBe(true);
});

test("usesProxiedClaudeCredentials: profiles without Claude", () => {
  for (const agent of ["codex", "copilot"] as const) {
    expect(
      usesProxiedClaudeCredentials({
        agent,
        agentState: { protectSettings: false, auth: "proxy" },
      }),
    ).toBe(false);
  }
});

test("usesProxiedCodexCredentials: launched or extra Codex outside Dev Container", () => {
  expect(
    usesProxiedCodexCredentials({
      agent: "codex",
      agentState: { protectSettings: false, auth: undefined },
    }),
  ).toBe(true);
  expect(
    usesProxiedCodexCredentials({
      agent: "claude",
      extraAgents: ["codex"],
      agentState: { protectSettings: false, auth: undefined },
    }),
  ).toBe(true);
  expect(
    usesProxiedCodexCredentials(
      {
        agent: "codex",
        agentState: { protectSettings: false, auth: undefined },
      },
      { devcontainer: true },
    ),
  ).toBe(false);
  expect(
    usesProxiedCodexCredentials({
      agent: "codex",
      agentState: { protectSettings: false, auth: "shared" },
    }),
  ).toBe(false);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `bun test src/agents/credentials_test.ts`
Expected: FAIL（`usesProxiedCodexCredentials` が export されていない）

- [ ] **Step 3: `src/agents/credentials.ts` を書き換える**

ファイルの全体を次にする。`usesClaude` は既存のまま残す（先頭に置く）。

```ts
import type { AgentCredentialsMode, Profile } from "../config/types.ts";
import type { AgentType } from "./types.ts";

/** 起動するか extraAgents に含むかを問わず、コンテナに Claude を用意するか */
export function usesClaude(
  profile: Pick<Profile, "agent" | "extraAgents">,
): boolean {
  return profile.agent === "claude" || profile.extraAgents.includes("claude");
}

/** `agentState.auth` の解決に要る、セッションの種類。 */
export interface CredentialsContext {
  /**
   * Dev Container のセッションか。Dev Container の Codex は VS Code 拡張機能が
   * 起動し、`~/.codex` の扱いが異なるので、proxy の対象にしない。
   */
  readonly devcontainer?: boolean;
}

export type CredentialsProfile = Pick<Profile, "agent" | "agentState"> & {
  readonly extraAgents?: readonly AgentType[];
};

/** ホスト側で認証情報を保持し proxy で注入する方式を実装済みのエージェントか。 */
export function supportsProxiedCredentials(agent: AgentType): boolean {
  return agent === "claude" || agent === "codex";
}

/**
 * エージェントの `agentState.auth` の実効値を返す。
 *
 * 未実装のエージェントは、明示されていても `"shared"` になる。Copilot の
 * token は `~/.copilot` に無いので、共有しても保護は弱まらない。未指定なら
 * 実装済みのエージェントは `"proxy"` になる。ただし Dev Container の Codex は
 * `"shared"` になる。
 */
export function resolveAgentCredentials(
  agent: AgentType,
  configured: AgentCredentialsMode | undefined,
  context: CredentialsContext = {},
): AgentCredentialsMode {
  if (!supportsProxiedCredentials(agent)) return "shared";
  if (configured !== undefined) return configured;
  if (agent === "codex" && context.devcontainer) return "shared";
  return "proxy";
}

/**
 * コンテナに用意する agent を、ホストが保持する credential を proxy で
 * 注入する方式で動かすかを返す。起動するエージェントと extraAgents の
 * どちらに含まれていてもよい。
 */
export function usesProxiedCredentials(
  profile: CredentialsProfile,
  agent: AgentType,
  context: CredentialsContext = {},
): boolean {
  const provisioned =
    profile.agent === agent || (profile.extraAgents ?? []).includes(agent);
  return (
    provisioned &&
    resolveAgentCredentials(agent, profile.agentState.auth, context) ===
      "proxy"
  );
}

export function usesProxiedClaudeCredentials(
  profile: CredentialsProfile,
): boolean {
  return usesProxiedCredentials(profile, "claude");
}

export function usesProxiedCodexCredentials(
  profile: CredentialsProfile,
  context: CredentialsContext = {},
): boolean {
  return usesProxiedCredentials(profile, "codex", context);
}
```

- [ ] **Step 4: test が通ることを確認する**

Run: `bun test src/agents/credentials_test.ts`
Expected: PASS

- [ ] **Step 5: 検証の test を書き換える**

`src/config/validate_test.ts` の `validate: agentState.auth proxy is rejected for agents other than claude` と `validate: an API key env on codex is not checked` を削除し、`// agentState.auth` の節に次を足す。

```ts
test("validate: agentState.auth proxy is rejected when no provisioned agent supports it", () => {
  const config = makeConfig({
    profiles: {
      p: makeProfile({
        agent: "copilot",
        agentState: { protectSettings: false, auth: "proxy" },
      }),
    },
  });
  expect(() => validateConfig(config)).toThrow(
    /agentState\.auth = "proxy" supports only agents "claude" and "codex"/,
  );
});

test("validate: agentState.auth proxy is accepted when an extra agent supports it", () => {
  const config = makeConfig({
    profiles: {
      p: makeProfile({
        agent: "copilot",
        extraAgents: ["codex"],
        agentState: { protectSettings: false, auth: "proxy" },
      }),
    },
  });
  expect(() => validateConfig(config)).not.toThrow();
});

test("validate: proxied Codex credentials reject a static OPENAI_API_KEY env", () => {
  const config = makeConfig({
    profiles: {
      p: makeProfile({
        agent: "codex",
        env: [{ key: "OPENAI_API_KEY", val: "x", mode: "set" }],
      }),
    },
  });
  expect(() => validateConfig(config)).toThrow(
    /OPENAI_API_KEY[\s\S]*Codex[\s\S]*agentState\.auth = "shared"/,
  );
});

test("validate: proxied Codex credentials reject a static CODEX_API_KEY env", () => {
  const config = makeConfig({
    profiles: {
      p: makeProfile({
        agent: "claude",
        extraAgents: ["codex"],
        env: [{ key: "CODEX_API_KEY", val: "x", mode: "set" }],
      }),
    },
  });
  expect(() => validateConfig(config)).toThrow(/CODEX_API_KEY/);
});

test("validate: shared Codex credentials accept an API key env", () => {
  const config = makeConfig({
    profiles: {
      p: makeProfile({
        agent: "codex",
        agentState: { protectSettings: false, auth: "shared" },
        env: [{ key: "OPENAI_API_KEY", val: "x", mode: "set" }],
      }),
    },
  });
  expect(() => validateConfig(config)).not.toThrow();
});

test("validate: an Anthropic API key env on a profile without Claude is not checked", () => {
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

Run: `bun test src/config/validate_test.ts --test-name-pattern 'agentState.auth|API key'`
Expected: FAIL（新しいメッセージと Codex の env の検証が無い）

- [ ] **Step 7: `validateAgentCredentials` を書き換える**

`src/config/validate.ts` の import に `usesProxiedCodexCredentials` を足し、`API_KEY_ENV_KEYS` から `validateAgentCredentials` の終わりまでを次にする。

```ts
// ホストの API key を container へ渡す設定は、proxy が Authorization を
// 上書きするので動かない。起動前に opt-out を案内する。
const CLAUDE_API_KEY_ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
const CODEX_API_KEY_ENV_KEYS = ["OPENAI_API_KEY", "CODEX_API_KEY"];

function apiKeyEnvErrors(
  name: string,
  profile: Profile,
  keys: readonly string[],
  label: string,
): string[] {
  const errors: string[] = [];
  for (const entry of profile.env) {
    // keyCmd のキー名はホストでコマンドを実行するまで決まらない。
    if (!("key" in entry) || !keys.includes(entry.key)) continue;
    errors.push(
      `profile "${name}": env ${entry.key} does not work while ${label} credentials are injected by the proxy; set agentState.auth = "shared" to use an API key`,
    );
  }
  return errors;
}

function validateAgentCredentials(name: string, profile: Profile): string[] {
  const errors: string[] = [];
  const provisioned = [profile.agent, ...profile.extraAgents];
  if (
    profile.agentState.auth === "proxy" &&
    !provisioned.some(supportsProxiedCredentials)
  ) {
    errors.push(
      `profile "${name}": agentState.auth = "proxy" supports only agents "claude" and "codex"; use "shared" for agent "${profile.agent}"`,
    );
  }
  if (usesProxiedClaudeCredentials(profile)) {
    errors.push(
      ...apiKeyEnvErrors(name, profile, CLAUDE_API_KEY_ENV_KEYS, "Claude"),
    );
  }
  // 検証の時点では Dev Container かどうか分からないので、Dev Container でない
  // ものとして調べる。Dev Container の Codex で API key を使うなら "shared" を
  // 明示する。
  if (usesProxiedCodexCredentials(profile)) {
    errors.push(
      ...apiKeyEnvErrors(name, profile, CODEX_API_KEY_ENV_KEYS, "Codex"),
    );
  }
  return errors;
}
```

既存の Claude の test（`proxied Claude credentials reject a static ANTHROPIC_API_KEY env`）の正規表現はこのメッセージにも一致する。

- [ ] **Step 8: test が通ることを確認する**

Run: `bun test src/config/validate_test.ts`
Expected: PASS

- [ ] **Step 9: Dev Container の policy に test を足す**

`src/domain/devcontainer/policy_test.ts` に足す（`makeProfile` など既存の helper を使う）。

```ts
test("validateDevcontainerProfile: rejects an explicit proxy for Codex", () => {
  const profile = makeProfile({
    agent: "codex",
    agentState: { protectSettings: false, auth: "proxy" },
  });
  expect(validateDevcontainerProfile(profile)).toContain(
    'agentState.auth = "proxy" is unsupported for Codex devcontainer sessions; use "shared"',
  );
});

test("validateDevcontainerProfile: accepts Codex with auth unset", () => {
  const profile = makeProfile({ agent: "codex" });
  expect(validateDevcontainerProfile(profile)).toEqual([]);
});
```

Run: `bun test src/domain/devcontainer/policy_test.ts`
Expected: FAIL（1つ目）

- [ ] **Step 10: policy に検証を足す**

`src/domain/devcontainer/policy.ts` の `extraAgents` の検証の後に足す。

```ts
  if (profile.agent === "codex" && profile.agentState.auth === "proxy")
    errors.push(
      'agentState.auth = "proxy" is unsupported for Codex devcontainer sessions; use "shared"',
    );
```

Run: `bun test src/domain/devcontainer/policy_test.ts`
Expected: PASS

- [ ] **Step 11: Schema の説明を直す**

`src/config/Schema.pkl` の `auth` の doc comment を次にする。

```pkl
  /// エージェント自身のログイン情報の扱い。
  ///
  /// `"proxy"` はホスト側で認証情報を保持・更新し、network proxy が許可した
  /// request にだけ注入する。container にはダミー値を見せ、ホストの認証情報
  /// ファイルは共有しない。Claude と Codex が対応し、起動するエージェントと
  /// `extraAgents` のどちらにも適用する。Copilot には適用しない。
  /// `"shared"` はホストの認証情報ファイルを container と共有する。
  /// API key を使う場合と、Codex の認証情報をキーリングに保存している場合は
  /// `"shared"` を指定する。
  ///
  /// 未指定 (null) なら、Claude と Codex は `"proxy"`、Copilot は `"shared"`。
  /// Dev Container の Codex は `"shared"`。
  auth: ("proxy"|"shared")? = null
```

- [ ] **Step 12: 型と unit test を確認してコミットする**

Run: `bun run check && bun run test:unit`
Expected: PASS。`usesProxiedClaudeCredentials` は `extraAgents` の Claude も含むようになるが、この時点で proxy stage と mount stage が参照するのは Claude の判定だけで、既存の test の profile はどれも `extraAgents` に Claude を持たないので、期待値は変わらない。落ちる test があれば、この前提が崩れているので原因を調べる。

```bash
git add src/agents/credentials.ts src/agents/credentials_test.ts src/config/validate.ts src/config/validate_test.ts src/domain/devcontainer/policy.ts src/domain/devcontainer/policy_test.ts src/config/Schema.pkl
git commit -m "feat(config): resolve agentState.auth per provisioned agent and support Codex"
```

---

### Task 2: Codex の `auth.json` の解析とダミーの生成

**Files:**
- Create: `src/agents/codex_oauth.ts`
- Create: `src/agents/codex_oauth_test.ts`

**Interfaces:**
- Produces（`src/agents/codex_oauth.ts`）:
  - `CODEX_DUMMY_REFRESH_TOKEN = "nas-proxy-injected-refresh-token"`
  - `CODEX_DUMMY_JWT_SIGNATURE = "nas-proxy-injected"`
  - `CODEX_DUMMY_ACCESS_TOKEN_EXP = 32503680000`
  - `interface CodexOAuthTokens { accessToken: string; refreshToken: string; expiresAt: number /* ms */; accountId: string | null; clientId?: string }`
  - `interface RefreshedCodexTokens { accessToken: string; refreshToken?: string; idToken?: string; refreshedAt: number /* ms */ }`
  - `class CodexOAuthUnavailableError extends Error`
  - `codexCredentialsReadError(error: unknown): unknown`
  - `decodeJwtPayload(jwt: string): Record<string, unknown> | null`
  - `parseCodexOAuthTokens(text: string): CodexOAuthTokens`
  - `buildDummyCodexAuth(hostText: string, now: number): string`
  - `mergeRefreshedCodexTokens(tokens: CodexOAuthTokens, refreshed: RefreshedCodexTokens): CodexOAuthTokens`
  - `applyRefreshedCodexTokens(hostText: string, refreshed: RefreshedCodexTokens): string`

- [ ] **Step 1: test を書く**

`src/agents/codex_oauth_test.ts` を作る。

```ts
import { expect, test } from "bun:test";
import {
  applyRefreshedCodexTokens,
  buildDummyCodexAuth,
  CODEX_DUMMY_ACCESS_TOKEN_EXP,
  CODEX_DUMMY_JWT_SIGNATURE,
  CODEX_DUMMY_REFRESH_TOKEN,
  CodexOAuthUnavailableError,
  codexCredentialsReadError,
  decodeJwtPayload,
  mergeRefreshedCodexTokens,
  parseCodexOAuthTokens,
} from "./codex_oauth.ts";

function jwt(payload: Record<string, unknown>): string {
  const b64 = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(payload)}.real-signature`;
}

const AUTH = "https://api.openai.com/auth";
const PROFILE = "https://api.openai.com/profile";

const HOST_ID_TOKEN = jwt({
  email: "me@example.com",
  sub: "secret-subject",
  [AUTH]: {
    chatgpt_plan_type: "pro",
    chatgpt_user_id: "user-1",
    user_id: "user-1",
    chatgpt_account_id: "acct-1",
    chatgpt_account_is_fedramp: false,
    organizations: [{ id: "org-secret" }],
  },
});
const HOST_ACCESS_TOKEN = jwt({
  exp: 1_800_000_000,
  client_id: "app_custom",
  [AUTH]: {
    chatgpt_account_id: "acct-1",
    chatgpt_account_user_id: "acct-user-1",
    chatgpt_plan_type: "pro",
  },
  [PROFILE]: { email: "me@example.com" },
});

function hostAuth(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: HOST_ID_TOKEN,
      access_token: HOST_ACCESS_TOKEN,
      refresh_token: "real-refresh",
      account_id: "acct-1",
    },
    last_refresh: "2026-09-19T14:20:05.692Z",
    extra_field: "kept-on-host",
    ...overrides,
  });
}

test("parseCodexOAuthTokens: reads tokens, expiry, account and client id", () => {
  expect(parseCodexOAuthTokens(hostAuth())).toEqual({
    accessToken: HOST_ACCESS_TOKEN,
    refreshToken: "real-refresh",
    expiresAt: 1_800_000_000_000,
    accountId: "acct-1",
    clientId: "app_custom",
  });
});

test("parseCodexOAuthTokens: falls back to the id token account and last_refresh + 8 days", () => {
  const access = jwt({ [AUTH]: {} });
  const text = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: HOST_ID_TOKEN,
      access_token: access,
      refresh_token: "r",
    },
    last_refresh: "2026-09-01T00:00:00.000Z",
  });
  const tokens = parseCodexOAuthTokens(text);
  expect(tokens.accountId).toBe("acct-1");
  expect(tokens.expiresAt).toBe(
    Date.parse("2026-09-01T00:00:00.000Z") + 8 * 24 * 60 * 60_000,
  );
  expect(tokens.clientId).toBeUndefined();
});

test("parseCodexOAuthTokens: rejects API key logins and incomplete files", () => {
  for (const text of [
    "not json",
    JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-x" }),
    JSON.stringify({ OPENAI_API_KEY: "sk-x" }),
    JSON.stringify({ auth_mode: "chatgpt" }),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { id_token: HOST_ID_TOKEN, access_token: "", refresh_token: "r" },
    }),
  ]) {
    expect(() => parseCodexOAuthTokens(text)).toThrow(
      CodexOAuthUnavailableError,
    );
  }
});

test("codexCredentialsReadError: a missing file asks for codex login", () => {
  const missing = Object.assign(new Error("nope"), { code: "ENOENT" });
  const converted = codexCredentialsReadError(missing);
  expect(converted).toBeInstanceOf(CodexOAuthUnavailableError);
  expect(String(converted)).toContain("codex login");
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  expect(codexCredentialsReadError(denied)).toBe(denied);
});

test("buildDummyCodexAuth: keeps no real token and only the listed claims", () => {
  const now = Date.parse("2026-09-24T00:00:00.000Z");
  const dummyText = buildDummyCodexAuth(hostAuth(), now);
  expect(dummyText).not.toContain("real-refresh");
  expect(dummyText).not.toContain("real-signature");
  expect(dummyText).not.toContain("secret-subject");
  expect(dummyText).not.toContain("org-secret");
  expect(dummyText).not.toContain("kept-on-host");

  const dummy = JSON.parse(dummyText);
  expect(dummy.auth_mode).toBe("chatgpt");
  expect(dummy.OPENAI_API_KEY).toBeNull();
  expect(dummy.last_refresh).toBe("2026-09-24T00:00:00.000Z");
  expect(dummy.tokens.refresh_token).toBe(CODEX_DUMMY_REFRESH_TOKEN);
  expect(dummy.tokens.account_id).toBe("acct-1");

  for (const token of [dummy.tokens.id_token, dummy.tokens.access_token]) {
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
    expect(parts[2]).toBe(CODEX_DUMMY_JWT_SIGNATURE);
  }
  expect(decodeJwtPayload(dummy.tokens.id_token)).toEqual({
    email: "me@example.com",
    [AUTH]: {
      chatgpt_plan_type: "pro",
      chatgpt_user_id: "user-1",
      user_id: "user-1",
      chatgpt_account_id: "acct-1",
      chatgpt_account_is_fedramp: false,
    },
  });
  expect(decodeJwtPayload(dummy.tokens.access_token)).toEqual({
    exp: CODEX_DUMMY_ACCESS_TOKEN_EXP,
    [AUTH]: {
      chatgpt_account_id: "acct-1",
      chatgpt_account_user_id: "acct-user-1",
    },
  });
});

test("buildDummyCodexAuth: rejects a host file without a ChatGPT login", () => {
  expect(() =>
    buildDummyCodexAuth(JSON.stringify({ OPENAI_API_KEY: "sk-x" }), 0),
  ).toThrow(CodexOAuthUnavailableError);
});

test("mergeRefreshedCodexTokens: takes the new expiry and keeps an omitted refresh token", () => {
  const tokens = parseCodexOAuthTokens(hostAuth());
  const access = jwt({ exp: 1_900_000_000 });
  expect(
    mergeRefreshedCodexTokens(tokens, {
      accessToken: access,
      refreshedAt: 0,
    }),
  ).toEqual({
    ...tokens,
    accessToken: access,
    expiresAt: 1_900_000_000_000,
  });
});

test("applyRefreshedCodexTokens: replaces only the refreshed tokens and last_refresh", () => {
  const access = jwt({ exp: 1_900_000_000 });
  const next = JSON.parse(
    applyRefreshedCodexTokens(hostAuth(), {
      accessToken: access,
      refreshToken: "refresh-2",
      idToken: "id-2",
      refreshedAt: Date.parse("2026-09-24T00:00:00.000Z"),
    }),
  );
  expect(next.tokens).toEqual({
    id_token: "id-2",
    access_token: access,
    refresh_token: "refresh-2",
    account_id: "acct-1",
  });
  expect(next.last_refresh).toBe("2026-09-24T00:00:00.000Z");
  expect(next.extra_field).toBe("kept-on-host");
  expect(next.auth_mode).toBe("chatgpt");
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `bun test src/agents/codex_oauth_test.ts`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: `src/agents/codex_oauth.ts` を作る**

```ts
/**
 * Codex CLI が `~/.codex/auth.json` に保存する ChatGPT の OAuth credential の
 * 読み取りと組み立て。ファイル I/O は持たない。
 *
 * Codex は id token と access token を JWT として読み (署名は検証しない)、
 * plan や account の情報を取り出す。ダミーにも JWT の形をした値が要るので、
 * 署名なしの JWT を作る。
 */

export const CODEX_DUMMY_REFRESH_TOKEN = "nas-proxy-injected-refresh-token";
export const CODEX_DUMMY_JWT_SIGNATURE = "nas-proxy-injected";
// Codex は access token の exp の5分前に自分で更新を始める。container 内で
// 更新させないために、ダミーの期限は十分遠くに置く (3000-01-01T00:00:00Z、秒)。
export const CODEX_DUMMY_ACCESS_TOKEN_EXP = 32503680000;
// Codex は期限を読めない access token を、最後の更新から8日で更新する。
const TOKEN_REFRESH_INTERVAL_MS = 8 * 24 * 60 * 60_000;

const AUTH_CLAIMS = "https://api.openai.com/auth";
const PROFILE_CLAIMS = "https://api.openai.com/profile";
// Codex が plan の表示や workspace の判定に使う claim だけをダミーへ写す。
// 未知の claim は秘密や不要な個人情報を含みうるので写さない。
const ID_TOKEN_AUTH_CLAIMS = [
  "chatgpt_plan_type",
  "chatgpt_user_id",
  "user_id",
  "chatgpt_account_id",
  "chatgpt_account_user_id",
  "chatgpt_account_is_fedramp",
];
const ACCESS_TOKEN_AUTH_CLAIMS = ["chatgpt_account_id", "chatgpt_account_user_id"];

export interface CodexOAuthTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** access token の期限 (ms)。 */
  readonly expiresAt: number;
  /** `chatgpt-account-id` header に付ける値。 */
  readonly accountId: string | null;
  /** access token の `client_id` claim。refresh の request に使う。 */
  readonly clientId?: string;
}

export interface RefreshedCodexTokens {
  readonly accessToken: string;
  /** 省略されたら元の refresh token を使い続ける。 */
  readonly refreshToken?: string;
  readonly idToken?: string;
  /** 更新した時刻 (ms)。ファイルの `last_refresh` になる。 */
  readonly refreshedAt: number;
}

export class CodexOAuthUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `[nas] Codex ChatGPT credentials are not available in the host ~/.codex/auth.json (${detail}). ` +
        `Run "codex login" on the host, or set agentState.auth = "shared" (required for API key use and for credentials stored in the keyring).`,
    );
    this.name = "CodexOAuthUnavailableError";
  }
}

/**
 * host の auth.json を読んだときのエラーを、呼び出し元が投げるエラーに
 * 変換する。file か `~/.codex` が無いときは、未ログインかキーリングに保存
 * しているとみなして案内する。それ以外は原因を隠さないよう元のエラーを返す。
 */
export function codexCredentialsReadError(error: unknown): unknown {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new CodexOAuthUnavailableError("no auth.json");
  }
  return error;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JWT の payload を読む。Codex と同じく署名は検証しない。読めなければ null。 */
export function decodeJwtPayload(jwt: string): JsonObject | null {
  const parts = jwt.split(".");
  if (parts.length !== 3 || parts.some((part) => part === "")) return null;
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(parts[1] as string, "base64url").toString("utf8"),
    );
    return isObject(payload) ? payload : null;
  } catch {
    return null;
  }
}

function encodeUnsignedJwt(payload: JsonObject): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.${CODEX_DUMMY_JWT_SIGNATURE}`;
}

function pickFields(
  source: unknown,
  fields: readonly string[],
): JsonObject | undefined {
  if (!isObject(source)) return undefined;
  const picked: JsonObject = {};
  for (const field of fields) {
    if (field in source) picked[field] = source[field];
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

function stringField(source: unknown, field: string): string | undefined {
  if (!isObject(source)) return undefined;
  const value = source[field];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function accessTokenExpiry(
  claims: JsonObject | null,
  lastRefreshMs: number | undefined,
): number {
  if (typeof claims?.exp === "number") return claims.exp * 1000;
  if (lastRefreshMs !== undefined) {
    return lastRefreshMs + TOKEN_REFRESH_INTERVAL_MS;
  }
  // 期限の手がかりが無ければ、すぐに更新して期限の読める token を得る。
  return 0;
}

function parseRoot(text: string): { root: JsonObject; tokens: JsonObject } {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw new CodexOAuthUnavailableError("auth.json is not JSON");
  }
  if (!isObject(root)) {
    throw new CodexOAuthUnavailableError("auth.json is not an object");
  }
  const mode = root.auth_mode;
  if (mode !== undefined && mode !== null && mode !== "chatgpt") {
    throw new CodexOAuthUnavailableError(
      `auth_mode is ${JSON.stringify(mode)}, not a ChatGPT login`,
    );
  }
  if (
    (mode === undefined || mode === null) &&
    typeof root.OPENAI_API_KEY === "string" &&
    root.OPENAI_API_KEY !== ""
  ) {
    throw new CodexOAuthUnavailableError(
      "an API key is stored instead of a ChatGPT login",
    );
  }
  if (!isObject(root.tokens)) {
    throw new CodexOAuthUnavailableError("no tokens entry");
  }
  return { root, tokens: root.tokens };
}

function validateTokens(
  root: JsonObject,
  tokens: JsonObject,
): CodexOAuthTokens {
  const accessToken = stringField(tokens, "access_token");
  const refreshToken = stringField(tokens, "refresh_token");
  const idToken = stringField(tokens, "id_token");
  if (!accessToken || !refreshToken || !idToken) {
    throw new CodexOAuthUnavailableError("the tokens entry is incomplete");
  }
  const accessClaims = decodeJwtPayload(accessToken);
  const idClaims = decodeJwtPayload(idToken);
  const accountId =
    stringField(tokens, "account_id") ??
    stringField(idClaims?.[AUTH_CLAIMS], "chatgpt_account_id") ??
    null;
  const clientId = stringField(accessClaims, "client_id");
  const lastRefresh =
    typeof root.last_refresh === "string"
      ? Date.parse(root.last_refresh)
      : Number.NaN;
  return {
    accessToken,
    refreshToken,
    expiresAt: accessTokenExpiry(
      accessClaims,
      Number.isNaN(lastRefresh) ? undefined : lastRefresh,
    ),
    accountId,
    ...(clientId !== undefined ? { clientId } : {}),
  };
}

export function parseCodexOAuthTokens(text: string): CodexOAuthTokens {
  const { root, tokens } = parseRoot(text);
  return validateTokens(root, tokens);
}

export function buildDummyCodexAuth(hostText: string, now: number): string {
  const { root, tokens } = parseRoot(hostText);
  const parsed = validateTokens(root, tokens);
  const idClaims = decodeJwtPayload(tokens.id_token as string);
  const accessClaims = decodeJwtPayload(tokens.access_token as string);

  const idPayload: JsonObject = {};
  const email = stringField(idClaims, "email");
  if (email !== undefined) idPayload.email = email;
  const profile = pickFields(idClaims?.[PROFILE_CLAIMS], ["email"]);
  if (profile !== undefined) idPayload[PROFILE_CLAIMS] = profile;
  const idAuth = pickFields(idClaims?.[AUTH_CLAIMS], ID_TOKEN_AUTH_CLAIMS);
  if (idAuth !== undefined) idPayload[AUTH_CLAIMS] = idAuth;

  const accessPayload: JsonObject = { exp: CODEX_DUMMY_ACCESS_TOKEN_EXP };
  const accessAuth = pickFields(
    accessClaims?.[AUTH_CLAIMS],
    ACCESS_TOKEN_AUTH_CLAIMS,
  );
  if (accessAuth !== undefined) accessPayload[AUTH_CLAIMS] = accessAuth;

  const dummy = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: encodeUnsignedJwt(idPayload),
      access_token: encodeUnsignedJwt(accessPayload),
      refresh_token: CODEX_DUMMY_REFRESH_TOKEN,
      account_id: parsed.accountId,
    },
    last_refresh: new Date(now).toISOString(),
  };
  return `${JSON.stringify(dummy, null, 2)}\n`;
}

export function mergeRefreshedCodexTokens(
  tokens: CodexOAuthTokens,
  refreshed: RefreshedCodexTokens,
): CodexOAuthTokens {
  return {
    ...tokens,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
    expiresAt: accessTokenExpiry(
      decodeJwtPayload(refreshed.accessToken),
      refreshed.refreshedAt,
    ),
  };
}

export function applyRefreshedCodexTokens(
  hostText: string,
  refreshed: RefreshedCodexTokens,
): string {
  const { root, tokens } = parseRoot(hostText);
  const next: JsonObject = {
    ...root,
    tokens: {
      ...tokens,
      access_token: refreshed.accessToken,
      ...(refreshed.refreshToken !== undefined
        ? { refresh_token: refreshed.refreshToken }
        : {}),
      ...(refreshed.idToken !== undefined
        ? { id_token: refreshed.idToken }
        : {}),
    },
    last_refresh: new Date(refreshed.refreshedAt).toISOString(),
  };
  return `${JSON.stringify(next, null, 2)}\n`;
}
```

- [ ] **Step 4: test が通ることを確認する**

Run: `bun test src/agents/codex_oauth_test.ts`
Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add src/agents/codex_oauth.ts src/agents/codex_oauth_test.ts
git commit -m "feat(agents): parse Codex ChatGPT credentials and build a dummy auth.json"
```

---

### Task 3: OAuth の更新処理をエージェント非依存にする

Claude の `ClaudeOAuthCredentialSource` の処理（ロック、読み直し、refresh、書き戻し、やり直し）を `HostOAuthCredentialSource` に移し、エージェントごとの違いを `HostOAuthFlavor` にまとめる。振る舞いは変えない。`src/network/claude_oauth_source_test.ts` は変更せずに通ること。

**Files:**
- Create: `src/network/host_oauth_source.ts`
- Modify: `src/network/claude_oauth_source.ts`

**Interfaces:**
- Produces（`src/network/host_oauth_source.ts`）:
  - `interface HostOAuthTokens { readonly accessToken: string; readonly expiresAt: number }`
  - `interface HostOAuthFlavor<T extends HostOAuthTokens, Req, R> { label; loginCommand; refreshLeadMs; parse(text): T; readError(error): unknown; refreshRequest(tokens: T): Req; merge(tokens: T, refreshed: R): T; apply(text: string, refreshed: R): string }`
  - `interface HostOAuthSourceDeps<Req, R>`（既存の `ClaudeOAuthSourceDeps` と同じメンバーで、`refresh(request: Req): Promise<R>`）
  - `class HostOAuthCredentialSource<T, Req, R>`: `protected constructor(flavor, deps, tokens)`, `protected start(): void`, `protected abandon(): void`, `currentTokens(): T`, `refreshNow(): Promise<void>`, `close(): Promise<void>`
  - `readInitialTokens<T, Req, R>(flavor, deps): Promise<T>`
- `src/network/claude_oauth_source.ts` の export（`AgentCredentialSource`、`ClaudeRefreshRequest`、`ClaudeOAuthSourceDeps`、`ClaudeOAuthCredentialSource`、`liveClaudeOAuthSourceDeps`、`parseRefreshResponse`、`CLAUDE_OAUTH_TOKEN_URL`、`CLAUDE_CODE_CLIENT_ID`）は名前も型も変えない。

- [ ] **Step 1: 既存の test が通ることを確認する（基準）**

Run: `bun test src/network/claude_oauth_source_test.ts`
Expected: PASS

- [ ] **Step 2: `src/network/host_oauth_source.ts` を作る**

`claude_oauth_source.ts` の `ClaudeOAuthCredentialSource` の本体を移し、Claude 固有の呼び出しを flavor に置き換えたもの。ログの文言は `${label} OAuth` と `${loginCommand}` で組み立て、Claude では従来と同じ文字列になる。

```ts
/**
 * ホスト側でエージェントの OAuth credential を保持し、期限前に更新する。
 *
 * container には本物の token を渡さず、proxy が許可した request にだけ
 * 保持している値を注入する。更新はロックの下で行い、ロックを取った後に
 * ファイルを読み直して、他のプロセスが既に更新していればその値を採用する。
 * ファイルの形式、refresh の request、更新を始める時期といったエージェント
 * ごとの違いは HostOAuthFlavor にまとめる。
 */

import { type HeldLock, LockContendedError } from "../lib/oauth_refresh_lock.ts";

const RETRY_DELAY_MS = 30_000;
const LOCK_ATTEMPTS = 5;
// setTimeout の delay は32bit 符号付き整数で扱われ、超えると即時発火する
// (TimeoutOverflowWarning)。有効期限がこれより先の token では、この値で
// 予約して発火のたびに期限までまだ間があるか確認し、無ければ延長予約する。
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface HostOAuthTokens {
  readonly accessToken: string;
  /** access token の期限 (ms)。 */
  readonly expiresAt: number;
}

export interface HostOAuthFlavor<T extends HostOAuthTokens, Req, R> {
  /** ログに出すエージェント名。 */
  readonly label: string;
  /** ホストで再ログインするコマンド。 */
  readonly loginCommand: string;
  /** 期限の何ミリ秒前に更新を始めるか。 */
  readonly refreshLeadMs: number;
  parse(text: string): T;
  /** open() での初回の読み取りの失敗を、利用者に見せるエラーへ変換する。 */
  readError(error: unknown): unknown;
  refreshRequest(tokens: T): Req;
  /** refresh の結果を、書き戻す前のメモリ上の tokens に反映する。 */
  merge(tokens: T, refreshed: R): T;
  /** refresh の結果をファイルの内容に反映した text を返す。 */
  apply(text: string, refreshed: R): string;
}

export interface HostOAuthSourceDeps<Req, R> {
  readCredentials(): Promise<string>;
  /** credentials file の内容を text で置き換える。 */
  writeCredentials(text: string): Promise<void>;
  acquireLock(): Promise<HeldLock>;
  refresh(request: Req): Promise<R>;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** 戻り値は予約の取り消し。 */
  schedule(fn: () => void, delayMs: number): () => void;
  log(message: string): void;
}

/**
 * open() での初回読み込みだけが対象。credentials ファイルが無いホストは
 * 珍しくないので、flavor.readError で再ログインを案内するエラーにする。
 * refresh 経路のファイル読み (refreshUnderLock/acquireLockOrAdopt) はこの
 * 変換を通さない。
 */
export async function readInitialTokens<T extends HostOAuthTokens, Req, R>(
  flavor: HostOAuthFlavor<T, Req, R>,
  deps: HostOAuthSourceDeps<Req, R>,
): Promise<T> {
  let text: string;
  try {
    text = await deps.readCredentials();
  } catch (error) {
    throw flavor.readError(error);
  }
  return flavor.parse(text);
}

export class HostOAuthCredentialSource<T extends HostOAuthTokens, Req, R> {
  private tokens: T;
  private cancelScheduled: (() => void) | null = null;
  private closed = false;
  /**
   * refresh には成功したがファイルへの書き戻しに失敗した分。次の
   * refreshUnderLock はまずこれの書き戻しだけをやり直す。
   */
  private pendingWriteBack: R | null = null;
  /** 進行中の refreshNow() があれば、その完了を close() が待てるように保持する。 */
  private inFlightRefresh: Promise<void> | null = null;

  protected constructor(
    private readonly flavor: HostOAuthFlavor<T, Req, R>,
    private readonly deps: HostOAuthSourceDeps<Req, R>,
    tokens: T,
  ) {
    this.tokens = tokens;
  }

  /** 期限前の更新を予約する。open の最後に1回呼ぶ。 */
  protected start(): void {
    this.scheduleBeforeExpiry();
  }

  /**
   * 以後の更新と書き戻しをやめる。ファイルが別のログインのものに置き換わった
   * ときに使う。書き戻し待ちの token は、置き換わった後のファイルへ書くと
   * 新しいログインを壊すので捨てる。
   */
  protected abandon(): void {
    this.closed = true;
    this.cancelScheduled?.();
    this.cancelScheduled = null;
    this.pendingWriteBack = null;
  }

  currentTokens(): T {
    return this.tokens;
  }

  /**
   * 以後の予約を止める。進行中の refresh があれば、呼び出し元が安全に
   * 終了できるようその完了を待ってから返す (refresh 内の失敗は
   * refreshNow が自分で処理済みなので、ここでは投げ直さない)。それでも
   * pendingWriteBack が残っていれば、最後にもう一度だけファイルへの反映を
   * 試みる。メモリ上には既に有効な token があるが、ファイルに残せなければ
   * このプロセスが終了した後は誰もそれを使えない。
   */
  async close(): Promise<void> {
    this.closed = true;
    this.cancelScheduled?.();
    this.cancelScheduled = null;
    if (this.inFlightRefresh !== null) {
      await this.inFlightRefresh;
    }
    if (this.pendingWriteBack !== null) {
      try {
        await this.refreshUnderLock();
      } catch (error) {
        this.deps.log(
          `[nas] could not save the refreshed ${this.flavor.label} OAuth credentials to the host file before closing; run "${this.flavor.loginCommand}" on the host to restore them: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * 更新処理を1回行う。失敗は投げず、やり直しを予約する。既に進行中の
   * refresh があれば新たに始めず、その完了を返す。close() が始まった後は
   * 何もしない (close() 自身の最後の書き戻しは refreshUnderLock を直接
   * 呼ぶので、この early return の影響を受けない)。
   */
  refreshNow(): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    if (this.inFlightRefresh !== null) {
      return this.inFlightRefresh;
    }
    const run = this.runRefreshNow().finally(() => {
      if (this.inFlightRefresh === run) {
        this.inFlightRefresh = null;
      }
    });
    this.inFlightRefresh = run;
    return run;
  }

  private async runRefreshNow(): Promise<void> {
    try {
      await this.refreshUnderLock();
      this.scheduleBeforeExpiry();
    } catch (error) {
      this.deps.log(
        `[nas] ${this.flavor.label} OAuth refresh failed; retrying in ${RETRY_DELAY_MS / 1000}s: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.scheduleIn(RETRY_DELAY_MS);
    }
  }

  private async refreshUnderLock(): Promise<void> {
    const lock = await this.acquireLockOrAdopt();
    if (lock === null) return;
    try {
      // このロックを保持している間の credentials は1回だけ読む。
      const text = await this.deps.readCredentials();
      // 前回 refresh には成功したが書き戻しに失敗した分が残っていれば、
      // 新たな refresh は行わずまずそれをファイルへ反映する。ここで
      // 「他プロセスが既に更新したか」の比較を先にやると、書き戻しに
      // 失敗しただけのファイル上の古い (既に死んだ) token を誤って
      // 採用してしまう。
      if (this.pendingWriteBack !== null) {
        await this.persistPendingWriteBack(text);
        return;
      }
      const onDisk = this.flavor.parse(text);
      if (onDisk.accessToken !== this.tokens.accessToken) {
        this.tokens = onDisk;
        return;
      }
      const refreshed = await this.deps.refresh(
        this.flavor.refreshRequest(onDisk),
      );
      // refresh はここで成功済み。この refresh token は使い切りで、サーバー
      // 側は既に新しいものへ入れ替えている。lock がこの後奪われていても、
      // 奪った側がこの refresh token で有効な token を得ることはあり得ない
      // ので、書き戻せなくても捨てるわけにはいかない。書き戻しより先に
      // メモリ上の tokens をこれへ差し替え、書き戻しは pendingWriteBack
      // として記録して次回以降やり直す。
      this.tokens = this.flavor.merge(onDisk, refreshed);
      this.pendingWriteBack = refreshed;
      if (lock.isCompromised()) {
        this.deps.log(
          `[nas] ${this.flavor.label} OAuth refresh lock was compromised (taken over by another process) during refresh; writing back the newly refreshed tokens anyway`,
        );
      }
      await this.persistPendingWriteBack(text);
    } finally {
      try {
        await lock.release();
      } catch (error) {
        this.deps.log(
          `[nas] failed to release the ${this.flavor.label} OAuth refresh lock: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * pendingWriteBack をファイルへ反映する。失敗しても pendingWriteBack は
   * 保持したままにし、呼び出し元へ投げて通常の失敗経路 (30秒後の再試行) に
   * 委ねる。
   */
  private async persistPendingWriteBack(text: string): Promise<void> {
    const pending = this.pendingWriteBack;
    if (pending === null) return;
    try {
      const next = this.flavor.apply(text, pending);
      await this.deps.writeCredentials(next);
      // 実際に書き込んだ内容からメモリ上の tokens を作り直し、ファイルと
      // 食い違わないようにする。
      this.tokens = this.flavor.parse(next);
      this.pendingWriteBack = null;
    } catch (error) {
      this.deps.log(
        `[nas] failed to write back refreshed ${this.flavor.label} OAuth tokens; already serving them from memory and will retry the write: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * ロックを取る。取れない間は読み直し、他のプロセスが更新を終えていれば
   * その値を採用して null を返す。ただし pendingWriteBack がある間は、この
   * 適応を行わない: ファイル上の token はまさにこれから上書きしようとして
   * いる、既に死んだ古い token であり、メモリ上の (既に refresh 済みの)
   * tokens より「新しい」わけではない。ここで比較すると死んだ token へ
   * 逆戻りしてしまうので、この場合は普通にロックの取り直しだけを行う。
   */
  private async acquireLockOrAdopt(): Promise<HeldLock | null> {
    for (let attempt = 1; attempt <= LOCK_ATTEMPTS; attempt++) {
      try {
        return await this.deps.acquireLock();
      } catch (error) {
        if (!(error instanceof LockContendedError)) throw error;
        if (this.pendingWriteBack === null) {
          const onDisk = this.flavor.parse(await this.deps.readCredentials());
          if (onDisk.accessToken !== this.tokens.accessToken) {
            this.tokens = onDisk;
            return null;
          }
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
      Math.max(
        0,
        this.tokens.expiresAt - this.flavor.refreshLeadMs - this.deps.now(),
      ),
    );
  }

  private scheduleIn(delayMs: number): void {
    if (this.closed) return;
    this.cancelScheduled?.();
    const cappedDelayMs = Math.min(Math.max(0, delayMs), MAX_TIMER_DELAY_MS);
    this.cancelScheduled = this.deps.schedule(() => {
      this.onScheduledFire();
    }, cappedDelayMs);
  }

  /**
   * 予約が発火した際の入口。MAX_TIMER_DELAY_MS で切り詰めた予約は、期限の
   * refreshLeadMs 前より早く発火しうるので、その場合は更新せず予約を延長する
   * だけにする。書き戻し待ちがある場合は期限に関わらず必ず進める。
   */
  private onScheduledFire(): void {
    if (
      this.pendingWriteBack === null &&
      this.deps.now() < this.tokens.expiresAt - this.flavor.refreshLeadMs
    ) {
      this.scheduleBeforeExpiry();
      return;
    }
    void this.refreshNow();
  }
}
```

- [ ] **Step 3: `src/network/claude_oauth_source.ts` を Claude 固有の部分だけにする**

`readCredentialsForOpen`、`ClaudeOAuthCredentialSource` の本体、`REFRESH_LEAD_MS`・`RETRY_DELAY_MS`・`LOCK_ATTEMPTS`・`MAX_TIMER_DELAY_MS` を削除し、`ClaudeOAuthSourceDeps` から `ClaudeOAuthCredentialSource` までを次にする。`replaceFileAtomically` 以下の live deps と `parseRefreshResponse` は変えない。import から使わなくなったもの（`LockContendedError`、`HeldLock`、`applyRefreshedTokens` 以外で使わなくなったもの）を消し、`host_oauth_source.ts` の import を足す。

```ts
export interface AgentCredentialSource {
  /** 上流へ送る access token。同期的に返す。 */
  current(): string;
  /** 進行中の refresh があれば、それの完了を待ってから返す。 */
  close(): Promise<void>;
}

export interface ClaudeRefreshRequest {
  readonly refreshToken: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
}

export type ClaudeOAuthSourceDeps = HostOAuthSourceDeps<
  ClaudeRefreshRequest,
  RefreshedClaudeTokens
>;

const CLAUDE_FLAVOR: HostOAuthFlavor<
  ClaudeOAuthTokens,
  ClaudeRefreshRequest,
  RefreshedClaudeTokens
> = {
  label: "Claude",
  loginCommand: "claude /login",
  refreshLeadMs: 5 * 60_000,
  parse: parseClaudeOAuthTokens,
  readError: claudeCredentialsReadError,
  refreshRequest: (tokens) => ({
    refreshToken: tokens.refreshToken,
    clientId: tokens.clientId ?? CLAUDE_CODE_CLIENT_ID,
    scopes: tokens.scopes,
  }),
  merge: (tokens, refreshed) => ({
    ...tokens,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt: refreshed.expiresAt,
  }),
  apply: applyRefreshedTokens,
};

export class ClaudeOAuthCredentialSource
  extends HostOAuthCredentialSource<
    ClaudeOAuthTokens,
    ClaudeRefreshRequest,
    RefreshedClaudeTokens
  >
  implements AgentCredentialSource
{
  static async open(
    deps: ClaudeOAuthSourceDeps,
  ): Promise<ClaudeOAuthCredentialSource> {
    const tokens = await readInitialTokens(CLAUDE_FLAVOR, deps);
    const source = new ClaudeOAuthCredentialSource(CLAUDE_FLAVOR, deps, tokens);
    source.start();
    return source;
  }

  current(): string {
    return this.currentTokens().accessToken;
  }
}
```

ファイル先頭の doc comment は「Claude の OAuth credential の形式と、ホストの Claude Code と同じロック・書き戻しで更新する live deps を定義する。更新の流れは host_oauth_source.ts にある」という内容に書き換える。

- [ ] **Step 4: 既存の test が変更なしで通ることを確認する**

Run: `bun test src/network/claude_oauth_source_test.ts && bun run check`
Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add src/network/host_oauth_source.ts src/network/claude_oauth_source.ts
git commit -m "refactor(network): extract the host OAuth refresh loop from the Claude source"
```

---

### Task 4: Codex の credential source

**Files:**
- Create: `src/network/codex_oauth_source.ts`
- Create: `src/network/codex_oauth_source_test.ts`
- Modify: `src/lib/oauth_refresh_lock.ts`
- Modify: `src/lib/oauth_refresh_lock_test.ts`

**Interfaces:**
- Consumes: Task 2 の `parseCodexOAuthTokens`・`mergeRefreshedCodexTokens`・`applyRefreshedCodexTokens`・`codexCredentialsReadError`・`RefreshedCodexTokens`・`CodexOAuthTokens`。Task 3 の `HostOAuthCredentialSource`・`HostOAuthFlavor`・`HostOAuthSourceDeps`・`readInitialTokens`。
- Produces:
  - `acquireCodexRefreshLock(codexDir: string, stateHome: string, options?: AcquireDirLockOptions): Promise<HeldLock>`（`src/lib/oauth_refresh_lock.ts`）
  - `CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token"`、`CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"`
  - `interface CodexRefreshRequest { readonly refreshToken: string; readonly clientId: string }`
  - `type CodexOAuthSourceDeps = HostOAuthSourceDeps<CodexRefreshRequest, RefreshedCodexTokens>`
  - `interface CodexCredential { readonly accessToken: string; readonly accountId: string | null }`
  - `class CodexOAuthCredentialSource`: `static open(deps): Promise<CodexOAuthCredentialSource>`、`current(): CodexCredential | null`、`revoke(): void`、`refreshNow()`、`close()`
  - `overwriteFileInPlace(file: string, text: string): Promise<void>`
  - `parseCodexRefreshResponse(body: unknown, now?: number): RefreshedCodexTokens`
  - `resolveNasStateHome(hostHome: string, env?: Record<string, string | undefined>): string`
  - `liveCodexOAuthSourceDeps(hostHome: string, stateHome: string): CodexOAuthSourceDeps`

- [ ] **Step 1: ロックの test を書く**

`src/lib/oauth_refresh_lock_test.ts` に足す（既存の import に `acquireCodexRefreshLock` を足す）。

```ts
test("acquireCodexRefreshLock: keeps the lock under the state home, keyed by the Codex dir", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nas-codex-lock-"));
  try {
    const codexDir = path.join(root, "home", ".codex");
    const stateHome = path.join(root, "state");
    await mkdir(codexDir, { recursive: true });
    const lock = await acquireCodexRefreshLock(codexDir, stateHome);
    try {
      const entries = await readdir(path.join(stateHome, "nas", "locks"));
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatch(/^codex-oauth-[0-9a-f]{16}\.lock$/);
      expect(await readdir(codexDir)).toEqual([]);
      await expect(
        acquireCodexRefreshLock(codexDir, stateHome),
      ).rejects.toBeInstanceOf(LockContendedError);
    } finally {
      await lock.release();
    }
    expect(await readdir(path.join(stateHome, "nas", "locks"))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

`mkdtemp`・`mkdir`・`readdir`・`rm`・`tmpdir`・`path` が import されていなければ足す。

Run: `bun test src/lib/oauth_refresh_lock_test.ts`
Expected: FAIL（`acquireCodexRefreshLock` が無い）

- [ ] **Step 2: ロックを実装する**

`src/lib/oauth_refresh_lock.ts` の import に `createHash`（`node:crypto`）を足し、ファイルの末尾に足す。

```ts
/**
 * Codex の OAuth 更新を、nas のセッションどうしで排他するロック。
 *
 * Codex 自身はファイルのロックを使わない (同じプロセスの中でだけ排他する)
 * ので、ホストの Codex とは共有できない。ロックは container から read-write
 * で見える `~/.codex` には置かない。container がロックを握ったまま離さない
 * ことで、ホストの更新を止められてしまうためである。
 */
export async function acquireCodexRefreshLock(
  codexDir: string,
  stateHome: string,
  options: AcquireDirLockOptions = {},
): Promise<HeldLock> {
  const resolved = await realpath(codexDir).catch(() => codexDir);
  const key = createHash("sha256").update(resolved).digest("hex").slice(0, 16);
  const locksDir = path.join(stateHome, "nas", "locks");
  await mkdir(locksDir, { recursive: true, mode: 0o700 });
  return acquireDirLock(
    path.join(locksDir, `codex-oauth-${key}.lock`),
    options,
  );
}
```

Run: `bun test src/lib/oauth_refresh_lock_test.ts`
Expected: PASS

- [ ] **Step 3: source の test を書く**

`src/network/codex_oauth_source_test.ts` を作る。

```ts
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { LockContendedError } from "../lib/oauth_refresh_lock.ts";
import {
  CODEX_CLIENT_ID,
  CodexOAuthCredentialSource,
  type CodexOAuthSourceDeps,
  type CodexRefreshRequest,
  overwriteFileInPlace,
  parseCodexRefreshResponse,
  resolveNasStateHome,
} from "./codex_oauth_source.ts";

const MIN = 60_000;

function jwt(payload: Record<string, unknown>): string {
  const b64 = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(payload)}.sig`;
}

function access(name: string, expSeconds: number, clientId?: string): string {
  return jwt({
    exp: expSeconds,
    name,
    ...(clientId ? { client_id: clientId } : {}),
  });
}

function authFile(accessToken: string, refreshToken: string): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: jwt({}),
      access_token: accessToken,
      refresh_token: refreshToken,
      account_id: "acct-1",
    },
    last_refresh: "2026-09-01T00:00:00.000Z",
  });
}

interface FakeState {
  file: string;
  now: number;
  refreshes: CodexRefreshRequest[];
  scheduled: { fn: () => void; delayMs: number }[];
  lockFailures: number;
  warnings: string[];
  nextAccess: string;
}

function fakeDeps(state: FakeState): CodexOAuthSourceDeps {
  return {
    readCredentials: async () => state.file,
    writeCredentials: async (text) => {
      state.file = text;
    },
    acquireLock: async () => {
      if (state.lockFailures > 0) {
        state.lockFailures--;
        throw new LockContendedError("/lock");
      }
      return { release: async () => {}, isCompromised: () => false };
    },
    refresh: async (request) => {
      state.refreshes.push(request);
      return {
        accessToken: state.nextAccess,
        refreshToken: "refresh-2",
        refreshedAt: state.now,
      };
    },
    now: () => state.now,
    sleep: async () => {},
    schedule: (fn, delayMs) => {
      const entry = { fn, delayMs };
      state.scheduled.push(entry);
      return () => {
        state.scheduled = state.scheduled.filter((e) => e !== entry);
      };
    },
    log: (message) => {
      state.warnings.push(message);
    },
  };
}

function initialState(nowMs: number, expSeconds: number): FakeState {
  return {
    file: authFile(access("a1", expSeconds), "refresh-1"),
    now: nowMs,
    refreshes: [],
    scheduled: [],
    lockFailures: 0,
    warnings: [],
    nextAccess: access("a2", expSeconds + 3600),
  };
}

test("CodexOAuthCredentialSource: serves the host token and account id", async () => {
  const state = initialState(0, 10_000);
  const source = await CodexOAuthCredentialSource.open(fakeDeps(state));
  expect(source.current()).toEqual({
    accessToken: access("a1", 10_000),
    accountId: "acct-1",
  });
  await source.close();
});

test("CodexOAuthCredentialSource: schedules the refresh 2 minutes before expiry", async () => {
  const state = initialState(0, 10_000);
  const source = await CodexOAuthCredentialSource.open(fakeDeps(state));
  expect(state.scheduled.map((e) => e.delayMs)).toEqual([
    10_000_000 - 2 * MIN,
  ]);
  await source.close();
});

test("CodexOAuthCredentialSource: refreshes with the default client id and writes back", async () => {
  const state = initialState(0, 10_000);
  const source = await CodexOAuthCredentialSource.open(fakeDeps(state));
  await source.refreshNow();
  expect(state.refreshes).toEqual([
    { refreshToken: "refresh-1", clientId: CODEX_CLIENT_ID },
  ]);
  expect(source.current()?.accessToken).toBe(state.nextAccess);
  const written = JSON.parse(state.file);
  expect(written.tokens.access_token).toBe(state.nextAccess);
  expect(written.tokens.refresh_token).toBe("refresh-2");
  expect(written.tokens.account_id).toBe("acct-1");
  await source.close();
});

test("CodexOAuthCredentialSource: uses the client id from the access token", async () => {
  const state = initialState(0, 10_000);
  state.file = authFile(access("a1", 10_000, "app_custom"), "refresh-1");
  const source = await CodexOAuthCredentialSource.open(fakeDeps(state));
  await source.refreshNow();
  expect(state.refreshes[0]?.clientId).toBe("app_custom");
  await source.close();
});

test("CodexOAuthCredentialSource: adopts a token the host Codex already refreshed", async () => {
  const state = initialState(0, 10_000);
  const source = await CodexOAuthCredentialSource.open(fakeDeps(state));
  const hostRefreshed = access("host", 20_000);
  state.file = authFile(hostRefreshed, "refresh-host");
  await source.refreshNow();
  expect(state.refreshes).toEqual([]);
  expect(source.current()?.accessToken).toBe(hostRefreshed);
  await source.close();
});

test("CodexOAuthCredentialSource: revoke stops serving and refreshing", async () => {
  const state = initialState(0, 10_000);
  const source = await CodexOAuthCredentialSource.open(fakeDeps(state));
  source.revoke();
  expect(source.current()).toBeNull();
  expect(state.scheduled).toEqual([]);
  await source.refreshNow();
  expect(state.refreshes).toEqual([]);
  await source.close();
});

test("parseCodexRefreshResponse: requires an access token and keeps optional tokens", () => {
  expect(
    parseCodexRefreshResponse(
      { access_token: "a", refresh_token: "r", id_token: "i" },
      5,
    ),
  ).toEqual({ accessToken: "a", refreshToken: "r", idToken: "i", refreshedAt: 5 });
  expect(parseCodexRefreshResponse({ access_token: "a" }, 5)).toEqual({
    accessToken: "a",
    refreshedAt: 5,
  });
  expect(() => parseCodexRefreshResponse({}, 5)).toThrow();
});

test("overwriteFileInPlace: keeps the inode and refuses to create a file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-codex-write-"));
  try {
    const file = path.join(dir, "auth.json");
    await writeFile(file, "old content that is longer", { mode: 0o600 });
    const before = await stat(file);
    await overwriteFileInPlace(file, "new");
    const after = await stat(file);
    expect(after.ino).toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).toBe("new");
    await expect(
      overwriteFileInPlace(path.join(dir, "missing.json"), "x"),
    ).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveNasStateHome: prefers XDG_STATE_HOME", () => {
  expect(resolveNasStateHome("/home/u", { XDG_STATE_HOME: "/state" })).toBe(
    "/state",
  );
  expect(resolveNasStateHome("/home/u", {})).toBe("/home/u/.local/state");
});
```

Run: `bun test src/network/codex_oauth_source_test.ts`
Expected: FAIL（モジュールが無い）

- [ ] **Step 4: `src/network/codex_oauth_source.ts` を作る**

```ts
/**
 * ホスト側で Codex の ChatGPT OAuth credential を保持し、期限前に更新する。
 *
 * 更新の流れは host_oauth_source.ts にある。ここには Codex の形式と、
 * ホストの `~/.codex/auth.json` を読み書きする live deps を置く。
 *
 * 書き戻しは rename せず、同じファイルへの上書きで行う。container には
 * ダミーの auth.json をホストの auth.json の上に bind mount しているので、
 * rename で inode が変わるとその mount が外れ、container から本物が見える。
 * ホストの Codex 自身も同じファイルへの上書きで保存している。
 */

import { open as openFile, readFile } from "node:fs/promises";
import * as path from "node:path";
import {
  applyRefreshedCodexTokens,
  type CodexOAuthTokens,
  codexCredentialsReadError,
  mergeRefreshedCodexTokens,
  parseCodexOAuthTokens,
  type RefreshedCodexTokens,
} from "../agents/codex_oauth.ts";
import { acquireCodexRefreshLock } from "../lib/oauth_refresh_lock.ts";
import { logWarn } from "../log.ts";
import {
  HostOAuthCredentialSource,
  type HostOAuthFlavor,
  type HostOAuthSourceDeps,
  readInitialTokens,
} from "./host_oauth_source.ts";

export const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
// Codex CLI の OAuth client id。ホストの access token の client_id claim が
// あればそちらを使う。
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const REFRESH_TIMEOUT_MS = 30_000;

export interface CodexRefreshRequest {
  readonly refreshToken: string;
  readonly clientId: string;
}

export type CodexOAuthSourceDeps = HostOAuthSourceDeps<
  CodexRefreshRequest,
  RefreshedCodexTokens
>;

/** broker が注入に使う値。 */
export interface CodexCredential {
  readonly accessToken: string;
  readonly accountId: string | null;
}

const CODEX_FLAVOR: HostOAuthFlavor<
  CodexOAuthTokens,
  CodexRefreshRequest,
  RefreshedCodexTokens
> = {
  label: "Codex",
  loginCommand: "codex login",
  // ホストの Codex は期限の5分前に更新する。それより遅らせることで、ホストの
  // Codex が動いていれば先に更新し、こちらは読み直してその値を採用する。
  // refresh token は使うたびに入れ替わり、ホストの Codex とはロックを共有
  // できないので、同時に更新すると片方が失敗する。
  refreshLeadMs: 2 * 60_000,
  parse: parseCodexOAuthTokens,
  readError: codexCredentialsReadError,
  refreshRequest: (tokens) => ({
    refreshToken: tokens.refreshToken,
    clientId: tokens.clientId ?? CODEX_CLIENT_ID,
  }),
  merge: mergeRefreshedCodexTokens,
  apply: applyRefreshedCodexTokens,
};

export class CodexOAuthCredentialSource extends HostOAuthCredentialSource<
  CodexOAuthTokens,
  CodexRefreshRequest,
  RefreshedCodexTokens
> {
  private revoked = false;

  static async open(
    deps: CodexOAuthSourceDeps,
  ): Promise<CodexOAuthCredentialSource> {
    const tokens = await readInitialTokens(CODEX_FLAVOR, deps);
    const source = new CodexOAuthCredentialSource(CODEX_FLAVOR, deps, tokens);
    source.start();
    return source;
  }

  /** 注入に使う credential。revoke の後は null。 */
  current(): CodexCredential | null {
    if (this.revoked) return null;
    const tokens = this.currentTokens();
    return { accessToken: tokens.accessToken, accountId: tokens.accountId };
  }

  /**
   * ホストの auth.json が消えるか置き換わったときに呼ぶ。以後は注入せず、
   * 更新も書き戻しもしない。置き換わった後のファイルは別のログインのもので
   * ありうる。
   */
  revoke(): void {
    this.revoked = true;
    this.abandon();
  }
}

// ---------------------------------------------------------------------------
// Live deps: 各メソッドは I/O を1つだけ行う。
// ---------------------------------------------------------------------------

/**
 * 同じ inode のまま内容を置き換える。ファイルが無ければ作らずに失敗する。
 * 書いている途中に読んだプロセスは書きかけの内容を見うるが、ホストの Codex
 * 自身も同じ方法で保存しているので、読み手の状況は変わらない。
 */
export async function overwriteFileInPlace(
  file: string,
  text: string,
): Promise<void> {
  const handle = await openFile(file, "r+");
  try {
    await handle.truncate(0);
    await handle.write(text, 0, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** nas がホスト側の状態を置くディレクトリの親 (XDG_STATE_HOME)。 */
export function resolveNasStateHome(
  hostHome: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const xdg = env.XDG_STATE_HOME;
  return xdg !== undefined && xdg !== ""
    ? xdg
    : path.join(hostHome, ".local", "state");
}

export function liveCodexOAuthSourceDeps(
  hostHome: string,
  stateHome: string,
): CodexOAuthSourceDeps {
  const codexDir = path.join(hostHome, ".codex");
  const authPath = path.join(codexDir, "auth.json");
  return {
    readCredentials: () => readFile(authPath, "utf8"),
    writeCredentials: (text) => overwriteFileInPlace(authPath, text),
    acquireLock: () => acquireCodexRefreshLock(codexDir, stateHome),
    refresh: postCodexTokenRefresh,
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

async function postCodexTokenRefresh(
  request: CodexRefreshRequest,
): Promise<RefreshedCodexTokens> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REFRESH_TIMEOUT_MS);
  try {
    const res = await fetch(CODEX_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: request.clientId,
        grant_type: "refresh_token",
        refresh_token: request.refreshToken,
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      throw new Error(`token endpoint returned HTTP ${res.status}`);
    }
    return parseCodexRefreshResponse(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

/** @internal Exported only for the colocated test file. */
export function parseCodexRefreshResponse(
  body: unknown,
  now: number = Date.now(),
): RefreshedCodexTokens {
  const data = (body ?? {}) as Record<string, unknown>;
  if (typeof data.access_token !== "string" || data.access_token === "") {
    throw new Error("token endpoint returned an unexpected body");
  }
  return {
    accessToken: data.access_token,
    ...(typeof data.refresh_token === "string" && data.refresh_token !== ""
      ? { refreshToken: data.refresh_token }
      : {}),
    ...(typeof data.id_token === "string" && data.id_token !== ""
      ? { idToken: data.id_token }
      : {}),
    refreshedAt: now,
  };
}
```

- [ ] **Step 5: test が通ることを確認する**

Run: `bun test src/network/codex_oauth_source_test.ts src/network/claude_oauth_source_test.ts && bun run check`
Expected: PASS

- [ ] **Step 6: コミットする**

```bash
git add src/network/codex_oauth_source.ts src/network/codex_oauth_source_test.ts src/lib/oauth_refresh_lock.ts src/lib/oauth_refresh_lock_test.ts
git commit -m "feat(network): keep and refresh the host Codex OAuth credential"
```

---

### Task 5: ホストの `auth.json` の置き換えの検知

**Files:**
- Create: `src/network/codex_auth_watch.ts`
- Create: `src/network/codex_auth_watch_test.ts`

**Interfaces:**
- Consumes: Task 2 の `CodexOAuthUnavailableError`
- Produces:
  - `interface FileIdentity { readonly dev: number; readonly ino: number }`
  - `interface CodexAuthWatchDeps { identify(): Promise<FileIdentity | null>; watch(onEvent: () => void): () => void; schedule(fn: () => void, delayMs: number): () => void }`
  - `CODEX_AUTH_CHECK_INTERVAL_MS = 5_000`
  - `watchCodexAuthFile(deps: CodexAuthWatchDeps, onReplaced: () => void): Promise<() => void>`（戻り値は監視の停止）
  - `liveCodexAuthWatchDeps(hostHome: string): CodexAuthWatchDeps`

- [ ] **Step 1: test を書く**

`src/network/codex_auth_watch_test.ts` を作る。

```ts
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { CodexOAuthUnavailableError } from "../agents/codex_oauth.ts";
import {
  CODEX_AUTH_CHECK_INTERVAL_MS,
  type CodexAuthWatchDeps,
  type FileIdentity,
  liveCodexAuthWatchDeps,
  watchCodexAuthFile,
} from "./codex_auth_watch.ts";

interface Fake {
  identity: FileIdentity | null;
  onEvent: (() => void) | null;
  scheduled: { fn: () => void; delayMs: number }[];
  unwatched: boolean;
}

function fakeDeps(fake: Fake): CodexAuthWatchDeps {
  return {
    identify: async () => fake.identity,
    watch: (onEvent) => {
      fake.onEvent = onEvent;
      return () => {
        fake.unwatched = true;
      };
    },
    schedule: (fn, delayMs) => {
      const entry = { fn, delayMs };
      fake.scheduled.push(entry);
      return () => {
        fake.scheduled = fake.scheduled.filter((e) => e !== entry);
      };
    },
  };
}

function newFake(): Fake {
  return {
    identity: { dev: 1, ino: 10 },
    onEvent: null,
    scheduled: [],
    unwatched: false,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

test("watchCodexAuthFile: fails when the file is missing at start", async () => {
  const fake = newFake();
  fake.identity = null;
  await expect(watchCodexAuthFile(fakeDeps(fake), () => {})).rejects.toBeInstanceOf(
    CodexOAuthUnavailableError,
  );
});

test("watchCodexAuthFile: an in-place write does not fire", async () => {
  const fake = newFake();
  let fired = 0;
  const stop = await watchCodexAuthFile(fakeDeps(fake), () => fired++);
  fake.onEvent?.();
  await flush();
  expect(fired).toBe(0);
  expect(fake.scheduled.map((e) => e.delayMs)).toEqual([
    CODEX_AUTH_CHECK_INTERVAL_MS,
  ]);
  stop();
  expect(fake.unwatched).toBe(true);
  expect(fake.scheduled).toEqual([]);
});

test("watchCodexAuthFile: removal fires once and stops watching", async () => {
  const fake = newFake();
  let fired = 0;
  await watchCodexAuthFile(fakeDeps(fake), () => fired++);
  fake.identity = null;
  fake.onEvent?.();
  fake.onEvent?.();
  await flush();
  expect(fired).toBe(1);
  expect(fake.unwatched).toBe(true);
  expect(fake.scheduled).toEqual([]);
});

test("watchCodexAuthFile: a replaced inode found by the periodic check fires", async () => {
  const fake = newFake();
  let fired = 0;
  await watchCodexAuthFile(fakeDeps(fake), () => fired++);
  fake.identity = { dev: 1, ino: 11 };
  fake.scheduled[0]?.fn();
  await flush();
  expect(fired).toBe(1);
});

test("watchCodexAuthFile: the periodic check reschedules itself", async () => {
  const fake = newFake();
  const stop = await watchCodexAuthFile(fakeDeps(fake), () => {});
  const first = fake.scheduled[0];
  fake.scheduled = [];
  first?.fn();
  await flush();
  expect(fake.scheduled.map((e) => e.delayMs)).toEqual([
    CODEX_AUTH_CHECK_INTERVAL_MS,
  ]);
  stop();
});

test("liveCodexAuthWatchDeps: distinguishes rename from an in-place write", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "nas-codex-watch-"));
  try {
    const dir = path.join(home, ".codex");
    await mkdir(dir);
    const file = path.join(dir, "auth.json");
    await writeFile(file, "a");
    const deps = liveCodexAuthWatchDeps(home);
    const before = await deps.identify();
    await writeFile(file, "b");
    expect(await deps.identify()).toEqual(before);
    await writeFile(path.join(dir, "auth.json.tmp"), "c");
    await rename(path.join(dir, "auth.json.tmp"), file);
    expect(await deps.identify()).not.toEqual(before);
    await rm(file);
    expect(await deps.identify()).toBeNull();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
```

Run: `bun test src/network/codex_auth_watch_test.ts`
Expected: FAIL（モジュールが無い）

- [ ] **Step 2: `src/network/codex_auth_watch.ts` を作る**

```ts
/**
 * ホストの `~/.codex/auth.json` が消えるか別のファイルに置き換わったことを
 * 検知する。
 *
 * container にはダミーの auth.json をホストの auth.json の上に bind mount
 * している。Linux では、別の mount namespace で mount point になっている
 * ファイルを unlink や rename で置き換えると、その mount が外れる。外れた後に
 * ホストで本物が書かれると、read-write で mount したホストの `~/.codex` を
 * 通して container から読める。ホストの Codex の保存は同じファイルへの上書き
 * なので inode は変わらない。変わるのは `codex logout` と、rename で置き換える
 * 別のツールである。
 *
 * fs.watch はイベントを取りこぼしうるので、一定間隔でも確かめる。
 */

import { watch as watchDir } from "node:fs";
import { stat } from "node:fs/promises";
import * as path from "node:path";
import { CodexOAuthUnavailableError } from "../agents/codex_oauth.ts";

export const CODEX_AUTH_CHECK_INTERVAL_MS = 5_000;

export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface CodexAuthWatchDeps {
  /** auth.json の device と inode。無ければ null。 */
  identify(): Promise<FileIdentity | null>;
  /** auth.json に関わるかもしれないイベントのたびに onEvent を呼ぶ。戻り値は停止。 */
  watch(onEvent: () => void): () => void;
  /** 戻り値は予約の取り消し。 */
  schedule(fn: () => void, delayMs: number): () => void;
}

/**
 * 監視を始め、置き換わったら onReplaced を1回だけ呼んで監視をやめる。
 * 戻り値は監視の停止。開始時にファイルが無ければ失敗する。
 */
export async function watchCodexAuthFile(
  deps: CodexAuthWatchDeps,
  onReplaced: () => void,
): Promise<() => void> {
  const initial = await deps.identify();
  if (initial === null) {
    throw new CodexOAuthUnavailableError("no auth.json");
  }
  let done = false;
  let cancelTimer: () => void = () => {};
  let unwatch: () => void = () => {};

  function stop(): void {
    done = true;
    cancelTimer();
    unwatch();
  }

  async function check(): Promise<void> {
    if (done) return;
    // 読めないときも、置き換わったものとして扱う (安全側)。
    const current = await deps.identify().catch(() => null);
    if (done) return;
    if (
      current === null ||
      current.dev !== initial.dev ||
      current.ino !== initial.ino
    ) {
      stop();
      onReplaced();
    }
  }

  function tick(): void {
    void check().finally(() => {
      if (!done) {
        cancelTimer = deps.schedule(tick, CODEX_AUTH_CHECK_INTERVAL_MS);
      }
    });
  }

  unwatch = deps.watch(() => {
    void check();
  });
  cancelTimer = deps.schedule(tick, CODEX_AUTH_CHECK_INTERVAL_MS);
  return stop;
}

export function liveCodexAuthWatchDeps(hostHome: string): CodexAuthWatchDeps {
  const codexDir = path.join(hostHome, ".codex");
  const authPath = path.join(codexDir, "auth.json");
  return {
    identify: async () => {
      try {
        const info = await stat(authPath);
        return { dev: info.dev, ino: info.ino };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return null;
        throw error;
      }
    },
    watch: (onEvent) => {
      try {
        const watcher = watchDir(codexDir, (_event, filename) => {
          if (filename === null || filename === "auth.json") onEvent();
        });
        // 監視できなくなっても、一定間隔の確認が続く。
        watcher.on("error", () => {});
        watcher.unref?.();
        return () => watcher.close();
      } catch {
        return () => {};
      }
    },
    schedule: (fn, delayMs) => {
      const timer = setTimeout(fn, delayMs);
      timer.unref?.();
      return () => clearTimeout(timer);
    },
  };
}
```

- [ ] **Step 3: test が通ることを確認する**

Run: `bun test src/network/codex_auth_watch_test.ts && bun run check`
Expected: PASS

- [ ] **Step 4: コミットする**

```bash
git add src/network/codex_auth_watch.ts src/network/codex_auth_watch_test.ts
git commit -m "feat(network): detect the host Codex auth.json being removed or replaced"
```

---

### Task 6: broker が複数のエージェントの credential を使い分ける

**Files:**
- Modify: `src/network/agent_credential.ts`
- Modify: `src/network/agent_credential_test.ts`
- Modify: `src/network/broker.ts`（`agentCredential` の option・field・評価前の deny・`decorateAllow`）
- Modify: `src/network/broker_integration_test.ts`（`agentCredential:` の6か所と新しい test）

**Interfaces:**
- Consumes: Task 4 の `CodexCredential` の形（`{ accessToken: string; accountId: string | null } | null`）。型は import せず構造で受ける。
- Produces（`src/network/agent_credential.ts`）:
  - `CREDENTIAL_REFRESH_DENY_REASON = "credential-refresh-owned-by-host"`（既存）
  - `CREDENTIAL_REVOKED_DENY_REASON = "credential-revoked-on-host"`
  - `interface AgentCredential { readonly injectHosts: readonly string[]; readonly removeHeaders: readonly string[]; isHostOwnedRefresh(host: string, method: string, path: string | undefined): boolean; headers(): readonly InjectHeader[] | null; close(): Promise<void> }`
  - `claudeAgentCredential(source: { current(): string; close(): Promise<void> }): AgentCredential`
  - `codexAgentCredential(source: { current(): { accessToken: string; accountId: string | null } | null; close(): Promise<void> }): AgentCredential`
  - `isHostOwnedCredentialRefresh(credentials: readonly AgentCredential[], host: string, method: string, path: string | undefined): boolean`
  - `isRevokedCredentialHost(credentials: readonly AgentCredential[], host: string): boolean`
  - `applyAgentCredentials(decision: DecisionResponse, host: string, credentials: readonly AgentCredential[]): DecisionResponse`
  - `SessionBroker` の option: `agentCredentials?: readonly AgentCredential[]`（`agentCredential` は削除）

- [ ] **Step 1: `agent_credential_test.ts` を書き換える**

ファイルの全体を次にする。

```ts
import { expect, test } from "bun:test";
import {
  type AgentCredential,
  applyAgentCredentials,
  claudeAgentCredential,
  codexAgentCredential,
  isHostOwnedCredentialRefresh,
  isRevokedCredentialHost,
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

const claude = claudeAgentCredential({
  current: () => "tok",
  close: async () => {},
});

function codex(
  current: { accessToken: string; accountId: string | null } | null = {
    accessToken: "ctok",
    accountId: "acct-1",
  },
): AgentCredential {
  return codexAgentCredential({ current: () => current, close: async () => {} });
}

test("applyAgentCredentials: injects the bearer token and removes x-api-key for Anthropic hosts", () => {
  for (const host of ["api.anthropic.com", "mcp-proxy.anthropic.com"]) {
    expect(applyAgentCredentials(allow(), host, [claude])).toEqual(
      allow({
        injectHeaders: [{ name: "Authorization", value: "Bearer tok" }],
        removeHeaders: ["x-api-key"],
      }),
    );
  }
});

test("applyAgentCredentials: replaces a user-configured Authorization inject of any case", () => {
  const result = applyAgentCredentials(
    allow({
      injectHeaders: [
        { name: "authorization", value: "user" },
        { name: "x-extra", value: "kept" },
      ],
    }),
    "api.anthropic.com",
    [claude],
  );
  expect(result.injectHeaders).toEqual([
    { name: "x-extra", value: "kept" },
    { name: "Authorization", value: "Bearer tok" },
  ]);
});

test("applyAgentCredentials: injects the Codex token and account id on chatgpt.com", () => {
  const result = applyAgentCredentials(
    allow({ injectHeaders: [{ name: "ChatGPT-Account-Id", value: "other" }] }),
    "chatgpt.com",
    [claude, codex()],
  );
  expect(result.injectHeaders).toEqual([
    { name: "Authorization", value: "Bearer ctok" },
    { name: "chatgpt-account-id", value: "acct-1" },
  ]);
  expect(result.removeHeaders).toBeUndefined();
});

test("applyAgentCredentials: omits the account header when the account is unknown", () => {
  const result = applyAgentCredentials(allow(), "chatgpt.com", [
    codex({ accessToken: "ctok", accountId: null }),
  ]);
  expect(result.injectHeaders).toEqual([
    { name: "Authorization", value: "Bearer ctok" },
  ]);
});

test("applyAgentCredentials: leaves other hosts and denials unchanged", () => {
  expect(applyAgentCredentials(allow(), "example.com", [claude, codex()])).toEqual(
    allow(),
  );
  const deny: DecisionResponse = { ...allow(), decision: "deny" };
  expect(applyAgentCredentials(deny, "chatgpt.com", [codex()])).toEqual(deny);
});

test("isHostOwnedCredentialRefresh: matches each agent's token endpoint", () => {
  const creds = [claude, codex()];
  expect(
    isHostOwnedCredentialRefresh(creds, "platform.claude.com", "POST", "/v1/oauth/token?x=1"),
  ).toBe(true);
  expect(
    isHostOwnedCredentialRefresh(creds, "auth.openai.com", "post", "/oauth/token"),
  ).toBe(true);
  expect(
    isHostOwnedCredentialRefresh(creds, "auth.openai.com", "GET", "/oauth/token"),
  ).toBe(false);
  expect(
    isHostOwnedCredentialRefresh([claude], "auth.openai.com", "POST", "/oauth/token"),
  ).toBe(false);
  expect(
    isHostOwnedCredentialRefresh(creds, "auth.openai.com", "POST", undefined),
  ).toBe(false);
});

test("isRevokedCredentialHost: only the revoked agent's hosts", () => {
  const creds = [claude, codex(null)];
  expect(isRevokedCredentialHost(creds, "chatgpt.com")).toBe(true);
  expect(isRevokedCredentialHost(creds, "api.anthropic.com")).toBe(false);
  expect(isRevokedCredentialHost(creds, "example.com")).toBe(false);
});
```

Run: `bun test src/network/agent_credential_test.ts`
Expected: FAIL

- [ ] **Step 2: `src/network/agent_credential.ts` を書き換える**

ファイルの全体を次にする。

```ts
/**
 * 許可した request に、ホストが保持するエージェントの credential を注入する。
 *
 * エージェントが付けた credential を上流へ届けないために、注入先のホストでは
 * 認証の header を必ずホストの値で上書きし、エージェントごとに決めた header
 * を削除する。利用者の設定が同じ header を注入していても、こちらが優先する。
 * container からの token 更新は、container が持つ refresh token がダミー値
 * なので、評価より前に拒否する。
 */

import type { DecisionResponse, InjectHeader } from "./protocol.ts";

export const CREDENTIAL_REFRESH_DENY_REASON =
  "credential-refresh-owned-by-host";
/** ホストの credential が使えなくなった後の、注入先への request。 */
export const CREDENTIAL_REVOKED_DENY_REASON = "credential-revoked-on-host";

export interface AgentCredential {
  /** 注入先のホスト。 */
  readonly injectHosts: readonly string[];
  /** 注入先で request から削除する header。 */
  readonly removeHeaders: readonly string[];
  /** container からの token 更新か。 */
  isHostOwnedRefresh(
    host: string,
    method: string,
    path: string | undefined,
  ): boolean;
  /** 注入する header。ホストの credential が使えなくなったら null。 */
  headers(): readonly InjectHeader[] | null;
  close(): Promise<void>;
}

function isPostTo(
  host: string,
  method: string,
  path: string | undefined,
  expectedHost: string,
  expectedPath: string,
): boolean {
  if (host !== expectedHost || method.toUpperCase() !== "POST") return false;
  if (path === undefined) return false;
  return path.split("?")[0] === expectedPath;
}

export function claudeAgentCredential(source: {
  current(): string;
  close(): Promise<void>;
}): AgentCredential {
  return {
    injectHosts: ["api.anthropic.com", "mcp-proxy.anthropic.com"],
    removeHeaders: ["x-api-key"],
    isHostOwnedRefresh: (host, method, path) =>
      isPostTo(host, method, path, "platform.claude.com", "/v1/oauth/token"),
    headers: () => [
      { name: "Authorization", value: `Bearer ${source.current()}` },
    ],
    close: () => source.close(),
  };
}

/**
 * `chatgpt-account-id` も上書きする。container の値はダミーファイルからの
 * もので同じ値になるが、ホストの token と異なる account を指定させない。
 */
export function codexAgentCredential(source: {
  current(): { accessToken: string; accountId: string | null } | null;
  close(): Promise<void>;
}): AgentCredential {
  return {
    injectHosts: ["chatgpt.com"],
    removeHeaders: [],
    isHostOwnedRefresh: (host, method, path) =>
      isPostTo(host, method, path, "auth.openai.com", "/oauth/token"),
    headers: () => {
      const credential = source.current();
      if (credential === null) return null;
      return [
        { name: "Authorization", value: `Bearer ${credential.accessToken}` },
        ...(credential.accountId !== null
          ? [{ name: "chatgpt-account-id", value: credential.accountId }]
          : []),
      ];
    },
    close: () => source.close(),
  };
}

function credentialForHost(
  credentials: readonly AgentCredential[],
  host: string,
): AgentCredential | undefined {
  return credentials.find((credential) =>
    credential.injectHosts.includes(host),
  );
}

export function isHostOwnedCredentialRefresh(
  credentials: readonly AgentCredential[],
  host: string,
  method: string,
  path: string | undefined,
): boolean {
  return credentials.some((credential) =>
    credential.isHostOwnedRefresh(host, method, path),
  );
}

export function isRevokedCredentialHost(
  credentials: readonly AgentCredential[],
  host: string,
): boolean {
  const credential = credentialForHost(credentials, host);
  return credential !== undefined && credential.headers() === null;
}

export function applyAgentCredentials(
  decision: DecisionResponse,
  host: string,
  credentials: readonly AgentCredential[],
): DecisionResponse {
  if (decision.decision !== "allow") return decision;
  const credential = credentialForHost(credentials, host);
  if (credential === undefined) return decision;
  const headers = credential.headers();
  // 使えなくなった credential の注入先は評価より前に拒否している。
  if (headers === null) return decision;
  const overridden = new Set(headers.map((h) => h.name.toLowerCase()));
  const injectHeaders: InjectHeader[] = [
    ...(decision.injectHeaders ?? []).filter(
      (header) => !overridden.has(header.name.toLowerCase()),
    ),
    ...headers,
  ];
  return {
    ...decision,
    injectHeaders,
    ...(credential.removeHeaders.length > 0
      ? { removeHeaders: [...credential.removeHeaders] }
      : {}),
  };
}
```

Run: `bun test src/network/agent_credential_test.ts`
Expected: PASS

- [ ] **Step 3: broker を書き換える**

`src/network/broker.ts` を次のように変える。

1. import の `applyAgentCredential` を `applyAgentCredentials`・`type AgentCredential`・`CREDENTIAL_REVOKED_DENY_REASON`・`isRevokedCredentialHost` に替え、`isHostOwnedCredentialRefresh` と `CREDENTIAL_REFRESH_DENY_REASON` はそのまま使う。`import type { AgentCredentialSource } from "./claude_oauth_source.ts";` を削除する。
2. option の `agentCredential?: AgentCredentialSource;` とその doc comment を次にする。

```ts
  /**
   * ホストが保持するエージェントの credential。注入先のホストで認証の header
   * を上書きし、container からの token 更新を拒否する。ホストの credential が
   * 使えなくなったエージェントの注入先への request は拒否する。
   */
  agentCredentials?: readonly AgentCredential[];
```

3. field を `private readonly agentCredentials: readonly AgentCredential[];` にし、constructor で `this.agentCredentials = options.agentCredentials ?? [];` とする。
4. 評価前の拒否（`isHostOwnedCredentialRefresh` を呼ぶ `if`）を次にする。

```ts
    // container が持つ refresh token はダミー値であり、body の refresh_token を
    // プロキシが書き換える仕組みは無い。つまりこの request を policy に通しても、
    // container 自身が本物の token で更新する経路には辿り着けない。本物の token
    // への更新はホスト側の credential source が担うので、評価より前に拒否する。
    if (
      isHostOwnedCredentialRefresh(
        this.agentCredentials,
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

    // ホストの credential が使えなくなった (ホストでファイルが置き換わった)
    // エージェントの注入先へは、container の付けた credential のまま通さない。
    if (isRevokedCredentialHost(this.agentCredentials, message.target.host)) {
      await this.recordAudit(
        message,
        "deny",
        CREDENTIAL_REVOKED_DENY_REASON,
        targetStr,
        undefined,
        undefined,
        undefined,
        requestBodyAuditStatus,
      );
      return denyDecision(message.requestId, CREDENTIAL_REVOKED_DENY_REASON);
    }
```

5. `decorateAllow` の末尾を次にする。

```ts
    const decorated = this.decorateWithPolicy(decision, decided);
    return applyAgentCredentials(
      decorated,
      target.host,
      this.agentCredentials,
    );
```

- [ ] **Step 4: broker の test を直し、Codex の test を足す**

`src/network/broker_integration_test.ts` の import に `claudeAgentCredential`・`codexAgentCredential`（`./agent_credential.ts`）を足す。`agentCredential: { current: () => "host-token", close: async () => {} },` の6か所をすべて次にする。

```ts
    agentCredentials: [
      claudeAgentCredential({ current: () => "host-token", close: async () => {} }),
    ],
```

`SessionBroker: container token refresh is denied before policy evaluation` の後に次を足す。

```ts
test("SessionBroker: Codex credential overrides Authorization and the account on chatgpt.com", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-codexcred-"));
  const auditDir = await mkdtemp(path.join(tmpdir(), "nas-broker-codexcred-audit-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  let current: { accessToken: string; accountId: string | null } | null = {
    accessToken: "codex-token",
    accountId: "acct-1",
  };
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_codexcred",
    document: resolvedDocument({
      network: {
        scopes: {
          chatgpt: { targets: ["chatgpt.com"], fallback: "allow" },
          openai: { targets: ["auth.openai.com"], fallback: "allow" },
        },
      },
    }),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
    auditDir,
    agentCredentials: [
      codexAgentCredential({ current: () => current, close: async () => {} }),
    ],
  });
  const socketPath = `${paths.brokersDir}/sess_codexcred/sock`;
  await broker.start(socketPath);
  try {
    const allowed = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      post("sess_codexcred", "req_1", "/backend-api/codex/responses", "chatgpt.com", 443),
    );
    expect(allowed.decision).toBe("allow");
    expect(allowed.injectHeaders).toEqual([
      { name: "Authorization", value: "Bearer codex-token" },
      { name: "chatgpt-account-id", value: "acct-1" },
    ]);

    const refresh = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      post("sess_codexcred", "req_2", "/oauth/token", "auth.openai.com", 443),
    );
    expect(refresh.decision).toBe("deny");
    expect(refresh.reason).toBe("credential-refresh-owned-by-host");

    current = null;
    const revoked = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      post("sess_codexcred", "req_3", "/backend-api/codex/responses", "chatgpt.com", 443),
    );
    expect(revoked.decision).toBe("deny");
    expect(revoked.reason).toBe("credential-revoked-on-host");
    expect(revoked.injectHeaders).toBeUndefined();
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(auditDir, { recursive: true, force: true }).catch(() => {});
  }
});
```

`post` の引数の並び（sessionId, requestId, path, host, port）と `resolvedDocument` の scope の書き方は、同じファイルの `SessionBroker: agent credential overrides Authorization on Anthropic hosts` に合わせてある。違っていたらそちらに合わせる。

- [ ] **Step 5: test が通ることを確認する**

Run: `bun test src/network/agent_credential_test.ts src/network/broker_integration_test.ts && bun run check`
Expected: PASS。`bun run check` で `src/stages/proxy/session_broker_service.ts` が `agentCredential` を渡している箇所が型エラーになる。Task 7 で直すので、この Task では `session_broker_service.ts` の `createBroker` の呼び出しを一時的に `agentCredentials: agentCredential ? [claudeAgentCredential(agentCredential)] : undefined,` にして型を通す（import に `claudeAgentCredential` を足す）。

- [ ] **Step 6: コミットする**

```bash
git add src/network/agent_credential.ts src/network/agent_credential_test.ts src/network/broker.ts src/network/broker_integration_test.ts src/stages/proxy/session_broker_service.ts
git commit -m "feat(network): let the broker hold one credential per provisioned agent"
```

---

### Task 7: credential の起動と、置き換え時のセッションの停止

**Files:**
- Modify: `src/stages/proxy/session_broker_service.ts`
- Modify: `src/stages/proxy/session_broker_service_test.ts`
- Modify: `src/stages/proxy/stage.ts`（`ProxyStageOptions`、`ProxyPlan.agentCredential`、`planProxy`、`createProxyStage`、`runProxy`）
- Modify: `src/stages/proxy/stage_test.ts`
- Modify: `src/pipeline/cli_builder.ts`

**Interfaces:**
- Consumes: Task 1 の `usesProxiedClaudeCredentials`・`usesProxiedCodexCredentials`。Task 4 の `CodexOAuthCredentialSource`・`liveCodexOAuthSourceDeps`・`resolveNasStateHome`。Task 5 の `watchCodexAuthFile`・`liveCodexAuthWatchDeps`。Task 6 の `AgentCredential`・`claudeAgentCredential`・`codexAgentCredential`。`src/docker/client.ts` の `dockerStop`、`src/docker/nas_resources.ts` の `containerNameForSession`。
- Produces:
  - `interface AgentCredentialConfig { readonly kind: "claude-oauth" | "codex-oauth"; readonly hostHome: string }`（`session_broker_service.ts`）
  - `SessionBrokerConfig.agentCredentials?: readonly AgentCredentialConfig[]`（`agentCredential` は削除）
  - `SessionBrokerStartDeps.openAgentCredential(config: AgentCredentialConfig, sessionId: string): Promise<AgentCredential>`
  - `ProxyStageOptions.devcontainer?: boolean`、`ProxyPlan.agentCredentials?: readonly AgentCredentialConfig[]`
  - `createProxyStage(shared: StageInput, options?: Pick<ProxyStageOptions, "devcontainer">)`

- [ ] **Step 1: session broker service の test を書き換える**

`src/stages/proxy/session_broker_service_test.ts` の `makeConfig` の `agentCredential: {...}` を次にする。

```ts
    agentCredentials: [
      { kind: "claude-oauth", hostHome: "/nonexistent" },
      { kind: "codex-oauth", hostHome: "/nonexistent" },
    ],
```

`makeSource` と `makeDeps` を次にし、import の `AgentCredentialSource` を `type AgentCredential`（`../../network/agent_credential.ts`）に替える。

```ts
function makeSource(): AgentCredential & { closed: number } {
  const source = {
    closed: 0,
    injectHosts: [],
    removeHeaders: [],
    isHostOwnedRefresh: () => false,
    headers: () => [],
    close: async () => {
      source.closed += 1;
    },
  };
  return source;
}

function makeDeps(
  source: AgentCredential,
  createBroker: SessionBrokerStartDeps["createBroker"],
): SessionBrokerStartDeps {
  return { openAgentCredential: async () => source, createBroker };
}
```

既存の test で `source.closed` を `1` と比べているものは、credential を2つ開くので `2` にする（同じ `source` を2回返すため）。次の test を足す。

```ts
test("startSessionBroker: closes the credentials already opened when a later one fails", async () => {
  const first = makeSource();
  let opened = 0;
  const deps: SessionBrokerStartDeps = {
    openAgentCredential: async (config) => {
      opened += 1;
      if (config.kind === "codex-oauth") throw new Error("no auth.json");
      return first;
    },
    createBroker: () => {
      throw new Error("must not be constructed");
    },
  };
  await expect(
    startSessionBroker(makeConfig("sess_partial"), deps),
  ).rejects.toThrow("no auth.json");
  expect(opened).toBe(2);
  expect(first.closed).toBe(1);
});

test("startSessionBroker: passes every opened credential to the broker", async () => {
  const source = makeSource();
  const seen: unknown[] = [];
  const deps = makeDeps(source, (options) => {
    seen.push(options.agentCredentials);
    return { start: async () => {}, close: async () => {} };
  });
  const handle = await startSessionBroker(makeConfig("sess_all"), deps);
  expect(seen).toEqual([[source, source]]);
  await Effect.runPromise(handle.close());
});
```

`Effect` と `startSessionBroker` が import されていなければ足す。`makeConfig` の `paths` を使う既存の test が registry を書くなら、この test も同じ後始末（既存の test に倣う）をする。

Run: `bun test src/stages/proxy/session_broker_service_test.ts`
Expected: FAIL

- [ ] **Step 2: session broker service を書き換える**

`src/stages/proxy/session_broker_service.ts` を次のように変える。

1. import を整理する。`AgentCredentialSource` を消し、次を足す。

```ts
import { dockerStop } from "../../docker/client.ts";
import { containerNameForSession } from "../../docker/nas_resources.ts";
import {
  type AgentCredential,
  claudeAgentCredential,
  codexAgentCredential,
} from "../../network/agent_credential.ts";
import {
  liveCodexAuthWatchDeps,
  watchCodexAuthFile,
} from "../../network/codex_auth_watch.ts";
import {
  CodexOAuthCredentialSource,
  liveCodexOAuthSourceDeps,
  resolveNasStateHome,
} from "../../network/codex_oauth_source.ts";
```

2. `SessionBrokerConfig` の `agentCredential` を次にする。

```ts
  /**
   * ホストが保持するエージェントの credential を broker に持たせる。
   * 1つでも取得できなければ start が失敗し、セッションを開始しない。
   */
  readonly agentCredentials?: readonly AgentCredentialConfig[];
```

その上に型を足す。

```ts
export interface AgentCredentialConfig {
  readonly kind: "claude-oauth" | "codex-oauth";
  readonly hostHome: string;
}
```

3. `SessionBrokerStartDeps.openAgentCredential` と live deps を次にする。

```ts
export interface SessionBrokerStartDeps {
  readonly openAgentCredential: (
    config: AgentCredentialConfig,
    sessionId: string,
  ) => Promise<AgentCredential>;
  readonly createBroker: (
    options: ConstructorParameters<typeof SessionBroker>[0],
  ) => SessionBrokerLifecycle;
}

const liveStartDeps: SessionBrokerStartDeps = {
  openAgentCredential: openLiveAgentCredential,
  createBroker: (options) => new SessionBroker(options),
};

async function openLiveAgentCredential(
  config: AgentCredentialConfig,
  sessionId: string,
): Promise<AgentCredential> {
  switch (config.kind) {
    case "claude-oauth":
      return claudeAgentCredential(
        await ClaudeOAuthCredentialSource.open(
          liveClaudeOAuthSourceDeps(config.hostHome),
        ),
      );
    case "codex-oauth":
      return await openLiveCodexCredential(config.hostHome, sessionId);
  }
}

/**
 * Codex の credential を開き、ホストの auth.json の監視を始める。
 *
 * container の auth.json はホストの auth.json の上に被せたダミーなので、
 * ホストのファイルが消えるか置き換わると外れ、以後にホストで書かれる本物が
 * container から見える。そうなったら注入をやめ、セッションの container を
 * 止める。
 */
async function openLiveCodexCredential(
  hostHome: string,
  sessionId: string,
): Promise<AgentCredential> {
  const source = await CodexOAuthCredentialSource.open(
    liveCodexOAuthSourceDeps(hostHome, resolveNasStateHome(hostHome)),
  );
  let stopWatching: () => void;
  try {
    stopWatching = await watchCodexAuthFile(
      liveCodexAuthWatchDeps(hostHome),
      () => {
        source.revoke();
        logWarn(
          `[nas] the host ~/.codex/auth.json was removed or replaced (for example by "codex logout"); stopping the session so the container cannot read the new file`,
        );
        void dockerStop(containerNameForSession(sessionId)).catch((error) =>
          logWarn(
            `[nas] failed to stop the session container after the host ~/.codex/auth.json changed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      },
    );
  } catch (error) {
    await source.close();
    throw error;
  }
  const credential = codexAgentCredential(source);
  return {
    ...credential,
    close: async () => {
      stopWatching();
      await credential.close();
    },
  };
}
```

4. `startSessionBroker` の credential の起動と後始末を複数に対応させる。関数の doc comment の「credential source」を「credential」の複数形の説明に直し、本体の先頭を次にする。

```ts
  const agentCredentials: AgentCredential[] = [];
  const closeCredentials = async () => {
    for (const credential of agentCredentials) {
      await credential
        .close()
        .catch((e) =>
          logInfo(
            `[nas] SessionBrokerService: failed to close an agent credential: ${e}`,
          ),
        );
    }
  };
  try {
    for (const credentialConfig of config.agentCredentials ?? []) {
      agentCredentials.push(
        await deps.openAgentCredential(credentialConfig, config.sessionId),
      );
    }
  } catch (error) {
    await closeCredentials();
    throw error;
  }
```

以後、`agentCredential` を渡していた `createBroker` の呼び出しを `agentCredentials,` にし、`await agentCredential?.close();` の2か所と teardown の `agentCredential?.close().catch(...)` を `await closeCredentials();` にする。Task 6 で入れた一時的な変換は消す。

Run: `bun test src/stages/proxy/session_broker_service_test.ts`
Expected: PASS

- [ ] **Step 3: proxy stage の test を書き換える**

`src/stages/proxy/stage_test.ts` の `planProxy: Claude with default credentials asks for the host OAuth source`・`planProxy: shared credentials do not start a host OAuth source`・`planProxy: other agents do not start a host OAuth source` を削除し、次を足す。

```ts
test("planProxy: Claude with default credentials asks for the host OAuth source", () => {
  const profile = makeProfile({ agent: "claude" });
  const { shared, container, observability } = makeInput(profile);

  const result = planProxy({ ...shared, container, observability });

  expect(result.agentCredentials).toEqual([
    { kind: "claude-oauth", hostHome: shared.host.home },
  ]);
});

test("planProxy: Codex with default credentials asks for the host OAuth source", () => {
  const profile = makeProfile({ agent: "codex" });
  const { shared, container, observability } = makeInput(profile);

  const result = planProxy({ ...shared, container, observability });

  expect(result.agentCredentials).toEqual([
    { kind: "codex-oauth", hostHome: shared.host.home },
  ]);
});

test("planProxy: a profile with both agents asks for both sources", () => {
  const profile = makeProfile({ agent: "codex", extraAgents: ["claude"] });
  const { shared, container, observability } = makeInput(profile);

  const result = planProxy({ ...shared, container, observability });

  expect(result.agentCredentials).toEqual([
    { kind: "claude-oauth", hostHome: shared.host.home },
    { kind: "codex-oauth", hostHome: shared.host.home },
  ]);
});

test("planProxy: Dev Container Codex does not start a host OAuth source", () => {
  const profile = makeProfile({ agent: "codex" });
  const { shared, container, observability } = makeInput(profile);

  const result = planProxy(
    { ...shared, container, observability },
    { devcontainer: true },
  );

  expect(result.agentCredentials).toBeUndefined();
});

test("planProxy: shared credentials and Copilot do not start a host OAuth source", () => {
  for (const profile of [
    makeProfile({
      agent: "claude",
      agentState: { protectSettings: false, auth: "shared" },
    }),
    makeProfile({ agent: "copilot" }),
  ]) {
    const { shared, container, observability } = makeInput(profile);
    const result = planProxy({ ...shared, container, observability });
    expect(result.agentCredentials).toBeUndefined();
  }
});
```

`runProxy: hands agentCredential to SessionBrokerService` の `agentCredential` を `agentCredentials` にし、期待値を `[{ kind: "claude-oauth", hostHome: ... }]` の配列にする（既存の期待値の object を配列で包む）。

Run: `bun test src/stages/proxy/stage_test.ts`
Expected: FAIL

- [ ] **Step 4: proxy stage を書き換える**

`src/stages/proxy/stage.ts` を次のように変える。

1. import の `usesProxiedClaudeCredentials` に `usesProxiedCodexCredentials` を足し、`type AgentCredentialConfig` を `./session_broker_service.ts` から import する。
2. `ProxyPlan` の `agentCredential?: {...}` を次にする。

```ts
  /** ホストが保持する OAuth credential のうち、broker に注入させるもの。 */
  readonly agentCredentials?: readonly AgentCredentialConfig[];
```

3. `ProxyStageOptions` に足す。

```ts
  /** Dev Container のセッションか。Dev Container の Codex は proxy の対象外。 */
  devcontainer?: boolean;
```

4. `planProxy` の `agentCredential` の計算を次にし、return の `...(agentCredential ? { agentCredential } : {})` を `...(agentCredentials.length > 0 ? { agentCredentials } : {})` にする。

```ts
  const credentialsContext = { devcontainer: options.devcontainer ?? false };
  const agentCredentials: AgentCredentialConfig[] = [
    ...(usesProxiedClaudeCredentials(input.profile)
      ? [{ kind: "claude-oauth" as const, hostHome: input.host.home }]
      : []),
    ...(usesProxiedCodexCredentials(input.profile, credentialsContext)
      ? [{ kind: "codex-oauth" as const, hostHome: input.host.home }]
      : []),
  ];
```

5. `runProxy` の `agentCredential: plan.agentCredential,` を `agentCredentials: plan.agentCredentials,` にする。
6. `createProxyStage` を次にする。

```ts
export function createProxyStage(
  shared: StageInput,
  options: Pick<ProxyStageOptions, "devcontainer"> = {},
): Stage<
  "container" | "observability",
  Partial<Pick<StageResult, "network" | "prompt" | "proxy" | "container">>,
  CaService | NetworkRuntimeService | ProxyService | SessionBrokerService,
  unknown
> {
  return createProxyStageWithOptions(shared, options);
}
```

7. `src/pipeline/cli_builder.ts` の `.add(createProxyStage(input))` を次にする。

```ts
    .add(
      createProxyStage(input, { devcontainer: devcontainerMounts !== undefined }),
    )
```

- [ ] **Step 5: test が通ることを確認する**

Run: `bun test src/stages/proxy/stage_test.ts src/stages/proxy/session_broker_service_test.ts && bun run check`
Expected: PASS

- [ ] **Step 6: コミットする**

```bash
git add src/stages/proxy/session_broker_service.ts src/stages/proxy/session_broker_service_test.ts src/stages/proxy/stage.ts src/stages/proxy/stage_test.ts src/pipeline/cli_builder.ts
git commit -m "feat(proxy): start the host Codex credential and stop the session if auth.json is replaced"
```

---

### Task 8: ダミーの `auth.json` の mount

**Files:**
- Create: `src/stages/mount/codex_credentials_fs.ts`
- Create: `src/stages/mount/codex_credentials_fs_test.ts`
- Modify: `src/stages/mount/mount_setup_service.ts`
- Modify: `src/agents/types.ts`（`AgentProvisionInput`）
- Modify: `src/agents/codex.ts`（`CodexProvisionInput`、`provisionCodex`）
- Modify: `src/agents/registry.ts`（`provisionAgent`、`configureAgent`）
- Modify: `src/agents/agents_integration_test.ts` または `src/agents/codex_test.ts`（あるほう。無ければ `src/agents/codex_test.ts` を作る）
- Modify: `src/stages/mount/stage.ts`（`run`、`planMount`）
- Modify: `src/stages/mount/stage_test.ts`

**Interfaces:**
- Consumes: Task 1 の `usesProxiedCodexCredentials`。Task 2 の `buildDummyCodexAuth`・`codexCredentialsReadError`。
- Produces:
  - `prepareDummyCodexCredentials(hostHome: string, now?: number): Promise<{ dir: string; file: string }>`、`removeDummyCodexCredentials(state): Promise<void>`
  - `MountSetupService.prepareCodexCredentials(hostHome: string): Effect.Effect<string, unknown, Scope.Scope>`
  - `AgentProvisionInput.codexAuthFile?: string`、`CodexProvisionInput.codexAuthFile?: string`
  - `planMount(input, probes, devcontainer?, protectedClaudeState?, claudeCredentialsFile?, codexAuthFile?)`

- [ ] **Step 1: ダミーファイルの test を書く**

`src/stages/mount/codex_credentials_fs_test.ts` を作る。

```ts
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  CODEX_DUMMY_REFRESH_TOKEN,
  CodexOAuthUnavailableError,
} from "../../agents/codex_oauth.ts";
import {
  prepareDummyCodexCredentials,
  removeDummyCodexCredentials,
} from "./codex_credentials_fs.ts";

async function withHome(fn: (home: string) => Promise<void>) {
  const home = await mkdtemp(path.join(tmpdir(), "nas-codex-creds-"));
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function jwt(payload: Record<string, unknown>): string {
  const b64 = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(payload)}.sig`;
}

test("prepareDummyCodexCredentials: writes a private dummy auth.json", async () => {
  await withHome(async (home) => {
    await mkdir(path.join(home, ".codex"));
    await writeFile(
      path.join(home, ".codex", "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          id_token: jwt({}),
          access_token: jwt({ exp: 1 }),
          refresh_token: "real-refresh",
          account_id: "acct-1",
        },
      }),
    );
    const dummy = await prepareDummyCodexCredentials(home, 0);
    try {
      expect(path.basename(dummy.file)).toBe("auth.json");
      expect((await stat(dummy.file)).mode & 0o777).toBe(0o600);
      const text = await readFile(dummy.file, "utf8");
      expect(text).not.toContain("real-refresh");
      expect(JSON.parse(text).tokens.refresh_token).toBe(
        CODEX_DUMMY_REFRESH_TOKEN,
      );
    } finally {
      await removeDummyCodexCredentials(dummy);
    }
    await expect(stat(dummy.dir)).rejects.toThrow();
  });
});

test("prepareDummyCodexCredentials: a missing host file asks for codex login", async () => {
  await withHome(async (home) => {
    await expect(prepareDummyCodexCredentials(home)).rejects.toBeInstanceOf(
      CodexOAuthUnavailableError,
    );
  });
});
```

Run: `bun test src/stages/mount/codex_credentials_fs_test.ts`
Expected: FAIL

- [ ] **Step 2: `src/stages/mount/codex_credentials_fs.ts` を作る**

```ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  buildDummyCodexAuth,
  codexCredentialsReadError,
} from "../../agents/codex_oauth.ts";

export interface DummyCodexCredentials {
  readonly dir: string;
  readonly file: string;
}

/**
 * ホストの Codex の auth.json からダミーを作り、セッション専用の
 * ディレクトリに置く。container の `~/.codex/auth.json` に被せる。
 */
export async function prepareDummyCodexCredentials(
  hostHome: string,
  now: number = Date.now(),
): Promise<DummyCodexCredentials> {
  let hostText: string;
  try {
    hostText = await readFile(
      path.join(hostHome, ".codex", "auth.json"),
      "utf8",
    );
  } catch (error) {
    throw codexCredentialsReadError(error);
  }
  const dummy = buildDummyCodexAuth(hostText, now);
  const dir = await mkdtemp(path.join(tmpdir(), "nas-codex-credentials-"));
  const file = path.join(dir, "auth.json");
  try {
    await writeFile(file, dummy, { mode: 0o600 });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return { dir, file };
}

export async function removeDummyCodexCredentials(
  state: DummyCodexCredentials,
): Promise<void> {
  await rm(state.dir, { recursive: true, force: true });
}
```

Run: `bun test src/stages/mount/codex_credentials_fs_test.ts`
Expected: PASS

- [ ] **Step 3: MountSetupService に足す**

`src/stages/mount/mount_setup_service.ts` に次を足す。

1. import に `prepareDummyCodexCredentials`・`removeDummyCodexCredentials`（`./codex_credentials_fs.ts`）。
2. Tag の型に、`prepareClaudeCredentials` の後に次を足す。

```ts
    readonly prepareCodexCredentials: (
      hostHome: string,
    ) => Effect.Effect<string, unknown, Scope.Scope>;
```

3. live 実装に、`prepareClaudeCredentials` と同じ形で足す。

```ts
      prepareCodexCredentials: (hostHome) =>
        Effect.acquireRelease(
          Effect.tryPromise({
            try: () => prepareDummyCodexCredentials(hostHome),
            // CodexOAuthUnavailableError のログイン案内を残すため、元のエラーを
            // そのまま返す。
            catch: (error) => error,
          }),
          (state) => Effect.promise(() => removeDummyCodexCredentials(state)),
        ).pipe(Effect.map((state) => state.file)),
```

`prepareClaudeCredentials` の live 実装が `.pipe(Effect.map(...))` で file を返していなければ、そちらの書き方に合わせる。

4. fake の override の型と既定値に、`prepareClaudeCredentials` と同じ形で足す。

```ts
  readonly prepareCodexCredentials?: (
    hostHome: string,
  ) => Effect.Effect<string, unknown, Scope.Scope>;
```

```ts
      prepareCodexCredentials:
        overrides.prepareCodexCredentials ??
        (() => Effect.die("prepareCodexCredentials fake is required")),
```

- [ ] **Step 4: provision の test を書く**

`src/agents/codex_test.ts` が無ければ作り、あれば足す。

```ts
import { expect, test } from "bun:test";
import { provisionCodex } from "./codex.ts";

const probes = {
  codexDirExists: true,
  codexBinPath: "/usr/bin/codex",
  codexCodeModeHostBinPath: null,
  codexSettingsFiles: [],
};

test("provisionCodex: mounts the dummy auth.json after the host ~/.codex", () => {
  const result = provisionCodex({
    containerHome: "/home/agent",
    hostHome: "/home/u",
    probes,
    protectSettings: false,
    priorDockerArgs: [],
    priorEnvVars: {},
    codexAuthFile: "/tmp/nas-codex-credentials-x/auth.json",
  });
  expect(result.dockerArgs).toContain("/home/u/.codex:/home/agent/.codex");
  expect(result.mounts).toEqual([
    {
      source: "/tmp/nas-codex-credentials-x/auth.json",
      target: "/home/agent/.codex/auth.json",
    },
  ]);
});

test("provisionCodex: shares the host auth.json when no dummy is given", () => {
  const result = provisionCodex({
    containerHome: "/home/agent",
    hostHome: "/home/u",
    probes,
    protectSettings: false,
    priorDockerArgs: [],
    priorEnvVars: {},
  });
  expect(result.mounts).toBeUndefined();
});

test("provisionCodex: rejects a dummy auth.json for Dev Container state", () => {
  expect(() =>
    provisionCodex({
      codexState: { codexDir: "/home/u/.codex" },
      containerHome: "/home/agent",
      hostHome: "/home/u",
      probes,
      protectSettings: false,
      priorDockerArgs: [],
      priorEnvVars: {},
      codexAuthFile: "/tmp/x/auth.json",
    }),
  ).toThrow("Dummy Codex credentials");
});
```

Run: `bun test src/agents/codex_test.ts`
Expected: FAIL

- [ ] **Step 5: provision に `codexAuthFile` を通す**

1. `src/agents/types.ts` の `AgentProvisionInput` の `claudeCredentialsFile` の後に足す。

```ts
  /**
   * container の `~/.codex/auth.json` に bind mount するダミーファイルの、
   * host 上のパスである。ホストの credential を proxy で注入するときに渡す。
   */
  readonly codexAuthFile?: string;
```

2. `src/agents/codex.ts` の `CodexProvisionInput` に同じ doc comment で `readonly codexAuthFile?: string;` を足し、import に `type MountSpec`（`../pipeline/state.ts`）を足す。`provisionCodex` の先頭（`const envVars` の後）に次を足す。

```ts
  if (input.codexState && input.codexAuthFile) {
    throw new Error(
      "[nas] Dummy Codex credentials are not supported for Dev Container sessions",
    );
  }
```

host のパスの return を次にする。

```ts
  // ~/.codex のマウントより後に置き、ホストの auth.json を隠す。ホストの
  // Codex は auth.json を同じファイルへの上書きで保存するので、この mount は
  // 普段の更新では外れない。
  const credentialsMount: MountSpec[] = input.codexAuthFile
    ? [
        {
          source: input.codexAuthFile,
          target: `${containerHome}/.codex/auth.json`,
        },
      ]
    : [];

  return {
    dockerArgs: [...args],
    envVars,
    ...(credentialsMount.length > 0 ? { mounts: credentialsMount } : {}),
  };
```

3. `src/agents/registry.ts` の `provisionAgent` の `case "codex"` と `configureAgent` の `case "codex"` の呼び出しに `codexAuthFile: input.codexAuthFile,` を足す。

Run: `bun test src/agents/codex_test.ts && bun run check`
Expected: PASS

- [ ] **Step 6: mount stage の test を書く**

`src/stages/mount/stage_test.ts` に足す。`CONTAINER_HOME`・`TEST_HOME`・`makeProfile`・`makeMountProbes`・`makeInput`・`defaultClaudeProbes` は既存の helper を使う。

```ts
test("MountStage: proxied Codex credentials hide the host auth.json behind the dummy", () => {
  const profile = makeProfile({ agent: "codex" });
  const mountProbes = makeMountProbes({
    agentProbes: {
      codexDirExists: true,
      codexBinPath: "/usr/bin/codex",
      codexCodeModeHostBinPath: null,
      codexSettingsFiles: [],
    },
  });
  const { input } = makeInput({ profile, mountProbes });
  const plan = planMount(
    input,
    mountProbes,
    undefined,
    undefined,
    undefined,
    "/tmp/nas-codex-credentials-x/auth.json",
  );
  const targets = plan.containerPatch.mounts!.map((m) => m.target);
  const dirIndex = targets.indexOf(`${CONTAINER_HOME}/.codex`);
  const authIndex = targets.indexOf(`${CONTAINER_HOME}/.codex/auth.json`);
  expect(dirIndex).toBeGreaterThanOrEqual(0);
  expect(authIndex).toBeGreaterThan(dirIndex);
});

test("MountStage: an extra Claude receives the dummy credentials file", () => {
  const profile = makeProfile({ agent: "codex", extraAgents: ["claude"] });
  const mountProbes = makeMountProbes({
    agentProbes: {
      codexDirExists: true,
      codexBinPath: "/usr/bin/codex",
      codexCodeModeHostBinPath: null,
      codexSettingsFiles: [],
    },
    extraAgentProbes: [{ agent: "claude", probes: defaultClaudeProbes }],
  });
  const { input } = makeInput({ profile, mountProbes });
  const plan = planMount(
    input,
    mountProbes,
    undefined,
    { runtimeDir: "/private/claude", claudeJson: "/private/claude.json", entries: [] },
    "/tmp/nas-claude-credentials-x/.credentials.json",
  );
  const targets = plan.containerPatch.mounts!.map((m) => m.target);
  expect(targets).toContain(`${CONTAINER_HOME}/.claude/.credentials.json`);
});

test("MountStage: run prepares the dummy auth.json for a proxied Codex", async () => {
  const profile = makeProfile({ agent: "codex" });
  const mountProbes = makeMountProbes({
    agentProbes: {
      codexDirExists: true,
      codexBinPath: "/usr/bin/codex",
      codexCodeModeHostBinPath: null,
      codexSettingsFiles: [],
    },
  });
  const { sharedInput, slices } = makeInput({ profile, mountProbes });
  const prepared: string[] = [];
  const layer = makeMountSetupServiceFake({
    prepareCodexCredentials: (home) =>
      Effect.sync(() => {
        prepared.push(home);
        return "/tmp/nas-codex-credentials-x/auth.json";
      }),
  });
  const result = await Effect.runPromise(
    Effect.scoped(
      createMountStage(sharedInput, mountProbes)
        .run(slices)
        .pipe(Effect.provide(layer)),
    ),
  );
  expect(prepared).toEqual([TEST_HOME]);
  expect(result.container.mounts.map((m) => m.target)).toContain(
    `${CONTAINER_HOME}/.codex/auth.json`,
  );
});
```

`makeInput` が返す `sharedInput`・`slices` と、`run` の結果の `container.mounts` の取り出し方は、同じファイルの `createMountStage` を使う既存の test に合わせる。

Run: `bun test src/stages/mount/stage_test.ts`
Expected: FAIL

- [ ] **Step 7: mount stage を書き換える**

`src/stages/mount/stage.ts` を次のように変える。

1. import の `usesClaude, usesProxiedClaudeCredentials` に `usesProxiedCodexCredentials` を足す。
2. `run` の `claudeCredentialsFile` の計算の後に足し、`planMount` の呼び出しの最後の引数に `codexAuthFile` を足す。

```ts
        const codexAuthFile = usesProxiedCodexCredentials(shared.profile, {
          devcontainer: devcontainer !== undefined,
        })
          ? yield* mountSetupService.prepareCodexCredentials(shared.host.home)
          : undefined;
```

3. `planMount` の引数の最後に `codexAuthFile?: string,` を足す。
4. 起動するエージェントの `configureAgent({...})` に `codexAuthFile,` を足す。
5. `extraAgents` の `provisionAgent({...})` に次の2つを足す。

```ts
        claudeCredentialsFile,
        codexAuthFile,
```

`extraAgents` の直前のコメントに「credential のダミーは起動するエージェントと同じく渡す」ことを1行足す。

- [ ] **Step 8: test が通ることを確認する**

Run: `bun test src/stages/mount/ src/agents/ && bun run check`
Expected: PASS。`bun test src/stages/mount/` はディレクトリ内の `integration_test.ts` も拾う。Docker を使う test は skip されることを確認し、skip 以外で落ちるものがあれば直す。

- [ ] **Step 9: コミットする**

```bash
git add src/stages/mount/codex_credentials_fs.ts src/stages/mount/codex_credentials_fs_test.ts src/stages/mount/mount_setup_service.ts src/agents/types.ts src/agents/codex.ts src/agents/codex_test.ts src/agents/registry.ts src/stages/mount/stage.ts src/stages/mount/stage_test.ts
git commit -m "feat(mount): show a proxied Codex a dummy auth.json over the shared ~/.codex"
```

---

### Task 9: 利用者向けの説明

**Files:**
- Modify: `docs-site/src/content/docs/configuration/authentication.md`
- Modify: `CHANGELOG.md`（`## Unreleased`）

- [ ] **Step 1: authentication.md を直す**

1. 冒頭の表の `| API key で Claude を使う | [Claude の認証情報の保持](#claude-の認証情報の保持) |` を `| API key で Claude や Codex を使う | [エージェントの認証情報の保持](#エージェントの認証情報の保持) |` にする。
2. `## Claude の認証情報の保持` を `## エージェントの認証情報の保持` に改め、最初の段落を次にする。

```md
`agentState.auth` は、エージェントのログイン情報をコンテナへどう渡すかを選びます。値は `"proxy"` と `"shared"` の2つで、指定しなければ既定値は Claude と Codex で `"proxy"`、Copilot で `"shared"` です。Dev Container の Codex は `"shared"` です。起動するエージェントにも `extraAgents` のエージェントにも同じ値を使います。Copilot の認証情報は `~/.copilot` に無いので、`"proxy"` を指定しても `"shared"` として扱います。
```

3. Claude の説明（`"proxy"` では、ホストの `~/.claude/.credentials.json` を…）の段落群を `### Claude` の見出しの下に移す。`### "proxy" の制限` は `#### "proxy" の制限` にして Claude の節に残す。
4. その後に `### Codex` の節を足す。

```md
### Codex

`"proxy"` では、ホストの `~/.codex` を今までどおり共有したうえで、`~/.codex/auth.json` の位置にだけセッションごとのダミーファイルを被せます。ダミーには実際のトークンは入っていません。Codex が `chatgpt.com` へ送る通信は nas のプロキシが中継し、`Authorization` と `chatgpt-account-id` をホストの値で上書きします。トークンの更新はホストの nas が行い、コンテナ内では起きません。

ログインはホストで `codex login` を実行してください。ホストの `~/.codex/auth.json` に ChatGPT のログイン情報が無い場合、セッションは起動しません。次の場合は `agentState.auth = "shared"` を指定してください。

- API key で Codex を使う（`"proxy"` のまま `env` に `OPENAI_API_KEY` や `CODEX_API_KEY` を設定すると、起動前の検証でエラーになります）
- ホストの Codex が認証情報をキーリングに保存している（`cli_auth_credentials_store = "keyring"`。[Codex のキーリング](#codex-のキーリング)の設定を使います）

#### `"proxy"` の制限

- セッションの実行中にホストの `~/.codex/auth.json` が削除されるか別のファイルに置き換わると、nas はそのセッションのコンテナを停止します。ホストでの `codex logout` がこれにあたります。ファイルが別のファイルに置き換わった場合（rename）は、停止するまでの短い間、新しいファイルがコンテナから見えます。
- ホストの Codex と nas が同時にトークンを更新すると、片方が失敗することがあります。nas はホストの Codex が更新したファイルを読み直して回復します。ホストの Codex が失敗した場合は、ホストで再ログインが必要になることがあります。
- コンテナ内で `codex login` を実行しても、書き込まれる先はそのセッション限りのダミーファイルで、セッションの終了とともに消えます。
```

5. `### 保護しないもの` より前の、Codex / Copilot の保護の表の説明「Codex / Copilot は状態ディレクトリを読み書き可能で共有し」はそのままにし、表の下に「Codex の `~/.codex/auth.json` は、`agentState.auth = "proxy"`（既定）ならダミーファイルを見せ、ホストの実体とは共有しません。」を足す。
6. 見出しを変えたので、このファイル内とリポジトリ内の `#claude-の認証情報の保持` へのリンクを `grep -rn "claude-の認証情報の保持" docs-site src` で探し、`#エージェントの認証情報の保持` に直す。

- [ ] **Step 2: CHANGELOG を直す**

`## Unreleased` の `### Changed` に足す。

```md
- **Codex credentials**: `agentState.auth` now defaults to `"proxy"` for Codex, as it does for Claude. The ChatGPT OAuth tokens in the host `~/.codex/auth.json` stay on the host; the container sees a dummy `auth.json` over the shared `~/.codex`, and nas's network proxy injects the host's access token and account id into requests to `chatgpt.com`. nas refreshes the token on the host. Profiles that use an API key (`OPENAI_API_KEY` / `CODEX_API_KEY`) or keep Codex credentials in the keyring must set `agentState.auth = "shared"`. Dev Container Codex sessions keep `"shared"`.
  - If the host `~/.codex/auth.json` is removed or replaced while a session runs (for example by `codex logout`), nas stops that session's container.
- **extraAgents**: `agentState.auth` now applies to agents listed in `extraAgents` too, so a Claude provisioned next to Codex also gets proxied credentials by default.
```

同じ節の `extraAgents` の Added の項目にある「`agentState.auth = "proxy"` covers only a launched Claude; a Claude listed in `extraAgents` shares the host credentials file.」の文を削除する。

- [ ] **Step 3: 最終確認をしてコミットする**

Run: `bun run check && bun run test:unit`
Expected: PASS

```bash
git add docs-site/src/content/docs/configuration/authentication.md CHANGELOG.md
git commit -m "docs(authentication): document proxied Codex credentials"
```
