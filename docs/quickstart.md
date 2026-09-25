# マジのクイックスタート

## 前提条件

* Linux (WSL2可)
* Docker
* Claude Code

## インストール

```
tmp=$(mktemp -d)
gh release download --repo Hogeyama/nix-agent-sandbox \
  --pattern 'nas-*_x86_64-linux.tar.gz' -O - | tar xz -C "$tmp"
"$tmp/nas" --extract ~/.local/share/nas-bin
ln -s ~/.local/share/nas-bin/bin/nas ~/.local/bin/nas
```

更新時は

```
rm -r ~/.local/share/nas-bin/bin/nas
tmp=$(mktemp -d)
gh release download --repo Hogeyama/nix-agent-sandbox \
  --pattern 'nas-*_x86_64-linux.tar.gz' -O - | tar xz -C "$tmp"
"$tmp/nas" --extract ~/.local/share/nas-bin
```

## 設定

1. `nas`を使いたいディレクトリに移動して以下を実行する
    ```
    cd /path/to/your-project
    nas config init
    ```
2. 生成された `~/.config/nas/global.pkl` を編集して、以下の内容にする
    ```pkl
    amends "Schema.pkl"

    local githubOwners: Listing<String> = new { "your-org" }

    // 秘匿情報の定義
    local secretsConfig: Mapping<String, SecretConfig> = new {
      ["gh-token-basic"] {
        from = #"cmd:printf 'Basic %s' "$(printf 'x-access-token:%s' "$(gh auth token)" | base64 -w0)""#
      }
      // 後述
      ["common-secrets"] {
        from = "lines:~/.config/nas/secrets.txt"
      }
    }

    // GitHub API へのアクセスに必要な認証ヘッダを注入するための定義。後で使う
    local githubAuthenticatedScope: Scope = new {
      targets {}
      fallback = "review"
      secrets { ["gh-token-basic"] = "inject" } // secretsで定義したもの
      inject {
        new Inject {
          name = "Authorization"
          value = #"template:${gh-token-basic}"#
        }
      }
    }

    // github.com へのトークンは、githubOwners のリポジトリを対象にするルールにだけ付ける。
    // スコープ全体に付けると、次の 2 つの問題が起きる。
    // * fallback の review で承認した他の owner のリポジトリにもトークンが送られる。
    // * github.com/<owner>/<repo>/releases/download/... にトークン付きで HEAD を送ると、
    //   GitHub は 401 を返す URL へリダイレクトする。トークンが無ければ
    //   release-assets.githubusercontent.com へリダイレクトされ、ダウンロードできる。
    //   Gradle の JDK 自動ダウンロードなど、最初に HEAD を送るツールが失敗する。
    local githubTokenInject: Listing<Inject> = new {
      new Inject {
        name = "Authorization"
        value = #"template:${gh-token-basic}"#
      }
    }

    // ネットワークの制御
    local networkConfig: NetworkConfig = new {
      // おまじない
      requestBodyAudit {
        enable = true
      }

      // 下記のscopesに出てこない宛先へのアクセスは許可制にする。
      fallback = "review"

      // 宛先・エンドポイントごとの設定。
      scopes {
        // Claude Code の動作に必要な宛先を許可する
        ["anthropic"] {
          targets {
            "api.anthropic.com"
            "claude.ai"
            "code.claude.com"
            "downloads.claude.ai"
            "mcp-proxy.anthropic.com"
            "platform.claude.com"
            "statsig.anthropic.com"
          }
          fallback = "allow"
        }

        // GitHub Copilot の動作に必要な宛先を許可する
        ["copilot"] {
          targets {
            "api.githubcopilot.com"
            "telemetry.business.githubcopilot.com"
            "api.business.githubcopilot.com"
          }
          fallback = "allow"
        }

        // GitHub の動作に必要な宛先を許可する（API編）。
        // プロンプトインジェクションや情報漏洩を防ぐため、
        // アクセスは所有者が githubOwners に含まれるリポジトリに限定する。
        ["github-api"] = (githubAuthenticatedScope) {
          targets { "api.github.com:443" }
          rules {
            // REST API
            ["rest"] {
              match {
                methods { "GET"; "HEAD" }
                paths {
                  "/repos/{owner}/**"
                  "/users/{owner}/**"
                  "/orgs/{owner}/**"
                  "/user"
                  // 以下は GitHub Copilot の動作に必要
                  "/copilot_internal/user"
                  "/copilot_internal/v2/token"
                }
                captures { ["owner"] = githubOwners }
              }
              onMatch = "allow"
            }

            // GraphQL API
            ["graphql"] {
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
                    // 自動許可する取得経路。
                    // うっかり starredRepos などを許可するとプロンプトインジェクションの経路になる。
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
                      "/repository/pullRequests/nodes/url"
                      "/repository/pullRequests/nodes/state"
                      "/repository/pullRequests/nodes/id"
                      "/repository/pullRequests/nodes/baseRefName"
                      "/repository/pullRequests/nodes/headRefName"
                      "/repository/pullRequests/nodes/isCrossRepository"
                      "/repository/pullRequests/nodes/headRepositoryOwner/id"
                      "/repository/pullRequests/nodes/headRepositoryOwner/login"
                      "/repository/pullRequests/nodes/headRepositoryOwner/name"
                      "/repository/defaultBranchRef/name"
                      "/repository/parent/id"
                      "/repository/parent/name"
                      "/repository/parent/owner/id"
                      "/repository/parent/owner/login"
                      "/repository/object/text"
                      "/organization/login"
                      "/user/login"
                      "/repositoryOwner/login"
                    }
                    // 各 root の出現ごとに、所有者を名指す引数が存在して
                    // githubOwners に含まれることを要求する。
                    fieldArguments {
                      ["/repository"]      { ["owner"] = githubOwners }
                      ["/organization"]    { ["login"] = githubOwners }
                      ["/user"]            { ["login"] = githubOwners }
                      ["/repositoryOwner"] { ["login"] = githubOwners }
                    }
                  }
                  onViolation = "review" // 上記のルールに違反する場合は、手動で確認する
                }
              }
            }
          }
        }

        // GitHub の動作に必要な宛先を許可する。
        // Web ページと git fetch 用。
        // トークンはスコープではなく各ルールで注入する（githubTokenInject の説明を参照）。
        ["github"] {
          targets { "github.com:443" }
          fallback = "review"
          secrets { ["gh-token-basic"] = "inject" }
          rules {
            ["read"] {
              match {
                methods { "GET"; "HEAD" }
                paths { "/{owner}/**" }
                captures { ["owner"] = githubOwners }
              }
              onMatch = "allow"
              inject = githubTokenInject
            }
            ["git-fetch"] {
              match {
                methods { "POST" }
                paths { "/{owner}/{repo}/git-upload-pack" }
                captures { ["owner"] = githubOwners }
              }
              onMatch = "allow"
              inject = githubTokenInject
            }
            // fallback の review で承認してもトークンが付かず 401 になるので、
            // push 用のルールを置いて inject する。push は外に出る操作なので承認は残す。
            ["git-push"] {
              match {
                methods { "POST" }
                paths { "/{owner}/{repo}/git-receive-pack" }
                captures { ["owner"] = githubOwners }
              }
              onMatch = "review"
              inject = githubTokenInject
            }
          }
        }

        // raw / archive / gist の配信も host 一括 allow にしない。
        ["github-content"] {
          targets {
            "raw.githubusercontent.com:443"
            "codeload.github.com:443"
            "gist.github.com:443"
            "gist.githubusercontent.com:443"
          }
          fallback = "review"
          rules {
            ["read"] {
              match {
                methods { "GET"; "HEAD" }
                paths { "/{owner}/**" }
                captures { ["owner"] = githubOwners }
              }
              onMatch = "allow"
            }
          }
        }

        // リリースをアップロードするときに認証ヘッダを付与する。
        // `fallback = "allow"` にはしていないので、手動許可は必要。
        ["github-uploads"] = (githubAuthenticatedScope) {
          targets { "uploads.github.com:443" }
        }

        // 自動送信のログやテレメトリを拒否する
        ["telemetry"] {
          targets {
            // Claude Code がなんか送ってるやつ
            "http-intake.logs.us5.datadoghq.com"
            // Copilot CLI がなんか送ってるやつ
            "copilot-telemetry.githubusercontent.com"
            // Copilot の実験配信
            "exp.business.githubcopilot.com"
          }
          fallback = "deny"
        }

        // chromium を開くと勝手にアクセスするやつを拒否する
        ["chromium"] {
          targets {
            "accounts.google.com"
            "android.clients.google.com"
            "clients2.google.com"
            "content-autofill.googleapis.com"
            "dl.google.com"
            "edgedl.me.gvt1.com"
            "mtalk.google.com"
            "www.google.com"
          }
          fallback = "deny"
        }

        // VS Code を開くと勝手にアクセスするやつを拒否する
        ["vscode"] {
          targets {
            "mobile.events.data.microsoft.com"
            "default.exp-tas.com"
            "westus-0.in.applicationinsights.azure.com"
            "o33249.ingest.us.sentry.io"
            "embeddings.vscode-cdn.net" // これは許可してもいいのかも
          }
          fallback = "deny"
        }
      }

      // シークレット（後述）をマスクする
      defaults {
        secrets { ["*"] = "ignore" }
      }
    }

    // エージェントに渡す環境変数。
    local envConfig: Listing<EnvConfig> = new {
      // 次の3つはお好みで
      new { key = "TZ"; val = "Asia/Tokyo" }
      new { key = "LANG"; val = "en_US.UTF-8" }
      new { key = "TERM"; val = "xterm-256color" }

      // GitHub の認証情報は上述の githubAuthenticatedScope で注入されるので不要ではあるが、
      // 空だと GitHub CLI がエラーを出すので、ダミー値を入れておく。
      new {
        key = "GITHUB_TOKEN"
        val = "dummy"
      }

      // Claude Codeが書くファイルをPWD以下にする(Optional)。
      // /tmpに書かれるとホストから見えないので。
      // extraMountsに/tmp/claude-1000:rwを追加する手もある。
      new {
        key = "CLAUDE_CODE_TMPDIR"
        valCmd = "echo \"$PWD/.local\""
      }
    }

    // コマンドをサンドボックス外（ホスト）で実行できるようにするエスケープハッチ。
    // 必要に応じて追加する。緩い argRegex と approval = "allow" を併用すると
    // 容易にサンドボックスの意味がなくなるので注意。
    local hostexecConfig: HostExecConfig = new {
      rules {
        // Gitの署名付きコミットを自動許可する例。
        // gpg --status-fd=2 -bsau <keyid> というパターンのコマンドはホストで実行される。
        // new {
        //   id = "gpg-git-sign"
        //   match {
        //     argv0 = "gpg"
        //     argRegex = "^--status-fd=2 -bsau [0-9A-Fa-f]{8,40}$"
        //   }
        //   cwd {
        //     mode = "workspace-or-session-tmp"
        //   }
        //   // 自動許可。手動許可にする場合は "prompt" にする。
        //   approval = "allow"
        //   // gpgの引数がargRegexにマッチしない場合はコンテナ内で実行する。
        //   // 失敗させたい場合は "deny" にする。
        //   fallback = "container"
        // }
      }
    }

    local baseProfile: Profile = new {
      // dtach でセッションを多重化する。ブラウザからのUI操作に必要。
      session {
        multiplex = true
      }
      // DinD を有効にする
      docker {
        enable = true
      }
      // マウント設定。ホストと共有したいディレクトリ／ファイルがあれば追加する
      extraMounts {
        new { src = ".git/hooks";  dst = ".git/hooks";  mode = "ro" }
        new { src = ".git/config"; dst = ".git/config"; mode = "ro" }
      }
      // シークレットマスク
      mask = new MaskConfig {
        maskfs = false // FUSEでファイルの中身をマスクする。FUSEが使えない環境ではfalseにする。
        proxy  = true  // TLS inspectionでマスクする。
        filter = true  // Bash toolの出力をマスクする。
      }
      // `/nas-sandbox`スキルをエージェントに渡す。
      guide {
        enable = true
      }
      env      = envConfig
      network  = networkConfig
      secrets  = secretsConfig
      hostexec = hostexecConfig
    }

    // トップレベル定義
    ///////////////////

    // OTELを有効にする。Web UI（後述）でセッション履歴や料金を確認できるようになる。
    observability {
      enable = true
    }

    profiles {
      ["claude"] = (baseProfile) {
        agent = "claude"
        agentArgs = new Listing { "--permission-mode"; "auto" }
      }

      // ACPを使う場合
      ["claude-acp"] = (baseProfile) {
        agent = "claude"
        mode = "acp"
        guide { enable = false } // ACPではスキルの注入ができないので無効化する
      }
    }
    ```
