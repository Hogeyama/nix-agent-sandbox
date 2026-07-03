# mitmproxy リクエストマスク Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MaskConfig の秘密値をエージェント発の HTTP リクエスト(ボディ・URL・ヘッダー)から `****` に置換する。あわせて `mask.maskfs` / `mask.proxy` の対象別有効フラグを追加する。

**Architecture:** ProxyStage がホスト側で秘密値を解決し、SessionBroker がメモリ保持して allow decision の `maskValues` フィールドでアドオンに渡す(credential 注入 `injectHeaders` と同経路、ディスク書き込みなし)。`nas_addon.py` は allow 受信後・credential 注入前に置換する。broker は受信した `reviewContext` を自前でマスクし、pending エントリ・監査ログ・UI への漏洩も塞ぐ。

**Tech Stack:** Bun + TypeScript + Effect(パイプライン)、Python(mitmproxy addon)、Pkl(設定スキーマ)

**Spec:** `docs/superpowers/specs/2026-07-03-mask-mitmproxy-design.md`(必読)

## Global Constraints

- **必読スキル**: 実装者・レビュアーは Skill ツールで `effect-separation`(stage/service を触るタスク)と `test-policy`(全タスク)を読むこと
- 各タスクの最後に `bun run check` と `bun test src/<触ったディレクトリ>` を実行して green を確認してからコミットする
- 置換文字列は **`****`(固定4文字)**。同一長置換にしない
- 秘密値の最低長ガードは **4バイト**(既存 `MIN_SECRET_BYTES` を共用)。base64 確定部分文字列の最低長は **8文字**(`B64_MIN_PATTERN_LEN = 8`)
- 秘密値をディスクに書かない。ログ・エラーメッセージに秘密値そのものを含めない
- テスト命名: unit は `*_test.ts` で co-location(test-policy 準拠)
- ブランチ: `mask-mitmproxy`(作成済み。この上でコミットを積む)
- パターン展開ロジック(percent / base64 バリアント)は TS(`src/network/mask_patterns.ts`)と Python(`nas_addon.py`)の2実装が存在する。**片方を変更したらもう片方も揃える**こと(両ファイル冒頭コメントに相互参照を書く)

---

### Task 1: 設定 — `mask.maskfs` / `mask.proxy` フラグ

**Files:**
- Modify: `src/config/Schema.pkl`(`class MaskConfig`、330行目付近)
- Modify: `src/config/types.ts:206-209`(`MaskConfig`)
- Modify: `src/config/validate.ts:108-111`(mask セクション)
- Modify: `src/config/validate_mask_test.ts`(既存 fixture 更新 + 新テスト)
- Modify: `src/stages/maskfs/stage_test.ts`(fixture 更新のみ)

**Interfaces:**
- Produces: `MaskConfig` に必須フィールド `maskfs: boolean` / `proxy: boolean`(Pkl デフォルト true)。後続タスクは `profile.mask.maskfs` / `profile.mask.proxy` を参照する

- [ ] **Step 1: 失敗するテストを書く**

`src/config/validate_mask_test.ts` に追加(既存の `makeProfile` / `makeConfig` ヘルパーを使う):

```typescript
test("rejects non-boolean maskfs / proxy flags", () => {
  const config = makeConfig(
    makeProfile({
      mask: {
        values: [{ source: "env:MY_SECRET" }],
        writePolicy: "readonly",
        // biome-ignore lint/suspicious/noExplicitAny: 型エラーを意図的に作る
        maskfs: "yes" as any,
        // biome-ignore lint/suspicious/noExplicitAny: 型エラーを意図的に作る
        proxy: 1 as any,
      },
    }),
  );
  expect(() => validateConfig(config)).toThrow(ConfigValidationError);
  try {
    validateConfig(config);
  } catch (e) {
    const msg = String(e);
    expect(msg).toContain("mask.maskfs must be a boolean");
    expect(msg).toContain("mask.proxy must be a boolean");
  }
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `bun test src/config/validate_mask_test.ts`
Expected: FAIL(型エラーでコンパイルが落ちる、または `not to throw`)。既存テストも `maskfs`/`proxy` 欠落の型エラーで落ちる — それが次の Step の作業リスト

- [ ] **Step 3: 型・スキーマ・バリデーションを実装**

`src/config/types.ts` の `MaskConfig` を拡張:

```typescript
export interface MaskConfig {
  values: MaskValueConfig[];
  writePolicy: MaskWritePolicy;
  /** FUSE ワークスペースマスク (maskfs) の有効化。デフォルト true */
  maskfs: boolean;
  /** mitmproxy リクエストマスクの有効化。デフォルト true */
  proxy: boolean;
}
```

`src/config/Schema.pkl` の `class MaskConfig` 末尾にフィールド追加:

```pkl
  /// FUSE ワークスペースマスク (maskfs) を有効にするか。
  /// 秘密値が git にコミットされているリポジトリでは、マスク後の内容が
  /// index と一致せずワークツリーが常に dirty に見えるため false にする。
  maskfs: Boolean = true

  /// mitmproxy によるリクエストマスク (ボディ・URL・ヘッダーの秘密値置換) を
  /// 有効にするか。network proxy が有効なセッションでのみ効果がある。
  proxy: Boolean = true
```

`src/config/validate.ts` の mask セクション(108行目付近)を拡張:

```typescript
  // --- mask ---
  if (profile.mask) {
    errors.push(...validateMaskValues(name, profile.mask.values));
    if (typeof profile.mask.maskfs !== "boolean") {
      errors.push(`profile "${name}": mask.maskfs must be a boolean`);
    }
    if (typeof profile.mask.proxy !== "boolean") {
      errors.push(`profile "${name}": mask.proxy must be a boolean`);
    }
  }
```

- [ ] **Step 4: 既存 fixture を更新**

`grep -rn "writePolicy" src tests --include="*.ts"` で TS リテラルの `MaskConfig` 構築箇所を洗い出し、すべてに `maskfs: true, proxy: true` を追加する。現時点の該当: `src/config/validate_mask_test.ts`(複数)、`src/stages/maskfs/stage_test.ts`(119行目付近と150行目付近)。`tests/maskfs_e2e_test.ts` は Pkl テキストなので変更不要(Pkl デフォルトが効く)

- [ ] **Step 5: テストが通ることを確認**

Run: `bun run check && bun test src/config src/stages/maskfs`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add src/config/Schema.pkl src/config/types.ts src/config/validate.ts src/config/validate_mask_test.ts src/stages/maskfs/stage_test.ts
git commit -m "feat(config): add mask.maskfs / mask.proxy enable flags"
```

---

### Task 2: MaskFsStage — `mask.maskfs = false` でスキップ

