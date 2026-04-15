/**
 * Env-op encoding helpers shared across pipeline and stage modules.
 *
 * encodeDynamicEnvOps produces shell commands for container-runtime evaluation,
 * used by the NAS_ENV_OPS env var to handle prefix/suffix PATH-style patching.
 *
 * Previously co-located with mount.ts; moved here so that container_plan.ts
 * and other pipeline modules can share the encoder without a pipeline→stage
 * value dependency.
 */

import type { DynamicEnvOp } from "./state.ts";

/** Valid POSIX shell variable name: letter/underscore, then alphanumeric/underscore. */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Shell-safe single-quoting (escape embedded single quotes). */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Encode prefix/suffix ops as shell commands for container-runtime evaluation.
 *
 * Each line calls either `__nas_pfx` or `__nas_sfx` to apply the op at
 * container startup. The output is stored in the NAS_ENV_OPS env var and
 * evaluated by the container entrypoint.
 *
 * Throws if any op's key is not a valid POSIX shell variable name, because
 * the entrypoint evaluates ops under `set -euo pipefail` and an invalid key
 * would abort the shell via Bash indirect expansion.
 */
export function encodeDynamicEnvOps(ops: readonly DynamicEnvOp[]): string {
  return ops
    .map((op) => {
      if (!ENV_KEY_RE.test(op.key)) {
        throw new Error(
          `[nas] encodeDynamicEnvOps: invalid env var key: ${JSON.stringify(op.key)}`,
        );
      }
      const fn = op.mode === "prefix" ? "__nas_pfx" : "__nas_sfx";
      return `${fn} ${shellQuote(op.key)} ${shellQuote(op.value)} ${shellQuote(op.separator)}`;
    })
    .join("\n");
}
