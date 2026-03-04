import { assertEquals } from "@std/assert";
import {
  mergeRawConfigs,
  mergeRawProfiles,
} from "../src/config/load.ts";
import type { RawConfig, RawProfile } from "../src/config/types.ts";

Deno.test("mergeRawConfigs: global only", () => {
  const global: RawConfig = {
    default: "dev",
    profiles: { dev: { agent: "claude" } },
  };
  const result = mergeRawConfigs(global, null);
  assertEquals(result, global);
});

Deno.test("mergeRawConfigs: local only", () => {
  const local: RawConfig = {
    default: "prod",
    profiles: { prod: { agent: "copilot" } },
  };
  const result = mergeRawConfigs(null, local);
  assertEquals(result, local);
});

Deno.test("mergeRawConfigs: local default overrides global", () => {
  const global: RawConfig = { default: "g", profiles: { g: { agent: "claude" } } };
  const local: RawConfig = { default: "l", profiles: { l: { agent: "copilot" } } };
  const result = mergeRawConfigs(global, local);
  assertEquals(result.default, "l");
});

Deno.test("mergeRawConfigs: global default used when local has none", () => {
  const global: RawConfig = { default: "g", profiles: { g: { agent: "claude" } } };
  const local: RawConfig = { profiles: { l: { agent: "copilot" } } };
  const result = mergeRawConfigs(global, local);
  assertEquals(result.default, "g");
});

Deno.test("mergeRawConfigs: profiles from both sides are included", () => {
  const global: RawConfig = { profiles: { a: { agent: "claude" } } };
  const local: RawConfig = { profiles: { b: { agent: "copilot" } } };
  const result = mergeRawConfigs(global, local);
  assertEquals(Object.keys(result.profiles!).sort(), ["a", "b"]);
});

Deno.test("mergeRawConfigs: same-name profile fields are merged", () => {
  const global: RawConfig = {
    profiles: {
      dev: {
        agent: "claude",
        nix: { enable: true, "mount-socket": false },
      },
    },
  };
  const local: RawConfig = {
    profiles: {
      dev: {
        nix: { "mount-socket": true },
      },
    },
  };
  const result = mergeRawConfigs(global, local);
  const p = result.profiles!["dev"];
  assertEquals(p.agent, "claude"); // from global
  assertEquals(p.nix?.enable, true); // from global
  assertEquals(p.nix?.["mount-socket"], true); // overridden by local
});

Deno.test("mergeRawProfiles: nested object shallow merge", () => {
  const global: RawProfile = {
    agent: "claude",
    docker: { "mount-socket": true },
    gcloud: { "mount-config": true },
  };
  const local: RawProfile = {
    docker: { "mount-socket": false },
  };
  const result = mergeRawProfiles(global, local);
  assertEquals(result.agent, "claude");
  assertEquals(result.docker?.["mount-socket"], false);
  assertEquals(result.gcloud?.["mount-config"], true); // from global
});

Deno.test("mergeRawProfiles: array fields use local replacement", () => {
  const global: RawProfile = {
    agent: "claude",
    "agent-args": ["--global-flag"],
    env: [{ key: "G", val: "1" }],
  };
  const local: RawProfile = {
    "agent-args": ["--local-flag"],
  };
  const result = mergeRawProfiles(global, local);
  assertEquals(result["agent-args"], ["--local-flag"]); // replaced, not merged
  assertEquals(result.env, [{ key: "G", val: "1" }]); // env from global (local undefined)
});

Deno.test("mergeRawProfiles: local env replaces global env", () => {
  const global: RawProfile = {
    agent: "claude",
    env: [{ key: "G", val: "1" }],
  };
  const local: RawProfile = {
    env: [{ key: "L", val: "2" }],
  };
  const result = mergeRawProfiles(global, local);
  assertEquals(result.env, [{ key: "L", val: "2" }]);
});

Deno.test("mergeRawProfiles: worktree shallow merge", () => {
  const global: RawProfile = {
    agent: "claude",
    worktree: { base: "origin/main", "on-create": "npm ci" },
  };
  const local: RawProfile = {
    worktree: { "on-create": "yarn install" },
  };
  const result = mergeRawProfiles(global, local);
  assertEquals(result.worktree?.base, "origin/main"); // from global
  assertEquals(result.worktree?.["on-create"], "yarn install"); // overridden
});

Deno.test("mergeRawProfiles: aws shallow merge", () => {
  const global: RawProfile = {
    agent: "claude",
    aws: { "mount-config": true },
  };
  const local: RawProfile = {
    aws: { "mount-config": false },
  };
  const result = mergeRawProfiles(global, local);
  assertEquals(result.aws?.["mount-config"], false);
});
