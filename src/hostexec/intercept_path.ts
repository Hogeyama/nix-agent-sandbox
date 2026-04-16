import * as path from "node:path";
import { resolveAsset } from "../lib/asset.ts";

/**
 * Container-side path where the intercept shared library is bind-mounted.
 */
export const INTERCEPT_LIB_CONTAINER_PATH =
  "/opt/nas/hostexec/lib/hostexec_intercept.so";

/**
 * Resolve the host-side absolute path to hostexec_intercept.so.
 *
 * Returns the path if the file exists, or `null` if it cannot be found
 * (e.g. the Nix build hasn't been run yet).
 *
 * @param opts.assetDir - Override the asset directory (for testing).
 */
export async function resolveInterceptLibPath(opts?: {
  assetDir?: string;
}): Promise<string | null> {
  const resolved = opts?.assetDir
    ? path.join(opts.assetDir, "hostexec/hostexec_intercept.so")
    : resolveAsset(
        "hostexec/hostexec_intercept.so",
        import.meta.url,
        "./intercept/zig-out/lib/libhostexec_intercept.so",
      );

  if (await Bun.file(resolved).exists()) {
    return resolved;
  }
  return null;
}
