import { assertEquals, assertRejects } from "@std/assert";
import { MountStage, serializeNixExtraPackages } from "../src/stages/mount.ts";
import { createContext } from "../src/pipeline/context.ts";
import type { Config, Profile } from "../src/config/types.ts";

const baseProfile: Profile = {
  agent: "claude",
  agentArgs: [],
  nix: { enable: false, mountSocket: false, extraPackages: [] },
  docker: { mountSocket: false },
  gcloud: { mountConfig: false },
  aws: { mountConfig: false },
  gpg: { forwardAgent: false },
  env: [],
};

const baseConfig: Config = {
  default: "test",
  profiles: { test: baseProfile },
};

Deno.test("MountStage: resolves static and command env", async () => {
  const profile: Profile = {
    ...baseProfile,
    env: [
      { key: "STATIC_KEY", val: "static_value" },
      {
        keyCmd: "printf DYNAMIC_KEY",
        valCmd: "printf dynamic_value",
      },
    ],
  };
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = await new MountStage().execute(ctx);
  assertEquals(result.envVars["STATIC_KEY"], "static_value");
  assertEquals(result.envVars["DYNAMIC_KEY"], "dynamic_value");
});

Deno.test("MountStage: invalid dynamic key throws", async () => {
  const profile: Profile = {
    ...baseProfile,
    env: [{
      keyCmd: "printf INVALID-KEY",
      valCmd: "printf dynamic_value",
    }],
  };
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  await assertRejects(
    () => new MountStage().execute(ctx),
    Error,
    "Invalid env var name",
  );
});

Deno.test("MountStage: GPG mount includes pubring.kbx and trustdb.gpg", async () => {
  const profile: Profile = {
    ...baseProfile,
    gpg: { forwardAgent: true },
  };
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = await new MountStage().execute(ctx);

  const home = Deno.env.get("HOME") ?? "/root";

  // Check pubring.kbx mount if file exists on host
  const pubringExists = await Deno.stat(`${home}/.gnupg/pubring.kbx`).then(
    () => true,
    () => false,
  );
  if (pubringExists) {
    const pubringMount = result.dockerArgs.find((a) =>
      a.includes("pubring.kbx")
    );
    assertEquals(
      pubringMount,
      `${home}/.gnupg/pubring.kbx:/home/nas/.gnupg/pubring.kbx:ro`,
    );
  }

  // Check trustdb.gpg mount if file exists on host
  const trustdbExists = await Deno.stat(`${home}/.gnupg/trustdb.gpg`).then(
    () => true,
    () => false,
  );
  if (trustdbExists) {
    const trustdbMount = result.dockerArgs.find((a) =>
      a.includes("trustdb.gpg")
    );
    assertEquals(
      trustdbMount,
      `${home}/.gnupg/trustdb.gpg:/home/nas/.gnupg/trustdb.gpg:ro`,
    );
  }
});

Deno.test("serializeNixExtraPackages: returns newline-delimited list", () => {
  const serialized = serializeNixExtraPackages([
    "nixpkgs#gh",
    "  nixpkgs#ripgrep  ",
    "",
    "   ",
  ]);
  assertEquals(serialized, "nixpkgs#gh\nnixpkgs#ripgrep");
});

Deno.test("serializeNixExtraPackages: returns null for empty list", () => {
  assertEquals(serializeNixExtraPackages(["", "   "]), null);
});
