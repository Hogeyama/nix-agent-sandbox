---
title: 相対パスコマンドのホスト実行
description: Gradle wrapper のホスト実行と作業ディレクトリの制約
---

作業フォルダーの `./gradlew assembleDebug` を、承認後にホストで実行する例です。相対パスは実行時の作業ディレクトリから解決されるため、ルートの `gradlew` だけに固定する設定ではありません。

## 前提条件

- エージェントの API への通信許可を設定済み。Claude Code の例は[クイックスタート](/nix-agent-sandbox/getting-started/quick-start/)を参照。

- 作業フォルダーに `gradlew` があり、ホストに必要な JDK などがある。
- 実行ごとに、承認画面の作業ディレクトリとファイルの変更状態を確認する。

## 設定例

エージェントとの通信を設定済みの `claude` プロファイルに、以下の設定を追加します。編集先は[プロファイルの編集](/nix-agent-sandbox/getting-started/configuration/#プロファイルの編集)を参照してください。既存の設定項目がある場合は、その中に要素を追加し、通信先やルールを残してください。

```pkl
hostexec = new HostExecConfig {
  rules = new Listing {
    new HostExecRule {
      id = "gradlew-assemble-debug"
      match { argv0 = "./gradlew"; argRegex = "^assembleDebug$" }
      cwd { mode = "workspace-only" }
      inheritEnv { mode = "minimal" }
      approval = "prompt"
    }
  }
}
```

設定を確認して `nas config trust` を実行後、ホストでルールの一致を確認します。

```sh
nas hostexec test --profile claude -- ./gradlew assembleDebug
```

`nas claude` で起動し、エージェントが対象コマンドを要求したら、一回限りで承認します。

## 作業ディレクトリの制約

`workspace-only` は子ディレクトリも許します。エージェントが子ディレクトリに別の `gradlew` を作り、そこから実行しても同じルールに一致します。ルートのファイルを読み取り専用にしても、この要求は防げません。

承認前に、作業ディレクトリ、コマンド、引数、`[CHANGED-SINCE-START]` の有無を確認し、`--scope once` を選んでください。セッション中の承認再利用は避けてください。

この確認に依存できない場合は、作業フォルダー外の、エージェントが変更できない絶対パスのスクリプトをルールに指定します。

## 関連ページ

- [HostExec](/nix-agent-sandbox/features/hostexec/)
- [通信・ホスト実行の承認](/nix-agent-sandbox/operations/approvals/)
