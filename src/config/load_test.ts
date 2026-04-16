import { expect, test } from "bun:test";
import { mergeRawConfigs, mergeRawProfiles } from "./load.ts";
import type { RawConfig, RawProfile } from "./types.ts";

test("mergeRawConfigs: global only", () => {
  const global: RawConfig = {
    default: "dev",
    profiles: { dev: { agent: "claude" } },
  };
  const result = mergeRawConfigs(global, null);
  expect(result).toEqual(global);
});

test("mergeRawConfigs: local only", () => {
  const local: RawConfig = {
    default: "prod",
    profiles: { prod: { agent: "copilot" } },
  };
  const result = mergeRawConfigs(null, local);
  expect(result).toEqual(local);
});

test("mergeRawConfigs: local default overrides global", () => {
  const global: RawConfig = {
    default: "g",
    profiles: { g: { agent: "claude" } },
  };
  const local: RawConfig = {
    default: "l",
    profiles: { l: { agent: "copilot" } },
  };
  const result = mergeRawConfigs(global, local);
  expect(result.default).toEqual("l");
});

test("mergeRawConfigs: global default used when local has none", () => {
  const global: RawConfig = {
    default: "g",
    profiles: { g: { agent: "claude" } },
  };
  const local: RawConfig = { profiles: { l: { agent: "copilot" } } };
  const result = mergeRawConfigs(global, local);
  expect(result.default).toEqual("g");
});

test("mergeRawConfigs: profiles from both sides are included", () => {
  const global: RawConfig = { profiles: { a: { agent: "claude" } } };
  const local: RawConfig = { profiles: { b: { agent: "copilot" } } };
  const result = mergeRawConfigs(global, local);
  expect(Object.keys(result.profiles!).sort()).toEqual(["a", "b"]);
});

test("mergeRawConfigs: same-name profile fields are merged", () => {
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
  const p = result.profiles!.dev;
  expect(p.agent).toEqual("claude"); // from global
  expect(p.nix?.enable).toEqual(true); // from global
  expect(p.nix?.["mount-socket"]).toEqual(true); // overridden by local
});

test("mergeRawProfiles: nested object shallow merge", () => {
  const global: RawProfile = {
    agent: "claude",
    docker: { enable: true, shared: false },
    gcloud: { "mount-config": true },
  };
  const local: RawProfile = {
    docker: { enable: false, shared: false },
  };
  const result = mergeRawProfiles(global, local);
  expect(result.agent).toEqual("claude");
  expect(result.docker?.enable).toEqual(false);
  expect(result.gcloud?.["mount-config"]).toEqual(true); // from global
});

test("mergeRawProfiles: array fields use local replacement", () => {
  const global: RawProfile = {
    agent: "claude",
    "agent-args": ["--global-flag"],
    env: [{ key: "G", val: "1" }],
  };
  const local: RawProfile = {
    "agent-args": ["--local-flag"],
  };
  const result = mergeRawProfiles(global, local);
  expect(result["agent-args"]).toEqual(["--local-flag"]); // replaced, not merged
  expect(result.env).toEqual([{ key: "G", val: "1" }]); // env from global (local undefined)
});

test("mergeRawProfiles: local env replaces global env", () => {
  const global: RawProfile = {
    agent: "claude",
    env: [{ key: "G", val: "1" }],
  };
  const local: RawProfile = {
    env: [{ key: "L", val: "2" }],
  };
  const result = mergeRawProfiles(global, local);
  expect(result.env).toEqual([{ key: "L", val: "2" }]);
});

test("mergeRawProfiles: worktree shallow merge", () => {
  const global: RawProfile = {
    agent: "claude",
    worktree: { base: "origin/main", "on-create": "npm ci" },
  };
  const local: RawProfile = {
    worktree: { "on-create": "yarn install" },
  };
  const result = mergeRawProfiles(global, local);
  expect(result.worktree?.base).toEqual("origin/main"); // from global
  expect(result.worktree?.["on-create"]).toEqual("yarn install"); // overridden
});

test("mergeRawProfiles: aws shallow merge", () => {
  const global: RawProfile = {
    agent: "claude",
    aws: { "mount-config": true },
  };
  const local: RawProfile = {
    aws: { "mount-config": false },
  };
  const result = mergeRawProfiles(global, local);
  expect(result.aws?.["mount-config"]).toEqual(false);
});

test("mergeRawProfiles: display shallow merge", () => {
  const global: RawProfile = {
    agent: "claude",
    display: { enable: true },
  };
  const local: RawProfile = {};
  const result = mergeRawProfiles(global, local);
  expect(result.display?.enable).toEqual(true);

  const result2 = mergeRawProfiles(local, global);
  expect(result2.display?.enable).toEqual(true);
});

