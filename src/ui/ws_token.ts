/**
 * WebSocket bearer token: generate, load/create, and constant-time compare.
 *
 * The token is 32 bytes of CSPRNG output, base64url-encoded without padding.
 * It is persisted at `${daemonStateDir}/daemon.token` with mode 0600 so only
 * the owning user can read it.
 *
 * NOTE: This module only creates/loads the secret. Injecting it into HTML
 * (C3) and verifying it on WS upgrade (C4) land in later commits.
 */

import { timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { logWarn } from "../log.ts";

/** base64url-encode a byte buffer without padding. */
function toBase64Url(bytes: Uint8Array): string {
  // Buffer.toString("base64url") is Node/Bun-native and omits padding.
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Generate a fresh 32-byte WS bearer token, base64url-encoded (no padding).
 * Uses `crypto.getRandomValues` (Web Crypto) — CSPRNG-backed in Bun.
 */
export function generateWsToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/**
 * Load the persisted WS token at `${stateDir}/daemon.token`, or create one
 * if missing. Returns the trimmed base64url token string.
 *
 * Semantics:
 *  - Atomic create via `writeFile(..., { flag: "wx", mode: 0o600 })`.
 *  - If another process created it first (EEXIST), we fall through to the
 *    load path so both processes see the same token.
 *  - On load, if the stored file has any group/other permission bits set
 *    (`mode & 0o077 !== 0`), we warn and `chmod 0600` to correct it.
 *    A chmod failure is re-thrown (no silent masking).
 *  - If the file contents are empty after trim (corruption), we regenerate.
 */
export async function loadOrCreateWsToken(stateDir: string): Promise<string> {
  await mkdir(stateDir, { recursive: true });
  const tokenPath = path.join(stateDir, "daemon.token");

  // Try atomic create first.
  const fresh = generateWsToken();
  try {
    await writeFile(tokenPath, fresh, { mode: 0o600, flag: "wx" });
    return fresh;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    // File already exists — fall through to the load path.
  }

  // Load existing.
  const raw = await readFile(tokenPath, "utf-8");
  const trimmed = raw.trim();

  // Ensure permissions are 0600 (strip group/other bits).
  const st = await stat(tokenPath);
  if ((st.mode & 0o077) !== 0) {
    logWarn(
      `[nas] ws token file has permissive mode ${(st.mode & 0o777).toString(8)}; forcing 0600`,
    );
    await chmod(tokenPath, 0o600);
  }

  if (trimmed.length === 0) {
    // Corrupted / empty file — regenerate in place.
    logWarn("[nas] ws token file was empty; regenerating");
    const regenerated = generateWsToken();
    await writeFile(tokenPath, regenerated, { mode: 0o600 });
    await chmod(tokenPath, 0o600);
    return regenerated;
  }

  return trimmed;
}

/**
 * Constant-time token comparison. Returns false for mismatched-length inputs,
 * but still performs a timingSafeEqual against a same-length dummy so the
 * caller pays the same CPU cost regardless of length — this avoids leaking
 * the token length to a remote attacker via response-time differences.
 * Never throws.
 */
export function tokenEquals(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a, "utf-8");
    const bufB = Buffer.from(b, "utf-8");
    if (bufA.length !== bufB.length) {
      // Pay the same cost as a real compare by diffing against ourselves.
      // Result is ignored; we return false because lengths did not match.
      timingSafeEqual(bufA, bufA);
      return false;
    }
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}
