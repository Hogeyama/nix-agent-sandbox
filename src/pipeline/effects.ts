/**
 * Barrel re-export for effect executor and ResourceHandle.
 *
 * External imports (`pipeline/effects.ts`) continue to work unchanged.
 */

export {
  executeEffect,
  executePlan,
  teardownHandles,
} from "./effects/executor.ts";
export type { ResourceEffect, ResourceHandle } from "./effects/types.ts";
