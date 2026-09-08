/**
 * ヘルプメッセージ
 */

export function printUsage(): void {
  console.log(`nas - Nix Agent Sandbox

Usage:
  nas [options-before-profile] [profile-name] [agent-args...]
  nas rebuild [profile-name] [options]
  nas worktree [list|clean] [options]
  nas container [list|clean]
  nas session [list|attach <session-id>]
  nas network [pending|approve|deny|review|gc|bind|unbind|forward|unforward]
  nas hostexec [pending|approve|deny|review|test] [options]
  nas ui [stop] [--port PORT] [--no-open]
  nas audit [--since YYYY-MM-DD] [--session ID] [--domain network|hostexec] [--json]
  nas config init
  nas config trust              # Trust the repo-local .nas/config.pkl in the cwd
  nas config untrust            # Revoke trust for the repo-local config
  nas config migrate yml2pkl [--global] [--input <path>] [-f, --force]
  nas config migrate nix2pkl [--global] [--input <path>] [-f, --force]
  nas hook --kind start|attention|stop [--when path=value ...]

Subcommands:
  rebuild   Docker イメージを削除して再ビルドする
  worktree  git worktree の管理
  container sidecar container の管理
  session   dtach セッションの管理
  network   network 承認キューと runtime の管理
  hostexec  hostexec 承認キューの管理
  ui        Web ダッシュボードを起動する
  audit     監査ログを表示する
  config    設定ファイルの管理 (init: 初期設定ファイルを生成, migrate yml2pkl: YAML→Pkl変換, migrate nix2pkl: Nix→Pkl変換)
  hook      Report a session event from an agent hook (internal use)

Options:
  (main command only — must appear before [profile-name])
  -h, --help      Show this help
  -V, --version   Show version
  -q, --quiet     Suppress info logs
  -v, --verbose   Show debug logs (stage timing, etc.)
  -b, --worktree <branch>  Create a git worktree for this session and base it on <branch>.
                           Use @ or HEAD for the current HEAD.
                           (This is a per-run option, not the same as the 'worktree' subcommand.)
  --no-worktree   Disable worktree for this run even if the profile has worktree configured

Main command notes:
  - nas options must appear before [profile-name]
  - args after [profile-name] are passed to the agent
  - if [profile-name] is omitted, use -- before agent args
  - NOTE: '-b/--worktree' (option) creates a worktree for one session;
          'nas worktree' (subcommand) lists/cleans worktrees left by past sessions

Rebuild options:
  -f, --force     Force remove Docker image (docker rmi --force)

Worktree subcommand options:
  ('nas worktree' manages worktrees created by past sessions, distinct from the -b/--worktree run option)
  list            nas が作成した worktree を一覧表示（デフォルト）
  clean           nas が作成した worktree をすべて削除
  -f, --force     確認なしで削除
  -B, --delete-branch  worktree 削除時にブランチも削除

Container options:
  list            nas 管理コンテナを一覧表示
  clean           未使用の nas sidecar container/network/volume を削除

Session options:
  list            アクティブな dtach セッション一覧（デフォルト）
  attach <id>     セッションに再接続

Network options:
  pending         保留中の network 承認要求を表示
  approve         承認する
  deny            拒否する
  review          fzf で対話的に承認/拒否する
  gc              stale runtime state を掃除する
  bind <session-id> -L <host-port>:<container-port>
                  ホストで待ち受け、コンテナへ転送する
  bind <session-id> -R <container-port>:<host-port>
                  コンテナで待ち受け、ホストへ転送する
                  L/R は左が待受ポート、右が転送先ポート（引数なしで両方向を一覧表示）
  unbind <session-id> -L <host-port>
  unbind <session-id> -R <container-port>
                  指定方向の待受ポートを削除する（引数なしで両方向から fzf 選択）
  bind <session-id>:<container-port> [<host-port>]
  unbind [<session-id>:<container-port> | <host-port>]
                  Local 転送の互換構文
  forward <session-id>:<container-port> [<host-port>]
                  Remote 転送の互換構文（引数なしで Remote のみ一覧表示）
  unforward [<session-id>:<container-port>]
                  Remote 転送を削除する互換構文（引数なしで fzf 選択）
  --local-forward  -L の長い形式
  --remote-forward -R の長い形式
  --runtime-dir DIR
                  bind/unbind/forward/unforward では ports runtime root、それ以外では network runtime root
  --format json   bind/forward の一覧を JSON 形式で表示

HostExec options:
  pending         保留中の hostexec 承認要求を表示
  approve         承認する
  deny            拒否する
  review          fzf で対話的に承認/拒否する
  test            ルールマッチングをテストする

Audit options:
  --since YYYY-MM-DD    指定日以降のログを表示（デフォルト: 今日）
  --session ID          セッション ID でフィルタ
  --domain DOMAIN       ドメインでフィルタ（network|hostexec）
  --json                JSON 形式で出力
  --audit-dir DIR       監査ログディレクトリを指定

Examples:
  nas                                    # Use default profile (interactive)
  nas copilot-nix                        # Use specific profile
  nas copilot-nix -p "list files"        # Pass args after profile to the agent
  nas copilot-nix --resume=session-id    # Copilot CLI resume without --
  nas -- -p "list files"                 # Pass args to the default profile
  nas rebuild                            # Rebuild Docker image only
  nas rebuild --force                    # Force remove image and rebuild
  nas worktree list                      # List all nas worktrees
  nas worktree clean                     # Remove all nas worktrees
  nas container clean                    # Remove unused nas sidecars
  nas network pending                    # Show pending approvals
  nas network approve <session> <request> --scope host-port
  nas network bind <session> -L 8080:3000 # Listen on host port 8080 and forward to container port 3000
  nas network bind <session> -R 15432:5432 # Listen on container port 15432 and forward to host port 5432
  nas network unbind <session> -L 8080   # Remove the Local forward by its host listen port
  nas network unbind <session> -R 15432  # Remove the Remote forward by its container listen port
  nas network bind <session>:3000        # Legacy Local syntax
  nas network bind <session>             # Pick from the ports the container is listening on
  nas network unbind <session>:3000      # Legacy Local removal syntax
  nas network forward <session>:5432     # Legacy Remote syntax
  nas network forward <session>          # Pick from the ports the host is listening on
  nas network unforward <session>:5432   # Legacy Remote removal syntax
  nas hostexec pending                   # Show pending hostexec approvals
  nas worktree clean --force             # Remove without confirmation
  nas worktree clean --delete-branch     # Remove worktrees and their branches
  nas worktree clean -f -B              # Force remove worktrees and branches
  nas config migrate yml2pkl              # Migrate local .agent-sandbox.yml to .nas/config.pkl
  nas config migrate yml2pkl --global    # Migrate global config
  nas audit                              # Show today's audit logs
  nas audit --since 2026-01-01           # Show logs since a date
  nas audit --session sess_abc --json    # JSON output for a session
  nas my-profile -b feature/login       # Create worktree from feature/login
  nas --worktree @                      # Use default profile, base current HEAD

Profile agent-args (in .nas/config.pkl):
  profiles {
    ["copilot-nix"] {
      agent = "copilot"
      agentArgs = new Listing { "--yolo" }
    }
    ["codex-nix"] {
      agent = "codex"
      agentArgs = new Listing { "--model"; "gpt-5-codex" }
    }
  }
`);
}
