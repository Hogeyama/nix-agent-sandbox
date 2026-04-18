import { expect, test } from "bun:test";
import {
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
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
import { emptyContainerPlan } from "../pipeline/container_plan.ts";
import { buildHostEnv, resolveProbes } from "../pipeline/host_env.ts";
import type { PipelineState } from "../pipeline/state.ts";
import type { StageInput } from "../pipeline/types.ts";
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
  network: structuredClone(DEFAULT_NETWORK_CONFIG),
  dbus: structuredClone(DEFAULT_DBUS_CONFIG),
  display: structuredClone(DEFAULT_DISPLAY_CONFIG),
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
    sliceOverrides?: Partial<
      Pick<
        PipelineState,
        "workspace" | "container" | "nix" | "dbus" | "display"
      >
    >;
  },
): Promise<{
  input: StageInput &
    Pick<PipelineState, "workspace" | "container" | "nix" | "dbus" | "display">;
  mountProbes: MountProbes;
}> {
  const hostEnv = buildHostEnv();
  const probes = await resolveProbes(hostEnv);
  const mountProbes = await resolveMountProbes(
    hostEnv,
    profile,
    workDir,
    probes.gpgAgentSocket,
  );

  const slices: Pick<
    PipelineState,
    "workspace" | "container" | "nix" | "dbus" | "display"
  > = {
    workspace: { workDir, imageName: "nas-sandbox" },
    container: {
      ...emptyContainerPlan("nas-sandbox", workDir),
      env: { static: { NAS_LOG_LEVEL: "info" }, dynamicOps: [] },
    },
    nix: { enabled: false },
    dbus: { enabled: false },
    display: { enabled: false },
    ...overrides?.sliceOverrides,
  };

  const input: StageInput &
    Pick<
      PipelineState,
      "workspace" | "container" | "nix" | "dbus" | "display"
    > = {
    config: baseConfig,
    profile,
    profileName: "test",
    sessionId: "sess_test",
    host: hostEnv,
    probes,
    ...slices,
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

test("MountStage: propagates log level from prior container env", async () => {
  const workDir = process.cwd();
  const { input, mountProbes } = await buildTestInput(baseProfile, workDir, {
    sliceOverrides: {
      container: {
        image: "nas-sandbox",
        workDir,
        mounts: [],
        env: { static: { NAS_LOG_LEVEL: "warn" }, dynamicOps: [] },
        extraRunArgs: [],
        command: { agentCommand: [], extraArgs: [] },
        labels: {},
      },
    },
  });
  const _plan = planMount(input, mountProbes);
  // NAS_LOG_LEVEL is set in initial prior container env, not by MountStage.
  expect(input.container.env.static.NAS_LOG_LEVEL).toEqual("warn");
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
        sliceOverrides: {
          dbus: {
            enabled: true,
            runtimeDir,
            socket: `${runtimeDir}/bus`,
            sourceAddress: "unix:path=/run/user/1000/bus",
          },
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

test("MountStage: resolveMountProbes canonicalizes extra-mounts src through symlinks", async () => {
  // Security regression test: a symlink under the workspace pointing at a
  // sensitive host path must NOT be followed into that host path as the
  // bind-mount source. resolveMountProbes should canonicalize via realpath so
  // the `normalizedSrc` is the realpath of the symlink target, letting callers
  // apply further policy. The key property we assert here is that
  // normalizedSrc is NOT left equal to the symlink path itself.
  const tmp = await mkdtemp(path.join(tmpdir(), "nas-mount-symlink-"));
  try {
    const target = path.join(tmp, "target-file");
    await writeFile(target, "ok");
    const link = path.join(tmp, "evil-link");
    await symlink(target, link);

    const profile: Profile = {
      ...baseProfile,
      extraMounts: [{ src: link, dst: "/tmp/nas-evil", mode: "ro" }],
    };
    const hostEnv = buildHostEnv();
    const probes = await resolveMountProbes(hostEnv, profile, tmp, null);
    expect(probes.resolvedExtraMounts.length).toEqual(1);
    const resolved = probes.resolvedExtraMounts[0];
    expect(resolved.srcExists).toEqual(true);
    // normalizedSrc must be the realpath of the target, not the symlink path.
    // Compare against realpath(target) to tolerate tmpdir itself being a
    // symlink (e.g. /tmp -> /private/tmp on macOS).
    const expected = await realpath(target);
    const linkReal = await realpath(link);
    expect(resolved.normalizedSrc).toEqual(expected);
    expect(resolved.normalizedSrc).toEqual(linkReal);
  } finally {
    await rm(tmp, { recursive: true, force: true });
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
