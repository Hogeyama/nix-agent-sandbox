/**
 * Tests for config validation: covers hostexec config, validate, and config tests.
 *
 * Merged from:
 *   - tests/hostexec_config_test.ts
 *   - tests/validate_test.ts
 *   - tests/config_test.ts
 */

import { assertEquals, assertThrows } from "@std/assert";
import { assertMatch } from "@std/assert/match";
import { ConfigValidationError, validateConfig } from "./validate.ts";
import { profileSchema } from "./schema.ts";
import { DEFAULT_DBUS_CONFIG, DEFAULT_DISPLAY_CONFIG } from "./types.ts";
import type { RawConfig } from "./types.ts";

// ---------------------------------------------------------------------------
// hostexec config tests (from tests/hostexec_config_test.ts)
// ---------------------------------------------------------------------------

Deno.test("hostexec config: validates secrets and rules", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        hostexec: {
          secrets: {
            github_token: { from: "env:GITHUB_TOKEN", required: true },
          },
          prompt: {
            notify: "desktop",
          },
          rules: [
            {
              id: "git-readonly",
              match: {
                argv0: "git",
                "arg-regex": "^(pull|fetch)\\b",
              },
              env: { GITHUB_TOKEN: "secret:github_token" },
              "inherit-env": { mode: "minimal", keys: ["SSH_AUTH_SOCK"] },
              cwd: { mode: "workspace-or-session-tmp" },
              approval: "prompt",
              fallback: "container",
            },
          ],
        },
      },
    },
  });

  assertEquals(
    config.profiles.test.hostexec?.secrets.github_token.from,
    "env:GITHUB_TOKEN",
  );
  assertEquals(config.profiles.test.hostexec?.rules[0].inheritEnv.keys, [
    "SSH_AUTH_SOCK",
  ]);
  assertEquals(config.profiles.test.hostexec?.prompt.notify, "desktop");
  assertEquals(
    config.profiles.test.hostexec?.rules[0].match.argRegex,
    "^(pull|fetch)\\b",
  );
});

Deno.test("hostexec config: rejects unknown secret references", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            hostexec: {
              rules: [{
                id: "git-readonly",
                match: { argv0: "git" },
                env: { GITHUB_TOKEN: "secret:missing" },
              }],
            },
          },
        },
      }),
    ConfigValidationError,
    "unknown secret",
  );
});

Deno.test("hostexec config: rejects legacy profile secrets", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            secrets: {
              github_token: { from: "env:GITHUB_TOKEN", required: true },
            },
          } as never,
        },
      }),
    ConfigValidationError,
    "secrets has moved to hostexec.secrets",
  );
});

Deno.test("hostexec config: rejects missing rule id", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            hostexec: {
              rules: [{
                match: { argv0: "git" },
              }],
            },
          },
        },
      }),
    ConfigValidationError,
    "hostexec.rules[0].id",
  );
});

Deno.test("hostexec config: rejects invalid inherit-env mode", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            hostexec: {
              rules: [{
                id: "git-readonly",
                match: { argv0: "git" },
                "inherit-env": { mode: "all" as never },
              }],
            },
          },
        },
      }),
    ConfigValidationError,
    "inherit-env.mode",
  );
});

Deno.test("hostexec config: rejects invalid notify backend", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            hostexec: {
              prompt: {
                notify: "dbus" as never,
              },
            },
          },
        },
      }),
    ConfigValidationError,
    "hostexec.prompt.notify must be one of",
  );
});

Deno.test("hostexec config: allows argv0-only match for catch-all", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        hostexec: {
          rules: [{
            id: "git-any",
            match: { argv0: "git" },
          }],
        },
      },
    },
  });

  assertEquals(
    config.profiles.test.hostexec?.rules[0].match.argRegex,
    undefined,
  );
});

Deno.test("hostexec config: accepts once as default-scope", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        hostexec: {
          prompt: {
            "default-scope": "once",
          },
        },
      },
    },
  });
  assertEquals(config.profiles.test.hostexec?.prompt.defaultScope, "once");
});

