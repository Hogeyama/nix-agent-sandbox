import { assertEquals, assertThrows } from "@std/assert";
import {
  ConfigValidationError,
  validateConfig,
} from "../src/config/validate.ts";
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
  assertEquals(config.profiles.test.docker.mountSocket, false);
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
          "on-end": "",
        },
        nix: {
          enable: true,
          "mount-socket": true,
          "extra-packages": ["nixpkgs.ripgrep"],
        },
        docker: {
          "mount-socket": true,
        },
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
  assertEquals(p.docker.mountSocket, true);
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
    "env[0] must use either",
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
