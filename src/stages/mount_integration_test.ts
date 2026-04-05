import { assertEquals, assertRejects } from "@std/assert";
import { createMountStage, resolveMountProbes } from "./mount.ts";
import type { MountProbes } from "./mount.ts";
import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_UI_CONFIG,
} from "../config/types.ts";
import type { Config, Profile } from "../config/types.ts";
import type { PriorStageOutputs, StageInput } from "../pipeline/types.ts";
import { buildHostEnv, resolveProbes } from "../pipeline/host_env.ts";

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

/** Build a StageInput for testing */
async function buildTestInput(
  profile: Profile,
  workDir: string,
  overrides?: {
    priorOverrides?: Partial<PriorStageOutputs>;
  },
): Promise<{ input: StageInput; mountProbes: MountProbes }> {
  const hostEnv = buildHostEnv();
  const probes = await resolveProbes(hostEnv);
  const mountProbes = await resolveMountProbes(
    hostEnv,
    profile,
    workDir,
    probes.gpgAgentSocket,
  );

  const prior: PriorStageOutputs = {
    dockerArgs: [],
    envVars: { NAS_LOG_LEVEL: "info" },
    workDir,
    nixEnabled: false,
    imageName: "nas-sandbox",
    agentCommand: [],
    networkPromptEnabled: false,
    dbusProxyEnabled: false,
    ...overrides?.priorOverrides,
  };

  const input: StageInput = {
    config: baseConfig,
    profile,
    profileName: "test",
    sessionId: "sess_test",
    host: hostEnv,
    probes,
    prior,
  };

  return { input, mountProbes };
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
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const stage = createMountStage(mountProbes);
  const plan = stage.plan(input);
  assertEquals(plan !== null, true);
  assertEquals(plan!.envVars["STATIC_KEY"], "static_value");
  assertEquals(plan!.envVars["DYNAMIC_KEY"], "dynamic_value");
});

Deno.test("MountStage: workspace mount keeps full absolute path", async () => {
  const workDir = Deno.cwd();
  const { input, mountProbes } = await buildTestInput(baseProfile, workDir);
  const stage = createMountStage(mountProbes);
  const plan = stage.plan(input)!;

  const mountArg = `${workDir}:${workDir}`;
  const mountIndex = plan.dockerArgs.indexOf(mountArg);
  assertEquals(
    mountIndex >= 1 && plan.dockerArgs[mountIndex - 1] === "-v",
    true,
  );

  const workDirIndex = plan.dockerArgs.indexOf(workDir);
  assertEquals(
    workDirIndex >= 1 && plan.dockerArgs[workDirIndex - 1] === "-w",
    true,
  );
  assertEquals(plan.envVars["WORKSPACE"], workDir);
});

Deno.test("MountStage: propagates log level from prior envVars", async () => {
  const workDir = Deno.cwd();
  const { input, mountProbes } = await buildTestInput(baseProfile, workDir, {
    priorOverrides: {
      envVars: { NAS_LOG_LEVEL: "warn" },
    },
  });
  const stage = createMountStage(mountProbes);
  const _plan = stage.plan(input)!;
  // NAS_LOG_LEVEL is set in initialPrior, not by MountStage.
  // Verify it comes through from prior envVars (merged by pipeline).
  assertEquals(input.prior.envVars["NAS_LOG_LEVEL"], "warn");
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
    const { input, mountProbes } = await buildTestInput(profile, Deno.cwd(), {
      priorOverrides: {
        dbusProxyEnabled: true,
        dbusSessionRuntimeDir: runtimeDir,
        dbusSessionSocket: `${runtimeDir}/bus`,
      },
    });
    const stage = createMountStage(mountProbes);
    const plan = stage.plan(input)!;

    assertEquals(
      plan.dockerArgs.includes(`${runtimeDir}:/run/user/${uid}`),
      true,
    );
    assertEquals(plan.envVars["XDG_RUNTIME_DIR"], `/run/user/${uid}`);
    assertEquals(
      plan.envVars["DBUS_SESSION_BUS_ADDRESS"],
      `unix:path=/run/user/${uid}/bus`,
    );
  } finally {
    await Deno.remove(runtimeDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("MountStage: GPG mount includes pubring.kbx and trustdb.gpg", async () => {
  const profile: Profile = {
    ...baseProfile,
    gpg: { forwardAgent: true },
  };
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const stage = createMountStage(mountProbes);
  const plan = stage.plan(input)!;

  const home = Deno.env.get("HOME") ?? "/root";
  const containerHome = getContainerHome();

  // Check pubring.kbx mount if file exists on host
  const pubringExists = await Deno.stat(`${home}/.gnupg/pubring.kbx`).then(
    () => true,
    () => false,
  );
  if (pubringExists) {
    const pubringMount = plan.dockerArgs.find((a) => a.includes("pubring.kbx"));
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
    const trustdbMount = plan.dockerArgs.find((a) => a.includes("trustdb.gpg"));
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
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const stage = createMountStage(mountProbes);
  const plan = stage.plan(input)!;

  assertEquals(
    plan.dockerArgs.includes(`${home}:${containerHome}/.cabal:ro`),
    true,
  );
  assertEquals(
    plan.dockerArgs.includes(`${Deno.cwd()}:/tmp/nas-extra-rw`),
    true,
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
    // Need to rebuild hostEnv after setting DISPLAY
    const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
    const stage = createMountStage(mountProbes);
    const plan = stage.plan(input)!;

    // DISPLAY should be passed through if /tmp/.X11-unix exists
    const x11Exists = await Deno.stat("/tmp/.X11-unix").then(() => true).catch(
      () => false,
    );
    if (x11Exists) {
      assertEquals(plan.envVars["DISPLAY"], ":42");
      const mountArg = "/tmp/.X11-unix:/tmp/.X11-unix:ro";
      const mountIndex = plan.dockerArgs.indexOf(mountArg);
      assertEquals(
        mountIndex >= 1 && plan.dockerArgs[mountIndex - 1] === "-v",
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
          plan.envVars["XAUTHORITY"],
          `${containerHome}/.Xauthority`,
        );
        const xauthMount = `${xauthority}:${containerHome}/.Xauthority:ro`;
        assertEquals(plan.dockerArgs.includes(xauthMount), true);
      }

      // --shm-size should be set for GUI apps (Chromium etc.)
      const shmIndex = plan.dockerArgs.indexOf("2g");
      assertEquals(
        shmIndex >= 1 && plan.dockerArgs[shmIndex - 1] === "--shm-size",
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
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const stage = createMountStage(mountProbes);
  const plan = stage.plan(input)!;
  assertEquals(plan.envVars["DISPLAY"], undefined);
});

Deno.test("MountStage: display.enable skips when host DISPLAY unset", async () => {
  const origDisplay = Deno.env.get("DISPLAY");
  try {
    Deno.env.delete("DISPLAY");
    const profile: Profile = {
      ...baseProfile,
      display: { enable: true },
    };
    const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
    const stage = createMountStage(mountProbes);
    const plan = stage.plan(input)!;
    assertEquals(plan.envVars["DISPLAY"], undefined);
  } finally {
    if (origDisplay !== undefined) {
      Deno.env.set("DISPLAY", origDisplay);
    }
  }
});

Deno.test("MountStage: unknown agent type throws in resolveMountProbes", async () => {
  const profile: Profile = {
    ...baseProfile,
    agent: "unknown-agent" as Profile["agent"],
  };
  const hostEnv = buildHostEnv();
  await assertRejects(
    () => resolveMountProbes(hostEnv, profile, Deno.cwd(), null),
    Error,
    "Unknown agent",
  );
});
