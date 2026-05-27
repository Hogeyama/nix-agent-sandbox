import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { compareSemver, initConfig, parseVersionFromPkl } from "./init.ts";

// ---------------------------------------------------------------------------
// parseVersionFromPkl
// ---------------------------------------------------------------------------

describe("parseVersionFromPkl", () => {
  test("parses version from first line", () => {
    expect(parseVersionFromPkl("/// @version 1.2.3\n/// doc")).toEqual("1.2.3");
  });

  test("parses version from later line within first 5", () => {
    expect(
      parseVersionFromPkl("/// doc line 1\n/// @version 0.14.0\nmodule foo"),
    ).toEqual("0.14.0");
  });

  test("returns null when no version tag", () => {
    expect(parseVersionFromPkl("/// doc\nmodule foo")).toBeNull();
  });

  test("returns null when version tag is beyond line 5", () => {
    const lines = ["a", "b", "c", "d", "e", "/// @version 1.0.0"].join("\n");
    expect(parseVersionFromPkl(lines)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// compareSemver
// ---------------------------------------------------------------------------

describe("compareSemver", () => {
  test("equal versions return 0", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toEqual(0);
  });

  test("major difference", () => {
    expect(compareSemver("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0", "2.0.0")).toBeLessThan(0);
  });

  test("minor difference", () => {
    expect(compareSemver("1.3.0", "1.2.9")).toBeGreaterThan(0);
  });

  test("patch difference", () => {
    expect(compareSemver("1.2.4", "1.2.3")).toBeGreaterThan(0);
  });

  test("non-semver treated as 0.0.0", () => {
    expect(compareSemver("bogus", "0.0.0")).toEqual(0);
  });
});

// ---------------------------------------------------------------------------
// initConfig
// ---------------------------------------------------------------------------

describe("initConfig", () => {
  let tmpDir: string;
  let projectDir: string;
  let originalXdg: string | undefined;

  function setup() {
    tmpDir = mkdtempSync(path.join(tmpdir(), "nas-init-test-"));
    projectDir = path.join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
    // Point XDG_CONFIG_HOME to our temp dir so global files land there.
    originalXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, "xdg-config");
  }

  afterEach(() => {
    if (originalXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdg;
    }
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("creates all files on fresh init", async () => {
    setup();
    const result = await initConfig({ projectDir });

    // All 7 files should be written
    expect(result.written.length).toEqual(7);
    expect(result.skipped.length).toEqual(0);

    // Global files
    const globalDir = path.join(tmpDir, "xdg-config", "nas");
    expect(existsSync(path.join(globalDir, "Schema.pkl"))).toBeTrue();
    expect(existsSync(path.join(globalDir, "global.pkl"))).toBeTrue();

    // Project files
    const nasDir = path.join(projectDir, ".nas");
    expect(existsSync(path.join(nasDir, "Schema.pkl"))).toBeTrue();
    expect(existsSync(path.join(nasDir, "config.pkl"))).toBeTrue();
    expect(existsSync(path.join(nasDir, "PklProject"))).toBeTrue();
    expect(existsSync(path.join(nasDir, "eval.pkl"))).toBeTrue();
    expect(existsSync(path.join(nasDir, ".gitignore"))).toBeTrue();
  });

  test(".nas/.gitignore contains '*'", async () => {
    setup();
    await initConfig({ projectDir });
    const content = readFileSync(
      path.join(projectDir, ".nas", ".gitignore"),
      "utf8",
    );
    expect(content).toEqual("*\n");
  });

  test("skips existing files on second init (except Schema.pkl and eval.pkl)", async () => {
    setup();
    // First init
    await initConfig({ projectDir });
    // Second init
    const result = await initConfig({ projectDir });

    // .nas/Schema.pkl is always overwritten (ADR policy).
    // .nas/eval.pkl is always overwritten (CLI-managed).
    // Global Schema.pkl is skipped (same version).
    // global.pkl, config.pkl, PklProject, .gitignore are all skipped.
    expect(result.written).toContain(
      path.join(projectDir, ".nas", "Schema.pkl"),
    );
    expect(result.written).toContain(path.join(projectDir, ".nas", "eval.pkl"));
    expect(result.skipped).toContain(
      path.join(tmpDir, "xdg-config", "nas", "Schema.pkl"),
    );
    expect(result.skipped).toContain(
      path.join(tmpDir, "xdg-config", "nas", "global.pkl"),
    );
    expect(result.skipped).toContain(
      path.join(projectDir, ".nas", "config.pkl"),
    );
    expect(result.skipped).toContain(
      path.join(projectDir, ".nas", "PklProject"),
    );
    expect(result.skipped).toContain(
      path.join(projectDir, ".nas", ".gitignore"),
    );
  });

  test("global Schema.pkl is overwritten when bundled version is newer", async () => {
    setup();
    // Write an older Schema.pkl to global dir
    const globalDir = path.join(tmpDir, "xdg-config", "nas");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(
      path.join(globalDir, "Schema.pkl"),
      "/// @version 0.0.1\n/// old schema\nopen module nas.Config\n",
    );

    const result = await initConfig({ projectDir });

    // Global Schema.pkl should be overwritten (0.13.0 > 0.0.1)
    expect(result.written).toContain(path.join(globalDir, "Schema.pkl"));

    // Verify the content is the new bundled version
    const content = readFileSync(path.join(globalDir, "Schema.pkl"), "utf8");
    expect(content).toContain("@version 0.14.0");
  });

  test("global Schema.pkl is skipped when existing version is same or newer", async () => {
    setup();
    // Write a newer Schema.pkl to global dir
    const globalDir = path.join(tmpDir, "xdg-config", "nas");
    mkdirSync(globalDir, { recursive: true });
    const newerContent =
      "/// @version 99.0.0\n/// future schema\nopen module nas.Config\n";
    writeFileSync(path.join(globalDir, "Schema.pkl"), newerContent);

    const result = await initConfig({ projectDir });

    // Global Schema.pkl should be skipped
    expect(result.skipped).toContain(path.join(globalDir, "Schema.pkl"));

    // Verify the content was not changed
    const content = readFileSync(path.join(globalDir, "Schema.pkl"), "utf8");
    expect(content).toEqual(newerContent);
  });

  test("project .nas/Schema.pkl is always overwritten", async () => {
    setup();
    // Create .nas/Schema.pkl with old content
    const nasDir = path.join(projectDir, ".nas");
    mkdirSync(nasDir, { recursive: true });
    writeFileSync(
      path.join(nasDir, "Schema.pkl"),
      "/// @version 99.0.0\n/// custom\n",
    );

    const result = await initConfig({ projectDir });

    // Should be overwritten regardless of version
    expect(result.written).toContain(path.join(nasDir, "Schema.pkl"));
    const content = readFileSync(path.join(nasDir, "Schema.pkl"), "utf8");
    expect(content).toContain("@version 0.14.0");
  });

  test("global Schema.pkl is skipped when bundled Schema.pkl has no version", async () => {
    setup();

    // Pre-create global Schema.pkl with a version
    const globalDir = path.join(tmpDir, "xdg-config", "nas");
    mkdirSync(globalDir, { recursive: true });
    const existingContent =
      "/// @version 1.0.0\n/// existing schema\nopen module nas.Config\n";
    writeFileSync(path.join(globalDir, "Schema.pkl"), existingContent);

    // Create a fake asset directory with a versionless Schema.pkl
    const fakeAssetDir = path.join(tmpDir, "fake-assets");
    const fakeConfigDir = path.join(fakeAssetDir, "config");
    const fakeTemplatesDir = path.join(fakeConfigDir, "templates");
    mkdirSync(fakeTemplatesDir, { recursive: true });

    // Write a Schema.pkl without @version tag
    writeFileSync(
      path.join(fakeConfigDir, "Schema.pkl"),
      "/// no version tag\nopen module nas.Config\n",
    );

    // Copy template files from the real source tree
    const realTemplatesDir = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "templates",
    );
    for (const name of ["global.pkl", "config.pkl", "PklProject", "eval.pkl"]) {
      const content = readFileSync(path.join(realTemplatesDir, name), "utf8");
      writeFileSync(path.join(fakeTemplatesDir, name), content);
    }

    // Point NAS_ASSET_DIR to our fake assets so initConfig uses the
    // versionless Schema.pkl
    const originalAssetDir = process.env.NAS_ASSET_DIR;
    process.env.NAS_ASSET_DIR = fakeAssetDir;
    try {
      const result = await initConfig({ projectDir });

      // Global Schema.pkl should be skipped because bundledVersion is null
      expect(result.skipped).toContain(path.join(globalDir, "Schema.pkl"));

      // Verify the content was not changed
      const content = readFileSync(path.join(globalDir, "Schema.pkl"), "utf8");
      expect(content).toEqual(existingContent);
    } finally {
      // Restore NAS_ASSET_DIR
      if (originalAssetDir === undefined) {
        delete process.env.NAS_ASSET_DIR;
      } else {
        process.env.NAS_ASSET_DIR = originalAssetDir;
      }
    }
  });

  test("global Schema.pkl is skipped when existing Schema.pkl has no version", async () => {
    setup();
    // Write a Schema.pkl without a @version tag to global dir
    const globalDir = path.join(tmpDir, "xdg-config", "nas");
    mkdirSync(globalDir, { recursive: true });
    const versionlessContent =
      "/// no version tag here\nopen module nas.Config\n";
    writeFileSync(path.join(globalDir, "Schema.pkl"), versionlessContent);

    const result = await initConfig({ projectDir });

    // Global Schema.pkl should be skipped because existingVersion is null
    // (the condition requires both bundledVersion and existingVersion to be non-null)
    expect(result.skipped).toContain(path.join(globalDir, "Schema.pkl"));

    // Verify the content was not changed
    const content = readFileSync(path.join(globalDir, "Schema.pkl"), "utf8");
    expect(content).toEqual(versionlessContent);
  });

  test("project .nas/eval.pkl is always overwritten", async () => {
    setup();
    // Create .nas/eval.pkl with custom content
    const nasDir = path.join(projectDir, ".nas");
    mkdirSync(nasDir, { recursive: true });
    writeFileSync(path.join(nasDir, "eval.pkl"), "custom content\n");

    const result = await initConfig({ projectDir });

    // Should be overwritten regardless of existing content
    expect(result.written).toContain(path.join(nasDir, "eval.pkl"));
    const content = readFileSync(path.join(nasDir, "eval.pkl"), "utf8");
    // Should match the bundled template, not the custom content
    expect(content).not.toEqual("custom content\n");
    expect(content).toContain('import "config.pkl"');
  });

  test("does not overwrite existing config.pkl", async () => {
    setup();
    const nasDir = path.join(projectDir, ".nas");
    mkdirSync(nasDir, { recursive: true });
    const customContent = 'amends "Schema.pkl"\n// custom config\n';
    writeFileSync(path.join(nasDir, "config.pkl"), customContent);

    await initConfig({ projectDir });

    const content = readFileSync(path.join(nasDir, "config.pkl"), "utf8");
    expect(content).toEqual(customContent);
  });

  test("does not overwrite existing PklProject", async () => {
    setup();
    const nasDir = path.join(projectDir, ".nas");
    mkdirSync(nasDir, { recursive: true });
    const customContent = 'amends "pkl:Project"\n// custom\n';
    writeFileSync(path.join(nasDir, "PklProject"), customContent);

    await initConfig({ projectDir });

    const content = readFileSync(path.join(nasDir, "PklProject"), "utf8");
    expect(content).toEqual(customContent);
  });

  test("does not overwrite existing global.pkl", async () => {
    setup();
    const globalDir = path.join(tmpDir, "xdg-config", "nas");
    mkdirSync(globalDir, { recursive: true });
    const customContent = 'amends "Schema.pkl"\n// my custom global\n';
    writeFileSync(path.join(globalDir, "global.pkl"), customContent);

    await initConfig({ projectDir });

    const content = readFileSync(path.join(globalDir, "global.pkl"), "utf8");
    expect(content).toEqual(customContent);
  });
});
