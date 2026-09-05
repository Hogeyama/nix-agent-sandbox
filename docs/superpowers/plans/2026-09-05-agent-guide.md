# Agent Guide (opt-in) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** nas が、解決済みプロファイルから生成した SKILL.md を opt-in でコンテナ内エージェントに供給する。

**Architecture:** 新規ステージ `src/stages/guide/` を追加する。`Profile → GuideFacts → SKILL.md 文字列` はすべて純粋関数で、書き込みだけを `GuideService`（Effect サービス）が担う。ステージは生成物をホストの runtime dir に書き、エージェント別のパスへ read-only bind mount する `ContainerPatch` を返す。

**Tech Stack:** Bun / TypeScript (strict) / Effect / pkl (設定スキーマ) / Docker

## Global Constraints

実装者・レビュアーは以下を読むこと。すべてこのリポジトリ内にある。

- `skills/effect-separation/SKILL.md` — ステージは I/O を書かない。`run()` は「純粋プランナ呼び出し / ステージ向けサービス呼び出し / 結果返却」の 3 つだけ。`fs.*` / `proc.*` / `docker.*` をステージから直接呼ぶことは禁止。サービス内部でも D1（プリミティブ 1 呼び出し）と D2（他の effect の合成）を混ぜない。
- `skills/security-constraints/SKILL.md` — C1: シークレットの生値がコンテナから読める場所に出てはならない。S1: シークレット解決はホスト側プロセスのみ。
- `skills/test-policy/SKILL.md` — ランタイムは Bun (`bun:test`)。ファイル名が実行レーンを決める。Docker 依存テストは末尾を `integration_test.ts` にする。unit テストは live Docker に到達してはならない。integration は `skipIf` ガードと cleanup が必須。
- `skills/post-change-checks/SKILL.md` — 変更後の検証フロー。
- `skills/git-commit/SKILL.md` — コミットメッセージの規約。body は diff から読み取れないこと（なぜそうしたか）だけを書く。plan / spec への参照を書かない。

設計の根拠は `docs/superpowers/specs/2026-09-05-agent-guide-design.md` にある。

**このプランに固有の不変条件:**

- 生成されるガイドはコンテナから読める。`GuideFacts` を構築する関数は `profile.env`、`profile.secrets`、`profile.hostexec.secrets`、`profile.hostexec.rules`、`profile.mask` の中身を **読まない**（`profile.mask` は null かどうかだけを見る）。
- ガイドのマウントは必ず `readOnly: true`。
- `network.fallback` の値域は `"review" | "deny"` のみ。`"allow"` は存在しない（スコープ単位の `Action` にのみある）。未設定時の既定は `"deny"`。

---

## File Structure

| ファイル | 責務 |
|---|---|
| `src/config/Schema.pkl` (modify) | `GuideConfig` クラスと `Profile.guide` フィールド |
| `src/config/types.ts` (modify) | `GuideConfig` インターフェース、`Profile.guide`、`DEFAULT_GUIDE_CONFIG` |
| `src/stages/guide.ts` (create) | barrel re-export |
| `src/stages/guide/facts.ts` (create) | `GuideFacts` 型と `profileToGuideFacts`（純粋） |
| `src/stages/guide/content.ts` (create) | `renderGuide(facts) → SKILL.md 文字列`（純粋） |
| `src/stages/guide/guide_service.ts` (create) | `GuideService`: Tag + Live + Fake |
| `src/stages/guide/stage.ts` (create) | `planGuide` / `createGuideStage` |
| `src/pipeline/types.ts` (modify) | `StageServices` union に `GuideService` を追加 |
| `src/cli.ts` (modify) | ステージ登録と Live layer 登録 |
| `docs-site/src/content/docs/features/agent-guide.md` (create) | ユーザー向け機能ドキュメント |

---

### Task 1: 設定サーフェスと GuideFacts

**Files:**
- Modify: `src/config/Schema.pkl`
- Modify: `src/config/types.ts`
- Create: `src/stages/guide/facts.ts`
- Test: `src/stages/guide/facts_test.ts`

**Interfaces:**
- Consumes: `Profile`, `AgentType`, `NetworkFallback`（既存）
- Produces:
  - `interface GuideConfig { enable: boolean; extra?: string }`
  - `const DEFAULT_GUIDE_CONFIG: GuideConfig`
  - `interface GuideFacts`（下記の完全な定義）
  - `function profileToGuideFacts(profile: Profile, workDir: string): GuideFacts`

- [ ] **Step 1: Schema.pkl に GuideConfig を追加**

`src/config/Schema.pkl` の `Profile` クラスに以下のフィールドを追加する（`mask` の隣）:

```pkl
  /// エージェント向けガイド設定
  guide: GuideConfig = new {}
```

ファイル末尾付近、他の Config クラス群と同じ場所に:

```pkl
/// エージェント向けガイド設定
class GuideConfig {
  /// ガイドをコンテナに供給するか。既定は無効（opt-in）。
  enable: Boolean = false

  /// 生成されたガイドの末尾に追記される、環境固有の注意書き。
  extra: String? = null
}
```

- [ ] **Step 2: types.ts に対応する型を追加**

`src/config/types.ts` に追加する:

```typescript
/** エージェント向けガイド設定 */
export interface GuideConfig {
  enable: boolean;
  extra?: string;
}

export const DEFAULT_GUIDE_CONFIG: GuideConfig = {
  enable: false,
};
```

`Profile` インターフェースに `guide: GuideConfig;` を `mask?: MaskConfig;` の直前に追加する。

- [ ] **Step 3: 型エラーになった Profile リテラルを埋める**

Run: `bun run check`

