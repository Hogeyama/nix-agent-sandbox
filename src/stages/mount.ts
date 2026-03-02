/**
 * マウント構成の組み立てステージ
 */

import type { Stage } from "../pipeline/pipeline.ts";
import type { ExecutionContext } from "../pipeline/context.ts";
import { configureClaude } from "../agents/claude.ts";
import { configureCopilot } from "../agents/copilot.ts";

export class MountStage implements Stage {
  name = "MountStage";

  async execute(ctx: ExecutionContext): Promise<ExecutionContext> {
    let result = { ...ctx };
    const args = [...result.dockerArgs];
    const envVars = { ...result.envVars };

    // ワークスペースマウント
    args.push("-v", `${result.workDir}:/workspace`);
    args.push("-w", "/workspace");

    // Nix store overlay (nix develop を使う場合のみ)
    // ホスト store とコンテナ store を fuse-overlayfs で統合する
    if (result.nixEnabled && result.profile.nix.mountHostStore) {
      const hasHostNixStore = await fileExists("/nix/store");
      if (hasHostNixStore) {
        args.push("-v", "/nix/store:/nix/store-host:ro");
        args.push("--device", "/dev/fuse");
        args.push("--cap-add", "SYS_ADMIN");
        envVars["NIX_ENABLED"] = "true";
      }
    }

    // Docker socket マウント
    if (result.profile.docker.mountSocket) {
      args.push("-v", "/var/run/docker.sock:/var/run/docker.sock");
    }

    // プロファイルの環境変数
    for (const [key, value] of Object.entries(result.profile.env)) {
      envVars[key] = value;
    }

    result = { ...result, dockerArgs: args, envVars };

    // エージェント固有の設定
    switch (result.profile.agent) {
      case "claude":
        result = configureClaude(result);
        break;
      case "copilot":
        result = configureCopilot(result);
        break;
    }

    await Promise.resolve();
    return result;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
