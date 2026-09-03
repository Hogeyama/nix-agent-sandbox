---
title: HostExec
description: 狭い rule と承認でホストのコマンドを実行する
---

## どんな機能？

HostExec は、コンテナ内から指定したコマンドだけをホスト側 broker 経由で実行します。host の filesystem や認証情報を広くマウントする代わりではありません。stable な rule ID、正確な `argv0`、絞り込んだ引数と作業ディレクトリで、許可する capability を小さくします。

## いつ使う？

ホストにしかない credential helper やローカルツールを、限定された操作だけで使うときに選びます。ビルド runner、shell、言語 runtime、editor のように設定や入力から任意コードを実行できるものを広く委譲しないでください。

## 主要な設定項目

| 設定 | 既定 | 用途 |
| --- | --- | --- |
| `rules[].id` | — | 監査と承認 fingerprint に使う安定 ID。 |
| `rules[].match.argv0` | — | bare name、絶対パス、または相対パスを正確に指定する。 |
| `rules[].match.argRegex` | なし | `argv0` 以降を space で join した文字列に対する正規表現。 |
| `cwd.mode` | `"workspace-or-session-tmp"` | 実行可能な作業ディレクトリを制限する。 |
| `inheritEnv.mode` | `"minimal"` | host 環境の継承を最小化する。 |
| `approval` | `"prompt"` | `"allow"`、`"prompt"`、`"deny"` を選ぶ。 |
| `fallback` | `"container"` | Schema 上は rule 不一致・不許可時に `"container"` または `"deny"` を選ぶ。現在の runtime は per-rule の `"deny"` を実行しない。 |

## 最小の設定例

次は host の固定パスにある `uptime` を、引数なし・workspace 内の cwd・最小環境で prompt 承認します。`/usr/bin/uptime` は実際の host 上の固定パスへ置き換えてください。`uptime` 自身は repository の設定や hook を読まないため、workspace を cwd にしても agent が書き換える設定を消費しません。

```pkl
hostexec = new HostExecConfig {
  rules {
    new {
      id = "host-uptime"
      match { argv0 = "/usr/bin/uptime"; argRegex = "^$" }
      cwd { mode = "workspace-only" }
      inheritEnv { mode = "minimal" }
      approval = "prompt"
      fallback = "container"
    }
  }
}
```

`allow` は一致した実行を常に許可、`prompt` は承認キューへ追加、`deny` は常に拒否します。prompt の timeout は拒否です。承認範囲は `once`（その一回だけ）または `capability`（同じ rule / command capability を session 中に再利用）で選べ、`hostexec.prompt.defaultScope` の既定は `"capability"` です。現在の runtime では rule 不一致に fallback response を返し、rule に一致して `approval = "deny"` の場合は error になります。fallback response はコンテナ実行の成功を保証しません。LD_PRELOAD 経路で spawn された command は 127 で終わることがあり、wrapper 経路でも実行可能な container binary が必要です。Schema にある `HostExecRule.fallback` はこの挙動を切り替えません。

## 注意点・セキュリティへの影響

- `env { ["TOKEN"] = "secret:token" }` は `hostexec.secrets` の名前付き秘密を、その rule のホスト実行時だけ注入します。この registry は profile の `secrets` とは別です。注入だけでは stdout / stderr のマスクは保証しません。出力 filter は profile の `secrets` から `mask.apply` で選んだ値を、`mask = new MaskConfig { filter = true }` で使います。注入値も出力で伏せたいなら、必要な取得元を両方の registry に登録し、profile 側の `mask.apply` にも含めてください。`unsafe-inherit-all` は host 環境を広く渡すため、通常は使いません。
- コンテナにマウントされる exec socket は execute / fallback 用だけです。approve、deny、pending 一覧を扱う control socket は host 専用で、エージェント自身が承認できないよう分離されています。
- `mask.filter = true` の場合、hostexec の stdout / stderr も秘密マスクの対象です。HostExec のために生の秘密 frame をコンテナへ渡すことはありません。
- relative `argv0`、PATH 上の executable、委譲先が読む設定ファイルをコンテナから変更できると、rule の意味を超えたホスト実行につながります。必要なファイルは [ファイル隔離・マウント](/nix-agent-sandbox/features/filesystem/) の `ro` mount で保護してください。

[HostExec のリスク](/nix-agent-sandbox/security/risks/#hostexec)と、current runtime の fallback / relative cwd の[制約](/nix-agent-sandbox/security/limitations/#実装上の境界)を確認してから rule を追加してください。

<img src="/nix-agent-sandbox/images/hostexec-prompt.png" width="720" alt="HostExec の承認画面。rule ID、作業ディレクトリ、実行する引数を確認する。" />

<img src="/nix-agent-sandbox/images/hostexec-result.png" width="720" alt="HostExec 承認後の結果画面。実行結果を確認できる。" />

設定した rule が意図どおりに一致するかは、実行前に確認できます。

```sh
nas hostexec test --profile <profile> -- /usr/bin/uptime
```

## 関連ページ

- [ファイル隔離・マウント](/nix-agent-sandbox/features/filesystem/) — rule が参照するファイルを読み取り専用にする
- [シークレット・認証情報](/nix-agent-sandbox/features/secrets/) — rule-scoped な secret injection
- [Schema.pkl](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/src/config/Schema.pkl) — `HostExecConfig` と rule の全定義
