# nas — Nix Agent Sandbox

`nas` は、AI コーディングエージェントを Docker サンドボックス内で実行する Linux 向け CLI です。
Claude Code、GitHub Copilot CLI、OpenAI Codex CLI の公式スタンドアロンバイナリを使えます。

ワークスペースと選択したエージェントの既存 state / 認証 directory は、既定で読み書き可能に
mount されます。既存の `~/.config/git` は読み取り専用です。

Nix の自動検出は `/nix`、daemon socket、Nix cache を読み書き可能に mount できます。
不要な profile では `nix.enable = false` を明示してください。

ネットワーク、`extraMounts`、HostExec は policy-controlled な capability です。許可を広げる前に
[信頼境界](https://hogeyama.github.io/nix-agent-sandbox/security/isolation/)を確認してください。

| 操作 | 広がる境界 |
| --- | --- |
| `nas network bind` | エージェントが作成したページをホストの loopback に公開するため、そのページから `127.0.0.1` 上のほかのサービスへ到達できる |
| `nas network forward` | 指定したホストの loopback ポートへエージェントが直接接続できる。通信ルールや承認は適用されないので、認証のないサービスや nas UI 自身のポートは転送しない |

## ユーザーガイド

起動、UI での承認、開発サーバーの確認、作業環境の設定は
[nas ユーザーガイド](https://hogeyama.github.io/nix-agent-sandbox/)を参照してください。

最初に使う場合は、次の順で進めます。

1. [インストール](https://hogeyama.github.io/nix-agent-sandbox/getting-started/installation/)
2. [最初の作業](https://hogeyama.github.io/nix-agent-sandbox/getting-started/quick-start/)
3. [作業の開始・再開](https://hogeyama.github.io/nix-agent-sandbox/work/sessions/)

## 前提条件

- Linux
- Docker 20.10 以降
- 使用するエージェントの公式スタンドアロンバイナリ

npm 版ではなく、Claude Code、GitHub Copilot CLI、または OpenAI Codex CLI の
公式配布バイナリを導入してください。

GitHub Releases の導入例には GitHub CLI (`gh`) と、`PATH` に含まれる
`~/.local/bin` が必要です。

## インストール

### GitHub Releases

ビルド済みバイナリは x86_64-linux と aarch64-linux 向けに公開しています。
aarch64-linux は動作未確認です。

```sh
# x86_64-linux
gh release download --repo Hogeyama/nix-agent-sandbox \
  --pattern 'nas-*_x86_64-linux.tar.gz' -O - | tar xz -C ~/.local/bin
nas
```

```sh
# aarch64-linux
gh release download --repo Hogeyama/nix-agent-sandbox \
  --pattern 'nas-*_aarch64-linux.tar.gz' -O - | tar xz -C ~/.local/bin
nas
```

### Nix

Nix が使える環境では、リポジトリから直接 profile に追加できます。

```sh
nix profile install github:Hogeyama/nix-agent-sandbox
```

## 最小のクイックスタート

作業するリポジトリのルートで設定を生成します。

```sh
cd /path/to/your-project
nas config init
```

`nas config init` は `.nas/` とユーザー共通設定を作成します。
初回生成した `.nas/config.pkl` を次の内容にし、Claude Code の API 接続を許可します。

```pkl
amends "modulepath:/global.pkl"

profiles {
  ["claude"] = (super["claude"]) {
    network {
      scopes {
        ["anthropic"] = (module.presets.anthropic.v1) {
          fallback = "deny"
        }
      }
    }
  }
  ["codex"] = super["codex"]
}
```

設定を確認して信頼し、プロジェクトのルートで起動します。

```sh
nas config trust
nas claude
```

エージェントに依頼した後、ホストのブラウザで http://localhost:3939 を開きます。
UI はエージェントとともに自動起動します。
Sessions で作業を選び、Pending の承認要求や Ports · in の公開ポートを確認できます。

この例では API 以外への通信を拒否します。作業に必要な接続先は
[外部への通信許可](https://hogeyama.github.io/nix-agent-sandbox/configuration/network/)で追加します。
設定変更の反映は[設定の変更と反映](https://hogeyama.github.io/nix-agent-sandbox/configuration/profiles/)を参照してください。

## 作業中の操作

- [通信・ホスト実行の承認](https://hogeyama.github.io/nix-agent-sandbox/work/approvals/)
- [開発サーバーの確認](https://hogeyama.github.io/nix-agent-sandbox/work/preview/)
- [作業中の問題と調査](https://hogeyama.github.io/nix-agent-sandbox/work/troubleshooting/)
- [過去の作業と利用量](https://hogeyama.github.io/nix-agent-sandbox/work/history/)
- [作業の終了と片付け](https://hogeyama.github.io/nix-agent-sandbox/work/finish/)

## 作業環境の設定

- [ファイルの共有と非公開](https://hogeyama.github.io/nix-agent-sandbox/configuration/files/)
- [ホストコマンドの実行許可](https://hogeyama.github.io/nix-agent-sandbox/configuration/host-commands/)
- [ホストの DB・API への接続](https://hogeyama.github.io/nix-agent-sandbox/configuration/host-services/)
- [ホストの認証情報の利用](https://hogeyama.github.io/nix-agent-sandbox/configuration/authentication/)
- [開発ツールと Docker](https://hogeyama.github.io/nix-agent-sandbox/configuration/development/)
- [GUI アプリの表示](https://hogeyama.github.io/nix-agent-sandbox/configuration/gui/)
- [入力待ちの通知](https://hogeyama.github.io/nix-agent-sandbox/configuration/notifications/)
- [記録と保存期間](https://hogeyama.github.io/nix-agent-sandbox/configuration/recording/)

## ライセンスと着想

nas は [MIT License](LICENSE) で提供されます。

設計は [agent-workspace](https://github.com/hiragram/agent-workspace) に着想を得ています。
