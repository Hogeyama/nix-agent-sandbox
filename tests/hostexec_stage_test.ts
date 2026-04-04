import { assertEquals, assertNotEquals } from "@std/assert";
import * as path from "@std/path";
import {
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_UI_CONFIG,
} from "../src/config/types.ts";
import type { Config, Profile } from "../src/config/types.ts";
import type {
  HostEnv,
  PriorStageOutputs,
  StageInput,
  SymlinkEffect,
  UnixListenerEffect,
} from "../src/pipeline/types.ts";
import { createHostExecStage } from "../src/stages/hostexec.ts";

function makeProfile(): Profile {
  return {
    agent: "claude",
    agentArgs: [],
    nix: { enable: false, mountSocket: false, extraPackages: [] },
    docker: { enable: false, shared: false },
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    display: structuredClone(DEFAULT_DISPLAY_CONFIG),
    network: {
      allowlist: [],
      prompt: {
        enable: false,
        denylist: [],
        timeoutSeconds: 300,
        defaultScope: "host-port",
        notify: "off",
      },
    },
    dbus: {
      session: {
        enable: false,
        see: [],
        talk: [],
        own: [],
        calls: [],
        broadcasts: [],
      },
    },
    extraMounts: [],
    env: [],
    hostexec: {
      prompt: {
        enable: true,
        timeoutSeconds: 300,
        defaultScope: "capability",
        notify: "off",
      },
      secrets: {
        token: { from: "env:TOKEN", required: false },
      },
      rules: [{
        id: "git-readonly",
        match: { argv0: "git", argRegex: "^pull\\b" },
        cwd: { mode: "workspace-or-session-tmp", allow: [] },
        env: { GITHUB_TOKEN: "secret:token" },
        inheritEnv: { mode: "minimal", keys: [] },
        approval: "prompt",
        fallback: "container",
      }],
    },
  };
}

function makeHostEnv(runtimeDir: string): HostEnv {
  return {
    home: "/home/testuser",
    user: "testuser",
    uid: 1000,
    gid: 1000,
    isWSL: false,
    env: new Map([
      ["HOME", "/home/testuser"],
      ["XDG_RUNTIME_DIR", runtimeDir],
    ]),
  };
}

function makeStageInput(
  profile: Profile,
  hostEnv: HostEnv,
  workDir?: string,
): StageInput {
  const config: Config = {
    profiles: { default: profile },
    ui: DEFAULT_UI_CONFIG,
  };
  const prior: PriorStageOutputs = {
    dockerArgs: [],
    envVars: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
    },
    workDir: workDir ?? "/workspace",
    nixEnabled: false,
    imageName: "nas-test",
    agentCommand: ["claude"],
    networkPromptEnabled: false,
    dbusProxyEnabled: false,
  };
  return {
    config,
    profile,
    profileName: "default",
    sessionId: "test-session-id",
    host: hostEnv,
    probes: {
      hasHostNix: false,
      xdgDbusProxyPath: null,
      dbusSessionAddress: null,
      gpgAgentSocket: null,
      auditDir: "/tmp/nas-test-audit",
    },
    prior,
  };
}

Deno.test("HostExecStage plan: returns null when no rules", () => {
  const profile = makeProfile();
  profile.hostexec!.rules = [];
  const hostEnv = makeHostEnv("/tmp/nas-test-runtime");
  const input = makeStageInput(profile, hostEnv);
  const stage = createHostExecStage();
  const plan = stage.plan(input);
  assertEquals(plan, null);
});

Deno.test("HostExecStage plan: produces correct effects and docker args", () => {
  const profile = makeProfile();
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const input = makeStageInput(profile, hostEnv);
  const stage = createHostExecStage();
  const plan = stage.plan(input);

  assertNotEquals(plan, null);
  if (!plan) return;

  // Check that wrapper directory mount is present
  assertEquals(
    plan.dockerArgs.some((arg) => arg.includes("/opt/nas/hostexec/bin")),
    true,
  );

  // Check PATH env includes wrapper dir
  assertEquals(
    plan.envVars["PATH"].startsWith("/opt/nas/hostexec/bin:"),
    true,
  );

  // Check socket env is set
  assertEquals(plan.envVars["NAS_HOSTEXEC_SOCKET"] !== undefined, true);
  assertEquals(
    plan.envVars["NAS_HOSTEXEC_SESSION_ID"],
    "test-session-id",
  );

  // Check outputOverrides
  assertEquals(plan.outputOverrides.hostexecBrokerSocket !== undefined, true);
  assertEquals(plan.outputOverrides.hostexecRuntimeDir !== undefined, true);
  assertEquals(
    (plan.outputOverrides.hostexecSessionTmpDir as string)?.includes(
      "test-session-id",
    ),
    true,
  );

  // Check socket path matches the env var
  assertEquals(
    plan.envVars["NAS_HOSTEXEC_SOCKET"],
    plan.outputOverrides.hostexecBrokerSocket,
  );
});