test("mergeRawProfiles: all RawProfile keys are preserved", () => {
  // Guard against forgetting to add new fields to mergeRawProfiles.
  // When a new field is added to RawProfile, add it here too.
  const full: Required<RawProfile> = {
    agent: "claude",
    "agent-args": ["--flag"],
    worktree: { base: "main" },
    session: { enable: false },
    nix: { enable: true },
    docker: { enable: true },
    gcloud: { "mount-config": true },
    aws: { "mount-config": true },
    gpg: { "forward-agent": true },
    display: { enable: true },
    network: {
      allowlist: ["example.com"],
      proxy: { "forward-ports": [8080] },
    },
    dbus: { session: { enable: true } },
    "extra-mounts": [{ src: "/a", dst: "/b" }],
    env: [{ key: "K", val: "V" }],
    hostexec: { rules: [] },
    hook: { notify: "auto" },
  };
  const result = mergeRawProfiles(full, {});
  for (const key of Object.keys(full) as (keyof RawProfile)[]) {
    expect(result[key] !== undefined).toEqual(true);
  }
});

test("mergeRawProfiles: network.prompt subfields are preserved", () => {
  const global: RawProfile = {
    agent: "claude",
    network: {
      allowlist: ["github.com"],
      prompt: {
        enable: true,
        "timeout-seconds": 300,
        "default-scope": "host-port",
        notify: "auto",
      },
    },
  };
  const local: RawProfile = {
    network: {
      prompt: {
        notify: "desktop",
      },
    },
  };
  const result = mergeRawProfiles(global, local);
  expect(result.network?.allowlist).toEqual(["github.com"]);
  expect(result.network?.prompt).toEqual({
    enable: true,
    "timeout-seconds": 300,
    "default-scope": "host-port",
    notify: "desktop",
  });
});

test("mergeRawProfiles: network.proxy subfields are preserved", () => {
  const global: RawProfile = {
    agent: "claude",
    network: {
      proxy: { "forward-ports": [8080] },
    },
  };
  const local: RawProfile = {
    network: {
      proxy: { "forward-ports": [5432] },
    },
  };
  const result = mergeRawProfiles(global, local);
  expect(result.network?.proxy).toEqual({
    "forward-ports": [5432],
  });
});

test("mergeRawProfiles: local agent overrides global", () => {
  const global: RawProfile = { agent: "claude" };
  const local: RawProfile = { agent: "copilot" };
  const result = mergeRawProfiles(global, local);
  expect(result.agent).toEqual("copilot");
});

test("mergeRawProfiles: local inherits global agent when not set", () => {
  const global: RawProfile = { agent: "claude" };
  const local: RawProfile = { "agent-args": ["--verbose"] };
  const result = mergeRawProfiles(global, local);
  expect(result.agent).toEqual("claude");
  expect(result["agent-args"]).toEqual(["--verbose"]);
});

test("mergeRawProfiles: nix config is shallow merged", () => {
  const global: RawProfile = {
    agent: "claude",
    nix: { enable: true, "mount-socket": false },
  };
  const local: RawProfile = {
    nix: { "mount-socket": true },
  };
  const result = mergeRawProfiles(global, local);
  expect(result.nix?.enable).toEqual(true); // from global
  expect(result.nix?.["mount-socket"]).toEqual(true); // from local
});

test("mergeRawProfiles: gpg config is shallow merged", () => {
  const global: RawProfile = {
    agent: "claude",
    gpg: { "forward-agent": false },
  };
  const local: RawProfile = {
    gpg: { "forward-agent": true },
  };
  const result = mergeRawProfiles(global, local);
  expect(result.gpg?.["forward-agent"]).toEqual(true);
});

test("mergeRawProfiles: dbus config is shallow merged", () => {
  const global: RawProfile = {
    agent: "claude",
    dbus: {
      session: {
        enable: true,
        see: ["org.freedesktop.secrets"],
      },
    },
  };
  const local: RawProfile = {
    dbus: {
      session: {
        talk: ["org.freedesktop.secrets"],
      },
    },
  };
  const result = mergeRawProfiles(global, local);
  expect(result.dbus?.session?.enable).toEqual(true);
  expect(result.dbus?.session?.see).toEqual(["org.freedesktop.secrets"]);
  expect(result.dbus?.session?.talk).toEqual(["org.freedesktop.secrets"]);
});

test("mergeRawProfiles: hostexec secrets are shallow merged", () => {
  const global: RawProfile = {
    agent: "claude",
    hostexec: {
      secrets: {
        github_token: {
          from: "env:GITHUB_TOKEN",
          required: true,
        },
      },
    },
  };
  const local: RawProfile = {
    hostexec: {
      secrets: {
        github_token: {
          from: "env:OVERRIDE_GITHUB_TOKEN",
          required: false,
        },
      },
    },
  };
  const result = mergeRawProfiles(global, local);
  expect(result.hostexec?.secrets).toEqual({
    github_token: {
      from: "env:OVERRIDE_GITHUB_TOKEN",
      required: false,
    },
  });
});

test("mergeRawConfigs: local ui overrides global ui fields", () => {
  const global: RawConfig = {
    ui: { enable: true, port: 3939, "idle-timeout": 300 },
    profiles: { dev: { agent: "claude" } },
  };
  const local: RawConfig = {
    ui: { port: 8080 },
    profiles: {},
  };
  const result = mergeRawConfigs(global, local);
  expect(result.ui).toEqual({ enable: true, port: 8080, "idle-timeout": 300 });
});