**Files:**
- Modify: `src/stages/maskfs/stage.ts:43-46`(skip 判定)
- Test: `src/stages/maskfs/stage_test.ts`

**Interfaces:**
- Consumes: Task 1 の `MaskConfig.maskfs: boolean`
- Produces: なし(挙動変更のみ)

- [ ] **Step 1: 失敗するテストを書く**

`src/stages/maskfs/stage_test.ts` に追加。既存の「no mask config → workspace passthrough, no daemon start」テスト(89行目付近)をコピーし、mask 設定ありで `maskfs: false` の場合にデーモンが起動しないことを検証する(fake の `startMaskFs` / `resolveSecrets` が呼ばれたら fail するフラグを既存テストと同じ手法で立てる):

```typescript
test("mask.maskfs=false → workspace passthrough, no daemon start", async () => {
  const input = makeStageInput();
  input.profile.mask = {
    values: [{ source: "env:SECRET" }],
    writePolicy: "readonly",
    maskfs: false,
    proxy: true,
  };
  let started = false;
  const stage = createMaskFsStage(input, makeMountProbes(), {
    resolveBinPath: async () => "/fake/nas-maskfs",
  });
  const result = await Effect.runPromise(
    Effect.scoped(
      stage.run({ workspace: makeWorkspace() }).pipe(
        Effect.provide(
          makeMaskFsServiceFake({
            startMaskFs: () =>
              Effect.sync(() => {
                started = true;
                return { kill: () => {} };
              }),
          }),
        ),
      ),
    ),
  );
  expect(started).toEqual(false);
  expect(result.workspace.maskedRoot).toBeUndefined();
});
```

(ヘルパー名 `makeStageInput` / `makeMountProbes` / `makeWorkspace` は同ファイルの既存テストが使っているものに合わせて読み替える)

- [ ] **Step 2: テストが失敗することを確認**

Run: `bun test src/stages/maskfs/stage_test.ts`
Expected: FAIL(`started` が true になる、または maskedRoot が設定される)

- [ ] **Step 3: skip 判定を実装**

`src/stages/maskfs/stage.ts` の `run()` 冒頭:

```typescript
      const mask = shared.profile.mask;
      if (!mask || !mask.maskfs || mask.values.length === 0) {
        return Effect.succeed({ workspace: input.workspace });
      }
```

- [ ] **Step 4: テストが通ることを確認**

Run: `bun run check && bun test src/stages/maskfs`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/stages/maskfs/stage.ts src/stages/maskfs/stage_test.ts
git commit -m "feat(maskfs): skip mount when mask.maskfs is false"
```

---

### Task 3: `mask_patterns.ts` — パターン展開と reviewContext マスクの純粋関数

**Files:**
- Create: `src/network/mask_patterns.ts`
- Test: `src/network/mask_patterns_test.ts`

**Interfaces:**
- Consumes: `ReviewContext`(`src/network/protocol.ts`)
- Produces(後続タスクが使う正確なシグネチャ):
  - `expandMaskPatterns(values: string[]): string[]` — 生値 + percent(quote / quote_plus 相当) + base64 確定部分文字列(3アライメント × 標準/URL-safe)。重複除去済み・**長い順ソート**
  - `maskText(text: string, patterns: string[]): string` — 逐次 `replaceAll` で `****` 置換
  - `maskReviewContext(ctx: ReviewContext | undefined, values: string[]): ReviewContext | undefined`
  - `B64_MIN_PATTERN_LEN = 8`(export、Python 実装と共通の値)

- [ ] **Step 1: 失敗するテストを書く**

`src/network/mask_patterns_test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import {
  expandMaskPatterns,
  maskReviewContext,
  maskText,
} from "./mask_patterns.ts";

