---
name: test-policy
description: テストの書き方ルール。テストを新規作成・修正するとき、また既存テストの分類・スキップ条件・cleanup を変更するときに参照する。ランタイムは Bun (bun:test)。Unit/integration/e2e の分類基準、ファイル名規約、skipIf ガード、モック方針を扱う。
---

# Test Policy

ランタイムは **Bun** (`bun:test`)。Deno ではない。`Deno.test` / `Deno.makeTempDir` /
`sanitizeOps` / `sanitizeResources` はこのリポジトリには存在しない。

## カテゴリと命名規約

| カテゴリ | ファイル名 | 配置 | 外部依存 | 速度 |
|---|---|---|---|---|
| Unit | `*_test.ts` | `src/` (ソース隣接) | 不要 | 高速 |
| Integration | `*integration_test.ts` | `src/` (ソース隣接) | Docker 等 | 遅い |
| E2E | `*_e2e_test.ts` | `tests/` (トップレベル) | Docker 等 | 遅い |

**ファイル名がそのまま実行レーンを決める。** `test:unit` は
`find src -name "*_test.ts" ! -name "*integration_test.ts"` で集めるので、
末尾を `integration_test.ts` にし忘れた Docker 依存テストは unit レーンに紛れ込み、
Docker が無い環境の高速テストを壊す。逆に付けると unit レーンから消える。
分類を変えたいときに書き換えるのはファイル名であって、テストの中身ではない。

除外グロブに先頭のアンダースコアが無いので、実在する形は2つある:

- `<module>_integration_test.ts` — ソースファイルに隣接させる場合（27ファイル）
- `integration_test.ts` — `src/stages/<name>/` のようにディレクトリ全体が
  一つの関心事に対応する場合（6ファイル）

どちらでもよいが、末尾が `integration_test.ts` で終わることだけは必須。

## 配置ルール

- Unit / Integration はテスト対象のソースと同じディレクトリに置く（co-location）
- E2E は複数モジュールをまたぐのでリポジトリルートの `tests/` に置く

## コマンド

```bash
bun test                       # 全テスト
bun test src/                  # src 配下（unit + integration）
bun test path/to/file_test.ts  # 単一ファイル
bun test --test-name-pattern 'config'   # 名前で絞る
bun run test:unit              # unit のみ（Docker 不要、高速、安全）
bun run test:integration       # integration + tests/ 配下すべて
```

## `bun run test` はホスト、それ以外はコンテナ内

hostexec のルールは `argv0 = "bun"` かつ `argRegex = "^run test$"` にのみ一致する。
つまり **`bun run test` だけがホストで実行され、承認プロンプトを出す**。
`bun test <args>` はどんな引数でもコンテナ内で走り、承認は増えない。

この2つは同じ結果を返さない。`docker build` がネットワークを要するテストは
ホストでしか通らない。サンドボックス内の DinD ではビルドコンテナに外向きの経路が
無く、`apt-get` が何も解決できないためである（ベースイメージの pull は proxy 済みの
dockerd が行うので成功する）。該当テストは `imageBuildable` のような述語で
サンドボックス内では skip する。**コンテナ内の green は、ホストの green より弱い主張**
である点に注意する。

開発中は Docker に触れない unit test を絞って実行し、最終確認で `bun run test` を
**1 回だけ**実行する。integration file は import 時の availability probe
（例: `docker info`）も実行し得るため、test body が skip でも無害ではない。
承認を減らすために Docker policy を迂回したり、絶対パスや permissive rule を
使ったりしてはならない。

## Unit テストで許可される依存

- temp dir: `mkdtemp(path.join(tmpdir(), "nas-<area>-"))`（`node:fs/promises` + `node:os`）
- fake script（PATH 差し替え）
- in-memory mock / Fake Layer（Effect サービスは Fake Layer、probe はデータを直接捏造）

Unit test は live の Docker CLI / daemon に到達してはならない。存在しない対象へ
graceful に落ちる呼び出しでも、`docker inspect` や `docker logs` を起動するなら
integration である。Docker wrapper を unit test する場合は Fake Layer または注入した
fake command runner を使う。

## Integration / E2E のルール

### skipIf ガード必須

能力の判定はモジュールトップレベルで一度だけ行い、`test.skipIf` に渡す。
判定用のプローブは共有ヘルパではなく各テストファイルにローカルに置く
（`isDockerAvailable` は現状 4ファイルにそれぞれ定義されている）。

```typescript
async function isDockerAvailable(): Promise<boolean> { ... }

const dockerAvailable = await isDockerAvailable();

test.skipIf(!dockerAvailable)("...", async () => { ... });
```

判定対象は Docker だけではない。実際に使われている述語は
`dockerAvailable` / `hasPkl` / `hasNix` / `python3` / `canBindMount` /
ビルド済みバイナリのパス有無など。**必要な能力ごとに述語を分ける** —
一つにまとめると、Docker はあるが pkl が無い環境で理由の分からない失敗になる。

### cleanup を必ず書く

`try`/`finally` か `afterEach`/`afterAll` のどちらでもよいが、
どちらか一方は必ず書く。失敗パスでもリソースが残らないこと。

```typescript
try {
  // テスト本体
} finally {
  await dockerStop(name, { timeoutSeconds: 0 }).catch(() => {});
  await dockerRm(name).catch(() => {});
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
}
```

### 本番リソースに触らない

`nas-dind-shared` のような固定名リソースをテストから作成・削除しない。
テスト用の名前は衝突しないよう生成する:

```typescript
const containerName = `nas-hostexec-gateway-${crypto.randomUUID()}`;
```

## モック優先順

1. **in-memory mock / Fake Layer** — オブジェクトや Effect サービスの差し替え
2. **fake script (PATH)** — シェルスクリプトを PATH の先頭に置く（外部コマンドの
   挙動そのものを検証したいときだけ。例: `src/lib/notify_send_wsl_test.ts`）
3. **実サービス** — integration / e2e のみ

`bun:test` の `mock()` / `spyOn()` はモジュール境界をまたぐ差し替えに使えるが、
まず引数で注入できないか検討する。注入で済むなら注入する。