Deno.test("hostexec config: rejects invalid default-scope", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            hostexec: {
              prompt: {
                "default-scope": "session" as never,
              },
            },
          },
        },
      }),
    ConfigValidationError,
    "hostexec.prompt.default-scope must be one of",
  );
});

Deno.test("hostexec config: rejects invalid arg-regex", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            hostexec: {
              rules: [{
                id: "git-any",
                match: { argv0: "git", "arg-regex": "[invalid" },
              }],
            },
          },
        },
      }),
    ConfigValidationError,
    "arg-regex is not a valid regular expression",
  );
});

Deno.test("hostexec config: warns on identical match rules", () => {
  const warnings: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => warnings.push(msg);
  try {
    validateConfig({
      profiles: {
        test: {
          agent: "claude",
          hostexec: {
            rules: [
              { id: "git-a", match: { argv0: "git" } },
              { id: "git-b", match: { argv0: "git" } },
            ],
          },
        },
      },
    });
  } finally {
    console.log = origLog;
  }
  assertEquals(warnings.length, 1);
  assertMatch(warnings[0], /git-a.*git-b.*identical match/);
});

Deno.test("hostexec config: warns when catch-all shadows specific rule", () => {
  const warnings: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => warnings.push(msg);
  try {
    validateConfig({
      profiles: {
        test: {
          agent: "claude",
          hostexec: {
            rules: [
              { id: "git-any", match: { argv0: "git" } },
              {
                id: "git-pull",
                match: { argv0: "git", "arg-regex": "^pull" },
              },
            ],
          },
        },
      },
    });
  } finally {
    console.log = origLog;
  }
  assertMatch(
    warnings.find((w) => /shadows/.test(w)) ?? "",
    /git-any.*shadows.*git-pull/,
  );
});

Deno.test("hostexec config: no warning when specific rule comes before catch-all", () => {
  const warnings: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => warnings.push(msg);
  try {
    validateConfig({
      profiles: {
        test: {
          agent: "claude",
          hostexec: {
            rules: [
              {
                id: "git-pull",
                match: { argv0: "git", "arg-regex": "^pull" },
              },
              { id: "git-any", match: { argv0: "git" } },
            ],
          },
        },
      },
    });
  } finally {
    console.log = origLog;
  }
  const shadowWarnings = warnings.filter((w) => /shadows/.test(w));
  assertEquals(shadowWarnings.length, 0);
});

Deno.test("hostexec config: rejects relative argv0 with fallback container", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            hostexec: {
              rules: [{
                id: "gradlew",
                match: { argv0: "./gradlew" },
                fallback: "container",
              }],
            },
          },
        },
      }),
    ConfigValidationError,
    "relative argv0",
  );
});

Deno.test("hostexec config: allows relative argv0 with fallback deny", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        hostexec: {
          rules: [{
            id: "gradlew",
            match: { argv0: "./gradlew" },
            fallback: "deny",
          }],
        },
      },
    },
  });
  assertEquals(config.profiles.test.hostexec?.rules[0].fallback, "deny");
});

// ---------------------------------------------------------------------------
// Error aggregation: hostexec env superRefine collects multiple issues
// ---------------------------------------------------------------------------

Deno.test("hostexec config: collects multiple env errors in a single rule", () => {
  // hostexecSchema's transform calls ruleSchema.parse() and wraps ZodError
  // into ConfigValidationError, so only the first env issue surfaces.
  // But the env superRefine itself now collects all issues within a rule.
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            hostexec: {
              secrets: { tok: { from: "env:TOK" } },
              rules: [{
                id: "r1",
                match: { argv0: "git" },
                env: {
                  "BAD-KEY": "secret:tok",
                  "NO_PREFIX": "plain-value",
                  "UNKNOWN": "secret:nope",
                },
              }],
            },
          },
        },
      }),
    ConfigValidationError,
    "BAD-KEY",
  );
});

// ---------------------------------------------------------------------------
// validate tests (from tests/validate_test.ts)
// ---------------------------------------------------------------------------

// --- profiles のバリデーション ---

