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
    display = {
      enable = true;
    };
    gcloud = {
      mount-config = false;
    };
    aws = {
      mount-config = false;
    };
    gpg = {
      forward-agent = false;
    };
    extra-mounts = [
      # playwright-cliを試すため
      { src = "~/.local/share/pnpm"; dst = "~/.local/share/pnpm"; }
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
        ];
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
      # playwright-cliを試すため
      {
        key = "PATH";
        val = "~/.local/share/pnpm";
        mode = "prefix";
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
          id = "git-fetch-pull";
          match = {
            argv0 = "git";
            arg-regex = ''^(fetch|pull)\b'';
          };
          cwd = {
            mode = "workspace-or-session-tmp";
          };
          approval = "allow";
          fallback = "container";
        }
        {
          id = "wl-copy";
          match = {
            argv0 = "wl-copy";
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
          id = "gh";
          match = {
            argv0 = "gh";
          };
          cwd = {
            mode = "workspace-or-session-tmp";
          };
          approval = "allow";
          fallback = "container";
        }
        {
          id = "gpg-sign";
          match = {
            argv0 = "gpg";
            arg-regex = ''(^|\s)(--sign|-[a-zA-Z]*s[a-zA-Z]*)(\s|$)'';
          };
          cwd = {
            mode = "workspace-or-session-tmp";
          };
          approval = "allow";
          fallback = "container";
        }
        {
          id = "bun-test";
          match = {
            argv0 = "bun";
            arg-regex = ''^(run\b)?test\b'';
          };
          cwd = {
            mode = "workspace-only";
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
