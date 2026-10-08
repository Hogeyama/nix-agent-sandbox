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

[settings.json 構成の評価と成立条件](threat-model.md#系統1-settingsjson)を確認し、共通設定と次の設定を同じ managed settings にマージする。以下の `/srv/project` は、対象リポジトリの絶対パスに置き換える。設定ファイルは起動前に確認し、すべての `excludedCommands` を空にする。

```jsonc
// /etc/claude-code/managed-settings.json
{
  "allowManagedMcpServersOnly": true,
  "allowedMcpServers": [],
  "permissions": {
    "defaultMode": "auto",
    "disableBypassPermissionsMode": "disable",
    // 本体の Read・Grep・Glob と sandbox 内の Bash から、作業領域外のホーム等を読めなくする
    // （v2.1.257 以降）
    "blockReadsOutsideWorkingDirectories": true,
    "deny": [
      "WebFetch", // bare 指定でツール自体を除去する
      "WebSearch", // 共通条件
      "Edit", // 本体のファイル書込みツールを除去し、書込みを sandbox 内の Bash に限る
      "Write",
      "NotebookEdit",
      "Read(./.env)" // mask は Bash 側だけ。本体の Read は deny で拒否する
    ]
  },
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true, // 初期化失敗時に非 sandbox 実行へ fallback しない
    "allowUnsandboxedCommands": false, // sandbox 外で再試行する機能を無効にする
    "excludedCommands": [], // 他の設定ファイルにある例外も起動前に除去する
    "network": {
      "allowedDomains": [
        "github.com:443",
        "api.github.com:443",
        "devapi.example.com:443"
      ],
      // Bash から Messages API を使わせない（MCP connector 等で第三者へ送れるため）。
      // Claude Code 本体の通信は sandbox の外なので影響しない
      "deniedDomains": ["api.anthropic.com"],
      "strictAllowlist": true,
      "allowManagedDomainsOnly": true,
      "tlsTerminate": {} // TLS inspection を行う（ダミー値の置換に必要）
    },
    "filesystem": {
      "allowWrite": ["./.local/tmp"],
      "denyWrite": [ // 作業領域内で保護するもの。作業領域外は allowWrite に無いので書けない
        "/srv/project/.claude-state/settings.json",
        "/srv/project/.claude-state/settings.local.json",
        "/srv/project/.claude"
      ],
      // allowManagedReadPathsOnly は設定しない（設定すると blockReadsOutsideWorkingDirectories が Bash に効かない）
      "denyRead": [ // Bash 側の読取拒否。ホーム配下は block と重複するが、block が外れた場合に備えて残す
        "/tmp", // block の対象外
        "~/.ssh",
        "~/.aws",
        "~/.config/gh"
      ],
      // sandbox 内の Bash が proxy へつなぐ socket。/tmp の denyRead の例外にする
      "allowRead": ["/tmp/claude-http-*.sock"]
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
export CLAUDE_CONFIG_DIR="$PWD/.claude-state"
mkdir -p "$CLAUDE_CONFIG_DIR" .claude
# denyWrite の対象は起動前に作る（存在しないパスを新規作成されないように）
for f in "$CLAUDE_CONFIG_DIR/settings.json" "$CLAUDE_CONFIG_DIR/settings.local.json"; do
  [ -e "$f" ] || echo '{}' > "$f"
done
sumi init --agent claude --secrets-file ~/.claude/sumi/secrets.txt # 既存の保護でシークレットを隠せない場合のみ
claude --permission-mode auto
```

`.claude-state` はこの構成専用の保存先とし、Git 管理から除外する。普段のホスト上の Claude Code とは履歴や memory を共有せず、同じ managed settings を適用する実行でだけ再利用する。Bash が書き込めるのは作業領域と `allowWrite` だけなので、元のホスト側の `~/.claude` と `~/.claude.json` には `denyWrite` を書かなくても書き込めない。作業領域をホーム自体やその親にすると、これが成り立たなくなる。専用の保存先では履歴や memory への書込みを許し、`settings.json` と `settings.local.json` への書込みを禁止する。

本体の Edit・Write・NotebookEdit はツールごと除去する。エージェントによるファイルの書込みは sandbox 内の Bash だけになり、`allowWrite` と `denyWrite` がそのすべてに適用される。編集は `sed` 等のコマンドで行うことになる。

`blockReadsOutsideWorkingDirectories` は、本体の Read・Grep・Glob・LSP に加え、sandbox 内の Bash からも `/home`・`/root`・`/mnt`・`/srv` 等を読めなくし、作業領域と session の temp directory 等だけを読めるように戻す。`/etc`・`/opt`・`/tmp` 等は対象外なので `/tmp` の `denyRead` は残す。global の Git 設定（`~/.gitconfig`、`~/.config/git/config` と、それらが `include` するファイル）は Git が動くように読めるように戻される。ただし Claude Code 2.1.294 では、これらが home-manager 等の作ったシンボリックリンクだと sandbox 内に現れず、作者情報と global の ignore が読めなかった（[実測](experiments/settings-block-reads/README.md#21294-での追加確認)）。その場合は `allowRead` に `~/.config/git` をディレクトリごと加える。リンクがそのまま現れ、リンク先の `/nix/store` は block の対象外なので読める。同じディレクトリの他のファイルも読めるようになる。`http.extraHeader` 等で token を書いている場合は、そのファイルを `denyRead` に加える。`sandbox.filesystem.allowManagedReadPathsOnly` を設定すると Bash には適用されなくなるため、この構成では設定しない。[公式仕様](https://code.claude.com/docs/en/settings-reference#sandboxed-commands-under-the-block)

Bash 側は credential masking、本体の Read は `.env` の deny で保護する。このマスク処理の対象は利用者が渡した token であり、プログラムが攻撃者の用意した別の token を使って通信する操作は残る。[系統1の評価](threat-model.md#系統1-settingsjson)

`excludedCommands` は各設定ファイルの指定が合算されるため、管理者側で空にするだけでは例外の追加を防げない。この例では書込みツールを除去したうえで、`denyWrite` で Bash とその子プロセスからの設定変更を禁止する。hook は sandbox の外で実行されるため、hook を定義する設定に加え、hook が実行するスクリプトも `denyWrite` の対象にする。上記と異なる `CLAUDE_CONFIG_DIR` や追加の設定ファイルを使う場合は、保護対象のパスも合わせる。保護対象は起動前に作っておく。[sandbox の仕様](https://code.claude.com/docs/en/sandboxing#configure-the-sandbox)

Bash の通信先には `api.anthropic.com` を含めず、`deniedDomains` でも拒否する。Messages API は、要求の本文に書いた MCP server へ Anthropic 側から接続する機能を持つため、Bash から送れると第三者への送信経路になる（[実測](experiments/anthropic-mcp-connector/README.md)）。

この構成の A1a と B2a は、上記の仕様と実測に基づいて ◎ と評価する。Claude Code 2.1.291 で、書込みツールの除去、Bash の読取り・書込み制限、本体の Read の拒否、通信先の制限、`GH_TOKEN` の代理注入を[実測](experiments/settings-block-reads/README.md)した。`deniedDomains` により Bash から `api.anthropic.com` への接続が拒否されることは、Claude Code 2.1.291 で[実測](experiments/anthropic-mcp-connector/README.md#bash-だけを内蔵-sandbox-で塞ぐ構成)した。2.1.291 の実測は `/tmp` の `denyRead` を外した状態で行った。2.1.294 では、`/tmp` の `denyRead` に proxy 用 socket の `allowRead` を加えた状態で、許可先へ接続でき、許可外が拒否されることを確認した。起動時に存在しない `denyWrite` の対象は、sandbox 内で `/dev/null` に置き換えられ、ホストには作られなかった。そこへの書込みが拒否されることと、hook の参照先の保護は確認していない。

実測では次の2点が成立条件となった。

- この設定は managed settings に置くか、既存の設定ファイルを置き換えて使う。`--settings` で重ねると既存の設定と合算され、`sandbox.filesystem.disabled` や `allowedDomains` の `*` が残って制限が外れた。
- Linux では、sandbox が使う `socat` をホーム外の PATH から見える場所に置く。`~/.nix-profile` 等のホーム配下にあると `blockReadsOutsideWorkingDirectories` が隠し、Bash の通信が宛先にかかわらず接続不能になる。拒否と見分けにくいので、許可先へ接続できることを先に確かめる。

## 系統2

[srt 構成の評価と成立条件](threat-model.md#系統2-srt)に従い、Claude Code 本体ごと隔離する。この JSON 設定では接続先の hostname を制限し、利用者が渡した認証情報をマスクする。プログラムが攻撃者の token を使い、許可したサービス上の攻撃者の repo などへ書き込む操作は残る。

```jsonc
// ~/.srt-settings.json
{
  "network": {
    "allowedDomains": [ // ポートを書かないと SSH 等も通る
      "api.anthropic.com:443",
      "github.com:443",
      "api.github.com:443",
      "devapi.example.com:443"
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
    ],
    "allowRead": ["/tmp/claude-http-*.sock"] // srt 自身の proxy 用 socket
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
mkdir -p .local/tmp .claude "$CLAUDE_CONFIG_DIR"
[ -e "$CLAUDE_CONFIG_DIR/.claude.json" ] ||
  echo '{"hasCompletedOnboarding":true}' > "$CLAUDE_CONFIG_DIR/.claude.json"
sumi init --agent claude --secrets-file ~/.claude/sumi/secrets.txt # 既存の保護でシークレットを隠せない場合のみ
srt --settings ~/.srt-settings.json -- claude --permission-mode auto
```

`.claude-state` はこの設定例で選んだ名前で、保存先を切り替えるのは Claude Code の `CLAUDE_CONFIG_DIR` である。Git 管理から除外し、ホストの通常実行では使わない。srt の `allowWrite` を作業領域に限定し、元のホスト状態への書込みを拒否する。この分離を[実験](experiments/state-isolation/README.md)で確認した。既存 hook の実体を共通条件と異なる場所へ置く場合は、その参照先も `denyWrite` に追加する。

起動前の準備と引数には、srt 0.0.77 で[起動を試した](experiments/srt-trial/README.md)結果を反映している。

- `allowRead` の例外がないと、sandbox 内から srt の proxy に接続できない。srt は proxy 用の socket を `/tmp` に置いて sandbox に渡すが、`denyRead` の `/tmp` がそれも隠すためである。例外を加えても、`/tmp` の他のファイルは読めない。
- Linux の srt は、起動時に存在するパスにだけ `denyWrite` を適用する。作業領域の `.claude` は起動前に作る。
- 新しい `CLAUDE_CONFIG_DIR` では、初回設定の接続確認が許可外の `platform.claude.com` に向かい、起動できない。`hasCompletedOnboarding` を先に書いて、この確認を省く。
- `--` で区切らないと、claude への引数が srt の引数として解釈される。

`allowedDomains` の `:443` は、srt 0.0.77 の[実測](experiments/srt-filter-bypass/README.md)に基づいて加えた。ポートを書かない許可では、sandbox 内から `github.com:22` へ SSH で接続でき、TLS 終端も認証情報の代理注入も通らなかった。`:443` を付けた許可では、この接続を proxy が拒否し、`api.github.com` への HTTPS は通った。ただし、この設定で Claude Code を起動しての通信確認はしていない。ポートを絞っても SOCKS 経由の接続は残るため、この構成の A1b は ○ のままである。

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

### nas で保護するファイル

既存の設定や hook が次の保護対象に収まるよう配置する。

| 対象 | 保護と条件 |
| --- | --- |
| Git と nas の既存設定 | `.git/config`、`.git/hooks`、`core.hooksPath` の参照先、`config.worktree`、linked worktree の `.git` ポインタ、`.nas` を自動で read-only にする。`.git/hooks` がなければホストに空で作る |
| 保護対象までの親ディレクトリ | 作業領域の root と、そこから `.git` 等までの親ディレクトリもマウントする。親の名前を変えて同名のディレクトリを作り直す操作で、保護を回避することを防ぐ |
| 作業領域の `.claude` | 自動保護の対象外なので明示的に read-only mount する。起動前に存在することが必須。存在しないパスは mount されず、新規作成できてしまう |
| ホストの Claude Code 設定 | `agentState.protectSettings = true` で `~/.claude/settings.json`、plugin、skill、agent、command 等を read-only 共有する。hook 実体も `~/.claude` 配下に置く |
| MCP 設定 | `~/.claude.json` は RW 共有するため、ホスト・container 双方の managed settings で MCP server を制限する |
| 共有する履歴・memory 等 | `~/.claude.json`、`~/.claude/history.jsonl`、`projects/` 内の auto memory を含む状態、`file-history/` は RW。ログ・キャッシュとホストにない項目はセッション専用 |

共有するファイルは [Claude 状態の共有定義](../../src/stages/mount/claude_state_fs.ts)と[マウント構成](../../src/agents/claude.ts)に実装されている。これらが生成するマウントを使った[書込み実験](experiments/state-isolation/README.md)では、設定への書込みは拒否されたが、実験用の会話履歴と memory は、ホスト側のファイルにも変更が反映された。`protectSettings` が保護するのは設定類で、履歴・memory は継続利用のため RW 共有する。`~/.claude.json` に含まれる MCP 設定は、両環境の managed settings で制限する。

`.git/config` の保護は、`core.hooksPath` の変更による迂回に加え、`core.fsmonitor`、`filter.*`、`diff.*.textconv` 等からの実行も防ぐために必要である。`git config`、`git remote add`、`git push -u` 等の設定更新は container 内では失敗するので、ホストで行う。共有する設定・plugin の更新もホスト側で行う。

自動保護の対象外は、サブディレクトリに新しく作った `.git`、submodule の `.git/modules`、起動後の `config.worktree`。作業領域のパスが symlink を経由すると `core.hooksPath` や worktree のポインタが保護から漏れる場合もある。ホストが既に使う設定がこれらの範囲にあれば B2a は未達となる。

### nas でのシークレットの扱い

マスクする値の一覧はホスト側で読み、コンテナ内の同じパスは `/dev/null` で隠す。`lines:` はマスクする値の指定に使う。通信に付ける認証情報は別途指定する。

maskfs はファイル内の値を、proxy は HTTP の要求に含まれる値を、`mask.filter` はツールの出力をマスクする。認証情報の代理注入と auto mode の操作審査も使い、シークレットがモデルへ送られたり、誤って保存されたりする被害を減らす。`mask.filter = true` では nas が sumi を自動配置し、Bash の stdout/stderr のマスクと Claude Code の managed hooks を設定する。秘密一覧はホスト側に保持し、container 内の sumi はマスク用 socket に処理を依頼するため、別途 sumi のインストールや `sumi init` は不要。

Read / Grep 等の成功ツール結果は、モデルへの送信とローカル会話履歴への保存より前にマスクする。利用者が実機の Claude Code で成功時のツール出力と保存後の会話履歴を確認し、どちらも値がマスクされていることを確かめた。失敗結果は hook から差し替えられないが、Bash の出力は実行時にマスクする。Git が管理するファイルには、共通条件の[差分への対策](threat-model.md#git-が管理するファイルの差分)も適用する。

Claude のログイン情報は container へ共有せず、既定の `agentState.auth = "injected"` でホスト側が OAuth token を保持・更新する。container にはダミーの `.credentials.json` を見せ、Anthropic の許可した request にだけ本物を注入する。proxy は接続先の証明書を検証し、TLS で通信する要求にだけ本物の認証情報を付ける。平文 HTTP の要求には付けない。一方、TLS を傍受する社内 proxy や自己署名証明書の接続先には対応せず、検証を回避する設定もない。

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
