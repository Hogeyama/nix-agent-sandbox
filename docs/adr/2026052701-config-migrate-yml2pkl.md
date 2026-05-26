---
Status: Draft
Date: 2026-05-27
---

# ADR: `nas config migrate yml2pkl` コマンド (Draft)

## Context

ADR 2026052601 で設定形式を Pkl 一本化し、YAML/Nix ローダーは
削除した。しかし既存ユーザーの手元には旧 `.agent-sandbox.yml` が残っている。
手動で YAML → Pkl に書き直すのは、kebab-case → camelCase 変換・Listing/Mapping
構文・amends ヘッダなど、機械的だが面倒な作業が多い。

ADR 2026052601 の「将来」セクションで `nas config migrate pkl` として言及
されていた変換コマンドを具体化する。

## Decision

### ローカルとグローバルは排他モード

`nas config migrate yml2pkl` は 2 つの排他モードを持つ:

| モード | 入力探索 | 出力先 |
|--------|----------|--------|
| ローカル (デフォルト) | cwd から親方向に `.agent-sandbox.yml` を探索 | `.nas/config.pkl` |
| グローバル (`--global`) | `$XDG_CONFIG_HOME/nas/agent-sandbox.yml` | `$XDG_CONFIG_HOME/nas/global.pkl` |

両方変換するにはコマンドを 2 回実行する。グローバルとローカルで入力ファイルの
探索・出力先・scaffold の扱いがすべて異なるため、同時実行時にどちらか一方が
失敗した場合のロールバックが複雑になる。排他にすれば各実行の成否が明確で
troubleshoot しやすい。

`--input <path>` で変換元 YAML を明示指定できる。省略時は上記のデフォルト探索
を行う。旧来の `findConfigFile` と同じ親方向探索パターン。

出力先が既に存在する場合はエラーで停止する。`--force` で上書きを許可する。

### amends ヘッダは常に `"Schema.pkl"`

ローカル・グローバルともに `amends "Schema.pkl"` を出力する。
`amends "modulepath:/global.pkl"` チェーンにはしない。

YAML 時代はグローバル/ローカルのマージを TypeScript 側 (`mergeRawConfigs`)
が担っていたため、各 YAML ファイルはグローバル設定の存在を前提としない
自己完結した値を持っていた。自動で amends チェーンに切り替えると、
グローバル側の値が暗黙にマージされ、YAML 時代と異なる挙動になるリスクがある。

Pkl の `amends "modulepath:/global.pkl"` への移行はユーザーが手動で行う
（config.pkl テンプレートのコメントに案内がある）。

### kebab-case → camelCase はホワイトリスト方式

YAML のキー名は kebab-case (`agent-args`, `extra-mounts`, `mount-socket` 等)。
Pkl の Schema.pkl は camelCase (`agentArgs`, `extraMounts`, `mountSocket`)。

変換対象のキーはホワイトリスト方式で管理する（以前の `pkl.ts` にあった
`KEBAB_KEYS` と同一セット）。ホワイトリスト外のキー（プロファイル名、
シークレット名、env の key/val 等のユーザー定義値）はそのまま保持する。

全キーを一律変換しない理由: `profiles` の子キーはプロファイル名であり、
`hostexec.secrets` の子キーはシークレット名である。これらは kebab-case であっても
ユーザーが意図的に付けた名前なので変換してはならない。

### Pkl 構文マッピング

| YAML | Pkl |
|------|-----|
| スカラー値 | そのまま (`"string"`, `true`, `42`) |
| 配列 | `new Listing { ... }` |
| ネストオブジェクト (設定フィールド) | `key { ... }` ブロック |
| Mapping 親 (`profiles`, `hostexec.secrets`, `hostexec.rules.*.env`) | ブラケット記法 `["key"] { ... }` |
| null / undefined | フィールドごとスキップ |

Mapping 親のパスセットは以前の `pkl.ts` にあった
`MAPPING_PARENT_PATHS` と同一。Pkl の型定義で `Mapping<K, V>` として
宣言されているフィールドは、ブラケット記法でないと `pkl eval` がエラーになる。

### デフォルト値は省略しない

YAML に書いてあるフィールドは Schema.pkl のデフォルト値と一致していても
全て出力する。理由:

- 変換ロジックがシンプルになる（DEFAULT_* 定数や Schema.pkl のデフォルト値
  との照合が不要）
- ユーザーが意図的に明示した値なのかデフォルトと同じ値をたまたま書いていた
  だけなのかを変換ツールが判断できない
- 冗長なフィールドは変換後にユーザーが手で削除できる

