/**
 * mask_secrets — MaskConfig の values を解決する共有ヘルパー。
 * maskfs (MaskFsService) と proxy (NetworkRuntimeService) の両方から使う。
 * fail-closed: 解決失敗・空値・4バイト未満はすべて throw。
 */

import type { MaskValueConfig } from "../config/types.ts";
import { resolveSecret } from "../hostexec/secret_store.ts";

export const MIN_SECRET_BYTES = 4;

export async function resolveMaskSecrets(
  values: MaskValueConfig[],
  env: Record<string, string | undefined>,
): Promise<string[]> {
  const secrets: string[] = [];
  for (const [i, value] of values.entries()) {
    let resolved: string | string[] | null;
    try {
      resolved = await resolveSecret(value.source, env);
    } catch (e) {
      throw new Error(
        `[nas] mask: failed to resolve mask.values[${i}].source ("${value.source}"): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (resolved === null || resolved === "") {
      throw new Error(
        `[nas] mask: failed to resolve mask.values[${i}].source ("${value.source}"): Required secret is unavailable`,
      );
    }
    if (Array.isArray(resolved)) {
      if (resolved.length === 0) {
        throw new Error(
          `[nas] mask: failed to resolve mask.values[${i}].source ("${value.source}"): Required secret is unavailable`,
        );
      }
      for (const [lineIndex, line] of resolved.entries()) {
        assertMinSecretBytes(
          line,
          `[nas] mask: mask.values[${i}] line ${lineIndex + 1}`,
        );
        secrets.push(line);
      }
      continue;
    }
    assertMinSecretBytes(resolved, `[nas] mask: mask.values[${i}]`);
    secrets.push(resolved);
  }
  return secrets;
}

function assertMinSecretBytes(value: string, label: string): void {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength < MIN_SECRET_BYTES) {
    throw new Error(
      `${label} resolved value must be at least 4 bytes (got ${bytes.byteLength}); short values would mass-mask unrelated content`,
    );
  }
}
