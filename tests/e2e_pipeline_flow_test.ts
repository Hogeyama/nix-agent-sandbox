/**
 * E2E tests: パイプラインの全体フロー
 *
 * 実際のステージ（NixDetectStage, MountStage）を組み合わせたパイプライン実行を検証する。
 * DockerBuildStage と LaunchStage はモックに差し替える。
 */

import { assertEquals } from "@std/assert";
import {
  createContext,
  type ExecutionContext,
} from "../src/pipeline/context.ts";
import { runPipeline, type Stage } from "../src/pipeline/pipeline.ts";
import { NixDetectStage } from "../src/stages/nix_detect.ts";
import { MountStage } from "../src/stages/mount.ts";
import type { Config, Profile } from "../src/config/types.ts";

type Ctx = ExecutionContext;

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    agent: "claude",
    agentArgs: [],
    nix: { enable: false, mountSocket: false, extraPackages: [] },
    docker: { enable: false, shared: false },
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    extraMounts: [],
    env: [],
    ...overrides,
  };
}

function makeConfig(
  profiles: Record<string, Profile>,
  defaultProfile?: string,
): Config {
  return {
    default: defaultProfile,
    profiles,
  };
}

/** teardown を記録するステージ */
class RecordingStage implements Stage {
  name: string;
  executed = false;
  tornDown = false;
  executionOrder: string[];

  constructor(name: string, executionOrder: string[]) {
    this.name = name;
    this.executionOrder = executionOrder;
  }

  execute(ctx: Ctx): Promise<Ctx> {
    this.executed = true;
    this.executionOrder.push(`execute:${this.name}`);
    return Promise.resolve(ctx);
  }

  teardown(_ctx: Ctx): Promise<void> {
    this.tornDown = true;
    this.executionOrder.push(`teardown:${this.name}`);
    return Promise.resolve();
  }
}

// --- パイプラインの基本フロー ---

Deno.test("Pipeline: stages execute in order", async () => {
  const order: string[] = [];
  const s1 = new RecordingStage("Stage1", order);
  const s2 = new RecordingStage("Stage2", order);
  const s3 = new RecordingStage("Stage3", order);

  const profile = makeProfile();
  const config = makeConfig({ test: profile }, "test");
  const ctx = createContext(config, profile, "test", "/tmp");

  await runPipeline([s1, s2, s3], ctx);

  assertEquals(order, [
    "execute:Stage1",
    "execute:Stage2",
    "execute:Stage3",
    "teardown:Stage3",
    "teardown:Stage2",
    "teardown:Stage1",
  ]);
});

Deno.test("Pipeline: teardown runs in reverse order after failure", async () => {
  const order: string[] = [];
  const s1 = new RecordingStage("Stage1", order);
  const failStage: Stage = {
    name: "FailStage",
    execute(_ctx: Ctx): Promise<Ctx> {
      order.push("execute:FailStage");
      return Promise.reject(new Error("boom"));
    },
    teardown(_ctx: Ctx): Promise<void> {
      order.push("teardown:FailStage");
      return Promise.resolve();
    },
  };
  const s3 = new RecordingStage("Stage3", order);

  const profile = makeProfile();
  const config = makeConfig({ test: profile }, "test");
  const ctx = createContext(config, profile, "test", "/tmp");

  try {
    await runPipeline([s1, failStage, s3], ctx);
  } catch {
    // expected
  }

  assertEquals(order, [
    "execute:Stage1",
    "execute:FailStage",
    // FailStage は completed に追加されないので teardown されない
    "teardown:Stage1",
  ]);
  assertEquals(s3.executed, false);
});

Deno.test("Pipeline: context modifications propagate through stages", async () => {
  const stage1: Stage = {
    name: "AddEnv",
    execute(ctx: Ctx): Promise<Ctx> {
      return Promise.resolve({
        ...ctx,
        envVars: { ...ctx.envVars, STAGE1: "yes" },
        dockerArgs: [...ctx.dockerArgs, "--stage1"],
      });
    },
  };
  const stage2: Stage = {
    name: "AddMore",
    execute(ctx: Ctx): Promise<Ctx> {
      return Promise.resolve({
        ...ctx,
        envVars: { ...ctx.envVars, STAGE2: "yes" },
        dockerArgs: [...ctx.dockerArgs, "--stage2"],
      });
    },
  };

  const profile = makeProfile();
  const config = makeConfig({ test: profile }, "test");
  const ctx = createContext(config, profile, "test", "/tmp");

  const result = await runPipeline([stage1, stage2], ctx);

  assertEquals(result.envVars["STAGE1"], "yes");
  assertEquals(result.envVars["STAGE2"], "yes");
  assertEquals(result.dockerArgs.includes("--stage1"), true);
  assertEquals(result.dockerArgs.includes("--stage2"), true);
});

