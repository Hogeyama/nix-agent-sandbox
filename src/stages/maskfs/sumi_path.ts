import { resolveAssetBinary } from "../../lib/asset.ts";

/**
 * Resolve the host-side absolute path to the sumi binary that nas mounts into
 * the container for Bash output masking and Claude Code hooks.
 *
 * Returns the path if the file exists, or `null` if it cannot be found
 * (e.g. `cd contrib/sumi && zig build` has not been run in dev).
 */
export async function resolveSumiBinPath(opts?: {
  assetDir?: string;
}): Promise<string | null> {
  return resolveAssetBinary(
    "sumi/sumi",
    import.meta.url,
    "../../../contrib/sumi/zig-out/bin/sumi",
    opts,
  );
}
