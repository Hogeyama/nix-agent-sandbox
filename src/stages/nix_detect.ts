/**
 * ホスト Nix 検出 + nix develop 統合 (PlanStage)
 */

import { logInfo } from "../log.ts";
import type { PlanStage, StageInput, StagePlan } from "../pipeline/types.ts";

export const NixDetectStage: PlanStage = {
  kind: "plan",
  name: "NixDetectStage",

  plan(input: StageInput): StagePlan | null {
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

    return {
      effects: [],
      dockerArgs: [],
      envVars: {},
      outputOverrides: { nixEnabled },
    };
  },
};