describe("expandMaskPatterns", () => {
  test("includes raw value", () => {
    expect(expandMaskPatterns(["s3cret-value"])).toContain("s3cret-value");
  });

  test("includes percent-encoded variants (quote / quote_plus)", () => {
    const patterns = expandMaskPatterns(["p@ss w+rd"]);
    // Python: urllib.parse.quote("p@ss w+rd", safe="") 相当
    expect(patterns).toContain("p%40ss%20w%2Brd");
    // Python: urllib.parse.quote_plus("p@ss w+rd") 相当 (space → +)
    expect(patterns).toContain("p%40ss+w%2Brd");
  });

  test("includes base64 confident substrings for all 3 alignments", () => {
    const secret = "s3cret-value-long";
    const patterns = expandMaskPatterns([secret]);
    const raw = new TextEncoder().encode(secret);
    for (let k = 0; k < 3; k++) {
      // 秘密値が offset k で埋め込まれた base64 ストリームを再現し、
      // いずれかのパターンが部分文字列として見つかることを確認する
      const prefix = new Uint8Array(k).fill(0x41); // "A" 埋め
      const stream = new Uint8Array([...prefix, ...raw, 0x42, 0x43]);
      const encoded = Buffer.from(stream).toString("base64");
      const hit = patterns.some((p) => encoded.includes(p));
      expect(hit).toBe(true);
    }
  });

  test("short secrets do not generate sub-minimum base64 patterns", () => {
    const patterns = expandMaskPatterns(["abcd"]); // 4 bytes
    for (const p of patterns) {
      // base64 確定部分文字列は 8 文字未満なら採用されない。
      // 生値・percent 変種 (どちらも "abcd") 以外は存在しないはず
      expect(p).toEqual("abcd");
    }
  });

  test("sorted longest-first", () => {
    const patterns = expandMaskPatterns(["shortpw1", "much-longer-secret"]);
    const lengths = patterns.map((p) => p.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
  });
});

describe("maskText", () => {
  test("replaces all occurrences with ****", () => {
    const patterns = expandMaskPatterns(["s3cret-value"]);
    expect(maskText("a=s3cret-value&b=s3cret-value", patterns)).toEqual(
      "a=****&b=****",
    );
  });

  test("longest pattern wins when one secret contains another", () => {
    const patterns = expandMaskPatterns(["s3cret", "s3cret-extended"]);
    expect(maskText("x=s3cret-extended", patterns)).toEqual("x=****");
  });
});

describe("maskReviewContext", () => {
  test("masks path and bodyPreview", () => {
    const ctx = maskReviewContext(
      {
        path: "/upload?token=s3cret-value",
        contentType: "application/x-www-form-urlencoded",
        bodyPreview: "data=s3cret-value",
        bodySize: 17,
      },
      ["s3cret-value"],
    );
    expect(ctx?.path).toEqual("/upload?token=****");
    expect(ctx?.bodyPreview).toEqual("data=****");
  });

  test("returns ctx unchanged when no values", () => {
    const ctx = {
      path: "/p",
      contentType: null,
      bodyPreview: "body",
      bodySize: 4,
    };
    expect(maskReviewContext(ctx, [])).toEqual(ctx);
    expect(maskReviewContext(undefined, ["s3cret-value"])).toBeUndefined();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `bun test src/network/mask_patterns_test.ts`
Expected: FAIL(モジュールが存在しない)

- [ ] **Step 3: 実装**

`src/network/mask_patterns.ts`:

```typescript
/**
 * mask_patterns — MaskConfig 秘密値の照合パターン展開と文字列マスク。
 *
 * broker が reviewContext (pending エントリ・監査ログ・レビュー UI に渡る)
 * をマスクするために使う。実際の HTTP リクエストのマスクは
 * src/docker/mitmproxy/nas_addon.py の同等実装が行う。
 * パターン展開ロジックを変更するときは両方を揃えること。
 */

import type { ReviewContext } from "./protocol.ts";

export const MASK_REPLACEMENT = "****";
/** base64 確定部分文字列の最低長。これ未満は誤マスク防止のため捨てる */
export const B64_MIN_PATTERN_LEN = 8;

/**
 * Python の urllib.parse.quote(value, safe="") / quote_plus(value) と同じ
 * 出力を生成する。unreserved (A-Za-z0-9_.~-) 以外を %XX にする。
 * plusForSpace が true のとき空白は "+" になる (quote_plus 相当)。
 */
function percentEncodeAll(value: string, plusForSpace: boolean): string {
  const bytes = new TextEncoder().encode(value);
  let out = "";
  for (const b of bytes) {
    const ch = String.fromCharCode(b);
    if (/[A-Za-z0-9_.~-]/.test(ch)) {
      out += ch;
    } else if (plusForSpace && ch === " ") {
      out += "+";
    } else {
      out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/**
 * base64 は3バイト単位でエンコードするため、秘密値がストリームのどの
 * オフセット (mod 3) に埋め込まれても検知できるよう、3アライメント分の
 * 「確定部分文字列」(隣接バイトの影響を受けない範囲) を生成する。
 * 標準/URL-safe 両アルファベット。truffleHog 等と同じ手法。
 */
function base64ConfidentSubstrings(value: string): string[] {
  const raw = new TextEncoder().encode(value);
  const out: string[] = [];
  for (let k = 0; k < 3; k++) {
    const prefixed = new Uint8Array(k + raw.length);
    prefixed.set(raw, k);
    const encoded = Buffer.from(prefixed).toString("base64").replace(/=+$/, "");
    // 先頭 k バイトの影響を受ける文字: i < 8k/6 → ceil(8k/6) 文字を落とす。
    // 末尾は後続バイトの影響を受け得るので floor(8(k+n)/6) 文字目まで。
    const start = Math.ceil((8 * k) / 6);
    const end = Math.floor((8 * (k + raw.length)) / 6);
    const candidate = encoded.slice(start, end);
    if (candidate.length >= B64_MIN_PATTERN_LEN) {
      out.push(candidate);
      out.push(candidate.replaceAll("+", "-").replaceAll("/", "_"));
    }
  }
  return out;
}

export function expandMaskPatterns(values: string[]): string[] {
  const patterns = new Set<string>();
  for (const value of values) {
    if (value.length === 0) continue;
    patterns.add(value);
    patterns.add(percentEncodeAll(value, false));
    patterns.add(percentEncodeAll(value, true));
    for (const p of base64ConfidentSubstrings(value)) {
      patterns.add(p);
    }
  }
  return [...patterns].sort((a, b) => b.length - a.length);
}

export function maskText(text: string, patterns: string[]): string {
  let out = text;
  for (const p of patterns) {
    out = out.replaceAll(p, MASK_REPLACEMENT);
  }
  return out;
}

/**
 * reviewContext (path / bodyPreview) をマスクする。
 * 既知の制限: bodyPreview は先頭 1024 バイトで切り詰められるため、
 * 秘密値がプレビュー境界をまたぐと先頭部分だけが残り得る (spec 参照)。
 */
export function maskReviewContext(
  ctx: ReviewContext | undefined,
  values: string[],
): ReviewContext | undefined {
  if (!ctx || values.length === 0) return ctx;
  const patterns = expandMaskPatterns(values);
  return {
    ...ctx,
    path: maskText(ctx.path, patterns),
    bodyPreview:
      ctx.bodyPreview === null ? null : maskText(ctx.bodyPreview, patterns),
  };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `bun run check && bun test src/network/mask_patterns_test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/network/mask_patterns.ts src/network/mask_patterns_test.ts
git commit -m "feat(network): add mask pattern expansion and reviewContext masking helpers"
```

---

### Task 4: protocol + broker — `maskValues` の保持・付与・reviewContext マスク

**Files:**
- Modify: `src/network/protocol.ts:49-58`(`DecisionResponse`)
- Modify: `src/network/broker.ts`(options / authorize / decorateAllow)
- Test: `src/network/broker_integration_test.ts`

**Interfaces:**
- Consumes: Task 3 の `maskReviewContext`
- Produces:
  - `DecisionResponse.maskValues?: string[]`(allow のときのみ、非空のときのみ付与)
  - `BrokerOptions.maskValues?: string[]`(`SessionBroker` コンストラクタオプション)

- [ ] **Step 1: 失敗するテストを書く**

`src/network/broker_integration_test.ts` に追加。同ファイルの既存ヘルパー `authorize(...)` / `waitForPending(...)` と mkdtemp / finally cleanup パターンに合わせる:

```typescript
test("SessionBroker: allow decision includes maskValues", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    reviewRules: [{ host: "example.com", action: "allow" }],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
    pendingNotify: "off",
    maskValues: ["s3cret-value"],
  });
  const socketPath = `${paths.brokersDir}/sess_test/sock`;
  await broker.start(socketPath);
  try {
    const response = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_mask1", "example.com", 443),
    );
    expect(response.decision).toEqual("allow");
    expect(response.maskValues).toEqual(["s3cret-value"]);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: deny decision does not include maskValues", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    reviewRules: [{ host: "example.com", action: "deny" }],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
    pendingNotify: "off",
    maskValues: ["s3cret-value"],
  });
  const socketPath = `${paths.brokersDir}/sess_test/sock`;
  await broker.start(socketPath);
  try {
    const response = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_mask2", "example.com", 443),
    );
    expect(response.decision).toEqual("deny");
    expect(response.maskValues).toBeUndefined();
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: pending entry reviewContext is masked", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    reviewRules: [{ action: "review" }],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
    pendingNotify: "off",
    maskValues: ["s3cret-value"],
  });
  const socketPath = `${paths.brokersDir}/sess_test/sock`;
  await broker.start(socketPath);
  try {
    const message = {
      ...authorize("sess_test", "req_mask3", "api.example.com", 443),
      reviewContext: {
        path: "/upload?token=s3cret-value",
        contentType: "application/x-www-form-urlencoded",
        bodyPreview: "data=s3cret-value",
        bodySize: 17,
      },
    };
    const authorizePromise = sendBrokerRequest<DecisionResponse>(
      socketPath,
      message,
    );
    const pending = await waitForPending(socketPath);
    expect(pending.items.length).toEqual(1);
    expect(pending.items[0].reviewContext?.path).toEqual("/upload?token=****");
    expect(pending.items[0].reviewContext?.bodyPreview).toEqual("data=****");
    await sendBrokerRequest(socketPath, {
      type: "approve",
      requestId: "req_mask3",
      scope: "host-port",
    });
    const decision = await authorizePromise;
    expect(decision.decision).toEqual("allow");
    expect(decision.maskValues).toEqual(["s3cret-value"]);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `bun test src/network/broker_integration_test.ts`
Expected: FAIL(`maskValues` オプションが型エラー / decision に含まれない)

- [ ] **Step 3: 実装**

`src/network/protocol.ts` の `DecisionResponse` に追加:

```typescript
export interface DecisionResponse {
  version: 1;
  type: "decision";
  requestId: string;
  decision: Decision;
  scope?: ApprovalScope;
  reason: string;
  message?: string;
  injectHeaders?: InjectHeader[];
  /** allow のとき、プロキシがリクエストから ****
   * へ置換すべき秘密値 (nas_addon.py が消費)。 */
  maskValues?: string[];
}
```

`src/network/broker.ts`:

1. import に `maskReviewContext` を追加: `import { maskReviewContext } from "./mask_patterns.ts";`
2. `BrokerOptions` に追加:

```typescript
  /** Secrets to mask out of outgoing requests. Attached to allow decisions
   * and used to sanitize incoming reviewContext. */
  maskValues?: string[];
```

3. フィールドとコンストラクタ:

```typescript
  private readonly maskValues: string[];
  // constructor 内:
  this.maskValues = options.maskValues ?? [];
```

4. `authorize()` の先頭(`const targetStr = ...` の直前)で reviewContext を受信時マスク:

```typescript
  private async authorize(
    message: AuthorizeRequest,
  ): Promise<DecisionResponse> {
    if (this.maskValues.length > 0 && message.reviewContext) {
      message = {
        ...message,
        reviewContext: maskReviewContext(message.reviewContext, this.maskValues),
      };
    }
    const targetStr = `${message.target.host}:${message.target.port}`;
    // ... 以下既存のまま
```

5. allow decision への付与。`injectCredentialHeaders` の呼び出し3箇所(approved 済みキャッシュ、review-rule allow、`resolveGroup` の allow)を `decorateAllow` に置き換え、メソッドを追加:

```typescript
  /** allow decision に credential 注入と maskValues 付与をまとめて行う */
  private decorateAllow(
    decision: DecisionResponse,
    message: AuthorizeRequest,
  ): DecisionResponse {
    const withCreds = this.injectCredentialHeaders(decision, message);
    if (withCreds.decision !== "allow" || this.maskValues.length === 0) {
      return withCreds;
    }
    return { ...withCreds, maskValues: this.maskValues };
  }
```

置き換え箇所(現行行番号): `broker.ts:272`、`broker.ts:302`、`broker.ts:502`(`this.injectCredentialHeaders(baseWithId, request)` → `this.decorateAllow(baseWithId, request)`)

- [ ] **Step 4: テストが通ることを確認**

Run: `bun run check && bun test src/network`
Expected: PASS(既存の injectHeaders テスト含む)

- [ ] **Step 5: コミット**

```bash
git add src/network/protocol.ts src/network/broker.ts src/network/broker_integration_test.ts
git commit -m "feat(network): attach maskValues to allow decisions and sanitize reviewContext"
```

---

### Task 5: 秘密値解決の共有化と `resolveMaskValues`

**Files:**
- Create: `src/lib/mask_secrets.ts`(maskfs_service から移設)
- Modify: `src/stages/maskfs/maskfs_service.ts:24, 160-217`(移設元を削除し委譲)
- Modify: `src/stages/proxy/network_runtime_service.ts`(メソッド追加)
- Modify: `src/stages/proxy/session_broker_service.ts:30-46, 82-94`(config passthrough)
- Test: `src/lib/mask_secrets_test.ts`(新規)、`src/stages/proxy/network_runtime_service_test.ts`

**Interfaces:**
- Consumes: `resolveSecret`(`src/hostexec/secret_store.ts`)、`MaskValueConfig`
- Produces:
  - `src/lib/mask_secrets.ts`: `export const MIN_SECRET_BYTES = 4;` / `export async function resolveMaskSecrets(values: MaskValueConfig[], env: Record<string, string | undefined>): Promise<string[]>`
  - `NetworkRuntimeService.resolveMaskValues: (values: MaskValueConfig[], env: Record<string, string | undefined>) => Effect.Effect<string[]>`(解決失敗は defect = fail-closed)
  - `SessionBrokerConfig.maskValues?: string[]`(`SessionBroker` へ passthrough)

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/mask_secrets_test.ts`(移設する関数の仕様を固定する):

```typescript
import { describe, expect, test } from "bun:test";
import { resolveMaskSecrets } from "./mask_secrets.ts";

describe("resolveMaskSecrets", () => {
  test("resolves env: sources", async () => {
    const secrets = await resolveMaskSecrets([{ source: "env:MY_SECRET" }], {
      MY_SECRET: "s3cret-value",
    });
    expect(secrets).toEqual(["s3cret-value"]);
  });

  test("throws when secret is unavailable (fail-closed)", async () => {
    await expect(
      resolveMaskSecrets([{ source: "env:MISSING" }], {}),
    ).rejects.toThrow(/Required secret is unavailable/);
  });

  test("throws when resolved value is under 4 bytes", async () => {
    await expect(
      resolveMaskSecrets([{ source: "env:SHORT" }], { SHORT: "abc" }),
    ).rejects.toThrow(/at least 4 bytes/);
  });
});
```

`src/stages/proxy/network_runtime_service_test.ts` に追加(同ファイルの `makeLiveLayer` を使う):

```typescript
test("resolveMaskValues: resolves env: sources via live layer", async () => {
  const fsFake = makeFsServiceFake();
  const live = makeLiveLayer(fsFake);
  const values = await Effect.runPromise(
    Effect.flatMap(NetworkRuntimeService, (svc) =>
      svc.resolveMaskValues([{ source: "env:MY_SECRET" }], {
        MY_SECRET: "s3cret-value",
      }),
    ).pipe(Effect.provide(live)),
  );
  expect(values).toEqual(["s3cret-value"]);
});

test("resolveMaskValues: dies when secret is unavailable (fail-closed)", async () => {
  const fsFake = makeFsServiceFake();
  const live = makeLiveLayer(fsFake);
  const exit = await Effect.runPromiseExit(
    Effect.flatMap(NetworkRuntimeService, (svc) =>
      svc.resolveMaskValues([{ source: "env:MISSING" }], {}),
    ).pipe(Effect.provide(live)),
  );
  expect(exit._tag).toEqual("Failure");
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `bun test src/lib/mask_secrets_test.ts src/stages/proxy/network_runtime_service_test.ts`
Expected: FAIL(モジュール・メソッドが存在しない)

- [ ] **Step 3: 実装**

`src/lib/mask_secrets.ts` を新規作成し、`src/stages/maskfs/maskfs_service.ts` の `resolveMaskSecrets`(167-208行)と `assertMinSecretBytes`(210-217行)と `MIN_SECRET_BYTES`(24行)を**そのまま移設**する。シグネチャだけ変更: `host: HostEnv` の代わりに `env: Record<string, string | undefined>` を受け取る(関数冒頭の `const env: ... = {}; for (...) env[k] = v;` の変換ループを削除):

```typescript
/**
 * mask_secrets — MaskConfig の values を解決する共有ヘルパー。
 * maskfs (MaskFsService) と proxy (NetworkRuntimeService) の両方から使う。
 * fail-closed: 解決失敗・空値・4バイト未満はすべて throw。
 */

import type { MaskValueConfig } from "../config/types.ts";
import { resolveSecret } from "../hostexec/secret_store.ts";

export const MIN_SECRET_BYTES = 4;

export async function resolveMaskSecrets(
  values: MaskValueConfig[],
  env: Record<string, string | undefined>,
): Promise<string[]> {
  const secrets: string[] = [];
  for (const [i, value] of values.entries()) {
    let resolved: string | string[] | null;
    try {
      resolved = await resolveSecret(value.source, env);
    } catch (e) {
      throw new Error(
        `[nas] mask: failed to resolve mask.values[${i}].source ("${value.source}"): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (resolved === null || resolved === "") {
      throw new Error(
        `[nas] mask: failed to resolve mask.values[${i}].source ("${value.source}"): Required secret is unavailable`,
      );
    }
    if (Array.isArray(resolved)) {
      if (resolved.length === 0) {
        throw new Error(
          `[nas] mask: failed to resolve mask.values[${i}].source ("${value.source}"): Required secret is unavailable`,
        );
      }
      for (const [lineIndex, line] of resolved.entries()) {
        assertMinSecretBytes(
          line,
          `[nas] mask: mask.values[${i}] line ${lineIndex + 1}`,
        );
        secrets.push(line);
      }
      continue;
    }
    assertMinSecretBytes(resolved, `[nas] mask: mask.values[${i}]`);
    secrets.push(resolved);
  }
  return secrets;
}

function assertMinSecretBytes(value: string, label: string): void {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength < MIN_SECRET_BYTES) {
    throw new Error(
      `${label} resolved value must be at least 4 bytes (got ${bytes.byteLength}); short values would mass-mask unrelated content`,
    );
  }
}
```

`src/stages/maskfs/maskfs_service.ts`: 移設した関数群を削除し、live 実装の `resolveSecrets` を委譲に変える(公開シグネチャ `(values, host)` は不変):

```typescript
import { resolveMaskSecrets } from "../../lib/mask_secrets.ts";
// (resolveSecret / MIN_SECRET_BYTES の import・定義は削除)

      resolveSecrets: (values, host) =>
        Effect.tryPromise({
          try: () => {
            const env: Record<string, string | undefined> = {};
            for (const [k, v] of host.env) env[k] = v;
            return resolveMaskSecrets(values, env);
          },
          catch: (e) => e,
        }),
