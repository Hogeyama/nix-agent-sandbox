import { assertEquals, assertThrows } from "@std/assert";
import {
  ConfigValidationError,
  validateConfig,
} from "../src/config/validate.ts";
import { DEFAULT_DBUS_CONFIG } from "../src/config/types.ts";
import type { RawConfig } from "../src/config/types.ts";

Deno.test("validateConfig: valid minimal config", () => {
  const raw: RawConfig = {
    default: "test",
    profiles: {
      test: {
        agent: "claude",
      },
    },
  };
  const config = validateConfig(raw);
  assertEquals(config.default, "test");
  assertEquals(config.profiles.test.agent, "claude");
  assertEquals(config.profiles.test.nix.enable, "auto");
  assertEquals(config.profiles.test.docker.enable, false);
  assertEquals(config.profiles.test.docker.shared, false);
  assertEquals(config.profiles.test.gpg.forwardAgent, false);
  assertEquals(config.profiles.test.network.allowlist, []);
  assertEquals(config.profiles.test.network.prompt.enable, false);
  assertEquals(config.profiles.test.network.prompt.timeoutSeconds, 300);
  assertEquals(config.profiles.test.network.prompt.defaultScope, "host-port");
  assertEquals(config.profiles.test.network.prompt.notify, "auto");
  assertEquals(config.profiles.test.dbus, DEFAULT_DBUS_CONFIG);
  assertEquals(config.profiles.test.extraMounts, []);
  assertEquals(config.profiles.test.env, []);
});

Deno.test("validateConfig: full config", () => {
  const raw: RawConfig = {
    default: "claude-nix",
    profiles: {
      "claude-nix": {
        agent: "claude",
        worktree: {
          base: "origin/main",
          "on-create": "npm install",
        },
        nix: {
          enable: true,
          "mount-socket": true,
          "extra-packages": ["nixpkgs.ripgrep"],
        },
        docker: {
          enable: true,
        },
        "extra-mounts": [
          { src: "~/.cabal", dst: "~/.cabal" },
          { src: "/tmp/data", dst: "/mnt/data", mode: "rw" },
        ],
        env: [
          { key: "FOO", val: "bar" },
          { key_cmd: "printf BAR", val_cmd: "printf baz" },
        ],
      },
    },
  };
  const config = validateConfig(raw);
  const p = config.profiles["claude-nix"];
  assertEquals(p.agent, "claude");
  assertEquals(p.worktree?.base, "origin/main");
  assertEquals(p.worktree?.onCreate, "npm install");
  assertEquals(p.nix.enable, true);
  assertEquals(p.nix.mountSocket, true);
  assertEquals(p.nix.extraPackages, ["nixpkgs.ripgrep"]);
  assertEquals(p.docker.enable, true);
  assertEquals(p.docker.shared, false);
  assertEquals(p.extraMounts, [
    { src: "~/.cabal", dst: "~/.cabal", mode: "ro" },
    { src: "/tmp/data", dst: "/mnt/data", mode: "rw" },
  ]);
  assertEquals(p.env[0], { key: "FOO", val: "bar" });
  assertEquals(p.env[1], {
    keyCmd: "printf BAR",
    valCmd: "printf baz",
  });
});

Deno.test("validateConfig: missing profiles throws", () => {
  assertThrows(
    () => validateConfig({ profiles: {} }),
    ConfigValidationError,
    "at least one entry",
  );
});

Deno.test("validateConfig: invalid agent throws", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: { test: { agent: "invalid" } },
      }),
    ConfigValidationError,
    "agent must be one of",
  );
});

Deno.test("validateConfig: codex agent is valid", () => {
  const raw: RawConfig = {
    profiles: {
      test: {
        agent: "codex",
      },
    },
  };
  const config = validateConfig(raw);
  assertEquals(config.profiles.test.agent, "codex");
});

