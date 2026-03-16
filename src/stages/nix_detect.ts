/**
 * ホスト Nix 検出 + nix develop 統合
 */

import type { Stage } from "../pipeline/pipeline.ts";
import type { ExecutionContext } from "../pipeline/context.ts";
import { logInfo } from "../log.ts";

export class NixDetectStage implements Stage {
  name = "NixDetectStage";

  async execute(ctx: ExecutionContext): Promise<ExecutionContext> {
    const nixCfg = ctx.profile.nix;
    let nixEnabled: boolean;

    if (nixCfg.enable === "auto") {
      nixEnabled = await hasHostNix();
      logInfo(
        `[nas] Nix: auto-detected host nix → ${
          nixEnabled ? "enabled" : "disabled"
        }`,
      );
    } else {
      nixEnabled = nixCfg.enable;
      logInfo(
        `[nas] Nix: explicitly ${nixEnabled ? "enabled" : "disabled"}`,
      );
    }

    return { ...ctx, nixEnabled };
  }
}

async function hasHostNix(): Promise<boolean> {
  try {
    await Deno.stat("/nix");
    return true;
  } catch {
    return false;
  }
}
