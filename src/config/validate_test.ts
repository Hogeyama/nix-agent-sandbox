import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
/**
 * Tests for validateConfig function: general config validation.
 * Split from the original monolithic file — covers "validate:" and "validateConfig:" test cases.
 *
 * See also:
 *   - validate_hostexec_test.ts — hostexec-specific validation
 *   - schema_test.ts — profileSchema tests
 */

import { ConfigValidationError, validateConfig } from "./validate.ts";
import { DEFAULT_DBUS_CONFIG, DEFAULT_DISPLAY_CONFIG } from "./types.ts";
import type { RawConfig } from "./types.ts";

// ---------------------------------------------------------------------------
// validate tests
// ---------------------------------------------------------------------------

// --- profiles のバリデーション ---

test("validate: profiles is required", () => {
  expect(() => validateConfig({} as RawConfig)).toThrow("at least one entry");
});

test("validate: empty profiles throws", () => {
  expect(() => validateConfig({ profiles: {} })).toThrow("at least one entry");
});

test("validate: profiles with null value throws", () => {
  expect(() =>
    validateConfig({
      profiles: {
        test: null as unknown as import("./types.ts").RawProfile,
      },
    })
  ).toThrow();
});

// --- agent バリデーション ---

test("validate: agent=claude is valid", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude" } },
  });
  expect(config.profiles.test.agent).toEqual("claude");
});

test("validate: agent=copilot is valid", () => {
  const config = validateConfig({
    profiles: { test: { agent: "copilot" } },
  });
  expect(config.profiles.test.agent).toEqual("copilot");
});

test("validate: agent=codex is valid", () => {
  const config = validateConfig({
    profiles: { test: { agent: "codex" } },
  });
  expect(config.profiles.test.agent).toEqual("codex");
});

test("validate: missing agent throws", () => {
  expect(() => validateConfig({ profiles: { test: {} } })).toThrow(
    "agent must be one of",
  );
});

test("validate: agent='' throws", () => {
  expect(() => validateConfig({ profiles: { test: { agent: "" } } })).toThrow(
    "agent must be one of",
  );
});

test("validate: agent=gpt throws", () => {
  expect(() => validateConfig({ profiles: { test: { agent: "gpt" } } }))
    .toThrow("agent must be one of");
});

test("validate: agent=Claude (case sensitive) throws", () => {
  expect(() => validateConfig({ profiles: { test: { agent: "Claude" } } }))
    .toThrow("agent must be one of");
});

// --- default profile バリデーション ---

test("validate: default profile exists", () => {
  const config = validateConfig({
    default: "test",
    profiles: { test: { agent: "claude" } },
  });
  expect(config.default).toEqual("test");
});

test("validate: default profile not in profiles throws", () => {
  expect(() =>
    validateConfig({
      default: "missing",
      profiles: { test: { agent: "claude" } },
    })
  ).toThrow('default profile "missing" not found');
});

test("validate: no default is ok", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude" } },
  });
  expect(config.default).toEqual(undefined);
});

// --- agent-args ---

test("validate: agent-args defaults to empty array", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude" } },
  });
  expect(config.profiles.test.agentArgs).toEqual([]);
});

test("validate: agent-args preserved", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        "agent-args": ["--flag1", "--flag2", "value"],
      },
    },
  });
  expect(config.profiles.test.agentArgs).toEqual([
    "--flag1",
    "--flag2",
    "value",
  ]);
});

// --- worktree バリデーション ---

test("validate: worktree not present returns undefined", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude" } },
  });
  expect(config.profiles.test.worktree).toEqual(undefined);
});

test("validate: worktree empty object gets defaults", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude", worktree: {} } },
  });
  expect(config.profiles.test.worktree?.base).toEqual("origin/main");
  expect(config.profiles.test.worktree?.onCreate).toEqual("");
});

