import { assertEquals, assertRejects } from "@std/assert";
import { MountStage, serializeNixExtraPackages } from "../src/stages/mount.ts";
import { createContext } from "../src/pipeline/context.ts";
import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_UI_CONFIG,
} from "../src/config/types.ts";
import type { Config, Profile } from "../src/config/types.ts";

const baseProfile: Profile = {
  agent: "claude",
  agentArgs: [],
  nix: { enable: false, mountSocket: false, extraPackages: [] },
  docker: { enable: false, shared: false },
  gcloud: { mountConfig: false },
  aws: { mountConfig: false },
  gpg: { forwardAgent: false },
  display: structuredClone(DEFAULT_DISPLAY_CONFIG),
  network: structuredClone(DEFAULT_NETWORK_CONFIG),
  dbus: structuredClone(DEFAULT_DBUS_CONFIG),
  extraMounts: [],
  env: [],
};

const baseConfig: Config = {
  default: "test",
  profiles: { test: baseProfile },
  ui: DEFAULT_UI_CONFIG,
};

function getContainerHome(): string {
  const user = Deno.env.get("USER")?.trim();
  return `/home/${user || "nas"}`;
}

Deno.test("MountStage: resolves static and command env", async () => {
  const profile: Profile = {
    ...baseProfile,
    env: [
      { key: "STATIC_KEY", val: "static_value", mode: "set" as const },
      {
        keyCmd: "printf DYNAMIC_KEY",
        valCmd: "printf dynamic_value",
        mode: "set" as const,
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

Deno.test("MountStage: propagates log level to container", async () => {
  const ctx = createContext(
    baseConfig,
    baseProfile,
    "test",
    Deno.cwd(),
    "warn",
  );
  const result = await new MountStage().execute(ctx);
  assertEquals(result.envVars["NAS_LOG_LEVEL"], "warn");
});

Deno.test("MountStage: mounts DBus proxy runtime and injects session env", async () => {
  const uid = Deno.uid();
  if (uid === null) return;

  const runtimeDir = await Deno.makeTempDir({ prefix: "nas-dbus-mount-" });
  try {
    const profile: Profile = {
      ...baseProfile,
      dbus: {
        session: {
          enable: true,
          see: [],
          talk: [],
          own: [],
          calls: [],
          broadcasts: [],
        },
      },
    };
    const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
    ctx.dbusProxyEnabled = true;
    ctx.dbusSessionRuntimeDir = runtimeDir;
    ctx.dbusSessionSocket = `${runtimeDir}/bus`;
    const result = await new MountStage().execute(ctx);

    assertEquals(
      result.dockerArgs.includes(`${runtimeDir}:/run/user/${uid}`),
      true,
    );
    assertEquals(result.envVars["XDG_RUNTIME_DIR"], `/run/user/${uid}`);
    assertEquals(
      result.envVars["DBUS_SESSION_BUS_ADDRESS"],
      `unix:path=/run/user/${uid}/bus`,
    );
  } finally {
    await Deno.remove(runtimeDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("MountStage: invalid dynamic key throws", async () => {
  const profile: Profile = {
    ...baseProfile,
    env: [{
      keyCmd: "printf INVALID-KEY",
      valCmd: "printf dynamic_value",
      mode: "set" as const,
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

Deno.test("MountStage: relative extra-mount dst resolves from workDir", async () => {
  const profile: Profile = {
    ...baseProfile,
    extraMounts: [{ src: "/dev/null", dst: ".env", mode: "ro" }],
  };
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = await new MountStage().execute(ctx);
  assertEquals(
    result.dockerArgs.includes(`/dev/null:${Deno.cwd()}/.env:ro`),
    true,
  );
});

Deno.test("MountStage: relative extra-mount src resolves from workDir", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "nas-relative-src-" });
  const srcDir = "mount-src";
  try {
    await Deno.mkdir(`${tmpDir}/${srcDir}`);
    const profile: Profile = {
      ...baseProfile,
      extraMounts: [{ src: srcDir, dst: "/tmp/mount-src", mode: "ro" }],
    };
    const ctx = createContext(baseConfig, profile, "test", tmpDir);
    const result = await new MountStage().execute(ctx);
    assertEquals(
      result.dockerArgs.includes(`${tmpDir}/${srcDir}:/tmp/mount-src:ro`),
      true,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
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

Deno.test("MountStage: display.enable sets DISPLAY and mounts X11 socket", async () => {
  const origDisplay = Deno.env.get("DISPLAY");
  try {
    Deno.env.set("DISPLAY", ":42");
    const profile: Profile = {
      ...baseProfile,
      display: { enable: true },
    };
    const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
    const result = await new MountStage().execute(ctx);
    // DISPLAY should be passed through if /tmp/.X11-unix exists
    // (it typically does on Linux desktops; if not, DISPLAY won't be set)
    const x11Exists = await Deno.stat("/tmp/.X11-unix").then(() => true).catch(
      () => false,
    );
    if (x11Exists) {
      assertEquals(result.envVars["DISPLAY"], ":42");
      const mountArg = "/tmp/.X11-unix:/tmp/.X11-unix:ro";
      const mountIndex = result.dockerArgs.indexOf(mountArg);
      assertEquals(
        mountIndex >= 1 && result.dockerArgs[mountIndex - 1] === "-v",
        true,
      );

      // Xauthority should be forwarded if the file exists on host
      const home = Deno.env.get("HOME") ?? "/root";
      const xauthority = Deno.env.get("XAUTHORITY") ?? `${home}/.Xauthority`;
      const xauthExists = await Deno.stat(xauthority).then(() => true).catch(
        () => false,
      );
      if (xauthExists) {
        const containerHome = getContainerHome();
        assertEquals(
          result.envVars["XAUTHORITY"],
          `${containerHome}/.Xauthority`,
        );
        const xauthMount = `${xauthority}:${containerHome}/.Xauthority:ro`;
        assertEquals(result.dockerArgs.includes(xauthMount), true);
      }

      // --shm-size should be set for GUI apps (Chromium etc.)
      const shmIndex = result.dockerArgs.indexOf("2g");
      assertEquals(
        shmIndex >= 1 && result.dockerArgs[shmIndex - 1] === "--shm-size",
        true,
      );
    }
  } finally {
    if (origDisplay !== undefined) {
      Deno.env.set("DISPLAY", origDisplay);
    } else {
      Deno.env.delete("DISPLAY");
    }
  }
});

Deno.test("MountStage: display.enable=false does not set DISPLAY", async () => {
  const profile: Profile = {
    ...baseProfile,
    display: { enable: false },
  };
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = await new MountStage().execute(ctx);
  assertEquals(result.envVars["DISPLAY"], undefined);
});

Deno.test("MountStage: display.enable skips when host DISPLAY unset", async () => {
  const origDisplay = Deno.env.get("DISPLAY");
  try {
    Deno.env.delete("DISPLAY");
    const profile: Profile = {
      ...baseProfile,
      display: { enable: true },
    };
    const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
    const result = await new MountStage().execute(ctx);
    assertEquals(result.envVars["DISPLAY"], undefined);
  } finally {
    if (origDisplay !== undefined) {
      Deno.env.set("DISPLAY", origDisplay);
    }
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
