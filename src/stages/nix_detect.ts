/**
 * flake.nix 検出 + nix develop 統合
 */

import * as path from "@std/path";
import type { Stage } from "../pipeline/pipeline.ts";
import type { ExecutionContext } from "../pipeline/context.ts";

export class NixDetectStage implements Stage {
  name = "NixDetectStage";

  async execute(ctx: ExecutionContext): Promise<ExecutionContext> {
    const nixCfg = ctx.profile.nix;
    let nixEnabled: boolean;

    if (nixCfg.enable === "auto") {
      nixEnabled = await hasFlakeNix(ctx.workDir);
      console.log(
        `[naw] Nix: auto-detected flake.nix → ${
          nixEnabled ? "enabled" : "disabled"
        }`,
      );
    } else {
      nixEnabled = nixCfg.enable;
      console.log(
        `[naw] Nix: explicitly ${nixEnabled ? "enabled" : "disabled"}`,
      );
    }

    return { ...ctx, nixEnabled };
  }
}

async function hasFlakeNix(dir: string): Promise<boolean> {
  try {
    await Deno.stat(path.join(dir, "flake.nix"));
    return true;
  } catch {
    return false;
  }
}