// --- NixDetectStage + MountStage 連携 ---

Deno.test("E2E Pipeline: NixDetect → Mount with nix disabled", async () => {
  const profile = makeProfile({
    nix: { enable: false, mountSocket: false, extraPackages: [] },
  });
  const config = makeConfig({ test: profile }, "test");
  const ctx = createContext(config, profile, "test", Deno.cwd());

  const result = await runPipeline(
    [new NixDetectStage(), new MountStage()],
    ctx,
  );

  assertEquals(result.nixEnabled, false);
  // /nix マウントが含まれていないこと
  const nixMount = result.dockerArgs.filter((a) => a === "/nix:/nix");
  assertEquals(nixMount.length, 0);
});

Deno.test("E2E Pipeline: NixDetect → Mount with nix enabled", async () => {
  const profile = makeProfile({
    nix: { enable: true, mountSocket: true, extraPackages: [] },
  });
  const config = makeConfig({ test: profile }, "test");
  const ctx = createContext(config, profile, "test", Deno.cwd());

  const result = await runPipeline(
    [new NixDetectStage(), new MountStage()],
    ctx,
  );

  assertEquals(result.nixEnabled, true);
  // ホストに /nix がある場合のみマウントされる
  const hasHostNix = await Deno.stat("/nix").then(() => true, () => false);
  if (hasHostNix) {
    assertEquals(result.dockerArgs.includes("/nix:/nix"), true);
    assertEquals(result.envVars["NIX_REMOTE"], "daemon");
    assertEquals(result.envVars["NIX_ENABLED"], "true");
  }
});

Deno.test("E2E Pipeline: NixDetect auto + Mount", async () => {
  const profile = makeProfile({
    nix: { enable: "auto", mountSocket: true, extraPackages: [] },
  });
  const config = makeConfig({ test: profile }, "test");
  const ctx = createContext(config, profile, "test", Deno.cwd());

  const result = await runPipeline(
    [new NixDetectStage(), new MountStage()],
    ctx,
  );

  const hasHostNix = await Deno.stat("/nix").then(() => true, () => false);
  assertEquals(result.nixEnabled, hasHostNix);
});

// --- MountStage の詳細な検証 ---

Deno.test("E2E Pipeline: MountStage sets workspace mount and env", async () => {
  const profile = makeProfile();
  const config = makeConfig({ test: profile }, "test");
  const workDir = Deno.cwd();
  const ctx = createContext(config, profile, "test", workDir);

  const result = await runPipeline([new MountStage()], ctx);

  // ワークスペースマウント
  assertEquals(result.dockerArgs.includes(`${workDir}:${workDir}`), true);
  assertEquals(result.dockerArgs.includes(workDir), true);
  assertEquals(result.envVars["WORKSPACE"], workDir);

  // UID/GID
  const uid = Deno.uid();
  const gid = Deno.gid();
  if (uid !== null && gid !== null) {
    assertEquals(result.envVars["NAS_UID"], String(uid));
    assertEquals(result.envVars["NAS_GID"], String(gid));
  }

  // NAS_USER / NAS_HOME
  const user = Deno.env.get("USER")?.trim() || "nas";
  assertEquals(result.envVars["NAS_USER"], user);
  assertEquals(result.envVars["NAS_HOME"], `/home/${user}`);
});

Deno.test("E2E Pipeline: MountStage with docker.enable does not mount socket", async () => {
  const profile = makeProfile({
    docker: { enable: true, shared: false },
  });
  const config = makeConfig({ test: profile }, "test");
  const ctx = createContext(config, profile, "test", Deno.cwd());

  const result = await runPipeline([new MountStage()], ctx);

  // DinD 移行後: MountStage は docker.sock をマウントしない
  assertEquals(
    result.dockerArgs.includes("/var/run/docker.sock:/var/run/docker.sock"),
    false,
  );
});

Deno.test("E2E Pipeline: MountStage without docker does not mount socket", async () => {
  const profile = makeProfile({
    docker: { enable: false, shared: false },
  });
  const config = makeConfig({ test: profile }, "test");
  const ctx = createContext(config, profile, "test", Deno.cwd());

  const result = await runPipeline([new MountStage()], ctx);

  assertEquals(
    result.dockerArgs.includes("/var/run/docker.sock:/var/run/docker.sock"),
    false,
  );
});

