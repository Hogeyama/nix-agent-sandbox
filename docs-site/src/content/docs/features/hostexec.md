---
title: HostExec
description: ホスト上のコマンド実行と承認ルール
---

認証情報やツールをコンテナへ渡さずに、それらが必要なコマンドだけを実行させたい場合に使います。たとえば、ビルド時に必要な秘密値を、そのコマンドにだけ渡せます。

この仕組みを HostExec と呼びます。エージェントからの要求を受け、コンテナの外側のホストでコマンドを実行します。実行ファイル、引数、作業ディレクトリをルールで制限します。

委譲したコマンドはホストの権限で動きます。シェルやビルドツールは入力から別のコードも実行できるため、コマンド名だけの制限では不十分です。

## 設定例

[対象プロファイル](/nix-agent-sandbox/getting-started/configuration/#プロファイルの編集)に追加します。

まず、認証情報を使わない `uptime` で、実行場所と承認の動作を確認します。`/usr/bin/uptime` はホスト上の実際のパスに合わせてください。

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

ルールの一致は、ホストで確認できます。

```sh
nas hostexec test --profile <profile> -- /usr/bin/uptime
```

設定を確認して `nas config trust` を実行後、対象プロファイルで起動します。エージェントに、ルールで指定したパスの `uptime` を引数なしで実行させてください。

承認画面にそのパスと作業ディレクトリが表示されたら、内容を確認して承認します。ホストの稼働時間がコマンドの結果として返ります。

一致した要求は `allow` で許可、`prompt` で承認待ち、`deny` で拒否します。時間切れは拒否です。承認範囲と操作は[通信・ホスト実行の承認](/nix-agent-sandbox/operations/approvals/)を参照してください。

<img src="/nix-agent-sandbox/images/hostexec-prompt.png" width="720" alt="実行コマンド、引数、作業ディレクトリを示す HostExec の承認画面" />

## 設定項目

| 設定 | 既定 | 用途 |
| --- | --- | --- |
| `rules[].id` | — | 監査と承認の再利用に使う識別子。 |
| `rules[].match.argv0` | — | コマンド名、絶対パス、または相対パスを完全一致で指定。 |
| `rules[].match.argRegex` | なし | 引数をスペースで連結した文字列に対する正規表現。 |
| `cwd.mode` | `"workspace-or-session-tmp"` | 実行可能な作業ディレクトリを制限する。 |
| `inheritEnv.mode` | `"minimal"` | ホスト環境の継承を最小化する。 |
| `approval` | `"prompt"` | `"allow"`、`"prompt"`、`"deny"` を選ぶ。 |
| `fallback` | `"container"` | 現在の実装では変更しても不一致時の動作に影響しない。 |

## 注意点

### 実行ファイルと設定の保護

実行ファイル、PATH 上のコマンド、委譲先が読む設定・スクリプトをエージェントが変更できると、ホストで別の処理を実行できます。必要なファイルは読み取り専用で共有してください。相対パスのコマンドには[作業ディレクトリの制約](/nix-agent-sandbox/recipes/relative-hostexec/#作業ディレクトリの制約)もあります。

### 秘密の注入と出力マスク

ルールの `env { ["TOKEN"] = "secret:token" }` は、`hostexec.secrets` の値をそのホスト実行にだけ渡します。出力もマスクするには、同じ取得元をプロファイルの `secrets` に登録し、`mask.apply` に含めて `mask.filter = true` にします。具体例は [.env の非公開とホスト実行](/nix-agent-sandbox/recipes/mask-env/)を参照してください。

### 不一致時の動作

ルール不一致はコンテナ実行へのフォールバック応答になりますが、実行成功の保証はありません。LD_PRELOAD 経由では終了コード 127 になる場合があり、ラッパー経由でもコンテナ内の実行ファイルが必要です。現在の実装では `HostExecRule.fallback` を変更しても、この動作は変わりません。一致したルールの `approval = "deny"` はエラーを返します。

## 関連ページ

- [ファイル隔離・マウント](/nix-agent-sandbox/features/filesystem/) — ルールが参照するファイルを読み取り専用にする
- [シークレット・認証情報](/nix-agent-sandbox/features/secrets/) — ルールごとの秘密値の注入
- [Schema.pkl](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/src/config/Schema.pkl) — `HostExecConfig` とルールの全定義