Deno.test("validateConfig: agent-args are parsed", () => {
  const raw: RawConfig = {
    profiles: {
      test: {
        agent: "copilot",
        "agent-args": ["--yolo"],
      },
    },
  };
  const config = validateConfig(raw);
  assertEquals(config.profiles.test.agentArgs, ["--yolo"]);
});

Deno.test("validateConfig: agent-args defaults to empty array", () => {
  const raw: RawConfig = {
    profiles: {
      test: {
        agent: "claude",
      },
    },
  };
  const config = validateConfig(raw);
  assertEquals(config.profiles.test.agentArgs, []);
});

Deno.test("validateConfig: invalid default profile throws", () => {
  assertThrows(
    () =>
      validateConfig({
        default: "nonexistent",
        profiles: { test: { agent: "claude" } },
      }),
    ConfigValidationError,
    "not found in profiles",
  );
});

Deno.test("validateConfig: mixed env entry throws", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            env: [{
              key: "A",
              val: "B",
              key_cmd: "echo C",
              val_cmd: "echo D",
            }],
          },
        },
      }),
    ConfigValidationError,
    "must have exactly one of key or key_cmd",
  );
});

Deno.test("validateConfig: invalid env command entry throws", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            env: [{ key_cmd: "", val_cmd: "echo x" }],
          },
        },
      }),
    ConfigValidationError,
    "env[0].key_cmd",
  );
});

Deno.test("validateConfig: invalid extra-mounts mode throws", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            "extra-mounts": [{
              src: "/tmp/src",
              dst: "/tmp/dst",
              mode: "invalid",
            }],
          },
        },
      }),
    ConfigValidationError,
    "extra-mounts[0].mode",
  );
});

Deno.test("validateConfig: missing extra-mounts src throws", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            "extra-mounts": [{ dst: "/tmp/dst", mode: "ro" }],
          },
        },
      }),
    ConfigValidationError,
    "extra-mounts[0].src",
  );
});

Deno.test("validateConfig: gpg.forward-agent defaults to false", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude" } },
  });
  assertEquals(config.profiles.test.gpg.forwardAgent, false);
});

Deno.test("validateConfig: gpg.forward-agent can be enabled", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        gpg: { "forward-agent": true },
      },
    },
  });
  assertEquals(config.profiles.test.gpg.forwardAgent, true);
});

Deno.test("validateConfig: dbus.session defaults to disabled", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude" } },
  });
  assertEquals(config.profiles.test.dbus, DEFAULT_DBUS_CONFIG);
});

Deno.test("validateConfig: dbus.session config is parsed", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        dbus: {
          session: {
            enable: true,
            "source-address": "unix:path=/run/user/1000/bus",
            see: ["org.freedesktop.secrets"],
            talk: ["org.freedesktop.secrets"],
            own: ["org.example.Owned"],
            calls: [{ name: "org.freedesktop.secrets", rule: "*" }],
            broadcasts: [{ name: "org.freedesktop.secrets", rule: "*" }],
          },
        },
      },
    },
  });
  assertEquals(config.profiles.test.dbus.session.enable, true);
  assertEquals(
    config.profiles.test.dbus.session.sourceAddress,
    "unix:path=/run/user/1000/bus",
  );
  assertEquals(config.profiles.test.dbus.session.see, [
    "org.freedesktop.secrets",
  ]);
  assertEquals(config.profiles.test.dbus.session.talk, [
    "org.freedesktop.secrets",
  ]);
  assertEquals(config.profiles.test.dbus.session.own, ["org.example.Owned"]);
  assertEquals(config.profiles.test.dbus.session.calls, [
    { name: "org.freedesktop.secrets", rule: "*" },
  ]);
  assertEquals(config.profiles.test.dbus.session.broadcasts, [
    { name: "org.freedesktop.secrets", rule: "*" },
  ]);
});

