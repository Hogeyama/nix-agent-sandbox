---
Status: Accepted
Date: 2026-05-26
---

# ADR: 設定ファイルの Pkl project-local 解決

## Context

現在の設定ファイル読み込み (`src/config/load.ts`) は以下の仕組みで動く:

1. **グローバル設定**: `$XDG_CONFIG_HOME/nas/agent-sandbox.{yml,nix,pkl}` を探索
2. **ローカル設定**: cwd から親方向に `.agent-sandbox.{yml,nix,pkl}` を探索
3. **Pkl 評価**: 一時ディレクトリに `Config.pkl` と `agent-sandbox.global.pkl`
   を書き出し、`pkl eval --module-path <tmpDir>` でユーザの `.pkl` を評価

この方式には以下の問題がある:

- **一時ディレクトリ依存**: `loadPklConfig` は毎回 tmpDir を作成し、
  `Config.pkl` とグローバル設定をコピーする。ファイル I/O オーバーヘッドと
  クリーンアップ管理が冗長
- **`modulepath:` 参照の不透明さ**: ユーザの `.agent-sandbox.pkl` は
  `amends "modulepath:/Config.pkl"` と書くが、`Config.pkl` が NAS バイナリの
  内部アセットであることが見えない。IDE (pkl-lsp) がモジュールパスを解決できず
  補完・型チェックが効かない
- **グローバル設定のマージが TypeScript 側にも分岐**: Pkl の `amends` で
  型付きマージができるにもかかわらず、YAML/Nix との互換性のために
  `mergeRawConfigs` を TypeScript 側に持っている。Pkl ユーザにとっては
  二重の仕組み
- **設定ファイルの配置場所がフラット**: `.agent-sandbox.pkl` がリポジトリ
  ルートに直接置かれる。nas 固有のファイルが増えた場合（worktree 管理等）
  にリポジトリルートが散らかる

## Decision

### `.nas/` ディレクトリとグローバル設定ディレクトリに設定ファイルを集約する

ローカル設定の探索パスを `.agent-sandbox.{yml,nix,pkl}` から `.nas/config.pkl`
に変更する。グローバル設定は `$XDG_CONFIG_HOME/nas/` に、プロジェクトローカル
設定は `.nas/` 以下に配置する。

```
$XDG_CONFIG_HOME/nas/
├── Schema.pkl          # CLIバイナリ同梱の型付きスキーマ
└── global.pkl          # ユーザのグローバル設定 (amends "Schema.pkl")

.nas/
├── .gitignore          # 中身: *  (全ファイルを gitignore)
├── PklProject          # pkl eval 用のプロジェクト定義 (modulePath で上記2箇所を参照)
├── Schema.pkl          # CLIバイナリ同梱の型付きスキーマ (グローバルと同一内容)
├── eval.pkl            # CLIが毎回上書きする評価エントリポイント
└── config.pkl          # ユーザのプロジェクトローカル設定 (amends "modulepath:/global.pkl")
```

> **後方互換性は一旦無視する** (idea.md の方針)。既存の
> `.agent-sandbox.{yml,nix,pkl}` とのフォールバック探索は実装しない。

### `nas config init` / 初回 `nas run` でのファイル生成

`nas config init` コマンド（または初回 `nas run` で設定ファイルが未発見の場合）
が以下のファイルを生成する:

#### 1. `$XDG_CONFIG_HOME/nas/Schema.pkl`（グローバル側の型付きスキーマ）

CLI に同梱した `Config.pkl` の内容をそのまま書き出す。
自分のバージョンより古いバージョンの `Schema.pkl` が既に存在する場合は
上書きする。同一以上のバージョンであればスキップする。

#### 2. `$XDG_CONFIG_HOME/nas/global.pkl`（グローバル設定）

CLI に同梱したテンプレートから生成。内容:

```pkl
amends "Schema.pkl"

// Add your custom global config here
```

