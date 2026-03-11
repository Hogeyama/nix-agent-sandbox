/**
 * E2E tests: バリデーションの網羅テスト
 *
 * validateConfig のさまざまなエッジケースを検証する。
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  ConfigValidationError,
  validateConfig,
} from "../src/config/validate.ts";
import type { RawConfig } from "../src/config/types.ts";

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
          test: null as unknown as import("../src/config/types.ts").RawProfile,
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
  assertEquals(config.profiles.test.docker.mountSocket, false);
});

Deno.test("validate: docker mount-socket=true", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        docker: { "mount-socket": true },
      },
    },
  });
  assertEquals(config.profiles.test.docker.mountSocket, true);
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
  assertEquals(config.profiles.test.env[0], { key: "FOO", val: "bar" });
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
    "must use either",
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
        docker: { "mount-socket": true },
        gpg: { "forward-agent": true },
      },
    },
  });
  assertEquals(config.profiles.a.nix.enable, true);
  assertEquals(config.profiles.b.agentArgs, ["--yolo"]);
  assertEquals(config.profiles.c.docker.mountSocket, true);
  assertEquals(config.profiles.c.gpg.forwardAgent, true);
});
