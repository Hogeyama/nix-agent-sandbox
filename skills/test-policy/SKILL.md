---
name: test-policy
description: テストの書き方ルール。テストを新規作成・修正するとき、また既存テストの分類・スキップ条件・cleanup を変更するときに参照する。Bun・Zig・Python ラッパーのテスト配置、コンポーネント別コマンド、unit/integration/e2e の分類、skip 条件、cleanup、モック方針を扱う。
---

# Test Policy

TypeScript / JavaScript のテストは **Bun** (`bun:test`) で実行する。
ネイティブコードは Zig の `test` ブロック、mitmproxy addon の Python テストは
Bun ラッパー経由で実行する。sumi の black-box テストには専用のシェルスクリプトがある。

実行コマンドと集約対象の正本は [package.json](../../package.json)。
全体の検証手順は [post-change-checks](../post-change-checks/SKILL.md) に従う。

## Bun テストのカテゴリと命名規約

| カテゴリ | ファイル名 | 配置 | 外部依存 | 速度 |
|---|---|---|---|---|
| Unit | `*_test.ts` | `src/` (ソース隣接) | Docker 不要 | 高速 |
| Integration | `*integration_test.ts` | `src/` (ソース隣接) | Docker 等 | 遅い |
| E2E | `*_e2e_test.ts` | `tests/` (トップレベル) | Docker 等 | 遅い |

**`src/` の TypeScript テストは、配置とファイル名で実行レーンを決める。**
`test:nas-ts-unit` と `test:mitmproxy-addon-unit` は、それぞれの対象範囲から
`*_test.ts` を集め、`*integration_test.ts` を除外する。
nas 側は `src/docker/mitmproxy/` を除外し、addon 側だけで実行するため重複しない。

末尾を `integration_test.ts` にし忘れた Docker 依存テストは unit レーンに紛れ込み、
Docker が無い環境の高速テストを壊す。逆に付けると unit レーンから消える。
分類を変えたいときに書き換えるのはファイル名であって、テストの中身ではない。

除外グロブに先頭のアンダースコアが無いので、実在する形は2つある:

- `<module>_integration_test.ts` — ソースファイルに隣接させる場合
- `integration_test.ts` — `src/stages/<name>/` のようにディレクトリ全体が
  一つの関心事に対応する場合

どちらでもよいが、末尾が `integration_test.ts` で終わることだけは必須。

## 配置ルール

- Unit / Integration はテスト対象のソースと同じディレクトリに置く（co-location）
- E2E は複数モジュールをまたぐのでリポジトリルートの `tests/` に置き、`test:nas-integration` に含める
- VS Code approval の JavaScript テストは `contrib/vscode-nas-approval/` のソース隣接に `*_test.js` として置く
- addon の Python テストを追加するときは、対応する Bun ラッパーから実行されることも確認する

## コマンド

```bash
bun run test                  # 全コンポーネントの unit + integration + e2e
bun run test:unit             # Bun と Zig の unit を集約（Docker 不要）
bun run test:integration      # nas/addon integration、nas e2e、sumi black-box
bun run test:nas-unit         # nas TS + hostexec + mask-filter
bun run test:vscode-approval
bun run test:mitmproxy-addon-unit
bun run test:mitmproxy-addon-integration
bun run test:masking-unit
bun run test:process-supervisor-unit
bun run test:sumi             # sumi unit + black-box
bun test path/to/file_test.ts # Bun の単一ファイル
```

`bun test` は Bun テストの直接実行であり、全コンポーネントの集約ではない。
`bun test src/` は import 時に Docker を呼ぶ integration も含むため、unit の代用にしない。

新しいスイートは `test:<component>-unit` / `test:<component>-integration` を基本とし、
対応する集約に明示的に追加する。`test:*` を無差別に実行すると集約と子スイートが
重複する。失敗しても残りのスイートを実行し、集約の終了コードは非ゼロにする。
実行には Zig などのビルドツールが必要なので、Nix 開発環境か同等の環境を使う。

## Zig の共有ライブラリとテスト

- `lib/masking/` はマスク本体とストリーム処理、`lib/process-supervisor/` は
  プロセス監督とリレーを所有する。製品固有のテストは製品側に置く。
- 各ライブラリの `build.zig` が独立したテストルートを持つ。
  **製品からモジュールを import しても、そのライブラリのテストは実行されない。**
  ファイルを共有ライブラリへ移したら、移したテストがそのルートから到達でき、
  `test:unit` と必要な Nix の `checkPhase` で実行されることを確認する。