test("validate: worktree with base only", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        worktree: { base: "develop" },
      },
    },
  });
  expect(config.profiles.test.worktree?.base).toEqual("develop");
  expect(config.profiles.test.worktree?.onCreate).toEqual("");
});

test("validate: worktree with on-create only", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        worktree: { "on-create": "make build" },
      },
    },
  });
  expect(config.profiles.test.worktree?.base).toEqual("origin/main");
  expect(config.profiles.test.worktree?.onCreate).toEqual("make build");
});

test("validate: worktree with both fields", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        worktree: {
          base: "origin/develop",
          "on-create": "npm ci && npm run build",
        },
      },
    },
  });
  expect(config.profiles.test.worktree?.base).toEqual("origin/develop");
  expect(config.profiles.test.worktree?.onCreate).toEqual(
    "npm ci && npm run build",
  );
});

test("validate: worktree base=HEAD is valid", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        worktree: { base: "HEAD" },
      },
    },
  });
  expect(config.profiles.test.worktree?.base).toEqual("HEAD");
});

// --- nix バリデーション ---

test("validate: nix defaults", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude" } },
  });
  expect(config.profiles.test.nix.enable).toEqual("auto");
  expect(config.profiles.test.nix.mountSocket).toEqual(true);
  expect(config.profiles.test.nix.extraPackages).toEqual([]);
});

test("validate: nix enable=true", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude", nix: { enable: true } } },
  });
  expect(config.profiles.test.nix.enable).toEqual(true);
});

test("validate: nix enable=false", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude", nix: { enable: false } } },
  });
  expect(config.profiles.test.nix.enable).toEqual(false);
});

test("validate: nix enable=auto", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude", nix: { enable: "auto" } } },
  });
  expect(config.profiles.test.nix.enable).toEqual("auto");
});

test("validate: nix mount-socket override", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        nix: { "mount-socket": false },
      },
    },
  });
  expect(config.profiles.test.nix.mountSocket).toEqual(false);
});

test("validate: nix extra-packages", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        nix: {
          "extra-packages": ["nixpkgs#gh", "nixpkgs#jq"],
        },
      },
    },
  });
  expect(config.profiles.test.nix.extraPackages).toEqual([
    "nixpkgs#gh",
    "nixpkgs#jq",
  ]);
});

// --- docker バリデーション ---

test("validate: docker defaults", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude" } },
  });
  expect(config.profiles.test.docker.enable).toEqual(false);
  expect(config.profiles.test.docker.shared).toEqual(false);
});

test("validate: docker enable=true", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        docker: { enable: true, shared: false },
      },
    },
  });
  expect(config.profiles.test.docker.enable).toEqual(true);
});

test("validate: docker shared=true", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        docker: { enable: true, shared: true },
      },
    },
  });
  expect(config.profiles.test.docker.shared).toEqual(true);
});

// --- gcloud バリデーション ---

test("validate: gcloud defaults", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude" } },
  });
  expect(config.profiles.test.gcloud.mountConfig).toEqual(false);
});

test("validate: gcloud mount-config=true", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        gcloud: { "mount-config": true },
      },
    },
  });
  expect(config.profiles.test.gcloud.mountConfig).toEqual(true);
});

// --- aws バリデーション ---

test("validate: aws defaults", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude" } },
  });
  expect(config.profiles.test.aws.mountConfig).toEqual(false);
});

test("validate: aws mount-config=true", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        aws: { "mount-config": true },
      },
    },
  });
  expect(config.profiles.test.aws.mountConfig).toEqual(true);
});

// --- gpg バリデーション ---

test("validate: gpg defaults", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude" } },
  });
  expect(config.profiles.test.gpg.forwardAgent).toEqual(false);
});

test("validate: gpg forward-agent=true", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        gpg: { "forward-agent": true },
      },
    },
  });
  expect(config.profiles.test.gpg.forwardAgent).toEqual(true);
});

// --- extra-mounts バリデーション ---