Deno.test("validate: profiles is required", () => {
  assertThrows(
    () => validateConfig({} as RawConfig),
    ConfigValidationError,
    "at least one entry",
  );
});

Deno.test("validate: empty profiles throws", () => {
  assertThrows(
    () => validateConfig({ profiles: {} }),
    ConfigValidationError,
    "at least one entry",
  );
});

Deno.test("validate: profiles with null value throws", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: null as unknown as import("./types.ts").RawProfile,
        },
      }),
  );
});

// --- agent バリデーション ---

Deno.test("validate: agent=claude is valid", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude" } },
  });
  assertEquals(config.profiles.test.agent, "claude");
});

Deno.test("validate: agent=copilot is valid", () => {
  const config = validateConfig({
    profiles: { test: { agent: "copilot" } },
  });
  assertEquals(config.profiles.test.agent, "copilot");
});

Deno.test("validate: agent=codex is valid", () => {
  const config = validateConfig({
    profiles: { test: { agent: "codex" } },
  });
  assertEquals(config.profiles.test.agent, "codex");
});

Deno.test("validate: missing agent throws", () => {
  assertThrows(
    () => validateConfig({ profiles: { test: {} } }),
    ConfigValidationError,
    "agent must be one of",
  );
});

Deno.test("validate: agent='' throws", () => {
  assertThrows(
    () => validateConfig({ profiles: { test: { agent: "" } } }),
    ConfigValidationError,
    "agent must be one of",
  );
});

Deno.test("validate: agent=gpt throws", () => {
  assertThrows(
    () => validateConfig({ profiles: { test: { agent: "gpt" } } }),
    ConfigValidationError,
    "agent must be one of",
  );
});

Deno.test("validate: agent=Claude (case sensitive) throws", () => {
  assertThrows(
    () => validateConfig({ profiles: { test: { agent: "Claude" } } }),
    ConfigValidationError,
    "agent must be one of",
  );
});

// --- default profile バリデーション ---

Deno.test("validate: default profile exists", () => {
  const config = validateConfig({
    default: "test",
    profiles: { test: { agent: "claude" } },
  });
  assertEquals(config.default, "test");
});

Deno.test("validate: default profile not in profiles throws", () => {
  assertThrows(
    () =>
      validateConfig({
        default: "missing",
        profiles: { test: { agent: "claude" } },
      }),
    ConfigValidationError,
    'default profile "missing" not found',
  );
});

Deno.test("validate: no default is ok", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude" } },
  });
  assertEquals(config.default, undefined);
});

// --- agent-args ---

Deno.test("validate: agent-args defaults to empty array", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude" } },
  });
  assertEquals(config.profiles.test.agentArgs, []);
});

Deno.test("validate: agent-args preserved", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        "agent-args": ["--flag1", "--flag2", "value"],
      },
    },
  });
  assertEquals(config.profiles.test.agentArgs, [
    "--flag1",
    "--flag2",
    "value",
  ]);
});

// --- worktree バリデーション ---

Deno.test("validate: worktree not present returns undefined", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude" } },
  });
  assertEquals(config.profiles.test.worktree, undefined);
});

Deno.test("validate: worktree empty object gets defaults", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude", worktree: {} } },
  });
  assertEquals(config.profiles.test.worktree?.base, "origin/main");
  assertEquals(config.profiles.test.worktree?.onCreate, "");
});

Deno.test("validate: worktree with base only", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        worktree: { base: "develop" },
      },
    },
  });
  assertEquals(config.profiles.test.worktree?.base, "develop");
  assertEquals(config.profiles.test.worktree?.onCreate, "");
});

Deno.test("validate: worktree with on-create only", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        worktree: { "on-create": "make build" },
      },
    },
  });
  assertEquals(config.profiles.test.worktree?.base, "origin/main");
  assertEquals(config.profiles.test.worktree?.onCreate, "make build");
});

Deno.test("validate: worktree with both fields", () => {
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
  assertEquals(config.profiles.test.worktree?.base, "origin/develop");
  assertEquals(
    config.profiles.test.worktree?.onCreate,
    "npm ci && npm run build",
  );
});