- コンパイルキャッシュの成功とテスト実行を区別し、`--summary all` の結果を確認する。
- `std.testing.tmpDir` の一時ファイルは `defer tmp.cleanup()` で削除する。
  Nix の `sourceRoot` 外は読み取り専用になるため、共有テストは書き込み可能な
  キャッシュ領域を作業ディレクトリにする。`--cache-dir` の指定だけでは
  `tmpDir` の作業ディレクトリは変わらない。
- maskfs の `zig build test` は互換入口として共有 masking のテストを実行する。
  FUSE 本体の検証ではない。FUSE の E2E は `tests/maskfs_e2e_test.ts` が担当する。

配置と製品からの依存関係は [lib/README.md](../../lib/README.md) を参照する。

## 集約ランナーとそのテスト

集約コマンドは [package.json](../../package.json) に
`bun run scripts/run_tests.ts <子スクリプト名>...` の形で定義する。
[scripts/run_tests.ts](../../scripts/run_tests.ts) は入れ子の集約を実行前に展開し、
同じスイートを重複実行せず、指定順に逐次実行する。
子スクリプトを追加するときもこの形を維持する。別の集約方式を混ぜると
展開対象にならず、入れ子の実行やログ表示が再発する。

ランナーの unit テストはソース隣接の `scripts/run_tests_test.ts` に置き、
`bun run test:runner-unit` で実行する。このスイートは `test:unit` に含まれる。
`src/` 外のテストは `test:nas-ts-unit` には自動で含まれないため、
ファイルを追加しただけで集約から実行されると考えず、対応するスクリプトを確認する。

ランナーを変更するときは、失敗後も残りを実行して全体が非ゼロ終了すること、
成功・失敗の両方で詳細ログが保存されることを保つ。
集計の読み方と保存ログの確認方法は
[post-change-checks](../post-change-checks/SKILL.md#reading-aggregate-output) を参照する。

## Unit テストで許可される依存

- temp dir: `mkdtemp(path.join(tmpdir(), "nas-<area>-"))`（`node:fs/promises` + `node:os`）
- fake script（PATH 差し替え）
- in-memory mock / Fake Layer（Effect サービスは Fake Layer、probe はデータを直接捏造）

Unit test は live の Docker CLI / daemon に到達してはならない。存在しない対象へ
graceful に落ちる呼び出しでも、`docker inspect` や `docker logs` を起動するなら
integration である。Docker wrapper を unit test する場合は Fake Layer または注入した
fake command runner を使う。

## Integration / E2E のルール

### Bun の integration / E2E は skipIf ガード必須

能力の判定はモジュールトップレベルで一度だけ行い、`test.skipIf` に渡す。
判定用のプローブは共有ヘルパではなく各テストファイルにローカルに置く。

```typescript
async function isDockerAvailable(): Promise<boolean> { ... }

const dockerAvailable = await isDockerAvailable();

test.skipIf(!dockerAvailable)("...", async () => { ... });
```

判定対象は Docker だけではない。実際に使われている述語は
`dockerAvailable` / `hasPkl` / `hasNix` / `python3` / `canBindMount` /
ビルド済みバイナリのパス有無など。**必要な能力ごとに述語を分ける** —
一つにまとめると、Docker はあるが pkl が無い環境で理由の分からない失敗になる。

### テストの実行環境

NAS 内での標準検証は `bun run test:unit`。必要な依存や権限がないために
スキップされたテストは、実行済みとして報告しない。integration / E2E が必要なら、
必要な依存を直接利用できる環境で実行する。スキップを埋めるために自動で
ホスト実行へ切り替えず、環境の選択は post-change-checks の手順に合わせる。

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

Docker CLI の認証設定は `scripts/test_preload.ts` で隔離する。
実ユーザーの `auths` / `credsStore` / `credHelpers` を引き継がず、
接続先の context と TLS 設定だけを維持する。テストからログインや
credential helper の解除を要求してはならない。

CLI / Dev Containers の E2E は `tests/docker_resources_fixture.ts` を使い、
子プロセスに実行ごとの `NAS_RESOURCE_NAMESPACE` を渡す。
共有 proxy と sandbox image はこの名前空間で分離し、fixture の cleanup で削除する。
直接 image を build する integration も UUID 付きの専用タグと cleanup を持つ。
ベースイメージや事前に用意した fixture image の参照は共有してよいが、
テストで本番のタグを上書き・削除しない。

## モック優先順

1. **in-memory mock / Fake Layer** — オブジェクトや Effect サービスの差し替え
2. **fake script (PATH)** — シェルスクリプトを PATH の先頭に置く（外部コマンドの
   挙動そのものを検証したいときだけ。例: `src/lib/notify_send_wsl_test.ts`）
3. **実サービス** — integration / e2e のみ

`bun:test` の `mock()` / `spyOn()` はモジュール境界をまたぐ差し替えに使えるが、
まず引数で注入できないか検討する。注入で済むなら注入する。
