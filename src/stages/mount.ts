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

    // ホストユーザーの UID/GID をコンテナに渡す (entrypoint で非 root ユーザー作成に使用)
    const uid = Deno.uid();
    const gid = Deno.gid();
    if (uid !== null && gid !== null) {
      envVars["NAS_UID"] = String(uid);
      envVars["NAS_GID"] = String(gid);
    }

    // Nix ソケットマウント (ホストの nix daemon にソケット経由で接続)
    if (result.nixEnabled && result.profile.nix.mountSocket) {
      const hasHostNix = await fileExists("/nix");
      if (hasHostNix) {
        args.push("-v", "/nix:/nix");
        envVars["NIX_REMOTE"] = "daemon";
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