```

`src/stages/proxy/network_runtime_service.ts`: Tag・Live・Fake の3箇所にメソッド追加。

Tag:

```typescript
    readonly resolveMaskValues: (
      values: import("../../config/types.ts").MaskValueConfig[],
      env: Record<string, string | undefined>,
    ) => Effect.Effect<string[]>;
```

Live(`resolveCredentials` の下):

```typescript
      resolveMaskValues: (values, env) =>
        Effect.tryPromise({
          try: () => resolveMaskSecrets(values, env),
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }).pipe(Effect.orDie),
```

(import: `import { resolveMaskSecrets } from "../../lib/mask_secrets.ts";`)

Fake(`NetworkRuntimeServiceFakeConfig` にも追加):

```typescript
  readonly resolveMaskValues?: (
    values: import("../../config/types.ts").MaskValueConfig[],
    env: Record<string, string | undefined>,
  ) => Effect.Effect<string[]>;
// makeNetworkRuntimeServiceFake 内:
      resolveMaskValues:
        overrides.resolveMaskValues ?? (() => Effect.succeed([])),
```

`src/stages/proxy/session_broker_service.ts`: `SessionBrokerConfig` に `readonly maskValues?: string[];` を追加し、Live の `new SessionBroker({...})` に `maskValues: config.maskValues,` を1行追加。

- [ ] **Step 4: テストが通ることを確認**

Run: `bun run check && bun test src/lib src/stages/maskfs src/stages/proxy src/network`
Expected: PASS(maskfs の既存テストも green のまま)

- [ ] **Step 5: コミット**

```bash
git add src/lib/mask_secrets.ts src/lib/mask_secrets_test.ts src/stages/maskfs/maskfs_service.ts src/stages/proxy/network_runtime_service.ts src/stages/proxy/network_runtime_service_test.ts src/stages/proxy/session_broker_service.ts
git commit -m "feat(proxy): share mask secret resolution and plumb maskValues to broker config"
```

---

### Task 6: ProxyStage 配線 — plan 取り込みと broker への受け渡し

**Files:**
- Modify: `src/stages/proxy/stage.ts`(`ProxyPlan` / `planProxy` / `runProxy`)
- Test: `src/stages/proxy/stage_test.ts`

**Interfaces:**
- Consumes: Task 1 の `MaskConfig.proxy`、Task 5 の `resolveMaskValues` / `SessionBrokerConfig.maskValues`
- Produces: `ProxyPlan.maskValueConfigs: MaskValueConfig[]`(proxy マスク無効時は空配列)、`ProxyPlan.hostEnv: Record<string, string | undefined>`

- [ ] **Step 1: 失敗するテストを書く**

`src/stages/proxy/stage_test.ts` に追加(既存の `makeProfile` / `makeInput` / fake 群を使い、`createProxyStage` を fake レイヤーで実行して `SessionBrokerConfig` をキャプチャする既存テストの形に合わせる):

```typescript
test("ProxyStage: resolves mask values and passes them to broker", async () => {
  const profile = makeProfile({
    network: { reviewRules: [{ action: "allow" as const }] },
    mask: {
      values: [{ source: "env:SECRET" }],
      writePolicy: "readonly",
      maskfs: true,
      proxy: true,
    },
  });
  const captured: SessionBrokerConfig[] = [];
  const resolveCalls: unknown[] = [];
  const result = await runStageWithFakes(profile, {
    networkRuntime: makeNetworkRuntimeServiceFake({
      resolveMaskValues: (values) =>
        Effect.sync(() => {
          resolveCalls.push(values);
          return ["resolved-secret"];
        }),
    }),
    sessionBroker: makeSessionBrokerServiceFake({
      start: (config) =>
        Effect.sync(() => {
          captured.push(config);
          return { close: () => Effect.void };
        }),
    }),
  });
  expect(resolveCalls).toEqual([[{ source: "env:SECRET" }]]);
  expect(captured[0].maskValues).toEqual(["resolved-secret"]);
});