test("validate: extra-mounts defaults to empty", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude" } },
  });
  expect(config.profiles.test.extraMounts).toEqual([]);
});

test("validate: extra-mounts with valid entries", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        "extra-mounts": [
          { src: "/a", dst: "/b", mode: "ro" },
          { src: "/c", dst: "/d", mode: "rw" },
        ],
      },
    },
  });
  expect(config.profiles.test.extraMounts.length).toEqual(2);
  expect(config.profiles.test.extraMounts[0]).toEqual({
    src: "/a",
    dst: "/b",
    mode: "ro",
  });
  expect(config.profiles.test.extraMounts[1]).toEqual({
    src: "/c",
    dst: "/d",
    mode: "rw",
  });
});

test("validate: extra-mounts mode defaults to ro", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        "extra-mounts": [{ src: "/a", dst: "/b" }],
      },
    },
  });
  expect(config.profiles.test.extraMounts[0].mode).toEqual("ro");
});

test("validate: extra-mounts missing src throws", () => {
  expect(() =>
    validateConfig({
      profiles: {
        test: {
          agent: "claude",
          "extra-mounts": [{ dst: "/b" }],
        },
      },
    })
  ).toThrow("extra-mounts[0].src");
});

test("validate: extra-mounts empty src throws", () => {
  expect(() =>
    validateConfig({
      profiles: {
        test: {
          agent: "claude",
          "extra-mounts": [{ src: "", dst: "/b" }],
        },
      },
    })
  ).toThrow("extra-mounts[0].src");
});

test("validate: extra-mounts missing dst throws", () => {
  expect(() =>
    validateConfig({
      profiles: {
        test: {
          agent: "claude",
          "extra-mounts": [{ src: "/a" }],
        },
      },
    })
  ).toThrow("extra-mounts[0].dst");
});

test("validate: extra-mounts empty dst throws", () => {
  expect(() =>
    validateConfig({
      profiles: {
        test: {
          agent: "claude",
          "extra-mounts": [{ src: "/a", dst: "" }],
        },
      },
    })
  ).toThrow("extra-mounts[0].dst");
});

test("validate: extra-mounts invalid mode throws", () => {
  expect(() =>
    validateConfig({
      profiles: {
        test: {
          agent: "claude",
          "extra-mounts": [{ src: "/a", dst: "/b", mode: "rwx" }],
        },
      },
    })
  ).toThrow("extra-mounts[0].mode");
});

test("validate: extra-mounts second entry error references index 1", () => {
  expect(() =>
    validateConfig({
      profiles: {
        test: {
          agent: "claude",
          "extra-mounts": [
            { src: "/a", dst: "/b", mode: "ro" },
            { src: "/c", dst: "", mode: "ro" },
          ],
        },
      },
    })
  ).toThrow("extra-mounts[1].dst");
});

// --- env バリデーション ---

test("validate: env defaults to empty", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude" } },
  });
  expect(config.profiles.test.env).toEqual([]);
});

test("validate: static env entry", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        env: [{ key: "FOO", val: "bar" }],
      },
    },
  });
  expect(config.profiles.test.env[0]).toEqual({
    key: "FOO",
    val: "bar",
    mode: "set",
  });
});

test("validate: command env entry", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        env: [{ key_cmd: "echo KEY", val_cmd: "echo VAL" }],
      },
    },
  });
  expect(config.profiles.test.env[0]).toEqual({
    keyCmd: "echo KEY",
    valCmd: "echo VAL",
    mode: "set",
  });
});

test("validate: mixed static and command throws", () => {
  expect(() =>
    validateConfig({
      profiles: {
        test: {
          agent: "claude",
          env: [{ key: "K", val: "V", key_cmd: "echo K", val_cmd: "echo V" }],
        },
      },
    })
  ).toThrow("must have exactly one of key or key_cmd");
});

