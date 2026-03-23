/**
 * ヘルプメッセージ
 */

export function printUsage(): void {
  console.log(`nas - Nix Agent Sandbox

Usage:
  nas [options-before-profile] [profile-name] [agent-args...]
  nas rebuild [profile-name] [options]
  nas worktree [list|clean] [options]
  nas container clean
  nas network [pending|approve|deny|review|gc]
  nas ui [--port PORT] [--no-open] [--runtime-dir DIR]

Subcommands:
  rebuild   Docker イメージを削除して再ビルドする
  worktree  git worktree の管理
  container sidecar container の管理
  network   network 承認キューと runtime の管理
  hostexec  hostexec 承認キューの管理
  ui        Web ダッシュボードを起動する

Options:
  -h, --help      Show this help
  -V, --version   Show version
  -q, --quiet     Suppress info logs
  -b, --worktree <branch>  Enable worktree and set base branch (use @ or HEAD for current HEAD)
  --no-worktree   Disable worktree even if configured in profile

Main command notes:
  - nas options must appear before [profile-name]
  - args after [profile-name] are passed to the agent
  - if [profile-name] is omitted, use -- before agent args

Rebuild options:
  -f, --force     Force remove Docker image (docker rmi --force)

Worktree options:
  list            nas が作成した worktree を一覧表示（デフォルト）
  clean           nas が作成した worktree をすべて削除
  -f, --force     確認なしで削除
  -B, --delete-branch  worktree 削除時にブランチも削除

Container options:
  clean           未使用の nas sidecar container/network/volume を削除

Network options:
  pending         保留中の network 承認要求を表示
  approve         承認する
  deny            拒否する
  gc              stale runtime state を掃除する

HostExec options:
  pending         保留中の hostexec 承認要求を表示
  approve         承認する
  deny            拒否する
  test            ルールマッチングをテストする

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
  nas hostexec pending                   # Show pending hostexec approvals
  nas worktree clean --force             # Remove without confirmation
  nas worktree clean --delete-branch     # Remove worktrees and their branches
  nas worktree clean -f -B              # Force remove worktrees and branches
  nas my-profile -b feature/login       # Create worktree from feature/login
  nas --worktree @                      # Use default profile, base current HEAD

Profile agent-args (in .agent-sandbox.yml):
  profiles:
    copilot-nix:
      agent: copilot
      agent-args:
        - "--yolo"
    codex-nix:
      agent: codex
      agent-args:
        - "--model"
        - "gpt-5-codex"
`);
}