test("ProxyStage: mask.proxy=false skips mask value resolution", async () => {
  const profile = makeProfile({
    network: { reviewRules: [{ action: "allow" as const }] },
    mask: {
      values: [{ source: "env:SECRET" }],
      writePolicy: "readonly",
      maskfs: true,
      proxy: false,
    },
  });
  const captured: SessionBrokerConfig[] = [];
  let resolveCalled = false;
  await runStageWithFakes(profile, {
    networkRuntime: makeNetworkRuntimeServiceFake({
      resolveMaskValues: () =>
        Effect.sync(() => {
          resolveCalled = true;
          return [];
        }),
    }),
    sessionBroker: makeSessionBrokerServiceFake({
      start: (config) =>
        Effect.sync(() => {
          captured.push(config);
          return { close: () => Effect.void };
        }),
    }),
  });
  expect(resolveCalled).toEqual(false);
  expect(captured[0].maskValues).toBeUndefined();
});
```

`runStageWithFakes` は同ファイルに stage を fake レイヤー一式(`makeCaServiceFake` / `makeProxyServiceFake` / `makeForwardPortRelayServiceFake` 含む)で `Effect.scoped` 実行する既存ヘルパーがあればそれを使い、なければ既存の stage 実行テストの本文を関数として抽出して共用する。

- [ ] **Step 2: テストが失敗することを確認**

Run: `bun test src/stages/proxy/stage_test.ts`
Expected: FAIL(`mask` が plan で無視され `maskValues` が渡らない)

- [ ] **Step 3: 実装**

`src/stages/proxy/stage.ts`:

1. import: `import type { CredentialRule, MaskValueConfig, ReviewRule } from "../../config/types.ts";`
2. `ProxyPlan` にフィールド追加:

```typescript
  /** proxy マスク対象の秘密値ソース。無効時は空配列 */
  readonly maskValueConfigs: MaskValueConfig[];
  /** resolveMaskValues 用のホスト環境変数スナップショット */
  readonly hostEnv: Record<string, string | undefined>;