test("validate: static env missing key throws", () => {
  expect(() =>
    validateConfig({
      profiles: {
        test: {
          agent: "claude",
          env: [{ val: "value" }],
        },
      },
    })
  ).toThrow();
});

test("validate: static env empty key throws", () => {
  expect(() =>
    validateConfig({
      profiles: {
        test: {
          agent: "claude",
          env: [{ key: "", val: "value" }],
        },
      },
    })
  ).toThrow("env[0].key");
});

test("validate: command env empty key_cmd throws", () => {
  expect(() =>
    validateConfig({
      profiles: {
        test: {
          agent: "claude",
          env: [{ key_cmd: "", val_cmd: "echo val" }],
        },
      },
    })
  ).toThrow("env[0].key_cmd");
});

test("validate: command env empty val_cmd throws", () => {
  expect(() =>
    validateConfig({
      profiles: {
        test: {
          agent: "claude",
          env: [{ key_cmd: "echo key", val_cmd: "" }],
        },
      },
    })
  ).toThrow("env[0].val_cmd");
});

// --- env mode / separator バリデーション ---

test("validate: env prefix mode with separator", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        env: [{ key: "PATH", val: "/opt/bin", mode: "prefix", separator: ":" }],
      },
    },
  });
  expect(config.profiles.test.env[0]).toEqual({
    key: "PATH",
    val: "/opt/bin",
    mode: "prefix",
    separator: ":",
  });
});

test("validate: env suffix mode with separator", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        env: [
          {
            key: "LD_LIBRARY_PATH",
            val: "/opt/lib",
            mode: "suffix",
            separator: ":",
          },
        ],
      },
    },
  });
  expect(config.profiles.test.env[0]).toEqual({
    key: "LD_LIBRARY_PATH",
    val: "/opt/lib",
    mode: "suffix",
    separator: ":",
  });
});

test("validate: env prefix mode with val_cmd", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        env: [
          {
            key: "PYTHONPATH",
            val_cmd: "echo /opt/py",
            mode: "prefix",
            separator: ":",
          },
        ],
      },
    },
  });
  expect(config.profiles.test.env[0]).toEqual({
    key: "PYTHONPATH",
    valCmd: "echo /opt/py",
    mode: "prefix",
    separator: ":",
  });
});

test("validate: env mode defaults to set when omitted", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        env: [{ key: "FOO", val: "bar" }],
      },
    },
  });
  expect(config.profiles.test.env[0].mode).toEqual("set");
});

test("validate: env prefix without separator throws", () => {
  expect(() =>
    validateConfig({
      profiles: {
        test: {
          agent: "claude",
          env: [{ key: "PATH", val: "/opt/bin", mode: "prefix" }],
        },
      },
    })
  ).toThrow("separator is required");
});

test("validate: env suffix without separator throws", () => {
  expect(() =>
    validateConfig({
      profiles: {
        test: {
          agent: "claude",
          env: [{ key: "PATH", val: "/opt/bin", mode: "suffix" }],
        },
      },
    })
  ).toThrow("separator is required");
});

test("validate: env set mode with separator throws", () => {
  expect(() =>
    validateConfig({
      profiles: {
        test: {
          agent: "claude",
          env: [{ key: "FOO", val: "bar", mode: "set", separator: ":" }],
        },
      },
    })
  ).toThrow("separator is only allowed");
});

test("validate: env omitted mode with separator throws", () => {
  expect(() =>
    validateConfig({
      profiles: {
        test: {
          agent: "claude",
          env: [{ key: "FOO", val: "bar", separator: ":" }],
        },
      },
    })
  ).toThrow("separator is only allowed");
});

test("validate: env invalid mode throws", () => {
  expect(() =>
    validateConfig({
      profiles: {
        test: {
          agent: "claude",
          env: [
            { key: "FOO", val: "bar", mode: "prepend", separator: ":" },
          ],
        },
      },
    })
  ).toThrow();
});

