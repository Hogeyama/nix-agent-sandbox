---
title: .env を隠してコマンドをホスト実行
description: .env の値をコンテナへ見せず、限定したビルドだけに渡す
---

## 得られること

エージェントからは `.env` を空として見せ、ホスト上の `pnpm build` にだけ
`API_TOKEN` を渡します。秘密の生値はコンテナへマウントせず、HostExec のその
rule が実行される短い間だけホスト側の環境変数になります。

## 前提

- `.env` がワークスペース直下にあり、`API_TOKEN` を持つ。
- ホストに `pnpm` があり、`pnpm build` が `.env` を読む必要がある。
- `package.json` と、ビルドが実行するスクリプトおよび設定ファイルを、エージェントが
  書き換えられないようにする。

次を `.nas/config.pkl` に置きます。独立した設定にする例なので、既存の共通設定を
継承する場合は先頭を `amends "modulepath:/global.pkl"` に替えてください。

```pkl
amends "Schema.pkl"

profiles {
  ["build"] {
    agent = "claude"
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
  }
}
```

実行前に rule を確認できます。

```sh
nas hostexec test --profile build -- pnpm build
```

## 権限と注意点

この rule は任意のホスト実行を許すものではありません。`argv0 = "pnpm"` と
引数がちょうど `build` の要求だけを、workspace を cwd にして承認待ちへ送ります。
ただし `pnpm build` は `package.json` と参照先スクリプトを実行します。エージェントが
それらを書き換えられるなら、HostExec を任意のホスト実行へ広げることになります。
依存するファイルを `ro` mount に追加するか、固定パスの単純な実行ファイルへ rule を
替えてください。

`hostexec.secrets` は注入専用で、profile の `secrets` とは別の registry です。注入だけでは
HostExec の stdout / stderr を伏せません。このレシピでは同じ取得元を profile 側にも登録し、
`mask.filter = true` と `mask.apply` で必ず出力 mask の対象にします。HostExec の control
socket はホスト専用で、コンテナから自分の要求を承認することはできません。

この rule が渡す host command capability は、[HostExec のリスク](/nix-agent-sandbox/security/risks/#hostexec)を参照してください。

## 関連ページ

- [HostExec](/nix-agent-sandbox/features/hostexec/)
- [ファイル隔離・マウント](/nix-agent-sandbox/features/filesystem/)
- [シークレット・認証情報](/nix-agent-sandbox/features/secrets/)