Deno.test("E2E Pipeline: MountStage with static env vars", async () => {
  const profile = makeProfile({
    env: [
      { key: "FOO", val: "bar" },
      { key: "BAZ", val: "qux" },
    ],
  });
  const config = makeConfig({ test: profile }, "test");
  const ctx = createContext(config, profile, "test", Deno.cwd());

  const result = await runPipeline([new MountStage()], ctx);

  assertEquals(result.envVars["FOO"], "bar");
  assertEquals(result.envVars["BAZ"], "qux");
});

Deno.test("E2E Pipeline: MountStage with command-based env vars", async () => {
  const profile = makeProfile({
    env: [
      { keyCmd: "printf MY_KEY", valCmd: "printf my_value" },
    ],
  });
  const config = makeConfig({ test: profile }, "test");
  const ctx = createContext(config, profile, "test", Deno.cwd());

  const result = await runPipeline([new MountStage()], ctx);

  assertEquals(result.envVars["MY_KEY"], "my_value");
});

Deno.test("E2E Pipeline: MountStage with nix extra packages", async () => {
  const profile = makeProfile({
    nix: {
      enable: true,
      mountSocket: true,
      extraPackages: ["nixpkgs#ripgrep", "nixpkgs#fd"],
    },
  });
  const config = makeConfig({ test: profile }, "test");
  const ctx = createContext(config, profile, "test", Deno.cwd());
  // NixDetectStage で nixEnabled=true にする
  const nixCtx = { ...ctx, nixEnabled: true };

  const result = await runPipeline([new MountStage()], nixCtx);

  const hasHostNix = await Deno.stat("/nix").then(() => true, () => false);
  if (hasHostNix) {
    assertEquals(
      result.envVars["NIX_EXTRA_PACKAGES"],
      "nixpkgs#ripgrep\nnixpkgs#fd",
    );
  }
});

Deno.test("E2E Pipeline: MountStage with mountDir differs from workDir", async () => {
  const profile = makeProfile();
  const config = makeConfig({ test: profile }, "test");
  const workDir = Deno.cwd();
  const mountDir = "/tmp";
  const ctx = { ...createContext(config, profile, "test", workDir), mountDir };

  const result = await runPipeline([new MountStage()], ctx);

  // mountDir がマウントされる
  const mountArg = result.dockerArgs.find((a) =>
    a.startsWith(`${mountDir}:${mountDir}`)
  );
  assertEquals(mountArg !== undefined, true);
  // workDir が PWD
  const wIdx = result.dockerArgs.indexOf(workDir);
  assertEquals(wIdx >= 1 && result.dockerArgs[wIdx - 1] === "-w", true);
});

Deno.test("E2E Pipeline: MountStage agent=claude configures claude", async () => {
  const profile = makeProfile({ agent: "claude" });
  const config = makeConfig({ test: profile }, "test");
  const ctx = createContext(config, profile, "test", Deno.cwd());

  const result = await runPipeline([new MountStage()], ctx);

  // agentCommand が設定される
  assertEquals(result.agentCommand.length > 0, true);
  // claude バイナリがある場合は "claude"、なければ bash -c ...
  if (result.agentCommand[0] === "claude") {
    assertEquals(result.agentCommand, ["claude"]);
  } else {
    assertEquals(result.agentCommand[0], "bash");
  }
});

Deno.test("E2E Pipeline: MountStage agent=copilot configures copilot", async () => {
  const profile = makeProfile({ agent: "copilot" });
  const config = makeConfig({ test: profile }, "test");
  const ctx = createContext(config, profile, "test", Deno.cwd());

  const result = await runPipeline([new MountStage()], ctx);

  // agentCommand が設定される
  assertEquals(result.agentCommand.length > 0, true);
});

Deno.test("E2E Pipeline: MountStage agent=codex configures codex", async () => {
  const profile = makeProfile({ agent: "codex" });
  const config = makeConfig({ test: profile }, "test");
  const ctx = createContext(config, profile, "test", Deno.cwd());

  const result = await runPipeline([new MountStage()], ctx);

  assertEquals(result.agentCommand.length > 0, true);
  if (result.agentCommand[0] === "codex") {
    assertEquals(result.agentCommand, ["codex"]);
  } else {
    assertEquals(result.agentCommand[0], "bash");
  }
});

// --- 複数ステージの組み合わせ ---

