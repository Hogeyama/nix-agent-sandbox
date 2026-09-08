---
title: ホストコマンドの実行許可
description: ホストのツールを使うコマンドの制限、秘密値の注入、相対パスの条件と UI 承認
---

ホストにあるツールや認証情報が必要な処理だけを、エージェントから要求して実行できます。この機能を HostExec と呼びます。実行場所はコンテナの外で、ホストユーザーの権限で動きます。

| 任せたい処理 | 手順 |
| --- | --- |
| 決まったコマンドだけを許可 | [固定コマンドの許可](#固定コマンドの許可) |
| エージェントが明示的にホスト実行を要求 | [hostexec コマンドの導入](#hostexec-コマンドの導入) |
| .env を読ませず認証付きビルドを実行 | [秘密値付きのビルド](#秘密値付きのビルド) |
| 作業フォルダーのスクリプトを実行 | [相対パスのコマンド](#相対パスのコマンド) |

## 実行前の条件

コマンド名を制限しても、そのコマンドが読むスクリプトや設定を書き換えられると、ホストで別の処理を実行できます。実行ファイル、PATH 上のコマンド、読み込む設定・スクリプトを確認し、必要な入力は[読み取り専用で共有](/nix-agent-sandbox/configuration/files/#ファイルの追加共有)します。

以下は[対象プロファイル](/nix-agent-sandbox/configuration/profiles/#プロファイルの編集)へ追加する例です。初めて HostExec を設定する場合の形なので、既存の hostexec がある場合は、必要なルールや項目をその中へ追加して既存の設定を残します。

## 固定コマンドの許可

まず秘密値を使わない uptime で、ホスト実行と承認を確認します。`/usr/bin/uptime` はホスト上の実際のパスに合わせます。

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

argv0 はコマンド名・絶対パス・相対パスの完全一致、argRegex は引数をスペースで連結した文字列への正規表現です。この例は引数なしに限定しています。workspace-only は作業フォルダーとその子ディレクトリからの要求を許します。

設定を確認して信頼した後、ホストでルールの一致を調べます。`<profile>` は追加したプロファイル名です。

```sh
nas config trust
nas hostexec test --profile <profile> -- /usr/bin/uptime
```

そのプロファイルで起動し、エージェントに指定パスの uptime を引数なしで実行させます。UI の Pending → **Host exec · cmd** でコマンドと Working directory を確認し、**This request only** を選んで **Approve** を押します。ホストの稼働時間が結果として返ることを確認します。

`approval = "prompt"` は承認待ち、allow は自動許可、deny は拒否です。拒否や時間切れでは要求が失敗します。承認を再利用する範囲は[UI の承認操作](/nix-agent-sandbox/work/approvals/#ホスト上でのコマンド実行)で確認します。

## hostexec コマンドの導入

任意のコマンドを明示的にホストへ委譲する場合は、コンテナ内の PATH に hostexec を追加できます。**承認したコマンドはホストの環境変数も引き継ぎます。** 作業に必要な実行内容か、要求ごとに確認してください。

```pkl
hostexec = new HostExecConfig {
  installScript = true
}
```

rules は必須ではありません。起動したセッション内だけにスクリプトが用意され、終了時に削除されます。既存の hostexec 設定があれば、その中へ installScript を追加します。

再信頼して新しいセッションを起動します。たとえば Wayland デスクトップで wl-copy が使えるホストなら、コンテナ内から次を要求できます。

```sh
hostexec wl-copy 'hello from the sandbox'
```

UI に届いた要求を確認して許可すると、ホストのクリップボードへ文字列が入ります。実行元は作業フォルダーかセッションの一時領域に限られます。引数や作業ディレクトリが違えば、その承認は再利用されません。自分で hostexec に一致するルールを設定した場合は、そちらが優先されます。

## 秘密値付きのビルド

.env を空のファイルとして見せ、ホストの `pnpm build` に API_TOKEN を渡す例です。コマンド出力に現れるトークンもマスクします。

作業フォルダー直下の .env に API_TOKEN があり、ホストに pnpm があることを確認します。**package.json とビルドが読むすべてのスクリプト・設定を、エージェントが変更できない状態にしてください。** 下の package.json の保護だけでは、読み込む別のファイルまで保護しません。

```pkl
extraMounts = new Listing {
  new ExtraMountConfig { src = "/dev/null"; dst = ".env" }
  new ExtraMountConfig {
    src = "package.json"
    dst = "package.json"
    mode = "ro"
  }
}
secrets {
  ["build_api_token"] { from = "dotenv:.env#API_TOKEN" }
}
mask = new MaskConfig {
  filter = true
  apply = new Listing { "build_api_token" }
}
hostexec = new HostExecConfig {
  secrets {
    ["build_api_token"] { from = "dotenv:.env#API_TOKEN" }
  }
  rules = new Listing {
    new HostExecRule {
      id = "pnpm-build"
      match { argv0 = "pnpm"; argRegex = "^build$" }
      cwd { mode = "workspace-only" }
      env { ["API_TOKEN"] = "secret:build_api_token" }
      inheritEnv { mode = "minimal" }
      approval = "prompt"
      fallback = "deny"
    }
  }
}
```

既存の extraMounts や rules がある場合、この新しい一覧で上書きせず、必要な要素を既存の一覧に追加します。エージェントの API への通信設定も残します。

hostexec.secrets はホスト実行への注入用、プロファイルの secrets は出力マスク用です。出力も隠すため、同じ取得元を両方に登録しています。注入だけで出力が隠れるわけではありません。

設定を確認して `nas config trust` を実行し、ホストで次を確認します。

```sh
nas hostexec test --profile claude -- pnpm build
```

そのプロファイルで起動し、エージェントに pnpm build を要求させます。UI で作業ディレクトリとコマンドを確認し、This request only → Approve で一回だけ許可します。ビルド結果が返り、出力にトークンが現れた場合はマスクされることを確認します。

例にある fallback の deny は、現在の実装ではルール不一致時の動作を変えません。次の「ルール不一致の要求」の扱いになります。

## 相対パスのコマンド

`./gradlew assembleDebug` のような相対パスは、要求時の作業ディレクトリから解決されます。**workspace-only は実行元をプロジェクトのルートには固定しません。** 子ディレクトリに別の gradlew を作り、そこから要求しても一致します。

作業フォルダーに gradlew、ホストに必要な JDK があることを確認した上で、次のルールを使えます。

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

再信頼後に `nas hostexec test --profile claude -- ./gradlew assembleDebug` で一致を確認し、エージェントから要求させます。UI の Working directory、コマンド、引数、ファイル変更の警告を毎回確認し、**This request only** で許可します。

その都度の確認に依存できない場合は、作業フォルダー外の、エージェントが変更できない絶対パスのスクリプトを指定してください。ルートの gradlew だけを読み取り専用にしても、別の実行元からの要求は防げません。

## ルール不一致の要求

不一致の要求はコンテナ実行へのフォールバック応答になります。コンテナにも必要な実行ファイルと環境がなければ失敗します。HostExecRule.fallback を変更しても、現在の実装ではこの動作は変わりません。

hostexec スクリプトはフォールバック時に実行場所を stderr に表示します。一致したルールの `approval = "deny"`、承認拒否、時間切れはエラーで、同じ扱いではありません。