Deno.test("validateConfig: dbus.session invalid source-address throws", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            dbus: {
              session: {
                "source-address": "",
              },
            },
          },
        },
      }),
    ConfigValidationError,
    "dbus.session.source-address",
  );
});

Deno.test("validateConfig: dbus.session invalid call rule throws", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            dbus: {
              session: {
                calls: [{ name: "", rule: "*" }],
              },
            },
          },
        },
      }),
    ConfigValidationError,
    "dbus.session.calls[0].name",
  );
});

Deno.test("validateConfig: worktree defaults", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        worktree: { base: "main" },
      },
    },
  });
  assertEquals(config.profiles.test.worktree?.base, "main");
  assertEquals(config.profiles.test.worktree?.onCreate, "");
});

Deno.test("validateConfig: worktree on-create is preserved", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        worktree: { "on-create": "npm install" },
      },
    },
  });
  assertEquals(config.profiles.test.worktree?.base, "origin/main");
  assertEquals(config.profiles.test.worktree?.onCreate, "npm install");
});

Deno.test("validateConfig: network.allowlist defaults to empty array", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude" } },
  });
  assertEquals(config.profiles.test.network.allowlist, []);
});

Deno.test("validateConfig: network.prompt defaults are applied", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude" } },
  });
  assertEquals(config.profiles.test.network.prompt, {
    enable: false,
    timeoutSeconds: 300,
    defaultScope: "host-port",
    notify: "auto",
  });
});

Deno.test("validateConfig: network.prompt accepts explicit values", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        network: {
          prompt: {
            enable: true,
            "timeout-seconds": 42,
            "default-scope": "host",
            notify: "tmux",
          },
        },
      },
    },
  });
  assertEquals(config.profiles.test.network.prompt, {
    enable: true,
    timeoutSeconds: 42,
    defaultScope: "host",
    notify: "tmux",
  });
});

Deno.test("validateConfig: network.prompt rejects invalid default-scope", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            network: {
              prompt: {
                "default-scope": "invalid" as "host",
              },
            },
          },
        },
      }),
    ConfigValidationError,
    "network.prompt.default-scope must be one of",
  );
});

Deno.test("validateConfig: network.prompt rejects invalid notify", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            network: {
              prompt: {
                notify: "invalid" as "auto",
              },
            },
          },
        },
      }),
    ConfigValidationError,
    "network.prompt.notify must be one of",
  );
});

Deno.test("validateConfig: network.allowlist is parsed correctly", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        network: {
          allowlist: ["github.com", "api.anthropic.com"],
        },
      },
    },
  });
  assertEquals(config.profiles.test.network.allowlist, [
    "github.com",
    "api.anthropic.com",
  ]);
});

Deno.test("validateConfig: network.allowlist invalid entry throws", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            network: { allowlist: ["github.com", ""] },
          },
        },
      }),
    ConfigValidationError,
    "network.allowlist[1] must be a non-empty string",
  );
});

Deno.test("validateConfig: network.allowlist accepts wildcard prefix", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        network: {
          allowlist: ["*.github.com", "api.anthropic.com"],
        },
      },
    },
  });
  assertEquals(config.profiles.test.network.allowlist, [
    "*.github.com",
    "api.anthropic.com",
  ]);
});

Deno.test("validateConfig: network.allowlist rejects wildcard in middle", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            network: { allowlist: ["git*hub.com"] },
          },
        },
      }),
    ConfigValidationError,
    "contains wildcard",
  );
});

Deno.test("validateConfig: network.allowlist rejects trailing wildcard", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            network: { allowlist: ["github.*"] },
          },
        },
      }),
    ConfigValidationError,
    "contains wildcard",
  );
});

Deno.test("validateConfig: network.allowlist non-array throws", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            // deno-lint-ignore no-explicit-any
            network: { allowlist: "not-an-array" as any },
          },
        },
      }),
    ConfigValidationError,
    "network.allowlist must be a list",
  );
});