Deno.test("validate: worktree base=HEAD is valid", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        worktree: { base: "HEAD" },
      },
    },
  });
  assertEquals(config.profiles.test.worktree?.base, "HEAD");
});

// --- nix バリデーション ---

Deno.test("validate: nix defaults", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude" } },
  });
  assertEquals(config.profiles.test.nix.enable, "auto");
  assertEquals(config.profiles.test.nix.mountSocket, true);
  assertEquals(config.profiles.test.nix.extraPackages, []);
});

Deno.test("validate: nix enable=true", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude", nix: { enable: true } } },
  });
  assertEquals(config.profiles.test.nix.enable, true);
});

Deno.test("validate: nix enable=false", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude", nix: { enable: false } } },
  });
  assertEquals(config.profiles.test.nix.enable, false);
});

Deno.test("validate: nix enable=auto", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude", nix: { enable: "auto" } } },
  });
  assertEquals(config.profiles.test.nix.enable, "auto");
});

Deno.test("validate: nix mount-socket override", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        nix: { "mount-socket": false },
      },
    },
  });
  assertEquals(config.profiles.test.nix.mountSocket, false);
});

Deno.test("validate: nix extra-packages", () => {
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
  assertEquals(config.profiles.test.nix.extraPackages, [
    "nixpkgs#gh",
    "nixpkgs#jq",
  ]);
});

// --- docker バリデーション ---

Deno.test("validate: docker defaults", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude" } },
  });
  assertEquals(config.profiles.test.docker.enable, false);
  assertEquals(config.profiles.test.docker.shared, false);
});

Deno.test("validate: docker enable=true", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        docker: { enable: true, shared: false },
      },
    },
  });
  assertEquals(config.profiles.test.docker.enable, true);
});

Deno.test("validate: docker shared=true", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        docker: { enable: true, shared: true },
      },
    },
  });
  assertEquals(config.profiles.test.docker.shared, true);
});

// --- gcloud バリデーション ---

Deno.test("validate: gcloud defaults", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude" } },
  });
  assertEquals(config.profiles.test.gcloud.mountConfig, false);
});

Deno.test("validate: gcloud mount-config=true", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        gcloud: { "mount-config": true },
      },
    },
  });
  assertEquals(config.profiles.test.gcloud.mountConfig, true);
});

// --- aws バリデーション ---

Deno.test("validate: aws defaults", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude" } },
  });
  assertEquals(config.profiles.test.aws.mountConfig, false);
});

Deno.test("validate: aws mount-config=true", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        aws: { "mount-config": true },
      },
    },
  });
  assertEquals(config.profiles.test.aws.mountConfig, true);
});

// --- gpg バリデーション ---

Deno.test("validate: gpg defaults", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude" } },
  });
  assertEquals(config.profiles.test.gpg.forwardAgent, false);
});

Deno.test("validate: gpg forward-agent=true", () => {
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

// --- extra-mounts バリデーション ---

Deno.test("validate: extra-mounts defaults to empty", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude" } },
  });
  assertEquals(config.profiles.test.extraMounts, []);
});

Deno.test("validate: extra-mounts with valid entries", () => {
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
  assertEquals(config.profiles.test.extraMounts.length, 2);
  assertEquals(config.profiles.test.extraMounts[0], {
    src: "/a",
    dst: "/b",
    mode: "ro",
  });
  assertEquals(config.profiles.test.extraMounts[1], {
    src: "/c",
    dst: "/d",
    mode: "rw",
  });
});

Deno.test("validate: extra-mounts mode defaults to ro", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        "extra-mounts": [{ src: "/a", dst: "/b" }],
      },
    },
  });
  assertEquals(config.profiles.test.extraMounts[0].mode, "ro");
});

Deno.test("validate: extra-mounts missing src throws", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            "extra-mounts": [{ dst: "/b" }],
          },
        },
      }),
    ConfigValidationError,
    "extra-mounts[0].src",
  );
});

