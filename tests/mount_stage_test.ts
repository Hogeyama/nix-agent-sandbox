import { assertEquals, assertRejects } from "@std/assert";
import { MountStage, serializeNixExtraPackages } from "../src/stages/mount.ts";
import { createContext } from "../src/pipeline/context.ts";
import { DEFAULT_NETWORK_CONFIG } from "../src/config/types.ts";
import type { Config, Profile } from "../src/config/types.ts";

const baseProfile: Profile = {
  agent: "claude",
  agentArgs: [],
  nix: { enable: false, mountSocket: false, extraPackages: [] },
  docker: { enable: false, shared: false },
  gcloud: { mountConfig: false },
  aws: { mountConfig: false },
  gpg: { forwardAgent: false },
  network: structuredClone(DEFAULT_NETWORK_CONFIG),
  extraMounts: [],
  env: [],
};

const baseConfig: Config = {
  default: "test",
  profiles: { test: baseProfile },
};

function getContainerHome(): string {
  const user = Deno.env.get("USER")?.trim();
  return `/home/${user || "nas"}`;
}

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

Deno.test("MountStage: workspace mount keeps full absolute path", async () => {
  const workDir = Deno.cwd();
  const ctx = createContext(baseConfig, baseProfile, "test", workDir);
  const result = await new MountStage().execute(ctx);

  const mountArg = `${workDir}:${workDir}`;
  const mountIndex = result.dockerArgs.indexOf(mountArg);
  assertEquals(
    mountIndex >= 1 && result.dockerArgs[mountIndex - 1] === "-v",
    true,
  );

  const workDirIndex = result.dockerArgs.indexOf(workDir);
  assertEquals(
    workDirIndex >= 1 && result.dockerArgs[workDirIndex - 1] === "-w",
    true,
  );
  assertEquals(result.envVars["WORKSPACE"], workDir);
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
  const containerHome = getContainerHome();

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
      `${home}/.gnupg/pubring.kbx:${containerHome}/.gnupg/pubring.kbx:ro`,
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
      `${home}/.gnupg/trustdb.gpg:${containerHome}/.gnupg/trustdb.gpg:ro`,
    );
  }
});

Deno.test("MountStage: applies extra-mounts with mode and ~ expansion", async () => {
  const home = Deno.env.get("HOME") ?? "/root";
  const containerHome = getContainerHome();
  const profile: Profile = {
    ...baseProfile,
    extraMounts: [
      { src: "~", dst: "~/.cabal", mode: "ro" },
      { src: Deno.cwd(), dst: "/tmp/nas-extra-rw", mode: "rw" },
    ],
  };
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = await new MountStage().execute(ctx);

  assertEquals(
    result.dockerArgs.includes(`${home}:${containerHome}/.cabal:ro`),
    true,
  );
  assertEquals(
    result.dockerArgs.includes(`${Deno.cwd()}:/tmp/nas-extra-rw`),
    true,
  );
});

Deno.test("MountStage: skips missing extra-mounts src", async () => {
  const profile: Profile = {
    ...baseProfile,
    extraMounts: [{
      src: `/tmp/nas-missing-${crypto.randomUUID()}`,
      dst: "/tmp/nas-missing-dst",
      mode: "ro",
    }],
  };
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = await new MountStage().execute(ctx);
  assertEquals(
    result.dockerArgs.some((arg) => arg.includes(":/tmp/nas-missing-dst")),
    false,
  );
});

Deno.test("MountStage: relative extra-mount dst throws", async () => {
  const profile: Profile = {
    ...baseProfile,
    extraMounts: [{ src: Deno.cwd(), dst: "relative/path", mode: "ro" }],
  };
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  await assertRejects(
    () => new MountStage().execute(ctx),
    Error,
    "dst must be an absolute path",
  );
});

Deno.test("MountStage: reserved extra-mount dst throws", async () => {
  const profile: Profile = {
    ...baseProfile,
    extraMounts: [{ src: Deno.cwd(), dst: "/nix", mode: "ro" }],
  };
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  await assertRejects(
    () => new MountStage().execute(ctx),
    Error,
    "conflicts with existing mount destination",
  );
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