```

3. `planProxy` 内(`reviewRules: [...]` の近く)で計算して返す:

```typescript
  const mask = input.profile.mask;
  const maskProxyEnabled = !!mask && mask.proxy && mask.values.length > 0;
  const hostEnv: Record<string, string | undefined> = {};
  for (const [k, v] of input.host.env) hostEnv[k] = v;
  // ... return に追加:
    maskValueConfigs: maskProxyEnabled ? [...mask.values] : [],
    hostEnv,
```

4. `runProxy` の step 5.5(resolveCredentials)の直後に追加:

```typescript
    // 5.6. Resolve mask values (fail-closed: 解決失敗はセッション起動中止)
    const maskValues =
      plan.maskValueConfigs.length > 0
        ? yield* networkRuntime.resolveMaskValues(
            plan.maskValueConfigs,
            plan.hostEnv,
          )
        : [];
```

5. `sessionBrokerService.start({...})` に追加:

```typescript
        maskValues: maskValues.length > 0 ? maskValues : undefined,
```

- [ ] **Step 4: テストが通ることを確認**

Run: `bun run check && bun test src/stages/proxy`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/stages/proxy/stage.ts src/stages/proxy/stage_test.ts
git commit -m "feat(proxy): resolve mask values in ProxyStage and pass to session broker"
```

---

### Task 7: nas_addon.py — マスク純粋関数と Python テスト基盤

**Files:**
- Modify: `src/docker/mitmproxy/nas_addon.py`(純粋関数追加)
- Create: `src/docker/mitmproxy/testdata/mitmproxy_stub/mitmproxy/__init__.py`
- Create: `src/docker/mitmproxy/testdata/mitmproxy_stub/mitmproxy/http.py`
- Create: `src/docker/mitmproxy/testdata/mitmproxy_stub/mitmproxy/connection.py`
- Create: `src/docker/mitmproxy/nas_addon_mask_test.py`
- Create: `src/docker/mitmproxy/nas_addon_test.ts`(TS ラッパー、python3 不在時 skip)

**Interfaces:**
- Produces(Task 8 が使う):
  - `_build_mask_patterns(mask_values: list[str]) -> list[bytes]` — 長い順ソート済み
  - `_mask_bytes(data: bytes, patterns: list[bytes]) -> bytes`
  - 定数 `MASK_REPLACEMENT = b"****"` / `B64_MIN_PATTERN_LEN = 8`
- 注意: パターン展開は TS 実装(`src/network/mask_patterns.ts`)と同一仕様。変更時は両方を揃える

- [ ] **Step 1: mitmproxy スタブを作成**

`nas_addon.py` は冒頭で `from mitmproxy import connection, http` するため、mitmproxy 未インストールのホストでテストするにはスタブが要る。

`src/docker/mitmproxy/testdata/mitmproxy_stub/mitmproxy/__init__.py`:

```python
# Test stub for the mitmproxy package. Provides just enough surface for
# nas_addon.py to import outside a real mitmproxy environment.
```

`src/docker/mitmproxy/testdata/mitmproxy_stub/mitmproxy/http.py`:

```python
class HTTPFlow:
    pass


class Response:
    @staticmethod
    def make(*args, **kwargs):
        raise NotImplementedError("stub: not used in pure-function tests")
```

`src/docker/mitmproxy/testdata/mitmproxy_stub/mitmproxy/connection.py`:

```python
class Client:
    pass
```

- [ ] **Step 2: 失敗する Python テストを書く**

`src/docker/mitmproxy/nas_addon_mask_test.py`:

