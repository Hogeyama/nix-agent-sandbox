---
name: test-policy
description: テストの書き方ルール。テストを新規作成・修正するときに参照する。Unit/integration の分類基準、命名規約、cleanup ルール、モック方針など。
---

# Test Policy

## カテゴリと命名規約

| カテゴリ | ファイル名 | Docker | 速度 |
|---|---|---|---|
| Unit | `*_test.ts` | 不要 | 高速 |
| Integration | `*_integration_test.ts` | 必要 | 遅い |

## コマンド

```bash
deno task test              # 全テスト（unit + integration）
deno task test:unit         # unit のみ（Docker 不要、高速、安全）
deno task test:integration  # integration のみ（Docker 必要）
```

## Unit テストで許可される依存

- temp dir (`Deno.makeTempDir`)
- fake script（PATH 差し替え）
- FakeBackend / in-memory mock
- Docker daemon が不在でも graceful に動く関数呼び出し（`dockerIsRunning("no-such")` → `false` など）

## Integration テストのルール

### ignore ガード必須

```typescript
Deno.test({
  name: "...",
  ignore: !dockerAvailable,  // Docker 不在時はスキップ
  async fn() { ... },
});
```

### finally で Docker リソースを必ず cleanup

```typescript
try {
  // テスト本体
} finally {
  await dockerStop(name, { timeoutSeconds: 0 }).catch(() => {});
  await dockerRm(name).catch(() => {});
  await dockerNetworkRemove(netName).catch(() => {});
}
```

### 本番リソースに触らない

`nas-dind-shared` 等の固定名リソースをテストから作成・削除しない。テスト用にはランダムな名前やプレフィックスを使う。

## モック優先順

1. **in-memory mock** — 関数やオブジェクトの差し替え
2. **fake script (PATH)** — シェルスクリプトを PATH の先頭に配置
3. **実サービス** — integration テストのみ

## sanitizer 無効化

`sanitizeOps: false` / `sanitizeResources: false` を使う場合はコメントで理由を明記する。

```typescript
Deno.test({
  name: "...",
  // sanitizer 無効化: Envoy コンテナのライフサイクルが Deno の
  // resource/op tracking と干渉するため
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() { ... },
});
```