Expected: `guide` が欠けている `Profile` リテラル（主にテストのフィクスチャ）が列挙される。各箇所に `guide: DEFAULT_GUIDE_CONFIG,` を追加し、`DEFAULT_GUIDE_CONFIG` を import する。型チェッカが網羅を保証するので、手で探さない。

Run: `bun run check`
Expected: エラーなし

- [ ] **Step 4: facts の失敗するテストを書く**

`src/stages/guide/facts_test.ts` を作成する:

```typescript
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DOCKER_CONFIG,
  DEFAULT_GUIDE_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  type Profile,
} from "../../config/types.ts";
import { profileToGuideFacts } from "./facts.ts";

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    agent: "claude",
    agentArgs: [],
    session: { multiplex: false, detachKey: "^\\", notify: "auto" },
    nix: { enable: "auto", mountSocket: true, extraPackages: [] },
    docker: DEFAULT_DOCKER_CONFIG,
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    network: DEFAULT_NETWORK_CONFIG,
    dbus: { session: { enable: false, see: [], talk: [], own: [], calls: [], broadcasts: [] } },
    display: { sandbox: "none", size: "1280x800" },
    extraMounts: [],
    env: [],
    hook: {},
    secrets: {},
    guide: DEFAULT_GUIDE_CONFIG,
    ...overrides,
  } as Profile;
}

describe("profileToGuideFacts", () => {
  test("carries the network fallback and forwarded ports", () => {
    const facts = profileToGuideFacts(
      makeProfile({
        network: {
          ...DEFAULT_NETWORK_CONFIG,
          fallback: "review",
          pendingTimeoutSeconds: 120,
          proxy: { forwardPorts: [8080, 5432] },
        },
      }),
      "/work/repo",
    );

    expect(facts.network.fallback).toBe("review");
    expect(facts.network.pendingTimeoutSeconds).toBe(120);
    expect(facts.network.forwardPorts).toEqual([8080, 5432]);
    expect(facts.workDir).toBe("/work/repo");
  });

  test("defaults the network fallback to deny when unset", () => {
    const facts = profileToGuideFacts(
      makeProfile({ network: { ...DEFAULT_NETWORK_CONFIG, fallback: undefined } }),
      "/work/repo",
    );

    expect(facts.network.fallback).toBe("deny");
  });

  test("reports hostexec only when the profile configures it", () => {
    expect(profileToGuideFacts(makeProfile(), "/w").hostexec).toBeNull();

    const facts = profileToGuideFacts(
      makeProfile({
        hostexec: {
          prompt: { enable: true, timeoutSeconds: 300, defaultScope: "capability" },
          secrets: {},
          rules: [],
        },
      }),
      "/w",
    );

    expect(facts.hostexec).toEqual({ promptEnabled: true, timeoutSeconds: 300 });
  });

  test("reports dind only when docker is enabled", () => {
    expect(profileToGuideFacts(makeProfile(), "/w").dind).toBeNull();

    const facts = profileToGuideFacts(
      makeProfile({ docker: { enable: true, shared: true } }),
      "/w",
    );

    expect(facts.dind).toEqual({ shared: true });
  });

  test("reduces mask config to a boolean without reading its contents", () => {
    expect(profileToGuideFacts(makeProfile(), "/w").maskEnabled).toBe(false);

    const facts = profileToGuideFacts(
      makeProfile({ mask: { proxy: true } as Profile["mask"] }),
      "/w",
    );

    expect(facts.maskEnabled).toBe(true);
  });

  test("does not surface env entries or secret names", () => {
    const facts = profileToGuideFacts(
      makeProfile({
        env: [{ key: "GITHUB_TOKEN", valCmd: "pass github/token" }],
        secrets: { "my-secret": { kind: "literal", value: "s3cret" } as never },
      }),
      "/w",
    );

    const serialized = JSON.stringify(facts);
    expect(serialized).not.toContain("GITHUB_TOKEN");
    expect(serialized).not.toContain("my-secret");
    expect(serialized).not.toContain("s3cret");
  });
});
```

- [ ] **Step 5: テストが落ちることを確認**

Run: `bun test src/stages/guide/facts_test.ts`
Expected: FAIL — `Cannot find module './facts.ts'`

- [ ] **Step 6: facts.ts を実装**

`src/stages/guide/facts.ts` を作成する:

```typescript
/**
 * Profile から、ガイド本文の分岐を駆動する事実だけを抽出する。
 *
 * この型はコンテナから読める内容の材料になる。したがって profile.env /
 * profile.secrets / hostexec.secrets / hostexec.rules / mask の中身は
 * 読まない（mask は null かどうかだけを見る）。security-constraints C1。
 */

import type { AgentType } from "../../agents/types.ts";
import type { Profile } from "../../config/types.ts";
import type { NetworkFallback } from "../../network/authz/config.ts";

export interface GuideNetworkFacts {
  /** 未設定時の既定は "deny"。"allow" は存在しない。 */
  readonly fallback: NetworkFallback;
  readonly pendingTimeoutSeconds: number;
  readonly forwardPorts: readonly number[];
}

export interface GuideHostExecFacts {
  readonly promptEnabled: boolean;
  readonly timeoutSeconds: number;
}

export interface GuideDindFacts {
  readonly shared: boolean;
}

export interface GuideFacts {
  readonly agent: AgentType;
  readonly workDir: string;
  readonly network: GuideNetworkFacts;
  readonly hostexec: GuideHostExecFacts | null;
  readonly dind: GuideDindFacts | null;
  readonly maskEnabled: boolean;
  readonly displaySandbox: string;
  readonly extra: string | null;
}

export function profileToGuideFacts(
  profile: Profile,
  workDir: string,
): GuideFacts {
  return {
    agent: profile.agent,
    workDir,
    network: {
      fallback: profile.network.fallback ?? "deny",
      pendingTimeoutSeconds: profile.network.pendingTimeoutSeconds,
      forwardPorts: [...profile.network.proxy.forwardPorts],
    },
    hostexec:
      profile.hostexec === undefined
        ? null
        : {
            promptEnabled: profile.hostexec.prompt.enable,
            timeoutSeconds: profile.hostexec.prompt.timeoutSeconds,
          },
    dind: profile.docker.enable ? { shared: profile.docker.shared } : null,
    maskEnabled: profile.mask !== undefined && profile.mask !== null,
    displaySandbox: profile.display.sandbox,
    extra: profile.guide.extra ?? null,
  };
}
```

