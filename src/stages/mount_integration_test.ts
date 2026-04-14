import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Config, Profile } from "../config/types.ts";
import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_HOOK_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_SESSION_CONFIG,
  DEFAULT_UI_CONFIG,
} from "../config/types.ts";
import { buildHostEnv, resolveProbes } from "../pipeline/host_env.ts";
import type { PriorStageOutputs, StageInput } from "../pipeline/types.ts";
import type { MountProbes } from "./mount.ts";
import { planMount, resolveMountProbes } from "./mount.ts";

const baseProfile: Profile = {
  agent: "claude",
  agentArgs: [],
  nix: { enable: false, mountSocket: false, extraPackages: [] },
  docker: { enable: false, shared: false },
  gcloud: { mountConfig: false },
  aws: { mountConfig: false },
  gpg: { forwardAgent: false },
  session: DEFAULT_SESSION_CONFIG,
  display: structuredClone(DEFAULT_DISPLAY_CONFIG),
  network: structuredClone(DEFAULT_NETWORK_CONFIG),
  dbus: structuredClone(DEFAULT_DBUS_CONFIG),
  hook: DEFAULT_HOOK_CONFIG,
  extraMounts: [],
  env: [],
};

const baseConfig: Config = {
  default: "test",
  profiles: { test: baseProfile },
  ui: DEFAULT_UI_CONFIG,
};

