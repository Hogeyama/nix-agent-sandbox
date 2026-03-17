import { assertEquals } from "@std/assert";
import {
  type Config,
  DEFAULT_DBUS_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  type Profile,
} from "../src/config/types.ts";
import { createContext } from "../src/pipeline/context.ts";
import { DockerBuildStage, LaunchStage } from "../src/stages/launch.ts";

Deno.test("DockerBuildStage: builds image from extracted embedded assets", async () => {
  await withFakeDocker(async ({ dir, logPath, assetLogPath }) => {
    Deno.env.set("NAS_FAKE_DOCKER_IMAGE_EXISTS", "0");

    const stage = new DockerBuildStage();
    const ctx = createTestContext();
    await stage.execute(ctx);

    const log = await Deno.readTextFile(logPath);
    assertEquals(log.includes("image inspect nas-sandbox"), true);
    assertEquals(log.includes("build"), true);

    const assetLog = await Deno.readTextFile(assetLogPath);
    for (
      const asset of [
        "Dockerfile\tpresent",
        "entrypoint.sh\tpresent",
        "osc52-clip.sh\tpresent",
        "envoy/envoy.template.yaml\tpresent",
      ]
    ) {
      assertEquals(assetLog.includes(asset), true);
    }
    assertEquals(dir.length > 0, true);
  });
});

Deno.test("DockerBuildStage: warns when cached image embed hash is outdated", async () => {
  await withFakeDocker(async ({ logPath }) => {
    Deno.env.set("NAS_FAKE_DOCKER_IMAGE_EXISTS", "1");
    Deno.env.set("NAS_FAKE_DOCKER_LABEL", "stale-hash");

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      await new DockerBuildStage().execute(createTestContext());
    } finally {
      console.log = originalLog;
    }

    const log = await Deno.readTextFile(logPath);
    assertEquals(log.includes("build"), false);
    assertEquals(
      logs.some((line) => line.includes("Docker image is outdated")),
      true,
    );
  });
});

Deno.test("LaunchStage: passes composed command and docker args to docker run", async () => {
  await withFakeDocker(async ({ logPath }) => {
    const ctx = createTestContext();
    ctx.imageName = "custom-image";
    ctx.agentCommand = ["agent-bin", "serve"];
    ctx.profile.agentArgs = ["--profile-arg"];
    ctx.dockerArgs = ["--network", "sandbox-net", "-v", "/tmp:/workspace"];
    ctx.envVars = { TOKEN: "secret", MODE: "test" };

    await new LaunchStage(["--user-arg"]).execute(ctx);

    const log = await Deno.readTextFile(logPath);
    assertEquals(log.includes("run --rm"), true);
    assertEquals(log.includes("--network sandbox-net"), true);
    assertEquals(log.includes("-e TOKEN=secret"), true);
    assertEquals(log.includes("-e MODE=test"), true);
    assertEquals(
      log.includes("custom-image agent-bin serve --profile-arg --user-arg"),
      true,
    );
  });
});

async function withFakeDocker(
  fn: (paths: {
    dir: string;
    logPath: string;
    assetLogPath: string;
  }) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "nas-launch-test-" });
  const logPath = `${dir}/docker.log`;
  const assetLogPath = `${dir}/assets.log`;
  const originalPath = Deno.env.get("PATH") ?? "";
  const originalLog = Deno.env.get("NAS_FAKE_DOCKER_LOG");
  const originalAssetLog = Deno.env.get("NAS_FAKE_DOCKER_ASSET_LOG");
  const originalImageExists = Deno.env.get("NAS_FAKE_DOCKER_IMAGE_EXISTS");
  const originalLabel = Deno.env.get("NAS_FAKE_DOCKER_LABEL");
  const originalRunExit = Deno.env.get("NAS_FAKE_DOCKER_RUN_EXIT");

  try {
    await Deno.writeTextFile(
      `${dir}/docker`,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "\${NAS_FAKE_DOCKER_LOG}"
if [[ "$1" == "image" && "$2" == "inspect" ]]; then
  if [[ "\${NAS_FAKE_DOCKER_IMAGE_EXISTS:-0}" == "1" ]]; then
    exit 0
  fi
  exit 1
fi
if [[ "$1" == "inspect" ]]; then
  printf '%s' "\${NAS_FAKE_DOCKER_LABEL:-}"
  exit 0
fi
if [[ "$1" == "build" ]]; then
  context="\${!#}"
  : > "\${NAS_FAKE_DOCKER_ASSET_LOG}"
  for rel in Dockerfile entrypoint.sh osc52-clip.sh envoy/envoy.template.yaml; do
    if [[ -s "$context/$rel" ]]; then
      printf '%s\tpresent\n' "$rel" >> "\${NAS_FAKE_DOCKER_ASSET_LOG}"
    else
      printf '%s\tmissing\n' "$rel" >> "\${NAS_FAKE_DOCKER_ASSET_LOG}"
    fi
  done
  exit 0
fi
if [[ "$1" == "run" ]]; then
  exit "\${NAS_FAKE_DOCKER_RUN_EXIT:-0}"
fi
exit 0
`,
    );
    await Deno.chmod(`${dir}/docker`, 0o755);
    Deno.env.set("PATH", `${dir}:${originalPath}`);
    Deno.env.set("NAS_FAKE_DOCKER_LOG", logPath);
    Deno.env.set("NAS_FAKE_DOCKER_ASSET_LOG", assetLogPath);
    await fn({ dir, logPath, assetLogPath });
  } finally {
    Deno.env.set("PATH", originalPath);
    restoreEnv("NAS_FAKE_DOCKER_LOG", originalLog);
    restoreEnv("NAS_FAKE_DOCKER_ASSET_LOG", originalAssetLog);
    restoreEnv("NAS_FAKE_DOCKER_IMAGE_EXISTS", originalImageExists);
    restoreEnv("NAS_FAKE_DOCKER_LABEL", originalLabel);
    restoreEnv("NAS_FAKE_DOCKER_RUN_EXIT", originalRunExit);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

function createTestContext() {
  const profile: Profile = {
    agent: "claude",
    agentArgs: [],
    nix: { enable: false, mountSocket: false, extraPackages: [] },
    docker: { enable: false, shared: false },
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    network: structuredClone(DEFAULT_NETWORK_CONFIG),
    dbus: structuredClone(DEFAULT_DBUS_CONFIG),
    extraMounts: [],
    env: [],
  };
  const config: Config = { default: "test", profiles: { test: profile } };
  return createContext(config, profile, "test", "/workspace");
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    Deno.env.delete(name);
    return;
  }
  Deno.env.set(name, value);
}
