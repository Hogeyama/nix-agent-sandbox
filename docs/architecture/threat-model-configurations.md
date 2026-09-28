# セキュリティ対策の比較に用いる設定例

[対策の選定](threat-model.md)で比較に用いる設定と起動コマンドを示す。各製品の導入後に、本体ページの[共通条件](threat-model.md#比較の共通条件)と併用する設定例である。各例の保護範囲、成立条件、必要水準に届かない点は本体ページに示す。

## 共通設定

各環境の managed settings に次を置き、系統ごとの設定と併用する。`my-org/private-repo` は、書込主体を含めて信頼済みと定めた自組織の非公開 repo に置き換える。

```jsonc
// /etc/claude-code/managed-settings.json
{
  "env": { "CLAUDE_CODE_TMPDIR": ".local/tmp" },
  "permissions": { "deny": ["WebSearch"] },
  "autoMode": {
    "classifyAllShell": true, // 許可済みの shell コマンドも classifier で審査する
    "environment": [
      "$defaults",
      "Source control: github.com/my-org/private-repo",
      "Internal API: devapi.example.com"
    ],
    "hard_deny": [
      "$defaults",
      "Never access GitHub repositories other than my-org/private-repo, including read-only operations such as GET, clone, and fetch."
    ]
  }
}
```

`hard_deny` は classifier が読む自然言語のルールである。P1 の強制境界としては扱わない。WebSearch を除去する理由を含め、[操作審査とモデル入力](threat-model.md#操作審査とモデル入力)を参照。

各実行環境で `.local/tmp` を作り、Git 管理から除外する。起動位置は作業領域とする。ホストの `/tmp` や操作用 socket を持ち込まないこと、不要な secret を除外することなどは、[シークレットと作業領域](threat-model.md#シークレットと作業領域)に従う。

系統1・2・5で既存機構では隠せない入力経路がある場合と、系統3では、sumi をインストールして秘密一覧ファイルを配置する。系統4では `mask.filter = true` により nas が sumi を自動配置・設定するため、別途のインストールや `sumi init` は不要。

## 系統1

[settings.json 構成の評価と成立条件](threat-model.md#系統1-settingsjson)を確認し、共通設定と次の設定を同じ managed settings にマージする。

```jsonc
// /etc/claude-code/managed-settings.json
{
  "allowManagedMcpServersOnly": true,
  "allowedMcpServers": [],
  "permissions": {
    "defaultMode": "auto",
    "disableBypassPermissionsMode": "disable",
    "deny": [
      "WebFetch", // bare 指定でツール自体を除去する
      "WebSearch", // 共通条件
      "Read(~/.ssh/**)", // 実行に使用しない秘密は Read ツールでも拒否する
      "Read(~/.aws/**)",
      "Read(~/.config/gh/**)", // gh auth login の保存先
      "Read(//tmp/**)",
      "Read(./.env)" // mask は Bash 側だけ。本体の Read は deny で拒否する
    ]
  },
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true, // 初期化失敗時に非 sandbox 実行へ fallback しない
    "allowUnsandboxedCommands": false, // sandbox 外での実行を許可しない
    "network": {
      "allowedDomains": [
        "api.anthropic.com:443",
        "github.com:443",
        "api.github.com:443",
        "devapi.example.com:443"
      ],
      "strictAllowlist": true,
      "allowManagedDomainsOnly": true,
      "tlsTerminate": {} // TLS inspection を行う（ダミー値の置換に必要）
    },
    "filesystem": {
      "allowWrite": ["./.local/tmp"],
      "denyRead": [ // Bash 側の読取拒否
        "/tmp",
        "~/.ssh",
        "~/.aws",
        "~/.config/gh"
      ]
    },
    "credentials": {
      "envVars": [
        {
          "name": "GH_TOKEN",
          "mode": "mask",
          "injectHosts": ["github.com", "api.github.com"]
        }
      ],
      "files": [
        {
          "path": "./.env",
          "mode": "mask",
          "extract": "API_PASSWORD=(\\S+)",
          "onExtractNoMatch": "deny",
          "injectHosts": ["devapi.example.com"]
        }
      ]
    }
  }
}
```

```sh
sumi init --agent claude --secrets-file ~/.claude/sumi/secrets.txt # 既存の保護でシークレットを隠せない場合のみ
```

Bash 側は credential masking、本体の Read は `.env` の deny で保護する。masking は別の token を持ち込む操作を拒否しないため、A1b の強制境界にはならない。[系統1の評価](threat-model.md#系統1-settingsjson)

`excludedCommands` を managed settings だけで固定できないため、この設定に加えて user / project settings から sandbox 外実行経路を追加できない運用が必要となる。

## 系統2

[srt 構成の評価と成立条件](threat-model.md#系統2-srt)に従い、Claude Code 本体ごと隔離する。この JSON 設定は hostname と自分の credential の保護を扱い、許可サービス上で別の認証主体を使う操作は制限しない。

```jsonc
// ~/.srt-settings.json
{
  "network": {
    "allowedDomains": [
      "api.anthropic.com",
      "github.com",
      "api.github.com",
      "devapi.example.com"
    ],
    "deniedDomains": [],
    "tlsTerminate": {} // ダミー値の置換に必要
  },
  "filesystem": {
    "allowWrite": ["."],
    "denyWrite": [".claude"],
    "denyRead": [ // Read ツールにも Bash にも適用される
      "/tmp",
      "~/.ssh",
      "~/.aws",
      "~/.config/gh"
    ]
  },
  "credentials": {
    "envVars": [
      {
        "name": "GH_TOKEN",
        "mode": "mask",
        "injectHosts": ["github.com", "api.github.com"]
      }
    ],
    "files": [
      {
        "path": "./.env",
        "mode": "mask",
        "extract": "API_PASSWORD=(\\S+)",
        "onExtractNoMatch": "deny",
        "injectHosts": ["devapi.example.com"]
      }
    ]
  }
}
```

```sh
export CLAUDE_CONFIG_DIR="$PWD/.claude-state"
sumi init --agent claude --secrets-file ~/.claude/sumi/secrets.txt # 既存の保護でシークレットを隠せない場合のみ
srt --settings ~/.srt-settings.json claude --permission-mode auto
```

設定・認証・履歴を `.claude-state` に分離し、Git 管理から除外する。この状態は隔離実行専用で、ホストでは使わない。既存 hook の実体を共通条件と異なる場所へ置く場合は、その参照先も `denyWrite` に追加する。

## 系統3

[Dev Container 構成の評価と成立条件](threat-model.md#系統3-dev-container)に対応する。参照実装から関係する部分を抜粋する。

```jsonc
// .devcontainer/devcontainer.json（参照実装から関係する部分を抜粋）
{
  "build": { "dockerfile": "Dockerfile" },
  "runArgs": ["--cap-add=NET_ADMIN", "--cap-add=NET_RAW"], // firewall の設定に必要
  "remoteUser": "node", // sudo は root 所有の init-firewall.sh の実行だけを許可
  "postStartCommand": "sudo /usr/local/bin/init-firewall.sh",
  "remoteEnv": { "GH_TOKEN": "${localEnv:GH_TOKEN}" }
}
```

firewall が許可するのは、GitHub の必要な IP range を `api.github.com/meta` から取得したもの、`api.anthropic.com` と `devapi.example.com` の解決先、DNS の UDP 53 とする。外部サービスへの接続は TCP 443 に限定し、全送信先への SSH は許可しない。

`init-firewall.sh` は起動時に `dig` で hostname を IP に解決して許可する。DNS は送信先を限定せず許可する。この方式に残る DNS・共有 IP の経路は、本体ページの A1a の評価を参照。

ホストからは作業領域だけを RW mount し、`~/.ssh`、`~/.aws`、`~/.config/gh`、Docker socket は mount しない。Claude Code の状態は container 用 volume に保存する。

```sh
# コンテナ内。sumi のインストールと secrets file の配置後に実行
sumi init --agent claude --secrets-file ~/.claude/sumi/secrets.txt

claude --permission-mode auto
```

この構成は container 内でも本物の `GH_TOKEN` と `API_PASSWORD` を使うため、sumi を併用する。

## 系統4

[nas 構成の評価と成立条件](threat-model.md#系統4-nas)を確認する。Nix 連携は無効にする。既存設定の保護対象と RW 共有する状態を確認する。

ホストと container の双方に managed settings を適用し、MCP server を制限する。

```json
{
  "allowManagedMcpServersOnly": true,
  "allowedMcpServers": []
}
```

起動前に作業領域の `.claude` を作っておく。存在しなければ以下の read-only mount は適用されず、エージェントが新規作成できる。既存 hook の実体は保護対象の `.git/hooks`・`.claude`・`~/.claude` 配下に置く。

次の設定は、GitHub への要求の既定を `review` とし、信頼済み情報源への read だけを自動許可する。Anthropic の未許可 endpoint は `deny` にする。業務 API は共通条件で `x-api-key` だけで認証する API と定め、その header を上書きする。この条件で A1b は ◎ とする。

```pkl
// .nas/config.pkl
local githubScope: Scope = new {
  targets {}
  fallback = "review"
  secrets {
    ["github-basic"] = "inject"
  }
  inject {
    new Inject {
      name = "authorization"
      value = "secret:github-basic"
    }
  }
}

profiles {
  ["claude"] = (super["claude"]) {
    agentArgs {
      "--permission-mode"
      "auto"
    }
    agentState {
      protectSettings = true // 共有する Claude 設定の上書きを防ぐ
    }
    nix { enable = false }
    hostexec = null
    extraMounts {
      // .git/config・.git/hooks は nas が自動で read-only にする。.claude は対象外なので明示する
      new { src = ".claude";     dst = ".claude";     mode = "ro" } // project settings の hooks
      new { src = "/dev/null";   dst = "~/.claude/sumi/secrets.txt"; mode = "ro" } // 秘密一覧の内容を container から隠す
    }
    secrets { // ホスト側で読み取る
      ["github-token"] {
        from = "env:GH_TOKEN"
        required = true
      }
      ["github-basic"] {
        // GitHub の HTTP 通信に注入する Authorization ヘッダ
        from = #"cmd:printf 'Basic %s' "$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)""#
        required = true
      }
      ["api-password"] {
        from = "dotenv:.env#API_PASSWORD"
        required = true
      }
      ["sumi-secrets"] {
        // 他系統で sumi に渡す秘密一覧と同じファイル。1行を1つの値としてマスクする
        from = "lines:~/.claude/sumi/secrets.txt"
        required = true
      }
    }
    env {
      new {
        key = "GH_TOKEN"
        val = "nas-injected" // gh にはダミー値を渡す
      }
    }
    mask = new MaskConfig {
      maskfs = true // ファイルシステム上の秘密値を墨消し
      proxy  = true // HTTP リクエストの秘密値を墨消し
      filter = true // Bash の出力と Claude Code の成功ツール結果を sumi で墨消し
    }
    network {
      fallback = "deny"
      scopes {
        ["anthropic"] = (module.presets.anthropic.v1) {
          fallback = "deny"
        }
        ["github-api"] = (githubScope) {
          targets {
            "api.github.com:443"
          }
          rules {
            ["owned.rest-read"] {
              match {
                methods { "GET"; "HEAD"}
                paths {
                  "/repos/my-org/private-repo/**"
                }
              }
              onMatch = "allow"
            }
            ["owned.graphql-read"] {
              match {
                methods { "POST" }
                paths { "/graphql" }
                body { format = "json" }
              }
              onMatch = "allow"
              onIndeterminate = "review"
              expect {
                new BodyExpect {
                  graphql {
                    operations { "query" }
                    fieldPaths {
                      "/repository/nameWithOwner"
                      "/repository/url"
                      "/repository/issues/nodes/number"
                      "/repository/issues/nodes/title"
                      "/repository/issues/nodes/body"
                      "/repository/issues/nodes/comments/nodes/body"
                      "/repository/issues/pageInfo/endCursor"
                      "/repository/issues/pageInfo/hasNextPage"
                      "/repository/pullRequests/nodes/number"
                      "/repository/pullRequests/nodes/title"
                      "/repository/pullRequests/nodes/body"
                      "/repository/pullRequests/nodes/comments/nodes/body"
                      "/repository/pullRequests/pageInfo/endCursor"
                      "/repository/pullRequests/pageInfo/hasNextPage"
                    }
                    fieldArguments {
                      ["/repository"] {
                        ["owner"] { "my-org" }
                        ["name"] { "private-repo" }
                      }
                    }
                  }
                  onViolation = "review"
                }
              }
            }
          }
        }
        ["github-git"] = (githubScope) {
          targets {
            "github.com:443"
          }
          rules {
            ["owned.git-fetch"] {
              match {
                methods { "GET"; "POST"}
                paths {
                  "/my-org/private-repo/info/refs"
                  "/my-org/private-repo/git-upload-pack"
                }
              }
              onMatch = "allow"
            }
          }
        }
        ["example-api"] {
          targets {
            "devapi.example.com:443"
          }
          secrets {
            ["api-password"] = "inject"
          }
          inject {
            new Inject {
              name = "x-api-key"
              value = "secret:api-password"
            }
          }
          rules {
            ["all"] {
              match {
                paths { "/**" }
              }
              onMatch = "allow"
            }
          }
        }
      }
    }
  }
}
```

```sh
nas config trust   # 設定を承認
nas claude
```

`expect.graphql` は Issue / PR / comment 用の取得経路と owner / repo 名を制限する。必要な field を追加するときも、未信頼情報源へ辿れない経路に限る。許可外の repo・取得経路、mutation、判定不能な要求、REST write、Git push は `review` とする。承認は `once` とし、後続の未信頼取得まで自動許可しない。

Git と nas の自動保護の内訳・対象外は[本体の保護対象表](threat-model.md#系統4-nas)を参照。`git config`、`git remote add`、`git push -u` 等、`.git/config` を更新する操作はホストで行う。

秘密一覧はホスト側で読み、container 内の同じパスは `/dev/null` で隠す。`lines:` はマスク用で、注入には使えない。自動配置する sumi は socket 経由でマスクを依頼する。[保護範囲と実機確認](threat-model.md#系統4-nas)を参照。

## 系統5

[Docker Sandbox 構成の評価と成立条件](threat-model.md#系統5-docker-sandbox)に対応する。hostname 単位の network policy と credential injection を設定する。

以下は組込み Claude（v2 kit）の設定例である。v3 kit の HTTP method/path 制限はこの構成に追加できないため含めない。今後の対応、または自前の v3 workload による改善の見通しは[本体ページ](threat-model.md#系統5-docker-sandbox)に示す。

`secret set` による認証 header の上書きと、hostname の許可を組み合わせる。ただし、`sbx v0.43.0` の[実測](experiments/sbx-a1b/README.md)では `curl --noproxy '*'` で認証注入を通らず GitHub に接続できたため、この提示構成の A1b は ○ で、必須の ◎ に届かない。業務 API の `set-custom` は placeholder の置換であり、認証主体を固定する機能としては評価しない。

```sh
sbx policy init deny-all

sbx policy allow network \
  "api.anthropic.com:443,github.com:443,api.github.com:443,devapi.example.com:443"

sbx secret set anthropic
sbx secret set github --command 'gh auth token'

sbx secret set-custom \
  --host devapi.example.com \
  --env API_PASSWORD \
  --value "$API_PASSWORD"

sbx settings set ssh.agentForwardingEnabled false
sbx daemon restart

sbx create \
  --name coding \
  --clone \
  --skills off \
  claude .
```

default kit が追加する不要な network allow rule を削除し、許可先を `api.anthropic.com:443`、`github.com:443`、`api.github.com:443`、`devapi.example.com:443` だけにする。

clone mode は VM 内に private clone を作り、ホスト repo も `/run/sandbox/source` に read-only で mount する。untracked file や `.gitignore` 対象も含むため、secret を含む `.env` 等は VM 内から読める。Git root 外へ移せる secret は移して secret store に登録し、VM 内の `.env` はダミー値で作る。移せず読取拒否もできない場合は sumi を併用する。

Claude Code は既定の起動方法を使わず、approval を利用する設定で起動する。

```sh
sbx exec -it coding bash
# ここから VM 内
sumi init --agent claude --secrets-file ~/.claude/sumi/secrets.txt # 既存の保護でシークレットを隠せない場合のみ
claude --permission-mode auto
```

## 系統1+2の実験結果

外側の srt と Claude Code の内蔵 sandbox を重ねる[実験](experiments/srt-settings/README.md)では、`enableWeakerNestedSandbox` を有効にした場合も含め、今回のバージョンと設定で正常通信を維持した選別は確認できなかった。診断用の `allowAllUnixSockets` は外側の境界を弱めるため推奨設定とせず、系統1+2を要求を満たす構成には数えない。
