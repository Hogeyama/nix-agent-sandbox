import { expect, test } from "bun:test";
import type { HostExecRule, Profile } from "../../config/types.ts";
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
  const off = devcontainerProfile();
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

test("the credentials shared from the host home are always disclosed", () => {
  // These outlive the container, which is the part a Dev Container user has
  // no reason to assume.
  const detailText = detail(devcontainerProfile(), "Claude credentials");
  expect(detailText).toContain("~/.claude");
  expect(detailText).toContain("after down");
});