既に存在する場合はスキップする（ユーザのカスタマイズを上書きしない）。

#### 3. `.nas/Schema.pkl`（プロジェクト側の型付きスキーマ）

CLI に同梱した `Config.pkl` の内容をそのまま書き出す。
`Schema.pkl` が既に存在する場合は上書きする。

#### 4. `.nas/config.pkl`（プロジェクトローカル設定）

CLI に同梱したテンプレートから生成。内容:

```pkl
amends "modulepath:/global.pkl"
// Comment out above line and uncomment below line to ignore global config
// amends "Schema.pkl"

// Add your custom config here
```

既に存在する場合はスキップする（ユーザのカスタマイズを上書きしない）。

#### 5. `.nas/PklProject`（Pkl プロジェクト定義）

```pkl
amends "pkl:Project"

local globalConfigDir = (read?("env:XDG_CONFIG_HOME") ?? "\(read("env:HOME"))/.config") + "/nas"

evaluatorSettings {
  modulePath {
    "."
    globalConfigDir
  }
}
```

既に存在する場合はスキップする。

このファイルにより `.nas/` ディレクトリ自体が Pkl プロジェクトルートとなる。
`modulePath` に `.`（= `.nas/` 自身）と `$XDG_CONFIG_HOME/nas/` の
2 ディレクトリを指定することで:

- `.nas/config.pkl` の `amends "modulepath:/global.pkl"` →
  `$XDG_CONFIG_HOME/nas/global.pkl` を解決
- `global.pkl` の `amends "Schema.pkl"` → 同ディレクトリの `Schema.pkl` を解決
- `.nas/config.pkl` の `amends "Schema.pkl"`（グローバル無視モード）→
  `.nas/Schema.pkl` を解決

#### 6. `.nas/eval.pkl`（評価エントリポイント）

CLI が毎回上書きするファイル。`config.pkl` を import し、`Schema` の型注釈で
型検査を行う:

```pkl
import "config.pkl"
import "Schema.pkl"

local validated: Schema = config

output {
  value = validated
}
```

CLI は `pkl eval -f json --project-dir .nas/ .nas/eval.pkl` でこのファイルを
評価する。`local validated: Schema = config` により、`config.pkl` が
`Schema.pkl` の amends チェーンを経由していない場合（amends を書いていない、
または無関係なモジュールを amends している場合）は Pkl が
`Expected value of type Schema, but got type config` でエラーにする。

これにより **amends チェーンの正当性検証が Pkl の型システムで完結**し、
TS 側でのランタイム nonce や amends 行の grep 検査が不要になる。

既に存在する場合は上書きする（CLI 管理ファイルのため）。

#### 7. `.nas/.gitignore`

中身は `*`。`.nas/` 以下のファイルをすべて gitignore する。

既に存在する場合はスキップする。

### Schema.pkl のバージョン管理

`Schema.pkl` には NAS バイナリのバージョンを埋め込む（doc comment 等）。
init 時に既存の `Schema.pkl` のバージョンと自身のバージョンを比較し、
古い場合のみ上書きする。これによりバイナリ更新時にスキーマが自動で最新化
されつつ、ダウングレード時に新しいスキーマが壊れることを防ぐ。

### 設定ファイルの読み込みフロー

`loadConfig` は以下のフローに変更する:

1. cwd から親方向に `.nas/config.pkl` を探索する
2. `.nas/eval.pkl` と `.nas/Schema.pkl` を CLI アセットから上書き生成する
3. `$XDG_CONFIG_HOME/nas/global.pkl` が存在すれば `readFile` で読み込み
   `.nas/global.pkl` にコピーする。Pkl の `modulePath` はシンボリックリンクを
   辿れないため（Alternative D 参照）、`readFile`（symlink を透過的に辿る）で
   ファイル実体を取得しコピーする。存在しない場合はスキップする