- [ ] **Step 7: テストが通ることを確認**

Run: `bun test src/stages/guide/facts_test.ts`
Expected: PASS（6 tests）

Run: `bun run check`
Expected: エラーなし

- [ ] **Step 8: コミット**

`skills/git-commit/SKILL.md` に従ってメッセージを書く。subject 例:

```bash
git add src/config/Schema.pkl src/config/types.ts src/stages/guide/facts.ts src/stages/guide/facts_test.ts
git commit  # feat(guide): derive guide facts from the resolved profile
```

body には「なぜ env / secrets を読まない設計にしたか」（生成物がコンテナから読めるため）を書く。

---

### Task 2: SKILL.md 本文の生成

**Files:**
- Create: `src/stages/guide/content.ts`
- Test: `src/stages/guide/content_test.ts`

**Interfaces:**
- Consumes: `GuideFacts`（Task 1）
- Produces: `function renderGuide(facts: GuideFacts): string` — YAML frontmatter を含む SKILL.md 全文を返す。`const GUIDE_SKILL_NAME = "nas-sandbox"`。

- [ ] **Step 1: 失敗するテストを書く**

`src/stages/guide/content_test.ts` を作成する:

```typescript
import { describe, expect, test } from "bun:test";
import type { GuideFacts } from "./facts.ts";
import { GUIDE_SKILL_NAME, renderGuide } from "./content.ts";

function makeFacts(overrides: Partial<GuideFacts> = {}): GuideFacts {
  return {
    agent: "claude",
    workDir: "/work/repo",
    network: { fallback: "deny", pendingTimeoutSeconds: 300, forwardPorts: [] },
    hostexec: null,
    dind: null,
    maskEnabled: false,
    displaySandbox: "none",
    extra: null,
    ...overrides,
  };
}

describe("renderGuide", () => {
  test("emits frontmatter with the skill name and a description", () => {
    const out = renderGuide(makeFacts());
    const lines = out.split("\n");

    expect(lines[0]).toBe("---");
    expect(out).toContain(`name: ${GUIDE_SKILL_NAME}`);
    expect(out).toMatch(/^description: .+$/m);
    expect(lines.indexOf("---", 1)).toBeGreaterThan(1);
  });

  test("always states the workspace boundary", () => {
    expect(renderGuide(makeFacts())).toContain("/work/repo");
  });

  test("says denied domains fail immediately when fallback is deny", () => {
    const out = renderGuide(makeFacts({ network: { fallback: "deny", pendingTimeoutSeconds: 300, forwardPorts: [] } }));

    expect(out).toContain("retry");
    expect(out).not.toContain("waits for approval");
  });

  test("says denied domains block for approval when fallback is review", () => {
    const out = renderGuide(makeFacts({ network: { fallback: "review", pendingTimeoutSeconds: 120, forwardPorts: [] } }));

    expect(out).toContain("waits for approval");
    expect(out).toContain("120");
  });

  test("lists forwarded ports only when there are any", () => {
    expect(renderGuide(makeFacts())).not.toContain("Forwarded ports");

    const out = renderGuide(makeFacts({ network: { fallback: "deny", pendingTimeoutSeconds: 300, forwardPorts: [8080, 5432] } }));
    expect(out).toContain("Forwarded ports");
    expect(out).toContain("8080");
    expect(out).toContain("5432");
  });

  test("warns that a hostexec approval is not a hang, with the timeout", () => {
    expect(renderGuide(makeFacts())).not.toContain("host");

    const out = renderGuide(makeFacts({ hostexec: { promptEnabled: true, timeoutSeconds: 300 } }));
    expect(out).toContain("300");
    expect(out).toContain("not a hang");
  });

  test("explains the DinD build asymmetry only when docker is enabled", () => {
    expect(renderGuide(makeFacts())).not.toContain("apt-get");

    const out = renderGuide(makeFacts({ dind: { shared: true } }));
    expect(out).toContain("apt-get");
  });

  test("mentions masking only when mask is configured", () => {
    expect(renderGuide(makeFacts())).not.toContain("masked");
    expect(renderGuide(makeFacts({ maskEnabled: true }))).toContain("masked");
  });

  test("mentions the display sandbox only when it is not none", () => {
    expect(renderGuide(makeFacts())).not.toContain("xpra");
    expect(renderGuide(makeFacts({ displaySandbox: "xpra" }))).toContain("xpra");
  });

  test("appends the user's extra section verbatim", () => {
    const out = renderGuide(makeFacts({ extra: "Run `just fmt` before committing." }));

    expect(out).toContain("Run `just fmt` before committing.");
    expect(out.trimEnd().endsWith("Run `just fmt` before committing.")).toBe(true);
  });

  test("description names only the symptoms of enabled features", () => {
    const bare = renderGuide(makeFacts());
    const bareDescription = bare.split("\n").find((l) => l.startsWith("description:")) ?? "";
    expect(bareDescription).not.toContain("docker");
    expect(bareDescription).not.toContain("unresponsive");

    const full = renderGuide(makeFacts({
      hostexec: { promptEnabled: true, timeoutSeconds: 300 },
      dind: { shared: false },
    }));
    const fullDescription = full.split("\n").find((l) => l.startsWith("description:")) ?? "";
    expect(fullDescription).toContain("docker");
    expect(fullDescription).toContain("unresponsive");
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `bun test src/stages/guide/content_test.ts`
Expected: FAIL — `Cannot find module './content.ts'`

- [ ] **Step 3: content.ts を実装**

`src/stages/guide/content.ts` を作成する:

```typescript
/**
 * GuideFacts から SKILL.md 全文を組み立てる（純粋）。
 *
 * description は skill 機構によって常時 system prompt に載る。エージェントが
 * 失敗に遭遇した瞬間にガイドの存在へ気づけるかはここに懸かっているので、
 * 有効な機能に対応する症状だけを、症状の語彙で列挙する。
 */

