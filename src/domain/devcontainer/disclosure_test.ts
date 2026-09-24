import { expect, test } from "bun:test";
import type {
  AgentCredentialsMode,
  HostExecRule,
  Profile,
} from "../../config/types.ts";
import * as defaults from "../../config/types.ts";
import { describeDevcontainerSharing } from "./disclosure.ts";
import { devcontainerProfile } from "./fixtures.ts";

function detail(profile: Profile, topic: string): string {
  const found = describeDevcontainerSharing(profile).find(
    (entry) => entry.topic === topic,
  );
  if (!found) throw new Error(`no disclosure for ${topic}`);
  return found.detail;
}

test("direnv is disclosed either way, because reading .envrc is not expected of a Dev Container", () => {
  const off = { ...devcontainerProfile(), direnv: { enable: false } };
  expect(detail(off, "direnv")).toContain("does not evaluate");
  const on = { ...off, direnv: { enable: true } };
  expect(detail(on, "direnv")).toContain("evaluates the workspace .envrc");
  expect(detail(on, "direnv")).toContain("allowed on the host");
});

test("the network fallback is named in the terms the user set it in", () => {
  const profile = devcontainerProfile();
  expect(
    detail(
      { ...profile, network: { ...profile.network, fallback: "deny" } },
      "network",
    ),
  ).toContain("denied");
  expect(
    detail(
      { ...profile, network: { ...profile.network, fallback: "review" } },
      "network",
    ),
  ).toContain("approval");
});

test("host command execution counts the rules that allow it", () => {
  const profile = devcontainerProfile();
  expect(detail(profile, "host commands")).toBe("disabled");

  const rule = (id: string): HostExecRule => ({
    id,
    match: { argv0: id },
    cwd: defaults.DEFAULT_HOSTEXEC_CWD_CONFIG,
    env: {},
    inheritEnv: defaults.DEFAULT_HOSTEXEC_INHERIT_ENV_CONFIG,
    approval: "prompt",
    fallback: "container",
  });
  const hostexec = {
    installScript: true,
    prompt: defaults.DEFAULT_HOSTEXEC_PROMPT_CONFIG,
    secrets: {},
    rules: [rule("gpg")],
  };
  expect(detail({ ...profile, hostexec }, "host commands")).toBe(
    "allowed within 1 rule from the profile",
  );
  expect(
    detail(
      {
        ...profile,
        hostexec: { ...hostexec, rules: [rule("gpg"), rule("x")] },
      },
      "host commands",
    ),
  ).toBe("allowed within 2 rules from the profile");
});

test("extra mounts are listed with their direction", () => {
  const profile = devcontainerProfile();
  const withMounts: Profile = {
    ...profile,
    extraMounts: [
      { src: "~/nix-config", dst: "~/nix-config", mode: "ro" },
      { src: "/tmp", dst: "/tmp", mode: "rw" },
    ],
  };
  const mounts = describeDevcontainerSharing(withMounts)
    .filter((entry) => entry.topic === "extra mount")
    .map((entry) => entry.detail);
  expect(mounts).toEqual([
    "~/nix-config -> ~/nix-config (read-only)",
    "/tmp -> /tmp (read-write)",
  ]);
});

test("an enabled DinD sidecar is disclosed with its lifetime", () => {
  const profile = devcontainerProfile();
  const found = describeDevcontainerSharing(profile).find(
    (entry) => entry.topic === "docker",
  );
  expect(found).toBeUndefined();

  const detailText = detail(
    { ...profile, docker: { ...profile.docker, enable: true } },
    "docker",
  );
  expect(detailText).toContain("rootless");
  expect(detailText).toContain("removed on down");
});

test("the credentials shared from the host home are always disclosed", () => {
  // These outlive the container, which is the part a Dev Container user has
  // no reason to assume.
  const detailText = detail(devcontainerProfile(), "Claude credentials");
  expect(detailText).toContain("~/.claude");
  expect(detailText).toContain("after down");
});

