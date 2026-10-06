---
title: Bash の隔離
description: コンテナ内で bubblewrap を使えるようにし、Claude Code の Bash を内蔵 sandbox で隔離する設定
---

Claude Code の内蔵 sandbox を有効にすると、Claude が Bash で実行するコマンドを bubblewrap で隔離し、通信先を制限できます。nas はコンテナ内で bubblewrap を使えるようにし、何を制限するかは Claude Code の設定で決めます。

## Bash を隔離する理由

Claude Code を動かすには `api.anthropic.com` への通信を許可する必要があります。ところが Messages API には、要求に書いた任意の URL へ Anthropic のサーバーから接続する機能があります（MCP connector、web fetch など）。Bash から `api.anthropic.com` へ直接要求を送れると、nas の proxy が許可していない相手にも情報を送れます。

nas の proxy から見ると、この要求も Claude Code 本体の要求も `api.anthropic.com` への `POST /v1/messages` です。宛先では区別できないので、Bash だけを `api.anthropic.com` に届かないようにします。

## nas が用意するもの

`bwrap.support` は既定で有効です。有効なとき、nas は次のようにコンテナを起動します。

- Docker の既定の seccomp プロファイルに、bubblewrap が user namespace を作るためのシステムコール（`clone`、`unshare`、`mount`、`umount2`、`pivot_root`）の許可を加えたプロファイルを使う
- AppArmor を `unconfined` にする。Docker がコンテナに適用する AppArmor プロファイルが `mount` を拒否するため
- イメージに bubblewrap と socat を入れる

capability は追加しません。コンテナ内で得られる権限は変わらず、増えるのはコンテナ内から呼べるカーネルの処理です。

Ubuntu 24.04 以降では、ホストの設定（`kernel.apparmor_restrict_unprivileged_userns`）が非特権の user namespace の作成を制限します。これはホストの設定なので、nas からは変えられません。

不要なら[対象プロファイル](/nix-agent-sandbox/configuration/profiles/#プロファイルの編集)で無効にします。

```pkl
bwrap = new BwrapConfig {
  support = false
}
```

## Claude Code の設定

Claude Code の内蔵 sandbox は、Claude Code の設定で有効にします。プロファイルの `agentArgs` で `--settings` に渡すと、エージェントから設定を書き換えられません。

```pkl
agentArgs {
  "--settings"
  #"{"sandbox":{"enabled":true,"failIfUnavailable":true,"allowUnsandboxedCommands":false,"enableWeakerNestedSandbox":true,"filesystem":{"disabled":true},"network":{"allowedDomains":["*"],"deniedDomains":["api.anthropic.com","mcp-proxy.anthropic.com"],"strictAllowlist":true,"allowAllUnixSockets":true}}}"#
}
```

| 設定 | 理由 |
| --- | --- |
| `failIfUnavailable`、`allowUnsandboxedCommands: false` | sandbox が起動できないときや、Claude が sandbox の外での実行を求めたときに、隔離なしで実行しない |
| `enableWeakerNestedSandbox` | Docker がコンテナの `/proc` の一部を隠しているため、新しい `/proc` をマウントできない。代わりにコンテナの `/proc` を見せる。Bash から見えるのはコンテナ内のプロセスだけで、ホストのプロセスは見えない |
| `filesystem.disabled` | ファイルの読み書きは nas のマウントで制限しているので、内蔵 sandbox では制限しない |
| `allowedDomains: ["*"]`、`deniedDomains` | Anthropic の2つのホストだけを拒否し、それ以外の判定は nas の proxy に任せる。承認もこれまでどおり nas で行う。`mcp-proxy.anthropic.com` には nas がホストの認証情報を付けるので、拒否しないと Bash から claude.ai の connector を操作できる |
| `allowAllUnixSockets` | hostexec など、nas がコンテナに渡した Unix ソケットを Bash から使えるようにする |

`filesystem.disabled` は、プロジェクトの `.claude/settings.json` には書けません。`--settings`、ユーザー設定、managed settings のいずれかで指定します。

## 隔離が及ばないもの

- **`excludedCommands` に書いたコマンド**: sandbox の外で実行され、`api.anthropic.com` に届きます。`curl` や `bash` などの汎用的なコマンドを書かないでください。
- **Docker**: Bash から DinD の docker デーモンには届かないので、`docker` コマンドは使えません。`excludedCommands` で docker を sandbox の外で実行させると、DinD の中のコンテナから nas の proxy を経由して `api.anthropic.com` に届く経路が残ります。
- **hostexec**: 承認したコマンドはホストで実行されるので、内蔵 sandbox も nas の proxy も通りません。
- **MCP server と hook**: Claude Code が sandbox の外で起動するので、隔離されません。
- **`enableWeakerNetworkIsolation`**: Bash がコンテナのネットワークを共有し、内蔵 sandbox の通信の制限を通らなくなります。指定しないでください。

## 起動の問題

| 状態 | 確認事項 |
| --- | --- |
| `No permissions to create a new namespace` | `bwrap.support` が有効か。ホストのカーネルで非特権の user namespace が使えるか。ホストの AppArmor が制限していないか |
| `Can't mount proc on /newroot/proc` | Claude Code の設定に `enableWeakerNestedSandbox` があるか |
| Bash の通信がすべて失敗する | `allowedDomains` に `"*"` があるか |
