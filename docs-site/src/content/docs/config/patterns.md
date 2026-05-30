---
title: 設定パターン
description: 実運用で頻出する構成のレシピ集
---

実運用で頻出する構成をいくつかレシピとして示します。

## .env を隠しつつ、必要なコマンドはホストに移譲する

`.env` を `/dev/null` でマスクしてエージェントから中身を見えなくしつつ、その秘匿情報を要するコマンドだけを hostexec でホストに移譲する、という構成です。

```pkl
profiles {
  ["blah"] {
    agent = "copilot"
    extraMounts = new Listing {
      new { src = "/dev/null"; dst = ".env" }
      new { src = "package.json"; dst = "package.json"; mode = "ro" }
    }
    hostexec = new {
      secrets {
        ["build_api_token"] { from = "dotenv:.env#API_TOKEN"; required = true }
      }
      rules = new Listing {
        new {
          id = "pnpm-build"
          match { argv0 = "pnpm"; argRegex = "^build\\b" }
          cwd { mode = "workspace-only" }
          env { ["API_TOKEN"] = "secret:build_api_token" }
          approval = "allow"
          fallback = "deny"
        }
      }
    }
  }
}
```

:::caution
`deno task` / `npm run` / `make` のような「設定ファイルを読んで実行するコマンド」を hostexec で委譲すると、エージェントがその設定ファイルを書き換えることで実質的に任意コマンドのホスト実行が可能になります。本番運用で使う場合は `extraMounts` で設定ファイルを read-only マウントするなどの工夫が必要です。

```pkl
extraMounts = new Listing {
  new { src = "deno.json"; dst = "deno.json"; mode = "ro" }
}
```
:::

## Git の署名をホストに移譲する

`git commit -S` のような署名操作を、ホスト側の gpg で行わせる構成です。署名鍵をコンテナに渡さずに済みます。

```pkl
profiles {
  ["blah"] {
    agent = "copilot"
    env = new Listing {
      // hostexec の gpg で署名する
      new { key = "GIT_CONFIG_COUNT"; val = "1" }
      new { key = "GIT_CONFIG_KEY_0"; val = "gpg.program" }
      new { key = "GIT_CONFIG_VALUE_0"; val = "/opt/nas/hostexec/bin/gpg" }
    }
    hostexec = new {
      rules = new Listing {
        // git commit/tag -S が呼ぶ形だけを通す:
        //   gpg --status-fd=2 -bsau <keyid>
        new {
          id = "gpg-git-sign"
          match { argv0 = "gpg"; argRegex = "^--status-fd=2 -bsau [0-9A-Fa-f]{8,40}$" }
          cwd { mode = "workspace-or-session-tmp" }
          approval = "allow"
          fallback = "deny"
        }
        new {
          id = "gpg-default"
          match { argv0 = "gpg" }
          approval = "deny"
          fallback = "deny"
        }
      }
    }
  }
}
```

:::caution
`gpg` のような「任意の引数で副作用を起こせるコマンド」を委譲する場合、`--sign` を含むだけ通すような緩い regex は危険です（`--output` で任意ファイル上書き、`--homedir` で keyring 差し替え等）。git の呼び出し形 (`gpg --status-fd=2 -bsau <keyid>`) のような完全一致パターンに絞ってください。
:::

## 相対パスのコマンド（`./gradlew` など）をホストに移譲する

リポジトリ同梱の `./gradlew` のような相対パスのコマンドをホストへ移譲する構成です。

```pkl
profiles {
  ["android"] {
    agent = "claude"
    hostexec = new {
      rules = new Listing {
        new {
          id = "gradlew"
          match { argv0 = "./gradlew" }
          cwd { mode = "workspace-only" }
          approval = "prompt"
          fallback = "deny"
        }
      }
    }
  }
}
```

:::note
相対パス `argv0` を指定すると、コンテナ内の該当ファイル（例: `./gradlew`）がラッパースクリプトで bind-mount 置換されます。そのためコンテナ内での直接実行にフォールバックできず、`fallback` は `"deny"` のみ利用可能です。
:::

## `http_proxy` を参照しないツールにプロキシを設定する

JVM ベースのツール（Gradle、Maven など）は `http_proxy` / `https_proxy` を無視するため、JVM システムプロパティでプロキシを明示的に渡す必要があります。

nas のコンテナ内では `http_proxy` / `https_proxy` が自動設定されますが、JVM ベースのツール（Gradle、Maven など）はこれらの環境変数を無視し、JVM システムプロパティでプロキシを受け取ります。
そのようなツールには `env` でプロパティを明示的に渡してください。nas の Envoy forward proxy はコンテナ内から `localhost:18080` でアクセスできます。

**Gradle**

```pkl
profiles {
  ["android"] {
    agent = "claude"
    env = new Listing {
      new {
        key = "GRADLE_OPTS"
        val = "-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=18080 -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=18080 -Dhttp.nonProxyHosts=localhost|127.0.0.1"
      }
    }
  }
}
```

**Maven**

```pkl
profiles {
  ["java"] {
    agent = "claude"
    env = new Listing {
      new {
        key = "MAVEN_OPTS"
        val = "-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=18080 -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=18080 -Dhttp.nonProxyHosts=localhost|127.0.0.1"
      }
    }
  }
}
```

## `cli_auth_credentials_store = "keyring"` な Codex を使う

Codex を keyring 認証で動かすために、DBus session bus 経由で `org.freedesktop.secrets` へ限定的にアクセスを許可する構成です。

```pkl
profiles {
  ["codex"] {
    agent = "codex"
    dbus {
      session {
        enable = true
        calls = new Listing {
          new { name = "org.freedesktop.secrets"; rule = "org.freedesktop.Secret.Service.OpenSession" }
          new { name = "org.freedesktop.secrets"; rule = "org.freedesktop.Secret.Service.SearchItems" }
          new { name = "org.freedesktop.secrets"; rule = "org.freedesktop.Secret.Item.GetSecret" }
        }
      }
    }
  }
}
```

## X11 アプリをサンドボックス経由で表示する

`display.sandbox = "xpra"` で、エージェントが起動した X11 アプリをホスト本体の X server から隔離しつつユーザのデスクトップに表示する構成です。`playwright-cli --headed` で共同ブラウザ操作をする、といったユースケース向けです。

```pkl
profiles {
  ["blah"] {
    agent = "claude"
    display {
      sandbox = "xpra"
      size = "1920x1080"
    }
  }
}
```

:::note[WSL ユーザー向け]
WSL2 では `/tmp/.X11-unix` がカーネルにより read-only マウントされているため、Xvfb がソケットを作成できません。nas はこの状況を自動検知し、`unshare --user --mount` で private mount namespace を作成して回避します。ソケットの実体はセッションディレクトリ配下に置かれるため、Docker からも問題なくアクセスできます。この回避策は unprivileged user namespace が利用可能な環境で動作します。もし `unshare` が失敗する場合は、`sudo mount -o remount,rw /tmp/.X11-unix` を nas 起動前に実行してください。
:::