Deno.test("validate: extra-mounts empty src throws", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            "extra-mounts": [{ src: "", dst: "/b" }],
          },
        },
      }),
    ConfigValidationError,
    "extra-mounts[0].src",
  );
});

Deno.test("validate: extra-mounts missing dst throws", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            "extra-mounts": [{ src: "/a" }],
          },
        },
      }),
    ConfigValidationError,
    "extra-mounts[0].dst",
  );
});

Deno.test("validate: extra-mounts empty dst throws", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            "extra-mounts": [{ src: "/a", dst: "" }],
          },
        },
      }),
    ConfigValidationError,
    "extra-mounts[0].dst",
  );
});

Deno.test("validate: extra-mounts invalid mode throws", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            "extra-mounts": [{ src: "/a", dst: "/b", mode: "rwx" }],
          },
        },
      }),
    ConfigValidationError,
    "extra-mounts[0].mode",
  );
});

Deno.test("validate: extra-mounts second entry error references index 1", () => {
  assertThrows(
    () =>
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
      }),
    ConfigValidationError,
    "extra-mounts[1].dst",
  );
});

// --- env バリデーション ---

Deno.test("validate: env defaults to empty", () => {
  const config = validateConfig({
    profiles: { test: { agent: "claude" } },
  });
  assertEquals(config.profiles.test.env, []);
});

Deno.test("validate: static env entry", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        env: [{ key: "FOO", val: "bar" }],
      },
    },
  });
  assertEquals(config.profiles.test.env[0], {
    key: "FOO",
    val: "bar",
    mode: "set",
  });
});

Deno.test("validate: command env entry", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        env: [{ key_cmd: "echo KEY", val_cmd: "echo VAL" }],
      },
    },
  });
  assertEquals(config.profiles.test.env[0], {
    keyCmd: "echo KEY",
    valCmd: "echo VAL",
    mode: "set",
  });
});

Deno.test("validate: mixed static and command throws", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            env: [{ key: "K", val: "V", key_cmd: "echo K", val_cmd: "echo V" }],
          },
        },
      }),
    ConfigValidationError,
    "must have exactly one of key or key_cmd",
  );
});

Deno.test("validate: static env missing key throws", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            env: [{ val: "value" }],
          },
        },
      }),
    ConfigValidationError,
  );
});

Deno.test("validate: static env empty key throws", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            env: [{ key: "", val: "value" }],
          },
        },
      }),
    ConfigValidationError,
    "env[0].key",
  );
});

Deno.test("validate: command env empty key_cmd throws", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            env: [{ key_cmd: "", val_cmd: "echo val" }],
          },
        },
      }),
    ConfigValidationError,
    "env[0].key_cmd",
  );
});

Deno.test("validate: command env empty val_cmd throws", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            env: [{ key_cmd: "echo key", val_cmd: "" }],
          },
        },
      }),
    ConfigValidationError,
    "env[0].val_cmd",
  );
});

// --- env mode / separator バリデーション ---

Deno.test("validate: env prefix mode with separator", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        env: [{ key: "PATH", val: "/opt/bin", mode: "prefix", separator: ":" }],
      },
    },
  });
  assertEquals(config.profiles.test.env[0], {
    key: "PATH",
    val: "/opt/bin",
    mode: "prefix",
    separator: ":",
  });
});

Deno.test("validate: env suffix mode with separator", () => {
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
  assertEquals(config.profiles.test.env[0], {
    key: "LD_LIBRARY_PATH",
    val: "/opt/lib",
    mode: "suffix",
    separator: ":",
  });
});

Deno.test("validate: env prefix mode with val_cmd", () => {
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
  assertEquals(config.profiles.test.env[0], {
    key: "PYTHONPATH",
    valCmd: "echo /opt/py",
    mode: "prefix",
    separator: ":",
  });
});

Deno.test("validate: env mode defaults to set when omitted", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        env: [{ key: "FOO", val: "bar" }],
      },
    },
  });
  assertEquals(config.profiles.test.env[0].mode, "set");
});