test("validate: env prefix with empty separator allowed", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        env: [{ key: "FLAGS", val: "-Wall", mode: "prefix", separator: "" }],
      },
    },
  });
  expect(config.profiles.test.env[0].separator).toEqual("");
});

// --- 複数プロファイルの独立バリデーション ---

test("validate: error in second profile references correct name", () => {
  expect(() =>
    validateConfig({
      profiles: {
        valid: { agent: "claude" },
        invalid: { agent: "bad" },
      },
    })
  ).toThrow('profile "invalid"');
});

test("validate: multiple valid profiles all validated", () => {
  const config = validateConfig({
    profiles: {
      a: { agent: "claude", nix: { enable: true } },
      b: { agent: "copilot", "agent-args": ["--yolo"] },
      c: {
        agent: "claude",
        docker: { enable: true, shared: false },
        gpg: { "forward-agent": true },
      },
    },
  });
  expect(config.profiles.a.nix.enable).toEqual(true);
  expect(config.profiles.b.agentArgs).toEqual(["--yolo"]);
  expect(config.profiles.c.docker.enable).toEqual(true);
  expect(config.profiles.c.gpg.forwardAgent).toEqual(true);
});

// ---------------------------------------------------------------------------
// config tests
// ---------------------------------------------------------------------------

test("validateConfig: valid minimal config", () => {
  const raw: RawConfig = {
    default: "test",
    profiles: {
      test: {
        agent: "claude",
      },
    },
  };
  const config = validateConfig(raw);
  expect(config.default).toEqual("test");
  expect(config.profiles.test.agent).toEqual("claude");
  expect(config.profiles.test.nix.enable).toEqual("auto");
  expect(config.profiles.test.docker.enable).toEqual(false);
  expect(config.profiles.test.docker.shared).toEqual(false);
  expect(config.profiles.test.gpg.forwardAgent).toEqual(false);
  expect(config.profiles.test.display).toEqual(DEFAULT_DISPLAY_CONFIG);
  expect(config.profiles.test.network.allowlist).toEqual([]);
  expect(config.profiles.test.network.prompt.enable).toEqual(false);
  expect(config.profiles.test.network.prompt.denylist).toEqual([]);
  expect(config.profiles.test.network.prompt.timeoutSeconds).toEqual(300);
  expect(config.profiles.test.network.prompt.defaultScope).toEqual("host-port");
  expect(config.profiles.test.network.prompt.notify).toEqual("auto");
  expect(config.profiles.test.dbus).toEqual(DEFAULT_DBUS_CONFIG);
  expect(config.profiles.test.extraMounts).toEqual([]);
  expect(config.profiles.test.env).toEqual([]);
});

test("validateConfig: full config", () => {
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
  expect(p.agent).toEqual("claude");
  expect(p.worktree?.base).toEqual("origin/main");
  expect(p.worktree?.onCreate).toEqual("npm install");
  expect(p.nix.enable).toEqual(true);
  expect(p.nix.mountSocket).toEqual(true);
  expect(p.nix.extraPackages).toEqual(["nixpkgs.ripgrep"]);
  expect(p.docker.enable).toEqual(true);
  expect(p.docker.shared).toEqual(false);
  expect(p.extraMounts).toEqual([
    { src: "~/.cabal", dst: "~/.cabal", mode: "ro" },
    { src: "/tmp/data", dst: "/mnt/data", mode: "rw" },
  ]);
  expect(p.env[0]).toEqual({ key: "FOO", val: "bar", mode: "set" });
  expect(p.env[1]).toEqual({
    keyCmd: "printf BAR",
    valCmd: "printf baz",
    mode: "set",
  });
});

test("validateConfig: missing profiles throws", () => {
  expect(() => validateConfig({ profiles: {} })).toThrow("at least one entry");
});

test("validateConfig: invalid agent throws", () => {
  expect(() =>
    validateConfig({
      profiles: { test: { agent: "invalid" } },
    })
  ).toThrow("agent must be one of");
});