Deno.test("E2E Pipeline: full pipeline preserves all context", async () => {
  const profile = makeProfile({
    agent: "claude",
    agentArgs: ["--dangerously-skip-permissions"],
    nix: { enable: false, mountSocket: false, extraPackages: [] },
    env: [{ key: "TEST_VAR", val: "test_value" }],
  });
  const config = makeConfig({ test: profile }, "test");
  const ctx = createContext(config, profile, "test", Deno.cwd());

  const result = await runPipeline(
    [new NixDetectStage(), new MountStage()],
    ctx,
  );

  assertEquals(result.envVars["TEST_VAR"], "test_value");
  assertEquals(result.agentCommand.length > 0, true);
  assertEquals(
    result.profile.agentArgs.includes("--dangerously-skip-permissions"),
    true,
  );
});

Deno.test("E2E Pipeline: gcloud mount config", async () => {
  const profile = makeProfile({
    gcloud: { mountConfig: true },
  });
  const config = makeConfig({ test: profile }, "test");
  const ctx = createContext(config, profile, "test", Deno.cwd());

  const result = await runPipeline([new MountStage()], ctx);

  const home = Deno.env.get("HOME") ?? "/root";
  const gcloudDir = `${home}/.config/gcloud`;
  const hasGcloud = await Deno.stat(gcloudDir).then(() => true, () => false);
  if (hasGcloud) {
    assertEquals(
      result.dockerArgs.some((a) => a.includes(".config/gcloud")),
      true,
    );
  }
});

Deno.test("E2E Pipeline: aws mount config", async () => {
  const profile = makeProfile({
    aws: { mountConfig: true },
  });
  const config = makeConfig({ test: profile }, "test");
  const ctx = createContext(config, profile, "test", Deno.cwd());

  const result = await runPipeline([new MountStage()], ctx);

  const home = Deno.env.get("HOME") ?? "/root";
  const awsDir = `${home}/.aws`;
  const hasAws = await Deno.stat(awsDir).then(() => true, () => false);
  if (hasAws) {
    assertEquals(
      result.dockerArgs.some((a) => a.includes(".aws")),
      true,
    );
  }
});

Deno.test("E2E Pipeline: git config is mounted when present", async () => {
  const profile = makeProfile();
  const config = makeConfig({ test: profile }, "test");
  const ctx = createContext(config, profile, "test", Deno.cwd());

  const result = await runPipeline([new MountStage()], ctx);

  const home = Deno.env.get("HOME") ?? "/root";
  const gitConfigDir = `${home}/.config/git`;
  const hasGitConfig = await Deno.stat(gitConfigDir).then(
    () => true,
    () => false,
  );
  if (hasGitConfig) {
    assertEquals(
      result.dockerArgs.some((a) => a.includes(".config/git")),
      true,
    );
  }
});

Deno.test("E2E Pipeline: TMUX env is forwarded", async () => {
  const profile = makeProfile();
  const config = makeConfig({ test: profile }, "test");
  const ctx = createContext(config, profile, "test", Deno.cwd());

  // TMUX 環境変数の有無に応じた期待値
  const hostTmux = Deno.env.get("TMUX");

  const result = await runPipeline([new MountStage()], ctx);

  if (hostTmux) {
    assertEquals(result.envVars["NAS_HOST_TMUX"], "1");
  } else {
    assertEquals("NAS_HOST_TMUX" in result.envVars, false);
  }
});

// --- createContext ---

Deno.test("createContext: initializes with correct defaults", () => {
  const profile = makeProfile({ agent: "copilot" });
  const config = makeConfig({ test: profile }, "test");
  const ctx = createContext(config, profile, "myprofile", "/work/dir");

  assertEquals(ctx.config, config);
  assertEquals(ctx.profile, profile);
  assertEquals(ctx.profileName, "myprofile");
  assertEquals(ctx.workDir, "/work/dir");
  assertEquals(ctx.imageName, "nas-sandbox");
  assertEquals(ctx.dockerArgs, []);
  assertEquals(ctx.envVars, {});
  assertEquals(ctx.nixEnabled, false);
  assertEquals(ctx.agentCommand, []);
  assertEquals(ctx.mountDir, undefined);
});

Deno.test("createContext: preserves config reference", () => {
  const profile = makeProfile();
  const config = makeConfig({ a: profile, b: profile }, "a");
  const ctx = createContext(config, profile, "a", "/tmp");

  assertEquals(Object.keys(ctx.config.profiles).length, 2);
  assertEquals(ctx.config.default, "a");
});