4. `pkl eval -f json --project-dir .nas/ .nas/eval.pkl` で評価する。
   `eval.pkl` 内の `local validated: Schema = config` により、
   `config.pkl` が `Schema.pkl` の amends チェーンを経由していることが
   Pkl の型システムで検証される。amends チェーンが壊れている場合は
   Pkl がエラーを返す
5. 結果の JSON を `JSON.parse() as Config` で取得する

TypeScript 側の `mergeRawConfigs` / `rawConfigToPklSource` / tmpDir 生成は
不要になる。

### zod の廃止

`eval.pkl` の型注釈により、`config.pkl` → `global.pkl` → `Schema.pkl` の
amends チェーン全体の型検査が Pkl 側で完結する。`config.pkl` が amends を
持たない場合や、`Schema.pkl` と無関係なモジュールを amends している場合は
`Expected value of type Schema, but got type ...` で Pkl がエラーにする。

これにより現行の zod ベースの `schema.ts` / `validate.ts` の構造・型・enum・
デフォルト値検証はすべて Pkl 側に移譲され、zod 依存を除去できる。

セマンティック検証（allowlist/denylist のホスト形式検証と重複検出、
env の mode/separator 相互依存、hostexec rules の overlapping 警告など）は
Pkl の型制約では表現できないため、薄い手書きバリデーション関数として TS 側に
残す。ただし zod は使わず、`Config` 型を前提とした plain な `if/throw` で
実装する。

### `nas config migrate pkl` (将来)

`.agent-sandbox.{yml,nix}` から `.nas/config.pkl` への変換コマンドを将来用意
する。本 ADR のスコープ外。

## Alternatives considered

### A. 一時ディレクトリ方式の改善のみ

現行の tmpDir 方式を維持しつつ、キャッシュやハッシュベースの再利用で I/O を
削減する案。

却下理由: IDE 補完が効かない根本問題 (`modulepath:` の不透明さ) は解消しない。
ユーザ体験の改善幅が限定的。

### B. `.nas/config.pkl` のみ、`PklProject` なし

`pkl eval --module-path .nas/ .nas/config.pkl` で評価し、`PklProject` を
省略する案。

却下理由: `--module-path` はコマンドライン引数でしか指定できず、pkl-lsp や
IDE が自動的に認識できない。`PklProject` を置くことで IDE 側のモジュール解決
が自動化される。

### C. `.nas/Schema.pkl` を gitignore せず VCS 管理する

チームメンバーが `nas config init` を実行しなくても型チェックが効くようにする案。

却下理由: `Schema.pkl` は NAS バイナリのバージョンと 1:1 対応する。VCS 管理
すると NAS バイナリ更新時に diff が生じ、「バイナリと Schema のバージョン不一致」
という新たな問題が生まれる。`*` gitignore + init 時上書きの方が運用シンプル。

### D. グローバル設定へのシンボリックリンク方式

`.nas/global.pkl` を `$XDG_CONFIG_HOME/nas/global.pkl` へのシンボリックリンク
として作成し、`PklProject` の `modulePath` はローカルのみにする案。

却下理由: Windows やシンボリックリンクを作成できないファイルシステムで問題が
生じる。加えて、Pkl の `ModulePathResolver` は `Files.find()` を
`FileVisitOption.FOLLOW_LINKS` なしで走査し `attributes.isRegularFile()` で
絞り込むため、**modulePath ディレクトリ内のシンボリックリンクはモジュール解決の
対象にならない**。Nix home-manager 環境では `$XDG_CONFIG_HOME/nas/global.pkl`
が `/nix/store/...` への symlink になるため、`PklProject` の `modulePath` に
グローバル設定ディレクトリを含めるだけでは `modulepath:/global.pkl` の解決に
失敗する。このため読み込みフロー側で `readFile`（symlink を辿る）によりファイル
実体を `.nas/` にコピーする方式を採用した。

### E. config.pkl の amends 行を grep で検査する

`pkl eval` の前に `config.pkl` をテキストとして読み、`amends` 行が
`"modulepath:/global.pkl"` または `"Schema.pkl"` であることを正規表現で
確認する案。

