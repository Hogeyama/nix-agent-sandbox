---
title: 相対パスコマンドを prompt 承認で移譲
description: ./gradlew の residual risk を確認して HostExec する
---

## 得られること

ワークスペースで実行した `./gradlew assembleDebug` を HostExec の prompt に送れます。相対
`argv0` と引数は絞れますが、現行の cwd 制約では workspace root の wrapper に固定できません。

## 前提

- ワークスペース直下に `gradlew` がある。
- ホストで Gradle wrapper が必要とする JDK などを利用できる。
- 実行ごとに、承認画面の cwd と integrity 状態を確認できる。
- この残余リスクを受け入れられない場合は、workspace 外の immutable な絶対パス wrapper を
  用意する。

```pkl
amends "Schema.pkl"

profiles {
  ["android"] {
    agent = "claude"
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
  }
}
```

```sh
nas hostexec test --profile android -- ./gradlew assembleDebug
```

## 権限と注意点

## 重要: workspace root には固定できない

`workspace-only` は workspace の子 directory も許します。相対 `argv0 = "./gradlew"` は
root のファイル名を固定するのではなく、現在の cwd から見た literal な `./gradlew` に一致
します。そのため agent が nested directory に `gradlew` を作り、そこから同じ引数で実行
すると prompt に到達します。root の `gradlew` を `ro` mount にしても nested wrapper を
保護することにはなりません。

この recipe は自動的に安全な固定 wrapper を作るものではなく、**one-shot 承認を人が確認
するための構成**です。承認画面で cwd が期待する root か、`[CHANGED-SINCE-START]` がないか、
command と引数が期待どおりかを確認し、`--scope once` で承認してください。session 中の
capability 再利用は選ばないでください。workspace 由来の wrapper をホストで実行する危険を
受け入れられない場合は、workspace 外に置いた immutable な絶対パス wrapper だけを rule に
指定します。

この current runtime の制約は、[HostExec のリスク](/nix-agent-sandbox/security/risks/#hostexec)と[制約・注意事項](/nix-agent-sandbox/security/limitations/#実装上の境界)にもまとめています。

## 関連ページ

- [HostExec](/nix-agent-sandbox/features/hostexec/)
- [ファイル隔離・マウント](/nix-agent-sandbox/features/filesystem/)
- [承認キューを操作する](/nix-agent-sandbox/operations/approvals/)
