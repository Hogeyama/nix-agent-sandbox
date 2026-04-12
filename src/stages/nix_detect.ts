/**
 * ホスト Nix 検出 + nix develop 統合 (EffectStage)
 */

import { Effect } from "effect";
import { logInfo } from "../log.ts";
import type {
  EffectStage,
  EffectStageResult,
  StageInput,
} from "../pipeline/types.ts";

export function planNixDetect(input: StageInput): EffectStageResult {
  const nixCfg = input.profile.nix;
  let nixEnabled: boolean;

  if (nixCfg.enable === "auto") {
    nixEnabled = input.probes.hasHostNix;
    logInfo(
      `[nas] Nix: auto-detected host nix → ${
        nixEnabled ? "enabled" : "disabled"
      }`,
    );
  } else {
    nixEnabled = nixCfg.enable;
    logInfo(`[nas] Nix: explicitly ${nixEnabled ? "enabled" : "disabled"}`);
  }

  return { nixEnabled };
}

export const NixDetectStage: EffectStage<never> = {
  kind: "effect",
  name: "NixDetectStage",

  run(input: StageInput) {
    return Effect.succeed(planNixDetect(input));
  },
};
