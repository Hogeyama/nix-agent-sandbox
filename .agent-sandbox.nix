let
  common_infra = {
    nix = {
      enable = "auto";
      mount-socket = true;
    };
    session = {
      enable = true;
    };
    docker = {
      enable = true;
      shared = true;
    };
    gcloud = {
      mount-config = false;
    };
    aws = {
      mount-config = false;
    };
    display = {
      sandbox = "xpra";
    };
    gpg = {
      forward-agent = false;
    };
    extra-mounts = [
      {
        src = "~/.nix-profile/bin";
        dst = "~/.nix-profile/bin";
        mode = "ro";
      }
      {
        src = "~/.config/nvim";
        dst = "~/.config/nvim";
        mode = "ro";
      }
      {
        src = "~/.config/tmux";
        dst = "~/.config/tmux";
        mode = "ro";
      }
      {
        src = "~/.local/share/nvim";
        dst = "~/.local/share/nvim";
        mode = "ro";
      }
      {
        src = "~/nix-config";
        dst = "~/nix-config";
        mode = "ro";
      }
    ];
  };

  common_network = {
    network = {
      allowlist = [
        # Anthropic / Claude
        "api.anthropic.com"
        "statsig.anthropic.com"
        "platform.claude.com"
        "mcp-proxy.anthropic.com"
        "code.claude.com"
        "claude.ai"

        # OpenAI / ChatGPT
        "api.openai.com"
        "*.api.openai.com"
        "ab.chatgpt.com"
        "chatgpt.com"

        # Google
        "storage.googleapis.com"

        # GitHub
        "api.github.com"
        "release-assets.githubusercontent.com"
        "codeload.github.com"
        # ユーザーのやつ
        "github.com"
        "gist.github.com"
        "raw.githubusercontent.com"
        # Copilot
        "api.githubcopilot.com"
        "telemetry.individual.githubcopilot.com"
        "api.individual.githubcopilot.com"
        "telemetry.business.githubcopilot.com"
        "api.business.githubcopilot.com"
        # 画像系
        "camo.githubusercontent.com"
        "avatars.githubusercontent.com"

        # Docker Hub
        "registry-1.docker.io"
        "auth.docker.io"
        "index.docker.io"
        "hub.docker.com"
        "www.docker.com"
        "production.cloudflare.docker.com"
        "download.docker.com"

        # Container Registries
        "*.gcr.io" # Google Container Registry
        "ghcr.io" # GitHub Container Registry
        "mcr.microsoft.com" # Microsoft Container Registry
        "*.data.mcr.microsoft.com"
        "public.ecr.aws" # AWS ECR

        # Package Registries
        "registry.npmjs.org" # npm
        "jsr.io" # JSR (Deno)
        "deno.land" # Deno
        "dl.deno.land" # Deno
        "esm.sh"
      ];
      prompt = {
        enable = true;
        denylist = [
          # Claude Codeがなんか送ってるやつ
          "http-intake.logs.us5.datadoghq.com"
          # Copilot CLIがなんか送ってるやつ
          "copilot-telemetry.githubusercontent.com"
        ];
      };
      proxy = {
        forward-ports = [ 8080 5432 ];
      };
    };
  };

  common_env = {
    env = [
      { key = "TZ"; val = "Asia/Tokyo"; }
      { key = "LANG"; val = "en_US.UTF-8"; }
      # hostexecのgpgで署名する
      { key = "GIT_CONFIG_COUNT"; val = "1"; }
      { key = "GIT_CONFIG_KEY_0"; val = "gpg.program"; }
      { key = "GIT_CONFIG_VALUE_0"; val = "gpg"; }
      { key = "TERM"; val = "xterm-256color"; }
      {
        key = "GITHUB_TOKEN";
        val_cmd = "pass github/token/for-agent";
      }
      {
        key = "PATH";
        val = "~/.nix-profile/bin";
        mode = "suffix";
        separator = ":";
      }
    ];
  };

  common_hostexec = {
    hostexec = {
      prompt = {
        enable = true;
        timeout-seconds = 300;
        default-scope = "capability";
      };
      rules = [
        {
          id = "git-push";
          match = {
            argv0 = "git";
            arg-regex = ''push'';
          };
          cwd = {
            mode = "workspace-or-session-tmp";
          };
          approval = "deny";
          fallback = "deny";
        }
        {
          id = "wl-paste";
          match = {
            argv0 = "wl-paste";
          };
          cwd = {
            mode = "workspace-or-session-tmp";
          };
          inherit-env = {
            mode = "minimal";
            keys = [ "WAYLAND_DISPLAY" "XDG_RUNTIME_DIR" ];
          };
          approval = "allow";
          fallback = "container";
        }
        {
          # git commit/tag -S が呼ぶ形だけを通す:
          #   gpg --status-fd=2 -bsau <keyid>
          id = "gpg-git-sign";
          match = {
            argv0 = "gpg";
            arg-regex = ''^--status-fd=2 -bsau [0-9A-Fa-f]{8,40}$'';
          };
          cwd = {
            mode = "workspace-or-session-tmp";
          };
          approval = "allow";
          fallback = "container";
        }
      ];
    };
  };

  mkProfile = builtins.foldl' (acc: overlay: acc // overlay) { };