test("validateConfig: codex agent is valid", () => {
  const raw: RawConfig = {
    profiles: {
      test: {
        agent: "codex",
      },
    },
  };
  const config = validateConfig(raw);
  expect(config.profiles.test.agent).toEqual("codex");
});

test("validateConfig: agent-args are parsed", () => {
  const raw: RawConfig = {
    profiles: {
      test: {
        agent: "copilot",
        "agent-args": ["--yolo"],
      },
    },
  };
  const config = validateConfig(raw);
  expect(config.profiles.test.agentArgs).toEqual(["--yolo"]);
});

test("validateConfig: agent-args defaults to empty array", () => {
  const raw: RawConfig = {
    profiles: {
      test: {
        agent: "claude",
      },
    },
  };
  const config = validateConfig(raw);
  expect(config.profiles.test.agentArgs).toEqual([]);
});

test("validateConfig: invalid default profile throws", () => {
  expect(() =>
    validateConfig({
      default: "nonexistent",
      profiles: { test: { agent: "claude" } },
    })
  ).toThrow("not found in profiles");
});

test("validateConfig: mixed env entry throws", () => {
  expect(() =>
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
    })
  ).toThrow("must have exactly one of key or key_cmd");
});

test("validateConfig: invalid env command entry throws", () => {
  expect(() =>
    validateConfig({
      profiles: {
        test: {
          agent: "claude",
          env: [{ key_cmd: "", val_cmd: "echo x" }],
        },
      },
    })
  ).toThrow("env[0].key_cmd");
});

test("validateConfig: invalid extra-mounts mode throws", () => {
  expect(() =>
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
    })
  ).toThrow("extra-mounts[0].mode");
});

test("validateConfig: missing extra-mounts src throws", () => {
  expect(() =>
    validateConfig({
      profiles: {
        test: {
          agent: "claude",
          "extra-mounts": [{ dst: "/tmp/dst", mode: "ro" }],
        },
      },
    })
  ).toThrow("extra-mounts[0].src");
});

test("validateConfig: gpg.forward-agent defaults to false", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude" } },
  });
  expect(config.profiles.test.gpg.forwardAgent).toEqual(false);
});

test("validateConfig: gpg.forward-agent can be enabled", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        gpg: { "forward-agent": true },
      },
    },
  });
  expect(config.profiles.test.gpg.forwardAgent).toEqual(true);
});

test("validateConfig: dbus.session defaults to disabled", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude" } },
  });
  expect(config.profiles.test.dbus).toEqual(DEFAULT_DBUS_CONFIG);
});

test("validateConfig: dbus.session config is parsed", () => {
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
  expect(config.profiles.test.dbus.session.enable).toEqual(true);
  expect(config.profiles.test.dbus.session.sourceAddress).toEqual(
    "unix:path=/run/user/1000/bus",
  );
  expect(config.profiles.test.dbus.session.see).toEqual([
    "org.freedesktop.secrets",
  ]);
  expect(config.profiles.test.dbus.session.talk).toEqual([
    "org.freedesktop.secrets",
  ]);
  expect(config.profiles.test.dbus.session.own).toEqual(["org.example.Owned"]);
  expect(config.profiles.test.dbus.session.calls).toEqual([
    { name: "org.freedesktop.secrets", rule: "*" },
  ]);
  expect(config.profiles.test.dbus.session.broadcasts).toEqual([
    { name: "org.freedesktop.secrets", rule: "*" },
  ]);
});

test("validateConfig: dbus.session invalid source-address throws", () => {
  expect(() =>
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
    })
  ).toThrow("dbus.session.source-address");
});

test("validateConfig: dbus.session invalid call rule throws", () => {
  expect(() =>
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
    })
  ).toThrow("dbus.session.calls[0].name");
});

test("validateConfig: worktree defaults", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        worktree: { base: "main" },
      },
    },
  });
  expect(config.profiles.test.worktree?.base).toEqual("main");
  expect(config.profiles.test.worktree?.onCreate).toEqual("");
});