3. `~/.config/nas/secrets.txt` にマスクしたいシークレットを改行区切りで書く。
    ```
    my-secret-value-1
    my-secret-value-2
    my-secret-value-3
    ```
4. （VS Codeを使う場合）VS Code 拡張をインストールする。
    * Dev Containers 拡張
    * Claude Code 拡張
    * nas の拡張
      1. vsixを取得する
          ```
          curl -fsSLo /tmp/nas-approval.vsix https://github.com/Hogeyama/nix-agent-sandbox/releases/download/vscode-nas-approval-latest/nas-approval.vsix
          ```
      2. VS Code の拡張管理タブの右上のドット三つから Install from VSIX を押下し、`/tmp/nas-approval.vsix` を選択する。
5. （VS Codeを使う場合）Dev Container 設定を生成する。
    ```
    # /path/to/your-projectで
    nas devcontainer init
    ```
    * この操作はプロジェクト毎に必要になる

## 利用する（CLI）

* `nas` を実行するとClaude Codeが起動する
* `C-\` でデタッチできる
* http://localhost:3939 にアクセスすると、実行中の nas セッションの一覧が見られる
  * Web UIから操作可能
  * ネットワーク通信やhostexecの手動承認依頼もこの画面から確認・操作できる

## 利用する（VS Code）

VS Code に Dev Containers 拡張を入れてワークスペースを開く。
「`compose.json` が古い」というような警告は無視してよい。

ネットワーク通信やhostexecの手動承認依頼は、Ctrl-Shift-Pで「NAS Review Pending Approvals」というアクションを選択すると現れるUIで確認・操作できる。

何かが壊れた場合は `cd /path/to/your-project && nas devcontainer down && rm .devcontainer -r && nas devcontainer init` でどうにかなることが多い。