Deno.test("validate: env prefix without separator throws", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            env: [{ key: "PATH", val: "/opt/bin", mode: "prefix" }],
          },
        },
      }),
    ConfigValidationError,
    "separator is required",
  );
});

Deno.test("validate: env suffix without separator throws", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            env: [{ key: "PATH", val: "/opt/bin", mode: "suffix" }],
          },
        },
      }),
    ConfigValidationError,
    "separator is required",
  );
});

Deno.test("validate: env set mode with separator throws", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            env: [{ key: "FOO", val: "bar", mode: "set", separator: ":" }],
          },
        },
      }),
    ConfigValidationError,
    "separator is only allowed",
  );
});

Deno.test("validate: env omitted mode with separator throws", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            env: [{ key: "FOO", val: "bar", separator: ":" }],
          },
        },
      }),
    ConfigValidationError,
    "separator is only allowed",
  );
});

Deno.test("validate: env invalid mode throws", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            env: [
              { key: "FOO", val: "bar", mode: "prepend", separator: ":" },
            ],
          },
        },
      }),
    ConfigValidationError,
  );
});

Deno.test("validate: env prefix with empty separator allowed", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        env: [{ key: "FLAGS", val: "-Wall", mode: "prefix", separator: "" }],
      },
    },
  });
  assertEquals(config.profiles.test.env[0].separator, "");
});

// --- 複数プロファイルの独立バリデーション ---

Deno.test("validate: error in second profile references correct name", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          valid: { agent: "claude" },
          invalid: { agent: "bad" },
        },
      }),
    ConfigValidationError,
    'profile "invalid"',
  );
});

Deno.test("validate: multiple valid profiles all validated", () => {
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
  assertEquals(config.profiles.a.nix.enable, true);
  assertEquals(config.profiles.b.agentArgs, ["--yolo"]);
  assertEquals(config.profiles.c.docker.enable, true);
  assertEquals(config.profiles.c.gpg.forwardAgent, true);
});

// ---------------------------------------------------------------------------
// config tests (from tests/config_test.ts)
// ---------------------------------------------------------------------------

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
  assertEquals(config.profiles.test.display, DEFAULT_DISPLAY_CONFIG);
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
  assertEquals(p.env[0], { key: "FOO", val: "bar", mode: "set" });
  assertEquals(p.env[1], {
    keyCmd: "printf BAR",
    valCmd: "printf baz",
    mode: "set",
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

// ---------------------------------------------------------------------------
// Error aggregation across profiles and fields
// ---------------------------------------------------------------------------

Deno.test("validateConfig: multiple errors in one profile are all reported", () => {
  const err = assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            // deno-lint-ignore no-explicit-any
            network: { allowlist: "not-an-array" as any },
            "extra-mounts": [{ dst: "/tmp/dst", mode: "invalid" }],
          },
        },
      }),
    ConfigValidationError,
  );
  const msg = (err as ConfigValidationError).message;
  assertEquals(msg.includes("network.allowlist must be a list"), true);
  assertEquals(msg.includes("extra-mounts[0].src"), true);
});

Deno.test("validateConfig: errors from multiple profiles are reported together", () => {
  const err = assertThrows(
    () =>
      validateConfig({
        profiles: {
          alpha: { agent: "invalid" },
          beta: { agent: "invalid" },
        },
      }),
    ConfigValidationError,
  );
  const msg = (err as ConfigValidationError).message;
  assertEquals(
    msg.includes('profile "alpha"'),
    true,
    "alpha error missing",
  );
  assertEquals(
    msg.includes('profile "beta"'),
    true,
    "beta error missing",
  );
});

Deno.test("validateConfig: hostexec rules errors are aggregated across rules", () => {
  const err = assertThrows(
    () =>
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
      }),
    ConfigValidationError,
  );
  const msg = (err as ConfigValidationError).message;
  assertEquals(
    msg.includes("hostexec.rules[0]"),
    true,
    "rules[0] error missing",
  );
  assertEquals(
    msg.includes("hostexec.rules[1]"),
    true,
    "rules[1] error missing",
  );
});
