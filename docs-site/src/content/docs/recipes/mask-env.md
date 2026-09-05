---
title: .env の非公開とホスト実行
description: .env の非公開、ビルド時の秘密値の注入、出力マスク
---

`.env` をエージェントには空のファイルとして見せ、ホスト上の `pnpm build` に `API_TOKEN` を渡す例です。コマンド出力に現れるトークンもマスクします。

## 前提条件

- エージェントの API への通信許可を設定済み。Claude Code の例は[クイックスタート](/nix-agent-sandbox/getting-started/quick-start/)を参照。

- 作業フォルダー直下の `.env` に `API_TOKEN` がある。
- ホストに `pnpm` がある。
- `package.json` とビルドが読むスクリプト・設定を、エージェントが変更できないようにする。

## 設定例

エージェントとの通信を設定済みの `claude` プロファイルに、以下の設定を追加します。編集先は[プロファイルの編集](/nix-agent-sandbox/getting-started/configuration/#プロファイルの編集)を参照してください。既存の設定項目がある場合は、その中に要素を追加し、通信先やルールを残してください。

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

設定を確認して `nas config trust` を実行後、ホストでルールの一致を確認します。

```sh
nas hostexec test --profile claude -- pnpm build
```

`nas claude` で起動し、エージェントが `pnpm build` を要求したら、実行内容を確認して承認します。

## 注意点

`pnpm build` はプロジェクトのスクリプトを実行します。エージェントがそれらを書き換えられると、変更したコードがホストで動きます。子ディレクトリからの要求もあり得るため、承認画面の作業ディレクトリも確認してください。

`hostexec.secrets` は注入用、プロファイルの `secrets` はマスク用です。出力も隠すため、この例では同じ取得元を両方に登録しています。

現在の実装では `fallback = "deny"` は不一致時の動作を変更しません。[HostExec の不一致時の動作](/nix-agent-sandbox/features/hostexec/#不一致時の動作)を参照してください。
