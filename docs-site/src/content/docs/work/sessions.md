---
title: 作業の開始・再開
description: UI でのセッション選択、ターミナルへの再接続、別の作業フォルダーでの起動
---

一度起動した作業へ戻るときも、次の作業を始めるときも、UI の **Sessions** で対象を選びます。UI はエージェントとともに自動起動し、ホストのブラウザから [http://localhost:3939](http://localhost:3939) で開けます。初回の設定と起動は[最初の作業](/nix-agent-sandbox/getting-started/quick-start/)を参照してください。

## 作業対象の選択

Sessions にはプロジェクトのパスとプロファイルが表示されます。同じプロジェクトで複数の作業をしている場合は、名前をダブルクリックして区別できる名前に変更します。

<img src="/nix-agent-sandbox/images/ui-workspace.png" width="1200" alt="左の Sessions で作業を選び、右の Pending で承認とポート公開を確認する nas の画面" />

例示用データの画面です。対象を選ぶと、そのセッションの[承認要求](/nix-agent-sandbox/work/approvals/)や[開発サーバー](/nix-agent-sandbox/work/preview/)を確認できます。右側の Pending が閉じている場合は、右端の展開ボタンを押します。

## エージェントへの入力と再接続

CLI から通常起動したエージェントには、起動したターミナルで入力します。**UI にセッションが表示されることと、中央のターミナルから入力できることは別です。** ブラウザからも入力する場合は、ホストに `dtach` を導入し、[対象プロファイル](/nix-agent-sandbox/configuration/profiles/#プロファイルの編集)に次を設定して起動し直します。

```pkl
session = new SessionConfig {
  multiplex = true
  detachKey = "^\\"
}
```

この設定で開始したセッションは、UI の Sessions で選ぶと中央のターミナルに接続できます。ブラウザを閉じても作業は継続し、同じ UI を開いて選び直せます。複数のターミナルからの入力は共有されるため、同時に操作しないでください。

起動した CLI ターミナルを切り離すキーは、既定で **Ctrl+\** です。後から CLI で再接続する場合は、ホストで次を実行します。

```sh
nas session list
nas session attach <session-id>
```

`<session-id>` は一覧の ID に置き換えます。`attach` で再接続した後の切り離しキーは dtach の既定値です。切り離しやブラウザを閉じる操作は、エージェントの終了ではありません。

## 別の作業の開始

UI の **+ new session** から、新しいセッションを起動できます。これにはホストの `dtach` が必要です。使用するプロジェクトの設定を編集した場合は、先に内容を確認して、そのプロジェクトで `nas config trust` を実行しておきます。

<img src="/nix-agent-sandbox/images/ui-new-session.png" width="520" alt="New Session の Directory、Profile、Worktree Base Branch、Session Name と Launch" />

例示用データの画面です。次の順で選びます。

1. **Directory**：Recent から作業フォルダーを選ぶか、Custom にホスト上の絶対パスを入力します。
2. **Profile**：そのプロジェクトで使うプロファイルを選びます。
3. **Worktree Base Branch**：同じフォルダーで作業するなら **None**、別の作業フォルダーを作るなら基準ブランチを選びます。
4. 必要なら **Session Name** を付け、**Launch** を押します。

起動後は中央のターミナルでエージェントに依頼できます。UI からの起動では `session.multiplex` を別途有効にする必要はありません。

### 別のブランチでの作業

同じフォルダーで並行作業をすると、ファイルの変更も共有されます。変更を分けたい場合は、Git リポジトリで Worktree Base Branch を選びます。nas は `.nas/worktrees/nas-<timestamp>/` と `nas/<timestamp>` ブランチを作り、そこで起動します。

**None は worktree を作らない指定です。** プロファイルに `worktree.base` があっても、その起動では無効になります。

CLI から一回だけ基準ブランチを指定する場合は、`nas -b main claude` を使えます。`-b` はプロファイル名より前に置き、現在の HEAD を使う場合は `main` の代わりに `@` を指定します。

### 作業フォルダー作成時の準備

毎回同じ基準ブランチを使う場合や、作成直後に準備コマンドを実行する場合は、対象プロファイルに設定します。**`onCreate` はホストで `bash -c` として実行します。** エージェントが変更できるスクリプトを指定する場合は、その変更もホストで実行されることを確認してください。

```pkl
worktree = new WorktreeConfig {
  base = "main"
  onCreate = "bun install"
}
```

既存の worktree がある場合は、再利用か新規作成を選べます。終了時に変更を保存・統合する手順は[作業の終了と片付け](/nix-agent-sandbox/work/finish/)にまとめています。

## 入力待ちの見分け方

エージェントの入力待ちや作業状態を UI に反映するには、[入力待ちの通知](/nix-agent-sandbox/configuration/notifications/)を設定します。通信・ホスト実行の承認要求は Pending に届くので、エージェントの入力待ちとは分けて確認します。