test("validateConfig: worktree on-create is preserved", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        worktree: { "on-create": "npm install" },
      },
    },
  });
  expect(config.profiles.test.worktree?.base).toEqual("origin/main");
  expect(config.profiles.test.worktree?.onCreate).toEqual("npm install");
});

test("validateConfig: network.allowlist defaults to empty array", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude" } },
  });
  expect(config.profiles.test.network.allowlist).toEqual([]);
});

test("validateConfig: network.prompt defaults are applied", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude" } },
  });
  expect(config.profiles.test.network.prompt).toEqual({
    enable: false,
    denylist: [],
    timeoutSeconds: 300,
    defaultScope: "host-port",
    notify: "auto",
  });
});

test("validateConfig: network.prompt accepts explicit values", () => {
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
  expect(config.profiles.test.network.prompt).toEqual({
    enable: true,
    denylist: [],
    timeoutSeconds: 42,
    defaultScope: "host",
    notify: "desktop",
  });
});

test("validateConfig: network.prompt rejects invalid default-scope", () => {
  expect(() =>
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
    })
  ).toThrow("network.prompt.default-scope must be one of");
});

test("validateConfig: network.prompt rejects invalid notify", () => {
  expect(() =>
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
    })
  ).toThrow("network.prompt.notify must be one of");
});

test("validateConfig: network.allowlist is parsed correctly", () => {
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
  expect(config.profiles.test.network.allowlist).toEqual([
    "github.com",
    "api.anthropic.com",
  ]);
});

test("validateConfig: network.allowlist invalid entry throws", () => {
  expect(() =>
    validateConfig({
      profiles: {
        test: {
          agent: "claude",
          network: { allowlist: ["github.com", ""] },
        },
      },
    })
  ).toThrow("network.allowlist[1] must be a non-empty string");
});

test("validateConfig: network.allowlist accepts wildcard prefix", () => {
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
  expect(config.profiles.test.network.allowlist).toEqual([
    "*.github.com",
    "api.anthropic.com",
  ]);
});

test("validateConfig: network.allowlist rejects wildcard in middle", () => {
  expect(() =>
    validateConfig({
      profiles: {
        test: {
          agent: "claude",
          network: { allowlist: ["git*hub.com"] },
        },
      },
    })
  ).toThrow("contains wildcard");
});

test("validateConfig: network.allowlist rejects trailing wildcard", () => {
  expect(() =>
    validateConfig({
      profiles: {
        test: {
          agent: "claude",
          network: { allowlist: ["github.*"] },
        },
      },
    })
  ).toThrow("contains wildcard");
});

test("validateConfig: network.allowlist non-array throws", () => {
  expect(() =>
    validateConfig({
      profiles: {
        test: {
          agent: "claude",
          // deno-lint-ignore no-explicit-any
          network: { allowlist: "not-an-array" as any },
        },
      },
    })
  ).toThrow("network.allowlist must be a list");
});

test("validateConfig: network.prompt.denylist defaults to empty array", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude" } },
  });
  expect(config.profiles.test.network.prompt.denylist).toEqual([]);
});

test("validateConfig: network.prompt.denylist is parsed correctly", () => {
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
  expect(config.profiles.test.network.prompt.denylist).toEqual([
    "evil.com",
    "*.bad.org",
  ]);
});

test("validateConfig: network.prompt.denylist rejects wildcard in middle", () => {
  expect(() =>
    validateConfig({
      profiles: {
        test: {
          agent: "claude",
          network: { prompt: { denylist: ["ev*il.com"] } },
        },
      },
    })
  ).toThrow("network.prompt.denylist[0]");
});

test("validateConfig: allowlist and denylist overlap throws", () => {
  expect(() =>
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
    })
  ).toThrow("appears in both network.allowlist and network.prompt.denylist");
});

