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
  nas network [pending|approve|deny|review|watch|gc|bind|unbind|forward|unforward]
  nas hostexec [pending|approve|deny|review|watch|test] [options]
  nas ui [stop] [--port PORT] [--no-open]
  nas audit [--since YYYY-MM-DD] [--session ID] [--domain network|hostexec] [--json]
  nas config init
  nas config trust              # Trust the repo-local .nas/config.pkl in the cwd
  nas config untrust            # Revoke trust for the repo-local config
  nas config migrate yml2pkl [--global] [--input <path>] [-f, --force]
  nas config migrate nix2pkl [--global] [--input <path>] [-f, --force]
  nas hook --kind start|attention|stop [--when path=value ...]
  nas devcontainer init [--profile PROFILE] [--workspace DIR]
  nas devcontainer up|status|down [--workspace DIR] [--json]

Subcommands:
  rebuild   Remove the Docker image and rebuild it
  worktree  Manage git worktrees
  container Manage sidecar containers
  session   Manage dtach sessions
  network   Manage the network approval queue and runtime state
  hostexec  Manage the hostexec approval queue
  ui        Start the web dashboard
  audit     Show audit logs
  config    Manage config files (init: generate the initial config, migrate yml2pkl: YAML→Pkl, migrate nix2pkl: Nix→Pkl)
  hook      Report a session event from an agent hook (internal use)
  devcontainer  Initialize, start, inspect, and stop a VS Code Dev Container

Options:
  (main command only — must appear before [profile-name])
  -h, --help      Show this help
  -V, --version   Show version
  -q, --quiet     Suppress info logs
  --log-file <path>   Append nas diagnostics to a host file (before profile)
  --write-session-id <path>
                      Write the session id to a host file (before profile)
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
  list            List worktrees created by nas (default)
  clean           Remove all worktrees created by nas
  -f, --force     Remove without confirmation
  -B, --delete-branch  Also delete the branch when removing a worktree

Container options:
  list            List nas-managed containers
  clean           Remove unused nas sidecar containers/networks/volumes

Session options:
  list            List active dtach sessions (default)
  attach <id>     Reattach to a session

Network options:
  pending         Show pending network approval requests
  approve         Approve a request
  deny            Deny a request
  review          Interactively approve/deny with fzf
  watch           Stream approval request arrivals/removals as JSON Lines
  gc              Clean up stale runtime state
  bind <session-id> -L <host-port>:<container-port>
                  Listen on the host and forward to the container
  bind <session-id> -R <container-port>:<host-port>
                  Listen in the container and forward to the host
                  For -L/-R, the left port listens and the right port is the target (no args lists both directions)
  unbind <session-id> -L <host-port>
  unbind <session-id> -R <container-port>
                  Remove the listener for the given direction (no args: pick from both directions with fzf)
  bind <session-id>:<container-port> [<host-port>]
  unbind [<session-id>:<container-port> | <host-port>]
                  Compatibility syntax for Local forwards
  forward <session-id>:<container-port> [<host-port>]
                  Compatibility syntax for Remote forwards (no args lists Remote only)
  unforward [<session-id>:<container-port>]
                  Compatibility syntax to remove a Remote forward (no args: pick with fzf)
  --local-forward  Long form of -L
  --remote-forward Long form of -R
  --runtime-dir DIR
                  Ports runtime root for bind/unbind/forward/unforward; network runtime root otherwise
  --format json   Print pending and bind/forward listings as JSON
  --session ID    Limit pending/review/watch to one session

HostExec options:
  pending         Show pending hostexec approval requests
  approve         Approve a request
  deny            Deny a request
  review          Interactively approve/deny with fzf
  watch           Stream approval request arrivals/removals as JSON Lines
  test            Test rule matching
  --format json   Print the pending list as JSON
  --session ID    Limit pending/review/watch to one session

Audit options:
  --since YYYY-MM-DD    Show logs since the given date (default: today)
  --session ID          Filter by session ID
  --domain DOMAIN       Filter by domain (network|hostexec)
  --json                Output as JSON
  --audit-dir DIR       Use DIR as the audit log directory

Dev Container options:
  init [--profile PROFILE]  Generate the managed configuration (default: claude)
  up                        Start or reuse the workspace session
  status                    Show the live supervisor/container status
  down                      Stop the owned session and container
  --workspace DIR           Select a workspace (default: current directory)
  --json                    Print up/status/down results as JSON

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
  nas network pending --session sess_a1b2 # Show one session's pending approvals
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
  nas hostexec watch                     # Stream approval arrivals as JSON Lines
  nas hostexec watch --session sess_a1b2 # Stream one session only
  nas hostexec review --session sess_a1b2 # Review one session's approvals
  nas --write-session-id /tmp/id claude  # Record this session's id for --session
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
  nas devcontainer init --profile claude
  nas devcontainer init --profile codex
  nas devcontainer up
  nas devcontainer status --json
  nas devcontainer down

Profile agent-args (in .nas/config.pkl):
  profiles {
    ["copilot-nix"] {
      agent = "copilot"
      agentArgs = new Listing { "--yolo" }
    }
    ["codex-nix"] {
      agent = "codex"
      agentArgs = new Listing { "--model"; "gpt-5-codex" }
      extraAgents { "claude" }             // claude usable inside, not launched
    }
  }
`);
}
