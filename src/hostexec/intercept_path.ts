import { resolveAssetBinary } from "../lib/asset.ts";

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
  return resolveAssetBinary(
    "hostexec/hostexec_intercept.so",
    import.meta.url,
    "./intercept/zig-out/lib/libhostexec_intercept.so",
    opts,
  );
}

/**
 * Container-side path where the standalone hostexec client is bind-mounted.
 *
 * Deliberately outside the wrapper directory: that directory is on PATH, and
 * everything in it is a command name the agent may invoke.
 */
export const HOSTEXEC_CLIENT_CONTAINER_PATH =
  "/opt/nas/hostexec/libexec/nas-hostexec-client";

/**
 * Resolve the host-side absolute path to `nas-hostexec-client`, the binary the
 * wrapper directory's symlinks point at.
 *
 * Returns the path if the file exists, or `null` if it cannot be found
 * (e.g. the Nix build hasn't been run yet).
 *
 * @param opts.assetDir - Override the asset directory (for testing).
 */
export async function resolveHostExecClientPath(opts?: {
  assetDir?: string;
}): Promise<string | null> {
  return resolveAssetBinary(
    "hostexec/nas-hostexec-client",
    import.meta.url,
    "./intercept/zig-out/bin/nas-hostexec-client",
    opts,
  );
}
