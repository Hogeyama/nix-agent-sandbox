---
title: クイックスタート
description: Claude Code 用の設定ファイルの作成、通信許可、最初の起動
---

nas、Docker、Claude Code を導入済みの環境で、最初のセッションを起動する手順です。ここでは Claude Code の API 接続を許可する設定を使います。

## 設定ファイルの作成

ホストのターミナルで、作業したいプロジェクトへ移動して実行します。

```sh
cd /path/to/your-project
nas config init
```

`.nas/config.pkl` とユーザー共通の設定が生成されます。

## 通信の設定

初回生成した `.nas/config.pkl` を、次の内容にします。共通設定の `claude` プロファイルに、Claude Code 用の通信許可を追加する例です。

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

この例で追加した許可は Claude Code 用 API の範囲です。パッケージのダウンロードや他の API 接続が必要になった場合は、[ネットワーク制御](/nix-agent-sandbox/features/network/)に従って接続先を追加します。

## 設定の確認と起動

編集した内容を確認し、同じプロジェクトのターミナルで実行します。

```sh
nas config trust
nas claude
```

Claude Code の画面が開いたら、プロジェクト内のファイルについて質問してください。応答を確認できれば、起動と API 接続を確認できています。

通信が拒否された場合は、接続先と拒否理由を[監査ログ](/nix-agent-sandbox/operations/audit/)で確認します。

## 他のエージェント

生成される共通設定には `claude` と `codex` のプロファイルがあります。上の通信設定は `claude` にだけ適用されます。Codex には必要な通信先を設定したうえで `nas codex` を使います。Copilot 用のプロファイルには `agent = "copilot"` を指定します。

プロファイルの追加と編集位置は[設定の基本](../configuration/)を参照してください。nas のオプションはプロファイル名より前、エージェントへの引数は後ろに置きます。
