import { containsIdentifier, maskNonCode } from "../lib/pkl_source.ts";

export const NIX_EXTRA_PACKAGES_MIGRATION =
  "nix.extraPackages is no longer supported. Define packages in .envrc or " +
  "a devShell, set direnv.enable = true, and run direnv allow on the host.";

export function retiredNixSourceErrors(
  source: string,
  fileName: string,
): string[] {
  return maskNonCode(source)
    .split("\n")
    .flatMap((line, index) =>
      containsIdentifier(line, "extraPackages")
        ? [`${fileName}:${index + 1}: ${NIX_EXTRA_PACKAGES_MIGRATION}`]
        : [],
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeLegacyNixPackages(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  if (!isRecord(raw.profiles)) return raw;
  const profiles = Object.fromEntries(
    Object.entries(raw.profiles).map(([name, profile]) => {
      if (!isRecord(profile) || !isRecord(profile.nix)) return [name, profile];
      const nix = { ...profile.nix };
      for (const key of ["extraPackages", "extra-packages"]) {
        if (!(key in nix)) continue;
        const value = nix[key];
        if (!Array.isArray(value) || value.length !== 0) {
          throw new Error(`profile "${name}": ${NIX_EXTRA_PACKAGES_MIGRATION}`);
        }
        delete nix[key];
      }
      return [name, { ...profile, nix }];
    }),
  );
  return { ...raw, profiles };
}
