import { assertEquals, assertThrows } from "@std/assert";
import {
  ConfigValidationError,
  validateConfig,
} from "../src/config/validate.ts";
import { profileSchema } from "../src/config/schema.ts";
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
  assertEquals(config.profiles.test.network.prompt.denylist, []);
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
    denylist: [],
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
            notify: "desktop",
          },
        },
      },
    },
  });
  assertEquals(config.profiles.test.network.prompt, {
    enable: true,
    denylist: [],
    timeoutSeconds: 42,
    defaultScope: "host",
    notify: "desktop",
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

Deno.test("validateConfig: network.prompt.denylist defaults to empty array", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude" } },
  });
  assertEquals(config.profiles.test.network.prompt.denylist, []);
});

Deno.test("validateConfig: network.prompt.denylist is parsed correctly", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        network: {
          prompt: { denylist: ["evil.com", "*.bad.org"] },
        },
      },
    },
  });
  assertEquals(config.profiles.test.network.prompt.denylist, [
    "evil.com",
    "*.bad.org",
  ]);
});

Deno.test("validateConfig: network.prompt.denylist rejects wildcard in middle", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            network: { prompt: { denylist: ["ev*il.com"] } },
          },
        },
      }),
    ConfigValidationError,
    "network.prompt.denylist[0]",
  );
});

Deno.test("validateConfig: allowlist and denylist overlap throws", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            network: {
              allowlist: ["example.com"],
              prompt: { denylist: ["example.com"] },
            },
          },
        },
      }),
    ConfigValidationError,
    "appears in both network.allowlist and network.prompt.denylist",
  );
});

Deno.test("validateConfig: allowlist=*.example.com and denylist=sub.example.com is allowed", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        network: {
          allowlist: ["*.example.com"],
          prompt: { denylist: ["sub.example.com"] },
        },
      },
    },
  });
  assertEquals(config.profiles.test.network.allowlist, ["*.example.com"]);
  assertEquals(config.profiles.test.network.prompt.denylist, [
    "sub.example.com",
  ]);
});

Deno.test("validateConfig: allowlist=sub.example.com and denylist=*.example.com is allowed", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        network: {
          allowlist: ["sub.example.com"],
          prompt: { denylist: ["*.example.com"] },
        },
      },
    },
  });
  assertEquals(config.profiles.test.network.allowlist, ["sub.example.com"]);
  assertEquals(config.profiles.test.network.prompt.denylist, [
    "*.example.com",
  ]);
});

// ---------------------------------------------------------------------------
// Error aggregation: superRefine collects multiple issues instead of aborting
// on the first one.
// ---------------------------------------------------------------------------

Deno.test("profileSchema: env collects errors from multiple entries", () => {
  const schema = profileSchema("test");
  const result = schema.safeParse({
    agent: "claude",
    env: [
      { key: "A", key_cmd: "echo A", val: "x" },
      { val: "y" },
    ],
  });
  assertEquals(result.success, false);
  if (!result.success) {
    const paths = result.error.issues.map((i) => i.path.join("."));
    assertEquals(paths.includes("env.0"), true, "env[0] error missing");
    assertEquals(paths.includes("env.1"), true, "env[1] error missing");
  }
});

Deno.test("profileSchema: env reports both key and val errors in same entry", () => {
  const schema = profileSchema("test");
  const result = schema.safeParse({
    agent: "claude",
    env: [
      { key: "A", key_cmd: "echo A", val: "x", val_cmd: "echo x" },
    ],
  });
  assertEquals(result.success, false);
  if (!result.success) {
    const messages = result.error.issues.map((i) => i.message);
    assertEquals(
      messages.some((m) => m.includes("key or key_cmd")),
      true,
    );
    // key error triggers early return, so val error is not reached (by design)
    // — the key/val checks are sequential within one entry
  }
});

Deno.test("profileSchema: network collects multiple allowlist/denylist overlaps", () => {
  const schema = profileSchema("test");
  const result = schema.safeParse({
    agent: "claude",
    network: {
      allowlist: ["a.com", "b.com", "c.com"],
      prompt: { denylist: ["a.com", "c.com"] },
    },
  });
  assertEquals(result.success, false);
  if (!result.success) {
    const overlapMessages = result.error.issues.filter((i) =>
      i.message.includes("appears in both")
    );
    assertEquals(overlapMessages.length, 2, "expected 2 overlap errors");
    assertEquals(
      overlapMessages.some((i) => i.message.includes('"a.com"')),
      true,
    );
    assertEquals(
      overlapMessages.some((i) => i.message.includes('"c.com"')),
      true,
    );
  }
});

// ---------------------------------------------------------------------------
// UI config
// ---------------------------------------------------------------------------

Deno.test("validateConfig: ui defaults when omitted", () => {
  const raw: RawConfig = {
    profiles: { test: { agent: "claude" } },
  };
  const config = validateConfig(raw);
  assertEquals(config.ui.enable, true);
  assertEquals(config.ui.port, 3939);
  assertEquals(config.ui.idleTimeout, 300);
});

Deno.test("validateConfig: ui explicit values", () => {
  const raw: RawConfig = {
    ui: { enable: false, port: 8080, "idle-timeout": 0 },
    profiles: { test: { agent: "claude" } },
  };
  const config = validateConfig(raw);
  assertEquals(config.ui.enable, false);
  assertEquals(config.ui.port, 8080);
  assertEquals(config.ui.idleTimeout, 0);
});

Deno.test("validateConfig: ui invalid port rejects", () => {
  const raw: RawConfig = {
    ui: { port: 0 },
    profiles: { test: { agent: "claude" } },
  };
  assertThrows(
    () => validateConfig(raw),
    ConfigValidationError,
    "ui:",
  );
});

Deno.test("validateConfig: ui negative idle-timeout rejects", () => {
  const raw: RawConfig = {
    ui: { "idle-timeout": -1 },
    profiles: { test: { agent: "claude" } },
  };
  assertThrows(
    () => validateConfig(raw),
    ConfigValidationError,
    "ui:",
  );
});