import type { GuideFacts } from "./facts.ts";

export const GUIDE_SKILL_NAME = "nas-sandbox";

function buildDescription(facts: GuideFacts): string {
  const symptoms = [
    "network requests fail to resolve or are refused",
  ];
  if (facts.hostexec !== null) {
    symptoms.push("a command becomes unresponsive for minutes");
  }
  if (facts.dind !== null) {
    symptoms.push("a docker build fails to reach the network");
  }
  if (facts.maskEnabled) {
    symptoms.push("output contains values that look wrong");
  }
  return (
    "Read before retrying or working around an unexpected failure inside " +
    "the nas sandbox: " +
    symptoms.join("; ") +
    ". Explains which sandbox constraint causes each, and which ones no " +
    "amount of retrying will get past."
  );
}

function networkSection(facts: GuideFacts): string {
  const denial =
    facts.network.fallback === "review"
      ? `A request to a domain outside the allowlist waits for approval on the host for up to ${facts.network.pendingTimeoutSeconds} seconds. A timeout means denial, not a transient error.`
      : "A request to a domain outside the allowlist fails immediately, and will fail the same way no matter how many times you retry.";

  return [
    "## Network is an allowlist proxy",
    "",
    denial,
    "",
    "The failure surfaces as a name-resolution error, so it is easy to read as",
    "\"this environment has no network\". It is not. Other domains work.",
    "",
    "There is no way to widen the allowlist from inside the container. If a",
    "domain you need is blocked, say so and ask the user to add it, rather than",
    "retrying, switching mirrors, or vendoring the dependency.",
  ].join("\n");
}

function forwardedPortsSection(facts: GuideFacts): string {
  return [
    "## Forwarded ports",
    "",
    `These host ports are reachable from inside the container: ${facts.network.forwardPorts.join(", ")}.`,
    "Any other host port is not.",
  ].join("\n");
}

function hostexecSection(facts: GuideFacts, hostexec: NonNullable<GuideFacts["hostexec"]>): string {
  const approval = hostexec.promptEnabled
    ? `Such a command can sit with no output for up to ${hostexec.timeoutSeconds} seconds while the user decides whether to approve it. **That is not a hang.** Do not kill it, do not retry it in another shell, and do not look for a workaround while it is waiting.`
    : "Such a command runs on the host under a fixed rule set, so its behaviour can differ from the same command run in the container.";

  return ["## Some commands run on the host", "", approval].join("\n");
}

function dindSection(): string {
  return [
    "## Docker builds cannot reach the network",
    "",
    "Docker works here, but a build container has no route out. Pulling a base",
    "image succeeds, because that goes through a proxied daemon, while anything",
    "the build itself fetches — `apt-get`, `pip`, `curl` — fails to resolve.",
    "",
    "So a Dockerfile that pulls fine and then dies on its first `apt-get` is not",
    "a broken Dockerfile. Do not rewrite it; use an image that already carries",
    "what you need, or tell the user the build needs network access.",
  ].join("\n");
}

function maskSection(): string {
  return [
    "## Output is masked",
    "",
    "Secret values are masked out of command output before you see it. A value",
    "that looks truncated or replaced is masked, not corrupt — reading it again",
    "will not reveal more.",
  ].join("\n");
}

function displaySection(facts: GuideFacts): string {
  return [
    "## GUI applications",
    "",
    `Graphical applications run under a ${facts.displaySandbox} display sandbox rather than the host's display.`,
  ].join("\n");
}