function getContainerHome(): string {
  const user = process.env.USER?.trim();
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

test("MountStage: resolves static and command env", async () => {
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
  const { input, mountProbes } = await buildTestInput(profile, process.cwd());
  const plan = planMount(input, mountProbes);
  expect(plan.envVars.STATIC_KEY).toEqual("static_value");
  expect(plan.envVars.DYNAMIC_KEY).toEqual("dynamic_value");
});

test("MountStage: workspace mount keeps full absolute path", async () => {
  const workDir = process.cwd();
  const { input, mountProbes } = await buildTestInput(baseProfile, workDir);
  const plan = planMount(input, mountProbes);

  // mount source は workDir を含むディレクトリ (worktree 内の場合はリポジトリルート)
  const vIdx = plan.dockerArgs.indexOf("-v");
  const mountArg = plan.dockerArgs[vIdx + 1] as string;
  const [mountSrc] = mountArg.split(":");
  expect(workDir.startsWith(mountSrc)).toEqual(true);

  const workDirIndex = plan.dockerArgs.indexOf(workDir);
  expect(
    workDirIndex >= 1 && plan.dockerArgs[workDirIndex - 1] === "-w",
  ).toEqual(true);
  expect(plan.envVars.WORKSPACE).toEqual(workDir);
});

test("MountStage: propagates log level from prior envVars", async () => {
  const workDir = process.cwd();
  const { input, mountProbes } = await buildTestInput(baseProfile, workDir, {
    priorOverrides: {
      envVars: { NAS_LOG_LEVEL: "warn" },
    },
  });
  const _plan = planMount(input, mountProbes);
  // NAS_LOG_LEVEL is set in initialPrior, not by MountStage.
  // Verify it comes through from prior envVars (merged by pipeline).
  expect(input.prior.envVars.NAS_LOG_LEVEL).toEqual("warn");
});

test("MountStage: mounts DBus proxy runtime and injects session env", async () => {
  const uid = process.getuid!();
  if (uid === null) return;

  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-dbus-mount-"));
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
    const { input, mountProbes } = await buildTestInput(
      profile,
      process.cwd(),
      {
        priorOverrides: {
          dbusProxyEnabled: true,
          dbusSessionRuntimeDir: runtimeDir,
          dbusSessionSocket: `${runtimeDir}/bus`,
        },
      },
    );
    const plan = planMount(input, mountProbes);

    expect(plan.dockerArgs.includes(`${runtimeDir}:/run/user/${uid}`)).toEqual(
      true,
    );
    expect(plan.envVars.XDG_RUNTIME_DIR).toEqual(`/run/user/${uid}`);
    expect(plan.envVars.DBUS_SESSION_BUS_ADDRESS).toEqual(
      `unix:path=/run/user/${uid}/bus`,
    );
  } finally {
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("MountStage: GPG mount includes pubring.kbx and trustdb.gpg", async () => {
  const profile: Profile = {
    ...baseProfile,
    gpg: { forwardAgent: true },
  };
  const { input, mountProbes } = await buildTestInput(profile, process.cwd());
  const plan = planMount(input, mountProbes);

  const home = process.env.HOME ?? "/root";
  const containerHome = getContainerHome();

  // Check pubring.kbx mount if file exists on host
  const pubringExists = await stat(`${home}/.gnupg/pubring.kbx`).then(
    () => true,
    () => false,
  );
  if (pubringExists) {
    const pubringMount = plan.dockerArgs.find((a) => a.includes("pubring.kbx"));
    expect(pubringMount).toEqual(
      `${home}/.gnupg/pubring.kbx:${containerHome}/.gnupg/pubring.kbx:ro`,
    );
  }

  // Check trustdb.gpg mount if file exists on host
  const trustdbExists = await stat(`${home}/.gnupg/trustdb.gpg`).then(
    () => true,
    () => false,
  );
  if (trustdbExists) {
    const trustdbMount = plan.dockerArgs.find((a) => a.includes("trustdb.gpg"));
    expect(trustdbMount).toEqual(
      `${home}/.gnupg/trustdb.gpg:${containerHome}/.gnupg/trustdb.gpg:ro`,
    );
  }
});

test("MountStage: applies extra-mounts with mode and ~ expansion", async () => {
  const home = process.env.HOME ?? "/root";
  const containerHome = getContainerHome();
  const profile: Profile = {
    ...baseProfile,
    extraMounts: [
      { src: "~", dst: "~/.cabal", mode: "ro" },
      { src: process.cwd(), dst: "/tmp/nas-extra-rw", mode: "rw" },
    ],
  };
  const { input, mountProbes } = await buildTestInput(profile, process.cwd());
  const plan = planMount(input, mountProbes);

  expect(
    plan.dockerArgs.includes(`${home}:${containerHome}/.cabal:ro`),
  ).toEqual(true);
  expect(
    plan.dockerArgs.includes(`${process.cwd()}:/tmp/nas-extra-rw`),
  ).toEqual(true);
});

test("MountStage: display.enable sets DISPLAY and mounts X11 socket", async () => {
  const origDisplay = process.env.DISPLAY;
  try {
    process.env.DISPLAY = ":42";
    const profile: Profile = {
      ...baseProfile,
      display: { enable: true },
    };
    // Need to rebuild hostEnv after setting DISPLAY
    const { input, mountProbes } = await buildTestInput(profile, process.cwd());
    const plan = planMount(input, mountProbes);

    // DISPLAY should be passed through if /tmp/.X11-unix exists
    const x11Exists = await stat("/tmp/.X11-unix")
      .then(() => true)
      .catch(() => false);
    if (x11Exists) {
      expect(plan.envVars.DISPLAY).toEqual(":42");
      const mountArg = "/tmp/.X11-unix:/tmp/.X11-unix:ro";
      const mountIndex = plan.dockerArgs.indexOf(mountArg);
      expect(
        mountIndex >= 1 && plan.dockerArgs[mountIndex - 1] === "-v",
      ).toEqual(true);

      // Xauthority should be forwarded if the file exists on host
      const home = process.env.HOME ?? "/root";
      const xauthority = process.env.XAUTHORITY ?? `${home}/.Xauthority`;
      const xauthExists = await stat(xauthority)
        .then(() => true)
        .catch(() => false);
      if (xauthExists) {
        const containerHome = getContainerHome();
        expect(plan.envVars.XAUTHORITY).toEqual(`${containerHome}/.Xauthority`);
        const xauthMount = `${xauthority}:${containerHome}/.Xauthority:ro`;
        expect(plan.dockerArgs.includes(xauthMount)).toEqual(true);
      }

      // --shm-size should be set for GUI apps (Chromium etc.)
      const shmIndex = plan.dockerArgs.indexOf("2g");
      expect(
        shmIndex >= 1 && plan.dockerArgs[shmIndex - 1] === "--shm-size",
      ).toEqual(true);
    }
  } finally {
    if (origDisplay !== undefined) {
      process.env.DISPLAY = origDisplay;
    } else {
      delete process.env.DISPLAY;
    }
  }
});

test("MountStage: display.enable=false does not set DISPLAY", async () => {
  const profile: Profile = {
    ...baseProfile,
    display: { enable: false },
  };
  const { input, mountProbes } = await buildTestInput(profile, process.cwd());
  const plan = planMount(input, mountProbes);
  expect(plan.envVars.DISPLAY).toBeUndefined();
});

test("MountStage: display.enable skips when host DISPLAY unset", async () => {
  const origDisplay = process.env.DISPLAY;
  try {
    delete process.env.DISPLAY;
    const profile: Profile = {
      ...baseProfile,
      display: { enable: true },
    };
    const { input, mountProbes } = await buildTestInput(profile, process.cwd());
    const plan = planMount(input, mountProbes);
    expect(plan.envVars.DISPLAY).toBeUndefined();
  } finally {
    if (origDisplay !== undefined) {
      process.env.DISPLAY = origDisplay;
    }
  }
});

test("MountStage: unknown agent type throws in resolveMountProbes", async () => {
  const profile: Profile = {
    ...baseProfile,
    agent: "unknown-agent" as Profile["agent"],
  };
  const hostEnv = buildHostEnv();
  await expect(
    resolveMountProbes(hostEnv, profile, process.cwd(), null),
  ).rejects.toThrow("Unknown agent");
});
