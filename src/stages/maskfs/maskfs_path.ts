import { resolveAssetBinary } from "../../lib/asset.ts";

/**
 * Resolve the host-side absolute path to the nas-maskfs binary.
 *
 * Returns the path if the file exists, or `null` if it cannot be found
 * (e.g. `cd src/maskfs && zig build` has not been run in dev).
 */
export async function resolveMaskFsBinPath(opts?: {
  assetDir?: string;
}): Promise<string | null> {
  return resolveAssetBinary(
    "maskfs/nas-maskfs",
    import.meta.url,
    "../../maskfs/zig-out/bin/nas-maskfs",
    opts,
  );
}