in
{
  default = "claude";

  ui = {
    enable = true;
    port = 3939;
    idle-timeout = 300;
  };

  profiles = {
    claude = mkProfile [
      {
        agent = "claude";
        agent-args = [ "--dangerously-skip-permissions" ];
      }
      common_env
      common_infra
      common_network
      common_hostexec
    ];

    claude-remote = mkProfile [
      {
        agent = "claude";
        agent-args = [ "remote" ];
      }
      common_env
      common_infra
      common_network
      common_hostexec
    ];

    codex = mkProfile [
      {
        agent = "codex";
        agent-args = [
          "--dangerously-bypass-approvals-and-sandbox"
        ];
        dbus = {
          session = {
            enable = true;
            calls = [
              {
                name = "org.freedesktop.secrets";
                rule = "org.freedesktop.Secret.Service.OpenSession";
              }
              {
                name = "org.freedesktop.secrets";
                rule = "org.freedesktop.Secret.Service.SearchItems";
              }
              {
                name = "org.freedesktop.secrets";
                rule = "org.freedesktop.Secret.Item.GetSecret";
              }
            ];
          };
        };
      }
      common_infra
      common_network
      common_env
      common_hostexec
    ];

    copilot = mkProfile [
      {
        agent = "copilot";
        agent-args = [
          "--allow-all"
        ];
      }
      common_infra
      common_network
      common_env
      common_hostexec
    ];

    hostexec-demo = mkProfile [
      {
        agent = "claude";
        agent-args = [ ];
        extra-mounts = [
          { src = "/dev/null"; dst = ".env"; }
          { src = "./deno.json"; dst = "deno.json"; mode = "ro"; }
        ];
        hostexec = {
          prompt = {
            enable = true;
            timeout-seconds = 300;
            default-scope = "capability";
          };
          secrets = {
            hostexec_demo_api_base_url = {
              from = "dotenv:.env#HOSTEXEC_DEMO_API_BASE_URL";
              required = true;
            };
            hostexec_demo_api_token = {
              from = "dotenv:.env#HOSTEXEC_DEMO_API_TOKEN";
              required = true;
            };
          };
          rules = [
            {
              id = "deno-task";
              match = {
                argv0 = "deno";
                subcommands = [ "task" ];
              };
              cwd = {
                mode = "workspace-only";
              };
              env = {
                HOSTEXEC_DEMO_API_BASE_URL = "secret:hostexec_demo_api_base_url";
                HOSTEXEC_DEMO_API_TOKEN = "secret:hostexec_demo_api_token";
              };
              approval = "prompt";
              fallback = "container";
            }
          ];
        };
      }
      common_network
      common_env
    ];
  };
}
