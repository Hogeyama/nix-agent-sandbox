---
title: 最初の作業
description: 最初のエージェント起動と、自動起動する UI での作業確認
---

エージェントにプロジェクトについて質問し、作業中のセッションをブラウザの UI で確認するところまで進めます。nas、Docker、使うエージェントは[導入済み](../installation/)の前提です。

以下は Claude Code の例です。Codex を使う場合は [Codex での最初の作業](#codex-での最初の作業)へ進みます。

## プロジェクトの準備

ホストのターミナルで、作業するプロジェクトへ移動して設定を作成します。

```sh
cd /path/to/your-project
nas config init
```

プロジェクトの `.nas/config.pkl` とユーザー共通の設定が生成されます。初回生成した `.nas/config.pkl` を次の内容にします。Claude Code の API 接続を許可する例です。

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

この例では、Claude Code の API 以外への通信は拒否します。まず API への接続と応答を確認し、作業に必要な配布元などは後から[ネットワーク制御](/nix-agent-sandbox/configuration/network/)で追加します。

## 最初の起動

編集した設定を確認して信頼し、エージェントを起動します。

```sh
nas config trust
nas claude
```

Claude Code の画面で「このプロジェクトの構成を説明して」と入力します。プロジェクトについて応答が返れば、エージェントの起動と API 接続を確認できています。

## 作業の確認画面

**エージェントの起動に合わせて UI も自動で起動します。** ホストのブラウザで [http://localhost:3939](http://localhost:3939) を開きます。

<img src="/nix-agent-sandbox/images/ui-workspace.png" width="1200" alt="nas の操作画面。左に Sessions の作業一覧、右に Pending の承認要求と Ports · in のポート公開欄" />

画面はブラウザターミナルも有効にした例示用のセッションです。この初回設定ではエージェントへの入力は起動元のターミナルで行います。ブラウザからの入力は[再接続の設定](/nix-agent-sandbox/work/sessions/#エージェントへの入力と再接続)で有効にできます。左の **Sessions** でプロジェクトのパスとプロファイルを確認して、作業中のセッションを選びます。ここに起動したセッションが表示されれば、UI からその作業を確認できています。

作業中の通信やホスト実行に判断が必要になると、右の **Pending** に要求が届きます。[通信・ホスト実行の承認](/nix-agent-sandbox/work/approvals/)で内容と許可範囲を確認します。エージェントが開発サーバーを起動したら、同じペインの **Ports · in** から[ページをブラウザで確認](/nix-agent-sandbox/work/preview/)できます。

この設定例で拒否された通信は Pending には現れません。応答や作業が通信エラーで止まった場合は、[監査ログ](/nix-agent-sandbox/work/troubleshooting/)で拒否された要求を調べます。

## Codex での最初の作業

Claude Code の導入や、上の Claude 用の設定は不要です。ホストで作業するプロジェクトへ移動し、`nas config init` を実行します。生成された `.nas/config.pkl` の codex プロファイルを使います。

ホストの Codex で認証を済ませておきます。認証情報を OS のキーリングに保存している場合は、起動前に [Codex のキーリング](/nix-agent-sandbox/configuration/authentication/#codex-のキーリング)の共有設定を codex プロファイルへ追加します。

```sh
nas config trust
nas codex
```

起動後は、上の[作業の確認画面](#作業の確認画面)と同じように `http://localhost:3939` を開き、Codex のセッションを選びます。

**生成直後の設定は Codex の API 通信を許可していません。** 最初の質問が通信エラーになったら、[Settings → Audit](/nix-agent-sandbox/work/troubleshooting/#許可拒否の記録)でそのセッションの拒否された接続先を確認します。[外部への通信許可](/nix-agent-sandbox/configuration/network/#接続先の追加)に従って codex プロファイルへ接続先と必要な要求を追加し、再信頼して `nas codex` を起動し直します。

「このプロジェクトの構成を説明して」と質問し、応答が返ることを確認します。追加の通信先が拒否された場合も同じ調査と設定の手順を使います。Claude 用の anthropic プリセットは Codex の通信許可にはなりません。

## 最初の作業の終了

質問と UI の確認が終わったら、起動したターミナルでエージェントの終了操作を行います。ブラウザを閉じるだけではセッションは終了しません。共有フォルダーへの変更はホストに残ります。

次の作業や再接続は[作業の開始・再開](/nix-agent-sandbox/work/sessions/)、不要な作業環境の削除は[作業の終了と片付け](/nix-agent-sandbox/work/finish/)に進みます。
