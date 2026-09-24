import { expect, test } from "bun:test";
import {
  CLOUD_CONFIG_MOUNT_MIGRATION,
  GPG_FORWARD_AGENT_MIGRATION,
  NIX_EXTRA_PACKAGES_MIGRATION,
  normalizeRetiredSettings,
  retiredSourceErrors,
} from "./retired.ts";

for (const source of [
  "// extraPackages\n/* extraPackages */",
  'value = "extraPackages"',
  'value = #"extraPackages"#',
  'value = """\nextraPackages\n"""',
  'value = ##"""\nextraPackages\n"""##',
  "value = extraPackagesOther",
]) {
  test(`retired nix ignores nonreferences: ${source}`, () => {
    expect(retiredSourceErrors(source, "config.pkl")).toEqual([]);
  });
}
for (const source of [
  "nix { extraPackages {} }",
  'value = "\\(extraPackages)"',
  'value = #"\\#(extraPackages)"#',
  'value = """\n\\(extraPackages)\n"""',
]) {
  test(`retired nix diagnoses executable references: ${source}`, () => {
    const errors = retiredSourceErrors(`// heading\n${source}`, "config.pkl");
    expect(errors).toEqual([
      `config.pkl:${source.includes('"""') ? 3 : 2}: ${NIX_EXTRA_PACKAGES_MIGRATION}`,
    ]);
  });
}
for (const [source, migration] of [
  ["gcloud { mountConfig = true }", CLOUD_CONFIG_MOUNT_MIGRATION],
  ["aws { mountConfig = false }", CLOUD_CONFIG_MOUNT_MIGRATION],
  ["gpg { forwardAgent = true }", GPG_FORWARD_AGENT_MIGRATION],
] as const) {
  test(`retired credential passthrough is diagnosed: ${source}`, () => {
    expect(retiredSourceErrors(`// heading\n${source}`, "config.pkl")).toEqual([
      `config.pkl:2: ${migration}`,
    ]);
  });
}
for (const source of [
  '// mountConfig / forwardAgent は廃止\nid = "forwardAgent"',
  "value = mountConfigOther",
  "value = hostForwardAgent",
]) {
  test(`retired credential passthrough ignores nonreferences: ${source}`, () => {
    expect(retiredSourceErrors(source, "config.pkl")).toEqual([]);
  });
}
for (const key of ["extraPackages", "extra-packages"]) {
  for (const value of [["jq"], null, "", {}, false, 0]) {
    test(`legacy nix rejects ${key}=${JSON.stringify(value)} without mutation`, () => {
      const raw = { profiles: { dev: { nix: { [key]: value } } } };
      const before = structuredClone(raw);
      expect(() => normalizeRetiredSettings(raw)).toThrow(
        `profile "dev": ${NIX_EXTRA_PACKAGES_MIGRATION}`,
      );
      expect(raw).toEqual(before);
    });
  }
}
for (const [section, key, migration] of [
  ["gcloud", "mountConfig", CLOUD_CONFIG_MOUNT_MIGRATION],
  ["gcloud", "mount-config", CLOUD_CONFIG_MOUNT_MIGRATION],
  ["aws", "mountConfig", CLOUD_CONFIG_MOUNT_MIGRATION],
  ["aws", "mount-config", CLOUD_CONFIG_MOUNT_MIGRATION],
  ["gpg", "forwardAgent", GPG_FORWARD_AGENT_MIGRATION],
  ["gpg", "forward-agent", GPG_FORWARD_AGENT_MIGRATION],
] as const) {
  test(`legacy ${section}.${key} = true is rejected without mutation`, () => {
    const raw = { profiles: { dev: { [section]: { [key]: true } } } };
    const before = structuredClone(raw);
    expect(() => normalizeRetiredSettings(raw)).toThrow(
      `profile "dev": ${migration}`,
    );
    expect(raw).toEqual(before);
  });

  test(`legacy ${section}.${key} = false drops the whole section`, () => {
    const raw = {
      profiles: { dev: { agent: "claude", [section]: { [key]: false } } },
    };
    expect(normalizeRetiredSettings(raw)).toEqual({
      profiles: { dev: { agent: "claude" } },
    });
  });
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
  expect(normalizeRetiredSettings(raw)).toEqual({
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
    expect(normalizeRetiredSettings(input)).toEqual(input);
  }
});
test("legacy hostexec rules lose the removed fallback field and keep the rest", () => {
  const raw = {
    profiles: {
      dev: {
        hostexec: {
          rules: [
            { id: "gh", match: { argv0: "gh" }, fallback: "deny" },
            { id: "git", match: { argv0: "git" } },
          ],
        },
      },
    },
  };
  const before = structuredClone(raw);
  expect(normalizeRetiredSettings(raw)).toEqual({
    profiles: {
      dev: {
        hostexec: {
          rules: [
            { id: "gh", match: { argv0: "gh" } },
            { id: "git", match: { argv0: "git" } },
          ],
        },
      },
    },
  });
  expect(raw).toEqual(before);
});