却下理由: テキスト検査では amends 先が Schema と無関係なモジュールである
ケースや、amends チェーンの途中が壊れているケースを検出できない。
`eval.pkl` の型注釈方式はチェーン全体の正当性を end-to-end で検証できる。

### F. ランタイム nonce で amends チェーンを検証する

`Schema.pkl` にトップレベルフィールド `_nasNonce: String = ""` を定義し、
`pkl eval` の直前にランダム値を書き込み、JSON 出力と照合する案。

却下理由: `eval.pkl` の `local validated: Schema = config` で Pkl の
型システムが同等の検証を行うため、nonce の書き込み・照合・
`Schema.pkl` のフィールド汚染が不要。`eval.pkl` 方式の方がシンプルで
Pkl のセマンティクスに沿っている。

### G. pkl eval 出力を zod / RawConfig で再検証する

現行と同様に zod で JSON → Config 変換を行う案。

却下理由: `amends` チェーンが存在すれば Pkl が構造・型・enum・デフォルト値を
すべて検証済みで出力するため、zod による二重検証は冗長。`eval.pkl` の型注釈で
Pkl 型検査の前提を保証し、zod 依存を除去する。

### H. pkl eval の出力を外部から Schema に当てはめる（spread / cast）

`(import("Schema.pkl")) { ...import("config.pkl") }` のような式で
config.pkl が amends を持たなくても型検査する案。

却下理由: Pkl の型システムは typed module の spread を許可しない
（`Cannot iterate over value of type`）。`toDynamic()` すると
`Mapping` 制約に合わない。`as` キャストも別モジュール間では不可。
一方、`import` + 型注釈（`local x: Schema = config`）は動作する。
採用した `eval.pkl` 方式はこの仕組みを利用している。

### I. `pkl eval -x` で eval.pkl を省略する

`pkl eval -f json -x 'import("config.pkl")' ...` のように `-x`（expression）
オプションで `eval.pkl` ファイルなしに評価する案。

却下理由: `-x` は `repl:text` コンテキストで実行されるため、相対 import が
不可（`Module repl:text cannot have a relative import URI`）。
また `-x` 内では `local` 宣言や型注釈が使えず、`-f json` も式の出力には
適用されない。`eval.pkl` ファイルが必要。

## Consequences

### 影響範囲

- `src/config/load.ts`: `findConfigFile` の探索パスを `.nas/config.pkl` に
  変更。`loadPklConfig` を `--project-dir` ベースに書き換え。評価対象を
  `eval.pkl` に変更。tmpDir 生成・`rawConfigToPklSource` の呼び出しを除去
- `src/config/pkl.ts`: `rawConfigToPklSource` / `normalizePklKeys` は
  Pkl → JSON 変換の正規化に引き続き使用。`rawConfigToPklSource` は
  `nas config migrate pkl` 実装時まで死コード化する可能性あり
- `src/cli.ts` (or 新規 `src/cli/config.ts`): `nas config init` サブコマンドの
  追加
- CLI アセット: `Config.pkl` に加え、`config.pkl` テンプレート・`PklProject`
  テンプレート・`global.pkl` テンプレート・`eval.pkl` を同梱
- YAML / Nix 設定の読み込み (`loadGlobalConfig` の yml/nix 分岐、
  `loadNixConfig`、YAML パース) は除去する
- zod 依存 (`src/config/schema.ts`) は除去する。セマンティック検証
  （ホスト形式、allowlist/denylist 重複、env 排他、hostexec overlap 警告）
  のみ薄い手書きバリデーションとして残す
- `.nas/.gitignore` は既に `*` で存在するため変更不要

### トレードオフ

- **Schema.pkl の二重配置**: グローバルとローカルに同一内容の `Schema.pkl` を
  持つ。冗長だが、各ディレクトリが独立して Pkl モジュール解決できることを
  保証する
