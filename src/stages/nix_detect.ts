/**
 * ホスト Nix 検出 + nix develop 統合 (EffectStage)
 */

import { Effect } from "effect";
import { logInfo } from "../log.ts";
import type { Stage } from "../pipeline/stage_builder.ts";
import type { StageInput } from "../pipeline/types.ts";

export function planNixDetect(input: StageInput): {
  nix: { enabled: boolean };
} {
  const nixCfg = input.profile.nix;
  let enabled: boolean;

  if (nixCfg.enable === "auto") {
    enabled = input.probes.hasHostNix;
    logInfo(
      `[nas] Nix: auto-detected host nix → ${enabled ? "enabled" : "disabled"}`,
    );
  } else {
    enabled = nixCfg.enable;
    logInfo(`[nas] Nix: explicitly ${enabled ? "enabled" : "disabled"}`);
  }

  return {
    nix: { enabled },
  };
}

export function createNixDetectStage(
  shared: StageInput,
): Stage<never, { nix: { enabled: boolean } }> {
  return {
    name: "NixDetectStage",
    needs: [],
    run(_input) {
      return Effect.succeed(planNixDetect(shared));
    },
  };
}