export function renderGuide(facts: GuideFacts): string {
  const sections: string[] = [
    [
      "# The nas sandbox",
      "",
      "You are running inside a container managed by nas. Several of its",
      "constraints produce failures that look like ordinary bugs, and reacting to",
      "them as bugs wastes the whole attempt. This page lists those cases.",
      "",
      "## Workspace",
      "",
      `Your workspace is \`${facts.workDir}\`. Paths outside it are either invisible or not persisted.`,
    ].join("\n"),
    networkSection(facts),
  ];

  if (facts.network.forwardPorts.length > 0) {
    sections.push(forwardedPortsSection(facts));
  }
  if (facts.hostexec !== null) {
    sections.push(hostexecSection(facts, facts.hostexec));
  }
  if (facts.dind !== null) {
    sections.push(dindSection());
  }
  if (facts.maskEnabled) {
    sections.push(maskSection());
  }
  if (facts.displaySandbox !== "none") {
    sections.push(displaySection(facts));
  }
  if (facts.extra !== null) {
    sections.push(["## Notes for this environment", "", facts.extra].join("\n"));
  }

  const frontmatter = [
    "---",
    `name: ${GUIDE_SKILL_NAME}`,
    `description: ${buildDescription(facts)}`,
    "---",
  ].join("\n");

  return `${frontmatter}\n\n${sections.join("\n\n")}\n`;
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `bun test src/stages/guide/content_test.ts`
Expected: PASS（11 tests）

注意: `renderGuide(makeFacts())` が `"host"` を含まないという表明があるため、常時出力されるセクションに `host` という語を入れないこと。テストが落ちたら文面を直す（テストの表明を緩めない）。

- [ ] **Step 5: コミット**

```bash
git add src/stages/guide/content.ts src/stages/guide/content_test.ts
git commit  # feat(guide): render the guide body from facts
```

body には「description が常時 system prompt に載るため、無効な機能の症状を書くとエージェントを実在しない原因の調査に誘導すること」を書く。

---

### Task 3: GuideService

**Files:**
- Create: `src/stages/guide/guide_service.ts`
- Test: `src/stages/guide/guide_service_test.ts`

**Interfaces:**
- Consumes: なし（`FsService` を Live が要求する）
- Produces:
  - `interface GuideWritePlan { readonly dir: string; readonly content: string }`
  - `interface GuideHandle { readonly close: () => Effect.Effect<void> }`
  - `class GuideService`（Tag）with `readonly write: (plan: GuideWritePlan) => Effect.Effect<GuideHandle>`
  - `const GuideServiceLive: Layer.Layer<GuideService, never, FsService>`
  - `function makeGuideServiceFake(overrides?): Layer.Layer<GuideService>` — `writes` 配列を併せて返す

- [ ] **Step 1: 失敗するテストを書く**

`src/stages/guide/guide_service_test.ts` を作成する:

```typescript
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { FsServiceLive } from "../../services/fs.ts";
import { GuideService, GuideServiceLive } from "./guide_service.ts";

describe("GuideServiceLive", () => {
  test("writes SKILL.md into the given directory and removes it on close", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "nas-guide-"));
    const dir = path.join(base, "nas-sandbox");
    try {
      const skillPath = path.join(dir, "SKILL.md");

      const handle = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* GuideService;
          return yield* service.write({ dir, content: "---\nname: x\n---\n" });
        }).pipe(Effect.provide(GuideServiceLive.pipe(Layer.provide(FsServiceLive)))),
      );

      expect(await readFile(skillPath, "utf8")).toBe("---\nname: x\n---\n");

      await Effect.runPromise(handle.close());

      await expect(stat(dir)).rejects.toThrow();
    } finally {
      await rm(base, { recursive: true, force: true }).catch(() => {});
    }
  });
});
```

`GuideServiceLive` は `FsService` を要求する `Layer` なので、`Layer.provide(FsServiceLive)` で依存を閉じてから `Effect.provide` に渡す。

- [ ] **Step 2: テストが落ちることを確認**

Run: `bun test src/stages/guide/guide_service_test.ts`
Expected: FAIL — `Cannot find module './guide_service.ts'`

- [ ] **Step 3: guide_service.ts を実装**

`src/stages/guide/guide_service.ts` を作成する。各メソッドは D1（プリミティブ 1 呼び出し）に留め、合成は `write` の中で `FsService` のメソッドを順に呼ぶだけにする:

```typescript
/**
 * GuideService — 生成済みガイドをホスト側の runtime dir に置き、
 * セッション終了時に片付けるところまでを 1 つの意図として持つ。
 */

import { Context, Effect, Layer } from "effect";
import * as path from "node:path";
import { FsService } from "../../services/fs.ts";

export interface GuideWritePlan {
  /** `SKILL.md` を置くディレクトリ。skill 名のディレクトリそのもの。 */
  readonly dir: string;
  readonly content: string;
}

export interface GuideHandle {
  readonly close: () => Effect.Effect<void>;
}

export class GuideService extends Context.Tag("nas/GuideService")<
  GuideService,
  {
    readonly write: (plan: GuideWritePlan) => Effect.Effect<GuideHandle>;
  }
>() {}

export const GuideServiceLive: Layer.Layer<GuideService, never, FsService> =
  Layer.effect(
    GuideService,
    Effect.gen(function* () {
      const fs = yield* FsService;
      return GuideService.of({
        write: (plan) =>
          Effect.gen(function* () {
            yield* fs.mkdir(plan.dir, { recursive: true, mode: 0o755 });
            yield* fs.writeFile(path.join(plan.dir, "SKILL.md"), plan.content, {
              mode: 0o644,
            });
            return {
              close: () =>
                fs
                  .rm(plan.dir, { recursive: true, force: true })
                  .pipe(Effect.catchAll(() => Effect.void)),
            };
          }).pipe(Effect.orDie),
      });
    }),
  );

export interface GuideServiceFakeConfig {
  readonly write?: (plan: GuideWritePlan) => Effect.Effect<GuideHandle>;
}

export interface GuideServiceFake {
  readonly layer: Layer.Layer<GuideService>;
  /** 呼び出された write の記録。テストが表明に使う。 */
  readonly writes: GuideWritePlan[];
}

export function makeGuideServiceFake(
  overrides: GuideServiceFakeConfig = {},
): GuideServiceFake {
  const writes: GuideWritePlan[] = [];
  const layer = Layer.succeed(
    GuideService,
    GuideService.of({
      write:
        overrides.write ??
        ((plan) =>
          Effect.sync(() => {
            writes.push(plan);
            return { close: () => Effect.void };
          })),
    }),
  );
  return { layer, writes };
}
```

`FsService.mkdir` / `writeFile` / `rm` の正確なシグネチャは `src/services/fs.ts` を読んで合わせること。引数の形が上と違う場合は実装側を合わせる（テストの表明は変えない）。

- [ ] **Step 4: テストが通ることを確認**

Run: `bun test src/stages/guide/guide_service_test.ts`
Expected: PASS（1 test）

Run: `bun run check`
Expected: エラーなし

- [ ] **Step 5: コミット**

```bash
git add src/stages/guide/guide_service.ts src/stages/guide/guide_service_test.ts
git commit  # feat(guide): write the generated guide behind a service
```

---

### Task 4: ステージ本体と barrel

**Files:**
- Create: `src/stages/guide/stage.ts`
- Create: `src/stages/guide.ts`
- Test: `src/stages/guide/stage_test.ts`

**Interfaces:**
- Consumes: `profileToGuideFacts`（Task 1）、`renderGuide`（Task 2）、`GuideService` / `makeGuideServiceFake`（Task 3）
- Produces:
  - `const GUIDE_CLAUDE_ADD_DIR = "/opt/nas/guide"`
  - `interface GuidePlan { readonly hostDir: string; readonly content: string; readonly mounts: readonly MountSpec[]; readonly extraArgs: readonly string[] }`
  - `function planGuide(input: GuideStageInput): GuidePlan | null` — `guide.enable` が false なら null
  - `function createGuideStage(shared: StageInput): Stage<"container", Pick<StageResult, "container">, GuideService, unknown>`

- [ ] **Step 1: 失敗するテストを書く**

`src/stages/guide/stage_test.ts` を作成する:

```typescript
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  DEFAULT_DOCKER_CONFIG,
  DEFAULT_GUIDE_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  type Profile,
} from "../../config/types.ts";
import { emptyContainerPlan, mergeContainerPlan } from "../../pipeline/container_plan.ts";
import type { ContainerPlan } from "../../pipeline/state.ts";
import type { StageInput } from "../../pipeline/types.ts";
import { makeGuideServiceFake } from "./guide_service.ts";
import { createGuideStage, GUIDE_CLAUDE_ADD_DIR, planGuide } from "./stage.ts";

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    agent: "claude",
    agentArgs: [],
    session: { multiplex: false, detachKey: "^\\", notify: "auto" },
    nix: { enable: "auto", mountSocket: true, extraPackages: [] },
    docker: DEFAULT_DOCKER_CONFIG,
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    network: DEFAULT_NETWORK_CONFIG,
    dbus: { session: { enable: false, see: [], talk: [], own: [], calls: [], broadcasts: [] } },
    display: { sandbox: "none", size: "1280x800" },
    extraMounts: [],
    env: [],
    hook: {},
    secrets: {},
    guide: DEFAULT_GUIDE_CONFIG,
    ...overrides,
  } as Profile;
}

function makeInput(
  profileOverrides: Partial<Profile> = {},
  agent: "claude" | "codex" | "copilot" = "claude",
): StageInput & { container: ContainerPlan } {
  const container = mergeContainerPlan(emptyContainerPlan("img", "/work/repo"), {
    env: { static: { NAS_HOME: "/home/nas" } },
    command: { agentCommand: [agent], extraArgs: [] },
  });
  return {
    config: {} as StageInput["config"],
    profile: makeProfile({ agent, ...profileOverrides }),
    profileName: "test",
    sessionId: "sess-1",
    host: {
      home: "/home/user",
      user: "user",
      uid: 1000,
      gid: 1000,
      isWSL: false,
      env: new Map([["XDG_RUNTIME_DIR", "/run/user/1000"]]),
    },
    probes: {} as StageInput["probes"],
    container,
  };
}

describe("planGuide", () => {
  test("returns null when the guide is disabled", () => {
    expect(planGuide(makeInput({ guide: { enable: false } }))).toBeNull();
  });

  test("mounts into ~/.agents/skills for codex", () => {
    const plan = planGuide(makeInput({ guide: { enable: true } }, "codex"));

    expect(plan?.mounts).toEqual([
      {
        source: "/run/user/1000/nas/guide/sess-1/nas-sandbox",
        target: "/home/nas/.agents/skills/nas-sandbox",
        readOnly: true,
      },
    ]);
    expect(plan?.extraArgs).toEqual([]);
  });

  test("mounts into ~/.agents/skills for copilot", () => {
    const plan = planGuide(makeInput({ guide: { enable: true } }, "copilot"));

    expect(plan?.mounts[0]?.target).toBe("/home/nas/.agents/skills/nas-sandbox");
  });

  test("mounts into a neutral dir and adds --add-dir for claude", () => {
    const plan = planGuide(makeInput({ guide: { enable: true } }, "claude"));

    expect(plan?.mounts[0]?.target).toBe(
      `${GUIDE_CLAUDE_ADD_DIR}/.claude/skills/nas-sandbox`,
    );
    expect(plan?.extraArgs).toEqual(["--add-dir", GUIDE_CLAUDE_ADD_DIR]);
  });

  test("never mounts the guide writable", () => {
    for (const agent of ["claude", "codex", "copilot"] as const) {
      const plan = planGuide(makeInput({ guide: { enable: true } }, agent));
      expect(plan?.mounts.every((m) => m.readOnly === true)).toBe(true);
    }
  });

  test("carries the rendered content", () => {
    const plan = planGuide(makeInput({ guide: { enable: true } }));

    expect(plan?.content).toContain("name: nas-sandbox");
    expect(plan?.content).toContain("/work/repo");
  });
});

describe("createGuideStage", () => {
  test("leaves the container plan untouched when disabled", async () => {
    const fake = makeGuideServiceFake();
    const input = makeInput({ guide: { enable: false } });

    const result = await Effect.runPromise(
      Effect.scoped(
        createGuideStage(input).run({ container: input.container }).pipe(
          Effect.provide(fake.layer),
        ),
      ),
    );

    expect(fake.writes).toEqual([]);
    expect(result.container).toBe(input.container);
  });

  test("writes the guide and patches mounts and args when enabled", async () => {
    const fake = makeGuideServiceFake();
    const input = makeInput({ guide: { enable: true } });

    const result = await Effect.runPromise(
      Effect.scoped(
        createGuideStage(input).run({ container: input.container }).pipe(
          Effect.provide(fake.layer),
        ),
      ),
    );

    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0]?.content).toContain("name: nas-sandbox");
    expect(result.container?.mounts).toHaveLength(1);
    expect(result.container?.command.extraArgs).toEqual([
      "--add-dir",
      GUIDE_CLAUDE_ADD_DIR,
    ]);
  });
});
```

`makeProfile` は `facts_test.ts` と同じ本体をこのファイルにも置く。テストヘルパを共有モジュールに切り出さない — フィクスチャがテストファイル内で自足しているほうが、片方のテストの都合で他方が壊れない。

- [ ] **Step 2: テストが落ちることを確認**

Run: `bun test src/stages/guide/stage_test.ts`
Expected: FAIL — `Cannot find module './stage.ts'`

- [ ] **Step 3: stage.ts を実装**

`src/stages/guide/stage.ts` を作成する:

```typescript
import { Effect } from "effect";
import * as path from "node:path";
import { resolveRuntimeSubdir } from "../../lib/runtime_dir.ts";
import { mergeContainerPlan } from "../../pipeline/container_plan.ts";
import type { Stage } from "../../pipeline/stage_builder.ts";
import type { MountSpec, PipelineState } from "../../pipeline/state.ts";
import type { StageInput, StageResult } from "../../pipeline/types.ts";
import { GUIDE_SKILL_NAME, renderGuide } from "./content.ts";
import { profileToGuideFacts } from "./facts.ts";
import { GuideService } from "./guide_service.ts";

/**
 * Claude Code は ~/.agents/skills を読まず、~/.claude はホストから RW で
 * bind mount されている。中立なディレクトリに置いて --add-dir で拾わせる。
 */
export const GUIDE_CLAUDE_ADD_DIR = "/opt/nas/guide";

export type GuideStageInput = StageInput & Pick<PipelineState, "container">;

export interface GuidePlan {
  readonly hostDir: string;
  readonly content: string;
  readonly mounts: readonly MountSpec[];
  readonly extraArgs: readonly string[];
}

function containerTarget(agent: StageInput["profile"]["agent"], containerHome: string): {
  readonly target: string;
  readonly extraArgs: readonly string[];
} {
  if (agent === "claude") {
    return {
      target: `${GUIDE_CLAUDE_ADD_DIR}/.claude/skills/${GUIDE_SKILL_NAME}`,
      extraArgs: ["--add-dir", GUIDE_CLAUDE_ADD_DIR],
    };
  }
  // codex と copilot はどちらも ~/.agents/skills を読む。nas はホストの
  // ~/.agents をマウントしないので、この位置は衝突しない。
  return {
    target: `${containerHome}/.agents/skills/${GUIDE_SKILL_NAME}`,
    extraArgs: [],
  };
}

export function planGuide(input: GuideStageInput): GuidePlan | null {
  if (!input.profile.guide.enable) return null;

  const containerHome = input.container.env.static.NAS_HOME;
  if (containerHome === undefined) return null;

  const hostDir = path.join(
    resolveRuntimeSubdir(input.host, "guide"),
    input.sessionId,
    GUIDE_SKILL_NAME,
  );
  const { target, extraArgs } = containerTarget(input.profile.agent, containerHome);
  const facts = profileToGuideFacts(input.profile, input.container.workDir);

  return {
    hostDir,
    content: renderGuide(facts),
    mounts: [{ source: hostDir, target, readOnly: true }],
    extraArgs,
  };
}

export function createGuideStage(
  shared: StageInput,
): Stage<"container", Pick<StageResult, "container">, GuideService, unknown> {
  return {
    name: "GuideStage",
    needs: ["container"],
    run(input) {
      return Effect.gen(function* () {
        const plan = planGuide({ ...shared, ...input });
        if (plan === null) return { container: input.container };

        const service = yield* GuideService;
        yield* Effect.acquireRelease(
          service.write({ dir: plan.hostDir, content: plan.content }),
          (handle) =>
            handle.close().pipe(
              Effect.catchAll(() => Effect.logWarning("guide cleanup failed")),
            ),
        );

        return {
          container: mergeContainerPlan(input.container, {
            mounts: plan.mounts,
            command: {
              agentCommand: input.container.command.agentCommand,
              extraArgs: [...input.container.command.extraArgs, ...plan.extraArgs],
            },
          }),
        };
      });
    },
  };
}
```

- [ ] **Step 4: barrel を作成**

`src/stages/guide.ts`:

```typescript
/**
 * guide ステージ — barrel re-export
 */

export { GUIDE_SKILL_NAME, renderGuide } from "./guide/content.ts";
export { type GuideFacts, profileToGuideFacts } from "./guide/facts.ts";
export {
  GuideService,
  type GuideServiceFake,
  GuideServiceLive,
  type GuideWritePlan,
  makeGuideServiceFake,
} from "./guide/guide_service.ts";
export {
  createGuideStage,
  GUIDE_CLAUDE_ADD_DIR,
  type GuidePlan,
  planGuide,
} from "./guide/stage.ts";
```

- [ ] **Step 5: テストが通ることを確認**

Run: `bun test src/stages/guide/`
Expected: PASS（全ファイル）

Run: `bun run check`
Expected: エラーなし

- [ ] **Step 6: コミット**

```bash
git add src/stages/guide.ts src/stages/guide/stage.ts src/stages/guide/stage_test.ts
git commit  # feat(guide): mount the guide where each agent looks for skills
```

body には「なぜ ~/.claude ではなく --add-dir なのか」（ホストから RW マウントされており、ネストしたマウントはホストに空ディレクトリを残す）を書く。

---

### Task 5: パイプラインへの配線

**Files:**
- Modify: `src/pipeline/types.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Consumes: `createGuideStage`, `GuideService`, `GuideServiceLive`（Task 4）
- Produces: 実行時に有効なガイドステージ

- [ ] **Step 1: StageServices に追加**

`src/pipeline/types.ts` の import に追加:

```typescript
import type { GuideService } from "../stages/guide.ts";
```

`StageServices` union に `| GuideService` を（アルファベット順の位置に）追加する。

- [ ] **Step 2: cli.ts にステージを登録**

`src/cli.ts` の import に追加:

```typescript
import { createGuideStage, GuideServiceLive } from "./stages/guide.ts";
```

ステージチェーンで `.add(createHostExecStage(input))` の直後に挿入する:

```typescript
      .add(createGuideStage(input))
```

`NAS_HOME` を確定させる mount ステージより後、`command.extraArgs` を確定させる launch ステージより前である必要がある。

- [ ] **Step 3: Live layer を登録**

`liveLayer` の `Layer.mergeAll(...)` に追加する。`GuideServiceLive` は `FsService` を要求するので:

```typescript
      GuideServiceLive.pipe(Layer.provide(FsServiceLive)),
```

- [ ] **Step 4: 型チェックと既存テスト**

Run: `bun run check`
Expected: エラーなし

Run: `bun run test:unit`
Expected: PASS（既存テストの回帰なし）

- [ ] **Step 5: コミット**

```bash
git add src/pipeline/types.ts src/cli.ts
git commit  # feat(guide): run the guide stage between mount and launch
```

body にはステージ順序の制約（NAS_HOME の後、extraArgs 確定の前）を書く。

---

### Task 6: integration テスト

**Files:**
- Create: `src/stages/guide/integration_test.ts`

**Interfaces:**
- Consumes: 完成したステージ

- [ ] **Step 1: integration テストを書く**

`src/stages/guide/integration_test.ts` を作成する。`test-policy` に従い、能力述語をこのファイルにローカルで定義し、`skipIf` でガードし、`finally` で後始末する:

```typescript
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

async function isDockerAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["docker", "info"], { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

const dockerAvailable = await isDockerAvailable();
const tmpDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tmpDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})),
  );
});