Deno.test("HostExecStage plan: creates symlink effects for bare command argv0s", () => {
  const profile = makeProfile();
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const input = makeStageInput(profile, hostEnv);
  const stage = createHostExecStage();
  const plan = stage.plan(input);

  assertNotEquals(plan, null);
  if (!plan) return;

  // "git" is a bare command argv0 — should have a symlink effect
  const symlinkEffects = plan.effects.filter(
    (e): e is SymlinkEffect => e.kind === "symlink",
  );
  assertEquals(symlinkEffects.length, 1);
  assertEquals(symlinkEffects[0].target, "hostexec-wrapper.py");
  assertEquals(path.basename(symlinkEffects[0].path), "git");
});

Deno.test("HostExecStage plan: creates unix-listener effect for hostexec-broker", () => {
  const profile = makeProfile();
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const input = makeStageInput(profile, hostEnv);
  const stage = createHostExecStage();
  const plan = stage.plan(input);

  assertNotEquals(plan, null);
  if (!plan) return;

  const listenerEffects = plan.effects.filter(
    (e): e is UnixListenerEffect => e.kind === "unix-listener",
  );
  assertEquals(listenerEffects.length, 1);
  assertEquals(listenerEffects[0].id, "hostexec-broker");
  assertEquals(listenerEffects[0].spec.kind, "hostexec-broker");
  if (listenerEffects[0].spec.kind === "hostexec-broker") {
    assertEquals(listenerEffects[0].spec.sessionId, "test-session-id");
    assertEquals(listenerEffects[0].spec.auditDir, "/tmp/nas-test-audit");
  }
});

Deno.test("HostExecStage plan: creates file-write effect for wrapper script", () => {
  const profile = makeProfile();
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const input = makeStageInput(profile, hostEnv);
  const stage = createHostExecStage();
  const plan = stage.plan(input);

  assertNotEquals(plan, null);
  if (!plan) return;

  const fileWriteEffects = plan.effects.filter(
    (e) => e.kind === "file-write",
  );
  assertEquals(fileWriteEffects.length, 1);
  assertEquals(fileWriteEffects[0].kind, "file-write");
  if (fileWriteEffects[0].kind === "file-write") {
    assertEquals(
      fileWriteEffects[0].content.includes("select.select([fd], [], [], 0)"),
      true,
    );
    assertEquals(
      fileWriteEffects[0].content.includes('"argv0": argv0,'),
      true,
    );
    assertEquals(
      fileWriteEffects[0].content.includes(
        "relative argv0 fallback is not supported",
      ),
      true,
    );
    assertEquals(
      fileWriteEffects[0].content.includes(
        "(not os.path.isabs(argv0)) and (os.path.sep in argv0)",
      ),
      true,
    );
  }
});

Deno.test("HostExecStage plan: mounts relative argv0 wrapper target", () => {
  const profile = makeProfile();
  profile.hostexec!.rules = [{
    id: "gradlew",
    match: { argv0: "./gradlew" },
    cwd: { mode: "workspace-only", allow: [] },
    env: {},
    inheritEnv: { mode: "minimal", keys: [] },
    approval: "allow",
    fallback: "container",
  }];
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const workspace = "/workspace";
  const input = makeStageInput(profile, hostEnv, workspace);
  const stage = createHostExecStage();
  const plan = stage.plan(input);

  assertNotEquals(plan, null);
  if (!plan) return;

  // Relative argv0 should produce a docker mount for the wrapper script
  assertEquals(
    plan.dockerArgs.some((arg) =>
      arg.endsWith(`:${path.join(workspace, "gradlew")}:ro`)
    ),
    true,
  );
});

Deno.test("HostExecStage plan: uses host.isWSL for notify resolution", () => {
  const profile = makeProfile();
  // Set notify to "auto" which resolves to "off" on WSL
  profile.hostexec!.prompt.notify = "auto";
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv: HostEnv = {
    ...makeHostEnv(runtimeDir),
    isWSL: true,
  };
  const input = makeStageInput(profile, hostEnv);
  const stage = createHostExecStage();
  const plan = stage.plan(input);

  assertNotEquals(plan, null);
  if (!plan) return;

  const listenerEffects = plan.effects.filter(
    (e): e is UnixListenerEffect => e.kind === "unix-listener",
  );
  assertEquals(listenerEffects.length, 1);
  if (listenerEffects[0].spec.kind === "hostexec-broker") {
    // On WSL with "auto", notify should resolve to "off"
    assertEquals(listenerEffects[0].spec.notify, "off");
  }
});
