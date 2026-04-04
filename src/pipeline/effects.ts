/**
 * Barrel re-export for effect executor and ResourceHandle.
 *
 * External imports (`pipeline/effects.ts`) continue to work unchanged.
 */

export type { ResourceHandle } from "./effects/types.ts";
export {
  executeEffect,
  executePlan,
  teardownHandles,
} from "./effects/executor.ts";