### scaffold の自動生成

ローカルモードでは、`.nas/` scaffold（Schema.pkl, PklProject, .gitignore）が
存在しなければ既存の `initConfig()` を呼んでから config.pkl を書き出す。
グローバルモードでは `$XDG_CONFIG_HOME/nas/` ディレクトリと Schema.pkl が
無ければ作成する。

コマンド一発で scaffold + config 生成まで完結させる。`stdout` に出力して
ユーザーにリダイレクトさせる方式だと scaffold 生成が別手順になり、
移行の手間が増える。

### 元の YAML は削除しない

変換結果を確認してからユーザーが手動で削除する。変換ツールが勝手に消すと
問題があった場合にロールバックできない。

### 変換ロジックの実装元

以前の `pkl.ts` にあった `rawConfigToPklSource` を復活・適応させる。
amends ヘッダを `"modulepath:/Config.pkl"` → `"Schema.pkl"` に変更し、
移行ツール専用のモジュールに閉じ込める。メインの設定読み込みパスには
影響しない。

YAML パースは `Bun.YAML.parse` を使う。Bun 組み込みなので追加の npm 依存は
不要。

### 出力例

入力 YAML:

```yaml
default: dev
profiles:
  dev:
    agent: claude
    agent-args: ["--dangerously-skip-permissions"]
    nix:
      enable: true
      extra-packages: ["ripgrep", "fd"]
    network:
      allowlist: ["github.com:443"]
```

出力 Pkl:

```pkl
amends "Schema.pkl"

default = "dev"
profiles {
  ["dev"] {
    agent = "claude"
    agentArgs = new Listing {
      "--dangerously-skip-permissions"
    }
    nix {
      enable = true
      extraPackages = new Listing {
        "ripgrep"
        "fd"
      }
    }
    network {
      allowlist = new Listing {
        "github.com:443"
      }
    }
  }
}
```

ここに反映されている決定: プロファイル名 `dev` はブラケット記法で保持、
`agent-args` → `agentArgs` に変換、配列は `new Listing { ... }`、
`nix` 配下のオブジェクトはブロック構文、`enable: true` はデフォルト値だが
省略せず出力。

## Alternatives considered

### A. ローカルの amends を `"modulepath:/global.pkl"` にする

変換時にグローバル設定の存在を検出し、存在すれば
`amends "modulepath:/global.pkl"` を出力する案。

却下理由: YAML 時代のローカル設定はグローバルとのマージを前提としない
自己完結した値を持っていた。自動で amends チェーンに切り替えると、
グローバル側の値が暗黙にマージされ、YAML 時代と異なる挙動になるリスクがある。
ユーザーが意図的に切り替えるのが安全。

### B. `--global` を排他ではなく同時実行可能にする

フラグなしで両方、`--local-only` / `--global-only` で片方だけにする案。

却下理由: グローバルとローカルで入力ファイルの探索・出力先・scaffold の
扱いがすべて異なる。同時実行時にどちらか一方が失敗した場合のロールバックが
複雑。2 回実行は手間だが、各実行の成否が明確で troubleshoot しやすい。

### C. デフォルト値を省略してコンパクトに出力する

Schema.pkl のデフォルト値と照合し、一致するフィールドを省略する案。

却下理由: 変換ロジックに全デフォルト値のミラーが必要になり、
Schema.pkl のデフォルト変更時に同期漏れのリスクがある。
「YAML に書いてあったものはそのまま出す」が最もシンプルで安全。

### D. stdout に出力し、ユーザーがリダイレクトで書き込む

`nas config migrate yml2pkl > .nas/config.pkl` 方式。

却下理由: `.nas/` scaffold の生成（initConfig）を別途手動で行う必要があり、
ユーザーの手順が増える。コマンド一発で scaffold 生成 + config 書き出しまで
完結するほうが移行体験がよい。

## Consequences

- 削除済みの `rawConfigToPklSource` 相当のコードを移行ツール専用
  モジュールとして復活させる。メインの設定読み込みパスとは独立しており、
  将来 YAML 移行が完了すれば丸ごと削除できる
- `Bun.YAML.parse` への依存が生じるが、Bun 組み込みのため npm 依存は増えない
- scaffold 自動生成により、`nas config init` を事前に実行していなくても
  `migrate yml2pkl` 一発で動作する環境が整う
- 元の `.agent-sandbox.yml` は残るため、ユーザーは変換結果を確認してから
  手動で削除する必要がある。削除忘れがあっても `.nas/config.pkl` が優先
  されるため実害はない（YAML ローダーは既に存在しない）