test.skipIf(!dockerAvailable)(
  "a read-only guide mount is visible at the container path",
  async () => {
    const hostDir = await mkdtemp(path.join(tmpdir(), "nas-guide-int-"));
    tmpDirs.push(hostDir);
    const skillDir = path.join(hostDir, "nas-sandbox");
    await Bun.write(path.join(skillDir, "SKILL.md"), "---\nname: nas-sandbox\n---\n");

    const target = "/home/nas/.agents/skills/nas-sandbox";
    const proc = Bun.spawn(
      [
        "docker", "run", "--rm",
        "-v", `${skillDir}:${target}:ro`,
        "alpine:3",
        "sh", "-c",
        `cat ${target}/SKILL.md && (touch ${target}/probe 2>/dev/null && echo WRITABLE || echo READONLY)`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toContain("name: nas-sandbox");
    expect(stdout).toContain("READONLY");
  },
);
```

このテストが確かめるのは「read-only bind mount がコンテナ内で読めて書けない」という、ステージが依存している Docker の挙動である。ステージ自身の分岐は Task 4 の unit テストが覆っている。

- [ ] **Step 2: テストを実行**

Run: `bun test src/stages/guide/integration_test.ts`
Expected: PASS、または Docker が無ければ skip として報告される

- [ ] **Step 3: unit レーンに紛れ込んでいないことを確認**

Run: `bun run test:unit 2>&1 | grep -c "guide/integration"`
Expected: `0`（ファイル名が `integration_test.ts` で終わるため unit レーンから除外される）

- [ ] **Step 4: コミット**

```bash
git add src/stages/guide/integration_test.ts
git commit  # test(guide): confirm the guide mount is readable and read-only
```

---

### Task 7: ユーザー向けドキュメント

**Files:**
- Create: `docs-site/src/content/docs/features/agent-guide.md`
- Modify: `docs-site/astro.config.mjs`（サイドバーに項目がある場合）

**Interfaces:**
- Consumes: 完成した機能

- [ ] **Step 1: 既存の features ページの体裁を確認**

Run: `head -40 docs-site/src/content/docs/features/hostexec.md`

frontmatter の形（`title`, `description`）とサイドバー登録の方法を確認する。`docs-site/AGENTS.md` があれば先に読む。

- [ ] **Step 2: ページを書く**

`docs-site/src/content/docs/features/agent-guide.md` を作成する。既存ページの frontmatter 形式に合わせたうえで、以下を扱う:

- 何のための機能か: サンドボックスの制約が「普通のバグ」に見える失敗を生み、エージェントがそれを誤診して無駄な回避策に走る。その誤診を防ぐ。
- 有効化の方法:

  ```pkl
  guide {
    enable = true
  }
  ```

- `extra` で環境固有の注意を足せること:

  ```pkl
  guide {
    enable = true
    extra = """
    このリポジトリでは commit 前に `just fmt` を実行すること。
    """
  }
  ```

- 内容がプロファイルから生成されること。無効な機能の話は載らない。
- エージェントごとのマウント先（`~/.agents/skills/nas-sandbox`、Claude は `--add-dir /opt/nas/guide`）。
- 生成物にシークレットが含まれないこと、read-only であること。

- [ ] **Step 3: サイドバーに登録**

`docs-site/astro.config.mjs` の features セクションに項目を追加する（既存項目の形に合わせる）。

- [ ] **Step 4: ドキュメントサイトのチェックを実行**

Run: `bun test src/docs/site_check_test.ts`
Expected: PASS（リンク切れ・未登録ページの検出）

- [ ] **Step 5: コミット**

```bash
git add docs-site/
git commit  # docs(guide): document enabling the agent guide
```

---

## 完了後

Run: `bun run check && bun run test:unit`
Expected: すべて PASS

`skills/post-change-checks/SKILL.md` の手順で最終確認を行う。フルスイート（`bun run test`）はサンドボックス内では一部がスキップされる。スキップの有無を報告に含めること。
