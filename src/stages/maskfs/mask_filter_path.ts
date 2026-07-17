import { resolveAssetBinary } from "../../lib/asset.ts";

/**
 * Resolve the host-side absolute path to the nas-mask-filter binary.
 *
 * Returns the path if the file exists, or `null` if it cannot be found
 * (e.g. `cd src/mask-filter && zig build` has not been run in dev).
 */
export async function resolveMaskFilterBinPath(opts?: {
  assetDir?: string;
}): Promise<string | null> {
  return resolveAssetBinary(
    "mask-filter/nas-mask-filter",
    import.meta.url,
    "../../mask-filter/zig-out/bin/nas-mask-filter",
    opts,
  );
}