```python
"""Unit tests for the mask helpers in nas_addon.py.

Run via nas_addon_test.ts, which sets PYTHONPATH to the mitmproxy stub.
Direct invocation:
    PYTHONPATH=testdata/mitmproxy_stub python3 nas_addon_mask_test.py
"""

import base64
import unittest

import nas_addon


class BuildMaskPatternsTest(unittest.TestCase):
    def test_includes_raw_value(self):
        patterns = nas_addon._build_mask_patterns(["s3cret-value"])
        self.assertIn(b"s3cret-value", patterns)

    def test_includes_percent_encoded_variants(self):
        patterns = nas_addon._build_mask_patterns(["p@ss w+rd"])
        self.assertIn(b"p%40ss%20w%2Brd", patterns)  # quote(value, safe="")
        self.assertIn(b"p%40ss+w%2Brd", patterns)    # quote_plus(value)

    def test_base64_detected_at_all_embedding_offsets(self):
        secret = b"s3cret-value-long"
        patterns = nas_addon._build_mask_patterns([secret.decode()])
        for offset in range(3):
            stream = b"A" * offset + secret + b"BC"
            encoded = base64.b64encode(stream)
            self.assertTrue(
                any(p in encoded for p in patterns),
                f"offset {offset}: no pattern found in {encoded!r}",
            )

    def test_short_secret_has_no_base64_patterns(self):
        patterns = nas_addon._build_mask_patterns(["abcd"])
        self.assertEqual(patterns, [b"abcd"])

    def test_sorted_longest_first(self):
        patterns = nas_addon._build_mask_patterns(
            ["shortpw1", "much-longer-secret"]
        )
        lengths = [len(p) for p in patterns]
        self.assertEqual(lengths, sorted(lengths, reverse=True))


class MaskBytesTest(unittest.TestCase):
    def test_replaces_all_occurrences(self):
        patterns = nas_addon._build_mask_patterns(["s3cret-value"])
        self.assertEqual(
            nas_addon._mask_bytes(b"a=s3cret-value&b=s3cret-value", patterns),
            b"a=****&b=****",
        )

    def test_longest_pattern_wins(self):
        patterns = nas_addon._build_mask_patterns(
            ["s3cret", "s3cret-extended"]
        )
        self.assertEqual(
            nas_addon._mask_bytes(b"x=s3cret-extended", patterns),
            b"x=****",
        )

    def test_masks_base64_encoded_body(self):
        secret = "s3cret-value-long"
        patterns = nas_addon._build_mask_patterns([secret])
        body = base64.b64encode(secret.encode())
        masked = nas_addon._mask_bytes(body, patterns)
        self.assertNotIn(secret.encode(), masked)
        self.assertIn(b"****", masked)


if __name__ == "__main__":
    unittest.main()
```

`src/docker/mitmproxy/nas_addon_test.ts`(TS ラッパー):

```typescript
/**
 * nas_addon.py のマスク純粋関数を python3 で実行するテストラッパー。
 * mitmproxy 本体は不要 (testdata/mitmproxy_stub を PYTHONPATH に置く)。
 * python3 不在のホストでは skip する。
 */

import { expect, test } from "bun:test";
import * as path from "node:path";

const python3 = Bun.which("python3");
const addonDir = path.dirname(new URL(import.meta.url).pathname);

test.skipIf(!python3)("nas_addon mask helpers (python unittest)", async () => {
  const proc = Bun.spawn(
    [python3 as string, "nas_addon_mask_test.py", "-v"],
    {
      cwd: addonDir,
      env: {
        ...process.env,
        PYTHONPATH: path.join(addonDir, "testdata", "mitmproxy_stub"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    console.error(stdout);
    console.error(stderr);
  }
  expect(exitCode).toEqual(0);
});
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `bun test src/docker/mitmproxy/nas_addon_test.ts`
Expected: FAIL(`AttributeError: module 'nas_addon' has no attribute '_build_mask_patterns'` が stderr に出る)

- [ ] **Step 4: nas_addon.py に純粋関数を実装**

`src/docker/mitmproxy/nas_addon.py` の import に `import urllib.parse` を追加し、`BODY_PREVIEW_MAX = 1024` の下に追加:

```python
# --- request masking -------------------------------------------------------
# Pattern expansion mirrors src/network/mask_patterns.ts (broker-side
# reviewContext masking). Keep both implementations in sync.

MASK_REPLACEMENT = b"****"
B64_MIN_PATTERN_LEN = 8