test("validateConfig: allowlist=*.example.com and denylist=sub.example.com is allowed", () => {
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
  expect(config.profiles.test.network.allowlist).toEqual(["*.example.com"]);
  expect(config.profiles.test.network.prompt.denylist).toEqual([
    "sub.example.com",
  ]);
});

test("validateConfig: allowlist=sub.example.com and denylist=*.example.com is allowed", () => {
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
  expect(config.profiles.test.network.allowlist).toEqual(["sub.example.com"]);
  expect(config.profiles.test.network.prompt.denylist).toEqual([
    "*.example.com",
  ]);
});

// ---------------------------------------------------------------------------
// UI config
// ---------------------------------------------------------------------------

test("validateConfig: ui defaults when omitted", () => {
  const raw: RawConfig = {
    profiles: { test: { agent: "claude" } },
  };
  const config = validateConfig(raw);
  expect(config.ui.enable).toEqual(true);
  expect(config.ui.port).toEqual(3939);
  expect(config.ui.idleTimeout).toEqual(300);
});

test("validateConfig: ui explicit values", () => {
  const raw: RawConfig = {
    ui: { enable: false, port: 8080, "idle-timeout": 0 },
    profiles: { test: { agent: "claude" } },
  };
  const config = validateConfig(raw);
  expect(config.ui.enable).toEqual(false);
  expect(config.ui.port).toEqual(8080);
  expect(config.ui.idleTimeout).toEqual(0);
});

test("validateConfig: ui invalid port rejects", () => {
  const raw: RawConfig = {
    ui: { port: 0 },
    profiles: { test: { agent: "claude" } },
  };
  expect(() => validateConfig(raw)).toThrow("ui:");
});

test("validateConfig: ui negative idle-timeout rejects", () => {
  const raw: RawConfig = {
    ui: { "idle-timeout": -1 },
    profiles: { test: { agent: "claude" } },
  };
  expect(() => validateConfig(raw)).toThrow("ui:");
});

// ---------------------------------------------------------------------------
// Error aggregation across profiles and fields
// ---------------------------------------------------------------------------

test("validateConfig: multiple errors in one profile are all reported", () => {
  let err: ConfigValidationError | undefined;
  try {
    validateConfig({
      profiles: {
        test: {
          agent: "claude",
          // deno-lint-ignore no-explicit-any
          network: { allowlist: "not-an-array" as any },
          "extra-mounts": [{ dst: "/tmp/dst", mode: "invalid" }],
        },
      },
    });
  } catch (e) {
    err = e as ConfigValidationError;
  }
  expect(err).toBeDefined();
  const msg = err!.message;
  expect(msg.includes("network.allowlist must be a list")).toEqual(true);
  expect(msg.includes("extra-mounts[0].src")).toEqual(true);
});

test("validateConfig: errors from multiple profiles are reported together", () => {
  let err: ConfigValidationError | undefined;
  try {
    validateConfig({
      profiles: {
        alpha: { agent: "invalid" },
        beta: { agent: "invalid" },
      },
    });
  } catch (e) {
    err = e as ConfigValidationError;
  }
  expect(err).toBeDefined();
  const msg = err!.message;
  expect(msg.includes('profile "alpha"')).toEqual(true);
  expect(msg.includes('profile "beta"')).toEqual(true);
});

test("validateConfig: hostexec rules errors are aggregated across rules", () => {
  let err: ConfigValidationError | undefined;
  try {
    validateConfig({
      profiles: {
        test: {
          agent: "claude",
          hostexec: {
            rules: [
              { id: "", match: { argv0: "git" } },
              { id: "", match: { argv0: "curl" } },
            ],
          },
        },
      },
    });
  } catch (e) {
    err = e as ConfigValidationError;
  }
  expect(err).toBeDefined();
  const msg = err!.message;
  expect(msg.includes("hostexec.rules[0]")).toEqual(true);
  expect(msg.includes("hostexec.rules[1]")).toEqual(true);
});
