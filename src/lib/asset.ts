import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the absolute path to a bundled asset file.
 *
 * When NAS_ASSET_DIR is set (nix-bundle-elf bundled mode), assets are
 * resolved relative to that directory. Otherwise, assets are resolved
 * relative to the source tree via import.meta.url.
 *
 * @param relativePath - Path relative to the asset root (e.g. "docker/embed/Dockerfile")
 * @param importMetaUrl - The caller's import.meta.url, used for source-tree resolution
 * @param sourceRelative - Path from the caller's directory to the asset in the source tree
 *                         (e.g. "./embed/Dockerfile" or "../docker/embed/Dockerfile")
 */
export function resolveAsset(
  relativePath: string,
  importMetaUrl: string,
  sourceRelative: string,
): string {
  const assetDir = process.env.NAS_ASSET_DIR;
  if (assetDir) {
    return path.join(assetDir, relativePath);
  }
  return fileURLToPath(new URL(sourceRelative, importMetaUrl));
}

/**
 * Resolve the host-side absolute path to a bundled binary asset.
 *
 * Combines the resolveAsset lookup with a file-existence check.
 * Returns the absolute path if the binary exists, or `null` otherwise
 * (e.g. the dev build hasn't been run yet).
 *
 * @param assetSubdir   - Path relative to the asset root (e.g. "maskfs/nas-maskfs")
 * @param importMetaUrl - The caller's import.meta.url
 * @param devFallback   - Path from the caller's directory to the binary in dev
 * @param opts.assetDir - Override the asset directory (for testing)
 */
export async function resolveAssetBinary(
  assetSubdir: string,
  importMetaUrl: string,
  devFallback: string,
  opts?: { assetDir?: string },
): Promise<string | null> {
  const resolved = opts?.assetDir
    ? path.join(opts.assetDir, assetSubdir)
    : resolveAsset(assetSubdir, importMetaUrl, devFallback);

  if (await Bun.file(resolved).exists()) {
    return resolved;
  }
  return null;
}

/**
 * Resolve an asset directory path.
 * Same as resolveAsset but ensures a trailing separator for directory usage.
 */
export function resolveAssetDir(
  relativePath: string,
  importMetaUrl: string,
  sourceRelative: string,
): string {
  const assetDir = process.env.NAS_ASSET_DIR;
  if (assetDir) {
    return path.join(assetDir, relativePath);
  }
  return fileURLToPath(new URL(sourceRelative, importMetaUrl));
}