def _base64_confident_substrings(secret: bytes) -> set[bytes]:
    """truffleHog 方式: 3 バイトアライメントごとに、隣接バイトの影響を
    受けない「確定部分文字列」を生成する (標準 / URL-safe 両アルファベット)。
    短すぎるパターンは誤マスク防止のため捨てる。"""
    out: set[bytes] = set()
    for k in range(3):
        encoded = base64.b64encode(b"\x00" * k + secret).rstrip(b"=")
        start = -(-8 * k // 6)                # ceil(8k/6)
        end = (8 * (k + len(secret))) // 6    # floor(8(k+n)/6)
        candidate = encoded[start:end]
        if len(candidate) >= B64_MIN_PATTERN_LEN:
            out.add(candidate)
            out.add(candidate.replace(b"+", b"-").replace(b"/", b"_"))
    return out


def _build_mask_patterns(mask_values: list[str]) -> list[bytes]:
    """秘密値ごとに 生値 / percent-encoded (quote, quote_plus) / base64
    バリアントを展開し、長い順に返す (部分重複対策)。"""
    patterns: set[bytes] = set()
    for value in mask_values:
        if not value:
            continue
        raw = value.encode("utf-8")
        patterns.add(raw)
        patterns.add(urllib.parse.quote(value, safe="").encode("ascii"))
        patterns.add(urllib.parse.quote_plus(value).encode("ascii"))
        patterns.update(_base64_confident_substrings(raw))
    return sorted(patterns, key=len, reverse=True)


def _mask_bytes(data: bytes, patterns: list[bytes]) -> bytes:
    for pattern in patterns:
        data = data.replace(pattern, MASK_REPLACEMENT)
    return data
```

- [ ] **Step 5: テストが通ることを確認**

Run: `bun run check && bun test src/docker/mitmproxy/nas_addon_test.ts`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add src/docker/mitmproxy/nas_addon.py src/docker/mitmproxy/nas_addon_mask_test.py src/docker/mitmproxy/nas_addon_test.ts src/docker/mitmproxy/testdata
git commit -m "feat(proxy-addon): add mask pattern expansion helpers with python test harness"
```

---

### Task 8: nas_addon.py — request フックでのマスク適用

**Files:**
- Modify: `src/docker/mitmproxy/nas_addon.py`(`_apply_request_masking` + `request()` 統合)
- Modify: `src/docker/mitmproxy/nas_addon_mask_test.py`(適用テスト追加)

**Interfaces:**
- Consumes: Task 7 の `_build_mask_patterns` / `_mask_bytes`、Task 4 の `DecisionResponse.maskValues`
- Produces: `_apply_request_masking(flow, patterns: list[bytes]) -> None`

- [ ] **Step 1: 失敗するテストを書く**

`src/docker/mitmproxy/nas_addon_mask_test.py` に追加:

```python
class FakeRequest:
    """flow.request の最小フェイク。headers は素の dict で代用する
    (nas_addon 側は keys() / [] アクセスしか使わない)。"""

    def __init__(self, path="/", headers=None, content=b""):
        self.path = path
        self.headers = headers if headers is not None else {}
        self._content = content
        self.raw_content = content

    @property
    def content(self):
        return self._content

    @content.setter
    def content(self, value):
        self._content = value


class FakeUndecodableRequest(FakeRequest):
    """Content-Encoding が未知で .content が ValueError を投げるケース。"""

    @property
    def content(self):
        raise ValueError("cannot decode")

    @content.setter
    def content(self, value):
        raise AssertionError("must not set .content on undecodable body")


class FakeFlow:
    def __init__(self, request):
        self.request = request


class ApplyRequestMaskingTest(unittest.TestCase):
    def setUp(self):
        self.patterns = nas_addon._build_mask_patterns(["s3cret-value"])

    def test_masks_url_headers_and_body(self):
        flow = FakeFlow(FakeRequest(
            path="/upload?token=s3cret-value",
            headers={"x-note": "v=s3cret-value", "host": "example.com"},
            content=b"data=s3cret-value",
        ))
        nas_addon._apply_request_masking(flow, self.patterns)
        self.assertEqual(flow.request.path, "/upload?token=****")
        self.assertEqual(flow.request.headers["x-note"], "v=****")
        self.assertEqual(flow.request.headers["host"], "example.com")
        self.assertEqual(flow.request.content, b"data=****")

    def test_masks_percent_encoded_secret_in_form_body(self):
        patterns = nas_addon._build_mask_patterns(["p@ss w+rd"])
        flow = FakeFlow(FakeRequest(content=b"password=p%40ss+w%2Brd"))
        nas_addon._apply_request_masking(flow, patterns)
        self.assertEqual(flow.request.content, b"password=****")

    def test_undecodable_body_falls_back_to_raw_content(self):
        flow = FakeFlow(FakeUndecodableRequest(
            content=b"xx s3cret-value yy",
        ))
        nas_addon._apply_request_masking(flow, self.patterns)
        self.assertEqual(flow.request.raw_content, b"xx **** yy")

    def test_empty_body_untouched(self):
        flow = FakeFlow(FakeRequest(content=b""))
        nas_addon._apply_request_masking(flow, self.patterns)
        self.assertEqual(flow.request.content, b"")
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `bun test src/docker/mitmproxy/nas_addon_test.ts`
Expected: FAIL(`_apply_request_masking` が存在しない)

- [ ] **Step 3: 実装**

`src/docker/mitmproxy/nas_addon.py` の `_mask_bytes` の下に追加:

```python
def _apply_request_masking(flow, patterns: list[bytes]) -> None:
    """allow されたリクエストの URL・ヘッダー・ボディから秘密値を **** に
    置換する。credential 注入 (injectHeaders) より前に呼ぶこと —
    逆順だと注入したばかりの本物の credential をマスクして壊す。"""
    if not patterns:
        return

    masked_path = _mask_bytes(
        flow.request.path.encode("utf-8", errors="surrogateescape"), patterns
    )
    flow.request.path = masked_path.decode("utf-8", errors="replace")

    # 注: 同名ヘッダーが複数あると上書きで1つに畳まれるが、置換が
    # 起きたときだけ書き込むので通常のリクエストには影響しない。
    for name in list(flow.request.headers.keys()):
        value = flow.request.headers[name]
        masked = _mask_bytes(
            value.encode("utf-8", errors="surrogateescape"), patterns
        ).decode("utf-8", errors="replace")
        if masked != value:
            flow.request.headers[name] = masked

    # .content は Content-Encoding 展開済みビュー。再代入で mitmproxy が
    # 再圧縮と Content-Length 更新を行う。展開できないエンコーディングは
    # ValueError になるので raw_content への生バイト照合にフォールバック。
    try:
        content = flow.request.content
    except ValueError:
        content = None
    if content:
        masked_content = _mask_bytes(content, patterns)
        if masked_content != content:
            flow.request.content = masked_content
    elif content is None:
        raw = flow.request.raw_content
        if raw:
            masked_raw = _mask_bytes(raw, patterns)
            if masked_raw != raw:
                flow.request.raw_content = masked_raw
```

`request()` フック内、`# Inject credential headers from broker decision (overwrites existing).` コメント(現行 299 行目)の**直前**に挿入:

```python
        # Mask secrets out of the outgoing request (URL / headers / body)
        # before credential injection so injected headers stay intact.
        mask_values = decision.get("maskValues") or []
        if mask_values:
            _apply_request_masking(flow, _build_mask_patterns(mask_values))
```

- [ ] **Step 4: テストが通ることを確認**

Run: `bun test src/docker/mitmproxy/nas_addon_test.ts`
Expected: PASS

- [ ] **Step 5: アドオン変更がプロキシ再作成に反映されることを確認**

`src/stages/proxy/proxy_service_test.ts` の addonHash テスト(「recreates when proxy is running but addon hash differs」)が既にこの性質を担保している。変更不要なことを確認するだけ:

Run: `bun test src/stages/proxy/proxy_service_test.ts`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add src/docker/mitmproxy/nas_addon.py src/docker/mitmproxy/nas_addon_mask_test.py
git commit -m "feat(proxy-addon): mask secrets in request URL, headers, and body before egress"
```

---

### Task 9: 仕上げ — 全体検証

**Files:**
- なし(検証のみ。修正が出た場合はその箇所)

- [ ] **Step 1: 型チェックと全ユニットテスト**

Run: `bun run check && bun test src/`
Expected: すべて PASS

- [ ] **Step 2: post-change-checks スキルの実行**

Skill ツールで `post-change-checks` を読み、指示に従って format / lint / typecheck / テストを流し、結果を報告する

- [ ] **Step 3: spec と実装の突き合わせ**

`docs/superpowers/specs/2026-07-03-mask-mitmproxy-design.md` の「変更点一覧」表と実際のコミット群を突き合わせ、乖離があれば spec を現実に合わせて更新してコミットする

- [ ] **Step 4: コミット(乖離修正があった場合のみ)**

```bash
git add docs/superpowers/specs/2026-07-03-mask-mitmproxy-design.md
git commit -m "docs(specs): align mask-mitmproxy spec with implementation"
```