test("describeDevcontainerSharing: proxied Claude credentials are not described as shared", () => {
  const lines = describeDevcontainerSharing(devcontainerProfile());
  const text = JSON.stringify(lines);
  expect(text).not.toMatch(/Claude credentials[^"]*read-write/);
  expect(text).toMatch(/injected by the proxy/);
});

test("describeDevcontainerSharing: Claude credentials shared for API-key profiles are described as shared", () => {
  const profile = {
    ...devcontainerProfile(),
    agentState: {
      ...devcontainerProfile().agentState,
      auth: "shared" as const,
    },
  };
  const text = detail(profile, "Claude credentials");
  expect(text).not.toMatch(/injected by the proxy/);
  expect(text).toContain("~/.claude and ~/.claude.json, read-write");
});

test("describeDevcontainerSharing: Claude credentials text is pinned for each auth x protectSettings combination", () => {
  const cases: ReadonlyArray<readonly [AgentCredentialsMode, boolean, string]> =
    [
      [
        "proxy",
        false,
        "credentials stay on the host and are injected by the proxy; the container sees a dummy credentials file; ~/.claude.json and the ~/.claude entries present on the host at session start, read-write and kept on the host after down; top-level ~/.claude entries created in the container, session-private and discarded on down",
      ],
      [
        "proxy",
        true,
        "credentials stay on the host and are injected by the proxy; the container sees a dummy credentials file; history, projects (including auto memory), and ~/.claude.json shared read-write; other host ~/.claude configuration read-only; logs and caches session-private; shared state kept on the host after down",
      ],
      [
        "shared",
        false,
        "host ~/.claude and ~/.claude.json, read-write; kept on the host after down",
      ],
      [
        "shared",
        true,
        "host Claude credentials, history, projects (including auto memory), and ~/.claude.json shared read-write; other host ~/.claude configuration read-only; logs and caches session-private; shared state kept on the host after down",
      ],
    ];
  for (const [auth, protectSettings, expected] of cases) {
    const profile = {
      ...devcontainerProfile(),
      agentState: { protectSettings, auth },
    };
    expect(detail(profile, "Claude credentials")).toBe(expected);
  }
});

test("protected Claude state discloses both writable sharing and private runtime data", () => {
  const profile = {
    ...devcontainerProfile(),
    agentState: { protectSettings: true },
  };
  const text = detail(profile, "Claude credentials");
  expect(text).toContain("auto memory");
  expect(text).toContain("~/.claude.json shared read-write");
  expect(text).toContain("configuration read-only");
  expect(text).toContain("logs and caches session-private");
});

test("codex disclosure names the shared ~/.codex directory", () => {
  const sharing = describeDevcontainerSharing({
    ...devcontainerProfile(),
    agent: "codex",
  });
  const credentials = sharing.find((entry) =>
    entry.topic.includes("credentials"),
  );
  expect(credentials).toEqual({
    topic: "Codex credentials",
    detail: "host ~/.codex, read-write; kept on the host after down",
  });
});

test("codex disclosure warns that cliExecutable is a development-only hook", () => {
  const codex = describeDevcontainerSharing({
    ...devcontainerProfile(),
    agent: "codex",
  });
  expect(codex.find((entry) => entry.topic === "Codex extension")).toEqual({
    topic: "Codex extension",
    detail:
      "chatgpt.cliExecutable is redirected to nas's wrapper — a development-only hook that extension updates may change",
  });
  expect(
    describeDevcontainerSharing(devcontainerProfile()).find(
      (entry) => entry.topic === "Codex extension",
    ),
  ).toBeUndefined();
});

test("protected Codex state keeps config.toml read-only over the shared directory", () => {
  const text = detail(
    {
      ...devcontainerProfile(),
      agent: "codex",
      agentState: { protectSettings: true },
    },
    "Codex credentials",
  );
  expect(text).toContain("~/.codex");
  expect(text).toContain("read-write");
  expect(text).toContain("config.toml");
  expect(text).toContain("read-only");
});
