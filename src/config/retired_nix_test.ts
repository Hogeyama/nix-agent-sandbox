import { expect, test } from "bun:test";
import {
  NIX_EXTRA_PACKAGES_MIGRATION,
  normalizeLegacyNixPackages,
  retiredNixSourceErrors,
} from "./retired_nix.ts";

for (const source of [
  "// extraPackages\n/* extraPackages */",
  'value = "extraPackages"',
  'value = #"extraPackages"#',
  'value = """\nextraPackages\n"""',
  'value = ##"""\nextraPackages\n"""##',
  "value = extraPackagesOther",
]) {
  test(`retired nix ignores nonreferences: ${source}`, () => {
    expect(retiredNixSourceErrors(source, "config.pkl")).toEqual([]);
  });
}
for (const source of [
  "nix { extraPackages {} }",
  'value = "\\(extraPackages)"',
  'value = #"\\#(extraPackages)"#',
  'value = """\n\\(extraPackages)\n"""',
]) {
  test(`retired nix diagnoses executable references: ${source}`, () => {
    const errors = retiredNixSourceErrors(
      `// heading\n${source}`,
      "config.pkl",
    );
    expect(errors).toEqual([
      `config.pkl:${source.includes('"""') ? 3 : 2}: ${NIX_EXTRA_PACKAGES_MIGRATION}`,
    ]);
  });
}
for (const key of ["extraPackages", "extra-packages"]) {
  for (const value of [["jq"], null, "", {}, false, 0]) {
    test(`legacy nix rejects ${key}=${JSON.stringify(value)} without mutation`, () => {
      const raw = { profiles: { dev: { nix: { [key]: value } } } };
      const before = structuredClone(raw);
      expect(() => normalizeLegacyNixPackages(raw)).toThrow(
        `profile "dev": ${NIX_EXTRA_PACKAGES_MIGRATION}`,
      );
      expect(raw).toEqual(before);
    });
  }
}
test("legacy normalization preserves unrelated data and removes both empty spellings", () => {
  const raw = {
    profiles: {
      dev: {
        env: ["unchanged"],
        nix: { enable: true, extraPackages: [], "extra-packages": [] },
      },
      other: null,
    },
    ui: { enable: true },
  };
  const before = structuredClone(raw);
  expect(normalizeLegacyNixPackages(raw)).toEqual({
    profiles: {
      dev: { env: ["unchanged"], nix: { enable: true } },
      other: null,
    },
    ui: { enable: true },
  });
  expect(raw).toEqual(before);
  for (const input of [
    {},
    { profiles: null },
    { profiles: [] },
    { profiles: { dev: { nix: null } } },
  ]) {
    expect(normalizeLegacyNixPackages(input)).toEqual(input);
  }
});
