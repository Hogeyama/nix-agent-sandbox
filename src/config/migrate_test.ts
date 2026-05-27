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
import {
  buildNixJsonStringLiteral,
  findNixConfig,
  findYamlConfig,
  migrateNix2Pkl,
  migrateYml2Pkl,
  normalizeEnvSnakeCaseKeys,
  objectToPklSource,
} from "./migrate.ts";

// ---------------------------------------------------------------------------
// objectToPklSource
// ---------------------------------------------------------------------------

describe("objectToPklSource", () => {
  test("empty object produces header only", () => {
    expect(objectToPklSource({})).toEqual('amends "Schema.pkl"\n');
  });

  test("simple string field", () => {
    const result = objectToPklSource({ default: "main" });
    expect(result).toEqual('amends "Schema.pkl"\n\ndefault = "main"\n');
  });

  test("boolean and number fields", () => {
    const result = objectToPklSource({ ui: { enable: true, port: 3939 } });
    expect(result).toContain("ui {");
    expect(result).toContain("  enable = true");
    expect(result).toContain("  port = 3939");
  });

  test("kebab-case keys are converted to camelCase", () => {
    const result = objectToPklSource({
      profiles: {
        dev: {
          "agent-args": ["--verbose"],
          "mount-socket": true,
        },
      },
    });
    expect(result).toContain("agentArgs");
    expect(result).not.toContain("agent-args");
    expect(result).toContain("mountSocket");
    expect(result).not.toContain("mount-socket");
  });

  test("profiles keys use bracket notation (Mapping)", () => {
    const result = objectToPklSource({
      profiles: {
        dev: { agent: "claude" },
      },
    });
    expect(result).toContain('["dev"]');
  });

  test("hostexec.secrets keys use bracket notation (Mapping)", () => {
    const result = objectToPklSource({
      profiles: {
        dev: {
          hostexec: {
            secrets: {
              "my-secret": { from: "env", required: true },
            },
          },
        },
      },
    });
    expect(result).toContain('["my-secret"]');
  });

  test("hostexec.rules.*.env keys use bracket notation (Mapping)", () => {
    const result = objectToPklSource({
      profiles: {
        dev: {
          hostexec: {
            rules: [
              {
                id: "r1",
                env: { FOO: "bar", BAZ: "qux" },
              },
            ],
          },
        },
      },
    });
    expect(result).toContain('["FOO"] = "bar"');
    expect(result).toContain('["BAZ"] = "qux"');
  });

  test("arrays produce Listing syntax", () => {
    const result = objectToPklSource({
      profiles: {
        dev: {
          "extra-packages": ["git", "curl"],
        },
      },
    });
    expect(result).toContain("new Listing {");
    expect(result).toContain('"git"');
    expect(result).toContain('"curl"');
  });

  test("empty array produces empty Listing", () => {
    const result = objectToPklSource({
      profiles: {
        dev: {
          "extra-packages": [],
        },
      },
    });
    expect(result).toContain("new Listing {}");
  });

  test("null and undefined values are omitted", () => {
    const result = objectToPklSource({
      default: null,
      ui: { enable: true, port: undefined },
    });
    expect(result).not.toContain("default");
    expect(result).not.toContain("port");
    expect(result).toContain("enable = true");
  });

  test("string escaping", () => {
    const result = objectToPklSource({
      profiles: {
        dev: {
          session: { "detach-key": '^"\\n' },
        },
      },
    });
    expect(result).toContain('detachKey = "^\\"\\\\n"');
  });

  test("array of objects produces nested Listing", () => {
    const result = objectToPklSource({
      profiles: {
        dev: {
          "extra-mounts": [
            { src: "/host/path", dst: "/container/path", mode: "ro" },
          ],
        },
      },
    });
    expect(result).toContain("new Listing {");
    expect(result).toContain('src = "/host/path"');
    expect(result).toContain('dst = "/container/path"');
    expect(result).toContain('mode = "ro"');
  });

  test("empty nested object produces empty block", () => {
    const result = objectToPklSource({
      ui: {},
    });
    expect(result).toContain("ui {}");
  });

  test("keys needing bracket notation get it", () => {
    const result = objectToPklSource({
      ui: { "with-hyphen": true },
    });
    // "with-hyphen" is not in KEBAB_KEYS, so it should use bracket notation
    expect(result).toContain('["with-hyphen"] = true');
  });

  test("null items in arrays are filtered out", () => {
    const result = objectToPklSource({
      profiles: {
        dev: {
          "extra-packages": ["git", null, "curl"],
        },
      },
    });
    expect(result).toContain('"git"');
    expect(result).toContain('"curl"');
    // Should not contain "null" as a value
    const lines = result.split("\n");
    const listingLines = lines.filter(
      (l) => l.trim() !== "" && !l.includes("Listing") && !l.includes("}"),
    );
    for (const l of listingLines) {
      expect(l).not.toContain("null");
    }
  });

  test("custom amendsHeader is used in output", () => {
    const result = objectToPklSource(
      { default: "main" },
      { amendsHeader: "modulepath:/global.pkl" },
    );
    expect(result).toContain('amends "modulepath:/global.pkl"');
    expect(result).not.toContain("Schema.pkl");
    expect(result).toContain('default = "main"');
  });

  test("omitting amendsHeader defaults to Schema.pkl", () => {
    const result = objectToPklSource({ default: "main" });
    expect(result).toContain('amends "Schema.pkl"');
  });
});

// ---------------------------------------------------------------------------
// buildNixJsonStringLiteral
// ---------------------------------------------------------------------------

describe("buildNixJsonStringLiteral", () => {
  test("simple path", () => {
    const result = buildNixJsonStringLiteral("/home/user/.agent-sandbox.nix");
    // Double-encoded: inner JSON.stringify produces '"/home/user/.agent-sandbox.nix"',
    // outer wraps it as '"\\"/home/user/.agent-sandbox.nix\\""'
    const outer = JSON.parse(result) as string;
    const inner = JSON.parse(outer) as string;
    expect(inner).toEqual("/home/user/.agent-sandbox.nix");
  });

  test("path containing double quotes", () => {
    const result = buildNixJsonStringLiteral('/path/with"quotes');
    const outer = JSON.parse(result) as string;
    const inner = JSON.parse(outer) as string;
    expect(inner).toEqual('/path/with"quotes');
  });

  test("path containing backslashes", () => {
    const result = buildNixJsonStringLiteral("C:\\Users\\foo\\file.nix");
    const outer = JSON.parse(result) as string;
    const inner = JSON.parse(outer) as string;
    expect(inner).toEqual("C:\\Users\\foo\\file.nix");
  });

  test("path containing newlines", () => {
    const result = buildNixJsonStringLiteral("/path/with\nnewline");
    const outer = JSON.parse(result) as string;
    const inner = JSON.parse(outer) as string;
    expect(inner).toEqual("/path/with\nnewline");
  });

  test("path containing Nix interpolation", () => {
    const nixInterp = `/path/${"$"}{builtins.getEnv}/evil`;
    const result = buildNixJsonStringLiteral(nixInterp);
    const outer = JSON.parse(result) as string;
    const inner = JSON.parse(outer) as string;
    expect(inner).toEqual(nixInterp);
    // The result is a JSON string passed to builtins.fromJSON, so Nix
    // interpolation cannot occur -- the value is never interpreted as a
    // Nix string literal directly.
  });

  test("empty string", () => {
    const result = buildNixJsonStringLiteral("");
    const outer = JSON.parse(result) as string;
    const inner = JSON.parse(outer) as string;
    expect(inner).toEqual("");
  });

  test("path with mixed special characters", () => {
    const value = '/a "b\\\nc ' + "$" + "{d}";
    const result = buildNixJsonStringLiteral(value);
    const outer = JSON.parse(result) as string;
    const inner = JSON.parse(outer) as string;
    expect(inner).toEqual(value);
  });
});

// ---------------------------------------------------------------------------
// normalizeEnvSnakeCaseKeys
// ---------------------------------------------------------------------------

describe("normalizeEnvSnakeCaseKeys", () => {
  test("returns input unchanged when no profiles", () => {
    const raw = { default: "main" };
    expect(normalizeEnvSnakeCaseKeys(raw)).toEqual({ default: "main" });
  });

  test("returns input unchanged when profile has no env", () => {
    const raw = {
      profiles: {
        dev: { agent: "claude" },
      },
    };
    const result = normalizeEnvSnakeCaseKeys(raw);
    expect(result).toEqual(raw);
  });

  test("converts key_cmd to keyCmd", () => {
    const raw = {
      profiles: {
        dev: {
          agent: "claude",
          env: [{ key_cmd: "echo FOO", val: "bar", mode: "set" }],
        },
      },
    };
    const result = normalizeEnvSnakeCaseKeys(raw);
    const env = (result.profiles as Record<string, Record<string, unknown>>).dev
      .env as Record<string, unknown>[];
    expect(env[0]).toEqual({ keyCmd: "echo FOO", val: "bar", mode: "set" });
    expect(env[0]).not.toHaveProperty("key_cmd");
  });

  test("converts val_cmd to valCmd", () => {
    const raw = {
      profiles: {
        dev: {
          agent: "claude",
          env: [{ key: "FOO", val_cmd: "echo bar", mode: "set" }],
        },
      },
    };
    const result = normalizeEnvSnakeCaseKeys(raw);
    const env = (result.profiles as Record<string, Record<string, unknown>>).dev
      .env as Record<string, unknown>[];
    expect(env[0]).toEqual({ key: "FOO", valCmd: "echo bar", mode: "set" });
    expect(env[0]).not.toHaveProperty("val_cmd");
  });

  test("converts both key_cmd and val_cmd together", () => {
    const raw = {
      profiles: {
        dev: {
          agent: "claude",
          env: [{ key_cmd: "echo KEY", val_cmd: "echo VAL", mode: "set" }],
        },
      },
    };
    const result = normalizeEnvSnakeCaseKeys(raw);
    const env = (result.profiles as Record<string, Record<string, unknown>>).dev
      .env as Record<string, unknown>[];
    expect(env[0]).toEqual({
      keyCmd: "echo KEY",
      valCmd: "echo VAL",
      mode: "set",
    });
  });

  test("leaves camelCase keys unchanged", () => {
    const raw = {
      profiles: {
        dev: {
          agent: "claude",
          env: [{ keyCmd: "echo KEY", valCmd: "echo VAL", mode: "set" }],
        },
      },
    };
    const result = normalizeEnvSnakeCaseKeys(raw);
    const env = (result.profiles as Record<string, Record<string, unknown>>).dev
      .env as Record<string, unknown>[];
    expect(env[0]).toEqual({
      keyCmd: "echo KEY",
      valCmd: "echo VAL",
      mode: "set",
    });
  });

  test("handles multiple profiles", () => {
    const raw = {
      profiles: {
        dev: {
          agent: "claude",
          env: [{ key_cmd: "cmd1", val: "v1", mode: "set" }],
        },
        prod: {
          agent: "copilot",
          env: [{ key: "K", val_cmd: "cmd2", mode: "set" }],
        },
      },
    };
    const result = normalizeEnvSnakeCaseKeys(raw);
    const profiles = result.profiles as Record<string, Record<string, unknown>>;
    const devEnv = profiles.dev.env as Record<string, unknown>[];
    const prodEnv = profiles.prod.env as Record<string, unknown>[];
    expect(devEnv[0]).toHaveProperty("keyCmd", "cmd1");
    expect(prodEnv[0]).toHaveProperty("valCmd", "cmd2");
  });

  test("does not mutate original object", () => {
    const raw = {
      profiles: {
        dev: {
          agent: "claude",
          env: [{ key_cmd: "echo FOO", val: "bar", mode: "set" }],
        },
      },
    };
    normalizeEnvSnakeCaseKeys(raw);
    // Original should still have key_cmd
    const env = (raw.profiles as Record<string, Record<string, unknown>>).dev
      .env as Record<string, unknown>[];
    expect(env[0]).toHaveProperty("key_cmd");
  });

  test("preserves non-env profile fields", () => {
    const raw = {
      profiles: {
        dev: {
          agent: "claude",
          session: { multiplex: true },
          env: [{ key: "A", val: "B", mode: "set" }],
        },
      },
    };
    const result = normalizeEnvSnakeCaseKeys(raw);
    const profile = (result.profiles as Record<string, Record<string, unknown>>)
      .dev;
    expect(profile.agent).toEqual("claude");
    expect(profile.session).toEqual({ multiplex: true });
  });
});

// ---------------------------------------------------------------------------
// findYamlConfig
// ---------------------------------------------------------------------------

describe("findYamlConfig", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = mkdtempSync(path.join(tmpdir(), "nas-migrate-find-"));
  }

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test("finds .agent-sandbox.yml in the start directory", async () => {
    setup();
    const ymlPath = path.join(tmpDir, ".agent-sandbox.yml");
    writeFileSync(ymlPath, "default: main\n");

    const result = await findYamlConfig(tmpDir);
    expect(result).toEqual(ymlPath);
  });

  test("finds .agent-sandbox.yml in a parent directory", async () => {
    setup();
    const ymlPath = path.join(tmpDir, ".agent-sandbox.yml");
    writeFileSync(ymlPath, "default: main\n");

    const childDir = path.join(tmpDir, "a", "b", "c");
    mkdirSync(childDir, { recursive: true });

    const result = await findYamlConfig(childDir);
    expect(result).toEqual(ymlPath);
  });

  test("returns null when no .agent-sandbox.yml exists", async () => {
    setup();
    const childDir = path.join(tmpDir, "empty", "dir");
    mkdirSync(childDir, { recursive: true });

    const result = await findYamlConfig(childDir);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findNixConfig
// ---------------------------------------------------------------------------

describe("findNixConfig", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = mkdtempSync(path.join(tmpdir(), "nas-migrate-findnix-"));
  }

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test("finds .agent-sandbox.nix in the start directory", async () => {
    setup();
    const nixPath = path.join(tmpDir, ".agent-sandbox.nix");
    writeFileSync(nixPath, "{ }\n");

    const result = await findNixConfig(tmpDir);
    expect(result).toEqual(nixPath);
  });

  test("finds .agent-sandbox.nix in a parent directory", async () => {
    setup();
    const nixPath = path.join(tmpDir, ".agent-sandbox.nix");
    writeFileSync(nixPath, "{ }\n");

    const childDir = path.join(tmpDir, "a", "b", "c");
    mkdirSync(childDir, { recursive: true });

    const result = await findNixConfig(childDir);
    expect(result).toEqual(nixPath);
  });

  test("returns null when no .agent-sandbox.nix exists", async () => {
    setup();
    const childDir = path.join(tmpDir, "empty", "dir");
    mkdirSync(childDir, { recursive: true });

    const result = await findNixConfig(childDir);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// migrateYml2Pkl
// ---------------------------------------------------------------------------

describe("migrateYml2Pkl", () => {
  let tmpDir: string;
  let originalCwd: string;
  let originalXdg: string | undefined;

  function setup() {
    tmpDir = mkdtempSync(path.join(tmpdir(), "nas-migrate-test-"));
    originalCwd = process.cwd();
    originalXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, "xdg-config");
  }

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdg;
    }
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  // -- Local mode -----------------------------------------------------------

  describe("local mode", () => {
    test("migrates YAML to .nas/config.pkl with scaffold", async () => {
      setup();
      const projectDir = path.join(tmpDir, "project");
      mkdirSync(projectDir, { recursive: true });

      // Place .agent-sandbox.yml in project dir
      const ymlPath = path.join(projectDir, ".agent-sandbox.yml");
      writeFileSync(ymlPath, "default: main\n");

      process.chdir(projectDir);
      const result = await migrateYml2Pkl({});

      expect(result.inputPath).toEqual(ymlPath);
      expect(result.outputPath).toEqual(
        path.join(projectDir, ".nas", "config.pkl"),
      );
      expect(result.scaffoldResult).toBeDefined();

      // Verify the output file content
      const content = readFileSync(result.outputPath, "utf8");
      expect(content).toContain('amends "Schema.pkl"');
      expect(content).toContain('default = "main"');
    });

    test("errors when output already exists", async () => {
      setup();
      const projectDir = path.join(tmpDir, "project");
      const nasDir = path.join(projectDir, ".nas");
      mkdirSync(nasDir, { recursive: true });

      // Place .agent-sandbox.yml
      writeFileSync(
        path.join(projectDir, ".agent-sandbox.yml"),
        "default: main\n",
      );

      // Pre-create output
      writeFileSync(path.join(nasDir, "config.pkl"), "existing content\n");

      process.chdir(projectDir);
      await expect(migrateYml2Pkl({})).rejects.toThrow(
        /Output file already exists.*--force/,
      );
    });

    test("--force overwrites existing output", async () => {
      setup();
      const projectDir = path.join(tmpDir, "project");
      const nasDir = path.join(projectDir, ".nas");
      mkdirSync(nasDir, { recursive: true });

      writeFileSync(
        path.join(projectDir, ".agent-sandbox.yml"),
        "default: dev\n",
      );
      writeFileSync(path.join(nasDir, "config.pkl"), "old content\n");

      process.chdir(projectDir);
      const result = await migrateYml2Pkl({ force: true });

      const content = readFileSync(result.outputPath, "utf8");
      expect(content).toContain('default = "dev"');
      expect(content).not.toContain("old content");
    });

    test("errors when YAML is not found", async () => {
      setup();
      const projectDir = path.join(tmpDir, "empty-project");
      mkdirSync(projectDir, { recursive: true });

      process.chdir(projectDir);
      await expect(migrateYml2Pkl({})).rejects.toThrow(
        /No \.agent-sandbox\.yml found/,
      );
    });
  });

  // -- Global mode ----------------------------------------------------------

  describe("global mode", () => {
    test("migrates YAML to global.pkl and creates Schema.pkl", async () => {
      setup();
      const globalDir = path.join(tmpDir, "xdg-config", "nas");
      mkdirSync(globalDir, { recursive: true });

      // Place global YAML
      writeFileSync(
        path.join(globalDir, ".agent-sandbox.yml"),
        "default: prod\n",
      );

      // Use a dummy cwd (should not matter for global mode)
      const projectDir = path.join(tmpDir, "project");
      mkdirSync(projectDir, { recursive: true });
      process.chdir(projectDir);

      const result = await migrateYml2Pkl({ global: true });

      expect(result.inputPath).toEqual(
        path.join(globalDir, ".agent-sandbox.yml"),
      );
      expect(result.outputPath).toEqual(path.join(globalDir, "global.pkl"));
      expect(result.scaffoldResult).toBeUndefined();

      // Verify output
      const content = readFileSync(result.outputPath, "utf8");
      expect(content).toContain('amends "Schema.pkl"');
      expect(content).toContain('default = "prod"');

      // Schema.pkl should have been created
      expect(existsSync(path.join(globalDir, "Schema.pkl"))).toBeTrue();
    });

    test("errors when output already exists", async () => {
      setup();
      const globalDir = path.join(tmpDir, "xdg-config", "nas");
      mkdirSync(globalDir, { recursive: true });

      writeFileSync(
        path.join(globalDir, ".agent-sandbox.yml"),
        "default: prod\n",
      );
      writeFileSync(path.join(globalDir, "global.pkl"), "existing\n");

      process.chdir(tmpDir);
      await expect(migrateYml2Pkl({ global: true })).rejects.toThrow(
        /Output file already exists.*--force/,
      );
    });

    test("--force overwrites existing output", async () => {
      setup();
      const globalDir = path.join(tmpDir, "xdg-config", "nas");
      mkdirSync(globalDir, { recursive: true });

      writeFileSync(
        path.join(globalDir, ".agent-sandbox.yml"),
        "default: staging\n",
      );
      writeFileSync(path.join(globalDir, "global.pkl"), "old\n");

      process.chdir(tmpDir);
      const result = await migrateYml2Pkl({ global: true, force: true });

      const content = readFileSync(result.outputPath, "utf8");
      expect(content).toContain('default = "staging"');
    });

    test("errors when YAML is not found", async () => {
      setup();
      // Don't create any YAML file in global dir
      process.chdir(tmpDir);
      await expect(migrateYml2Pkl({ global: true })).rejects.toThrow(
        /YAML config file not found/,
      );
    });

    test("does not overwrite existing Schema.pkl", async () => {
      setup();
      const globalDir = path.join(tmpDir, "xdg-config", "nas");
      mkdirSync(globalDir, { recursive: true });

      const existingSchema = "/// existing schema\n";
      writeFileSync(path.join(globalDir, "Schema.pkl"), existingSchema);
      writeFileSync(
        path.join(globalDir, ".agent-sandbox.yml"),
        "default: main\n",
      );

      process.chdir(tmpDir);
      await migrateYml2Pkl({ global: true });

      // Schema.pkl should not be overwritten
      const content = readFileSync(path.join(globalDir, "Schema.pkl"), "utf8");
      expect(content).toEqual(existingSchema);
    });

    test("overwrites existing Schema.pkl when bundled version is newer", async () => {
      setup();
      const globalDir = path.join(tmpDir, "xdg-config", "nas");
      mkdirSync(globalDir, { recursive: true });

      // Pre-create Schema.pkl with an older version
      const oldSchema =
        "/// @version 0.0.1\n/// old schema\nopen module nas.Config\n";
      writeFileSync(path.join(globalDir, "Schema.pkl"), oldSchema);
      writeFileSync(
        path.join(globalDir, ".agent-sandbox.yml"),
        "default: main\n",
      );

      process.chdir(tmpDir);
      await migrateYml2Pkl({ global: true });

      // Schema.pkl should be overwritten (bundled 0.14.0 > 0.0.1)
      const content = readFileSync(path.join(globalDir, "Schema.pkl"), "utf8");
      expect(content).not.toEqual(oldSchema);
      expect(content).toContain("@version 0.14.0");
    });

    test("does not overwrite existing Schema.pkl when existing version is newer", async () => {
      setup();
      const globalDir = path.join(tmpDir, "xdg-config", "nas");
      mkdirSync(globalDir, { recursive: true });

      // Pre-create Schema.pkl with a newer version
      const newerSchema =
        "/// @version 999.0.0\n/// future schema\nopen module nas.Config\n";
      writeFileSync(path.join(globalDir, "Schema.pkl"), newerSchema);
      writeFileSync(
        path.join(globalDir, ".agent-sandbox.yml"),
        "default: main\n",
      );

      process.chdir(tmpDir);
      await migrateYml2Pkl({ global: true });

      // Schema.pkl should NOT be overwritten (999.0.0 > 0.14.0)
      const content = readFileSync(path.join(globalDir, "Schema.pkl"), "utf8");
      expect(content).toEqual(newerSchema);
    });
  });

  // -- --input option -------------------------------------------------------

  describe("--input option", () => {
    test("uses specified input but writes to local mode default output", async () => {
      setup();
      const projectDir = path.join(tmpDir, "project");
      mkdirSync(projectDir, { recursive: true });

      // Put YAML in a custom location
      const customYaml = path.join(tmpDir, "custom", "my-config.yml");
      mkdirSync(path.dirname(customYaml), { recursive: true });
      writeFileSync(customYaml, "default: custom\n");

      process.chdir(projectDir);
      const result = await migrateYml2Pkl({ inputPath: customYaml });

      expect(result.inputPath).toEqual(customYaml);
      // Output should be in cwd's .nas/config.pkl, not near the input
      expect(result.outputPath).toEqual(
        path.join(projectDir, ".nas", "config.pkl"),
      );

      const content = readFileSync(result.outputPath, "utf8");
      expect(content).toContain('default = "custom"');
    });

    test("uses specified input but writes to global mode default output", async () => {
      setup();
      const globalDir = path.join(tmpDir, "xdg-config", "nas");

      const customYaml = path.join(tmpDir, "custom", "my-global.yml");
      mkdirSync(path.dirname(customYaml), { recursive: true });
      writeFileSync(customYaml, "default: from-custom\n");

      process.chdir(tmpDir);
      const result = await migrateYml2Pkl({
        global: true,
        inputPath: customYaml,
      });

      expect(result.inputPath).toEqual(customYaml);
      // Output should be in global dir, not near the input
      expect(result.outputPath).toEqual(path.join(globalDir, "global.pkl"));

      const content = readFileSync(result.outputPath, "utf8");
      expect(content).toContain('default = "from-custom"');
    });
  });

  // -- YAML parsing edge cases ----------------------------------------------

  describe("YAML parsing", () => {
    test("wraps YAML parse errors with file path", async () => {
      setup();
      const projectDir = path.join(tmpDir, "project");
      mkdirSync(projectDir, { recursive: true });

      const ymlPath = path.join(projectDir, ".agent-sandbox.yml");
      writeFileSync(ymlPath, "---\n{invalid:: yaml:: content");

      process.chdir(projectDir);
      await expect(migrateYml2Pkl({})).rejects.toThrow(
        new RegExp(
          `Failed to parse YAML in ${ymlPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        ),
      );
    });

    test("errors when YAML top-level is an array", async () => {
      setup();
      const projectDir = path.join(tmpDir, "project");
      mkdirSync(projectDir, { recursive: true });

      writeFileSync(
        path.join(projectDir, ".agent-sandbox.yml"),
        "- item1\n- item2\n",
      );

      process.chdir(projectDir);
      await expect(migrateYml2Pkl({})).rejects.toThrow(
        /Expected an object.*got an array/,
      );
    });

    test("errors when YAML top-level is a scalar", async () => {
      setup();
      const projectDir = path.join(tmpDir, "project");
      mkdirSync(projectDir, { recursive: true });

      writeFileSync(
        path.join(projectDir, ".agent-sandbox.yml"),
        "just a string\n",
      );

      process.chdir(projectDir);
      await expect(migrateYml2Pkl({})).rejects.toThrow(
        /Expected an object.*got string/,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// migrateNix2Pkl
// ---------------------------------------------------------------------------

let hasNix = false;
try {
  const proc = Bun.spawnSync(["nix", "--version"]);
  hasNix = proc.exitCode === 0;
} catch {}

describe("migrateNix2Pkl", () => {
  let tmpDir: string;
  let originalCwd: string;
  let originalXdg: string | undefined;

  function setup() {
    tmpDir = mkdtempSync(path.join(tmpdir(), "nas-migrate-nix-"));
    originalCwd = process.cwd();
    originalXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, "xdg-config");
  }

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdg;
    }
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  // -- Local mode -----------------------------------------------------------

  describe("local mode", () => {
    test.skipIf(!hasNix)("plain attrset -> amends Schema.pkl", async () => {
      setup();
      const projectDir = path.join(tmpDir, "project");
      mkdirSync(projectDir, { recursive: true });

      // Plain attrset (not a function)
      const nixPath = path.join(projectDir, ".agent-sandbox.nix");
      writeFileSync(nixPath, '{ default = "main"; }\n');

      process.chdir(projectDir);
      const result = await migrateNix2Pkl({});

      expect(result.inputPath).toEqual(nixPath);
      expect(result.outputPath).toEqual(
        path.join(projectDir, ".nas", "config.pkl"),
      );
      expect(result.isFunction).toBe(false);
      expect(result.scaffoldResult).toBeDefined();

      // Verify the output file content
      const content = readFileSync(result.outputPath, "utf8");
      expect(content).toContain('amends "Schema.pkl"');
      expect(content).toContain('default = "main"');
    });

    test.skipIf(!hasNix)(
      "function -> amends modulepath:/global.pkl",
      async () => {
        setup();
        const projectDir = path.join(tmpDir, "project");
        mkdirSync(projectDir, { recursive: true });

        // Function that takes an attrset and returns config
        const nixPath = path.join(projectDir, ".agent-sandbox.nix");
        writeFileSync(nixPath, '{ ... }: { default = "dev"; }\n');

        process.chdir(projectDir);
        const result = await migrateNix2Pkl({});

        expect(result.inputPath).toEqual(nixPath);
        expect(result.isFunction).toBe(true);

        const content = readFileSync(result.outputPath, "utf8");
        expect(content).toContain('amends "modulepath:/global.pkl"');
        expect(content).toContain('default = "dev"');
      },
    );

    test.skipIf(!hasNix)("--force overwrites existing output", async () => {
      setup();
      const projectDir = path.join(tmpDir, "project");
      const nasDir = path.join(projectDir, ".nas");
      mkdirSync(nasDir, { recursive: true });

      writeFileSync(
        path.join(projectDir, ".agent-sandbox.nix"),
        '{ default = "new"; }\n',
      );
      writeFileSync(path.join(nasDir, "config.pkl"), "old content\n");

      process.chdir(projectDir);
      const result = await migrateNix2Pkl({ force: true });

      const content = readFileSync(result.outputPath, "utf8");
      expect(content).toContain('default = "new"');
      expect(content).not.toContain("old content");
    });

    test.skipIf(!hasNix)("errors when output already exists", async () => {
      setup();
      const projectDir = path.join(tmpDir, "project");
      const nasDir = path.join(projectDir, ".nas");
      mkdirSync(nasDir, { recursive: true });

      writeFileSync(
        path.join(projectDir, ".agent-sandbox.nix"),
        '{ default = "main"; }\n',
      );
      writeFileSync(path.join(nasDir, "config.pkl"), "existing content\n");

      process.chdir(projectDir);
      await expect(migrateNix2Pkl({})).rejects.toThrow(
        /Output file already exists.*--force/,
      );
    });

    test.skipIf(!hasNix)("errors when .nix is not found", async () => {
      setup();
      const projectDir = path.join(tmpDir, "empty-project");
      mkdirSync(projectDir, { recursive: true });

      process.chdir(projectDir);
      await expect(migrateNix2Pkl({})).rejects.toThrow(
        /No \.agent-sandbox\.nix found/,
      );
    });

    test.skipIf(!hasNix)("isFunction is included in result", async () => {
      setup();
      const projectDir = path.join(tmpDir, "project");
      mkdirSync(projectDir, { recursive: true });

      // Plain attrset
      writeFileSync(
        path.join(projectDir, ".agent-sandbox.nix"),
        '{ default = "main"; }\n',
      );

      process.chdir(projectDir);
      const result = await migrateNix2Pkl({});
      expect(result).toHaveProperty("isFunction");
      expect(typeof result.isFunction).toBe("boolean");
    });
  });

  // -- Global mode ----------------------------------------------------------

  describe("global mode", () => {
    test.skipIf(!hasNix)(
      "migrates Nix to global.pkl and creates Schema.pkl",
      async () => {
        setup();
        const globalDir = path.join(tmpDir, "xdg-config", "nas");
        mkdirSync(globalDir, { recursive: true });

        // Place global Nix file
        writeFileSync(
          path.join(globalDir, ".agent-sandbox.nix"),
          '{ default = "prod"; }\n',
        );

        // Use a dummy cwd (should not matter for global mode)
        const projectDir = path.join(tmpDir, "project");
        mkdirSync(projectDir, { recursive: true });
        process.chdir(projectDir);

        const result = await migrateNix2Pkl({ global: true });

        expect(result.inputPath).toEqual(
          path.join(globalDir, ".agent-sandbox.nix"),
        );
        expect(result.outputPath).toEqual(path.join(globalDir, "global.pkl"));
        expect(result.scaffoldResult).toBeUndefined();

        // Verify output — global always amends Schema.pkl
        const content = readFileSync(result.outputPath, "utf8");
        expect(content).toContain('amends "Schema.pkl"');
        expect(content).toContain('default = "prod"');

        // Schema.pkl should have been created
        expect(existsSync(path.join(globalDir, "Schema.pkl"))).toBeTrue();
      },
    );

    test.skipIf(!hasNix)("errors when output already exists", async () => {
      setup();
      const globalDir = path.join(tmpDir, "xdg-config", "nas");
      mkdirSync(globalDir, { recursive: true });

      writeFileSync(
        path.join(globalDir, ".agent-sandbox.nix"),
        '{ default = "prod"; }\n',
      );
      writeFileSync(path.join(globalDir, "global.pkl"), "existing\n");

      process.chdir(tmpDir);
      await expect(migrateNix2Pkl({ global: true })).rejects.toThrow(
        /Output file already exists.*--force/,
      );
    });

    test.skipIf(!hasNix)("--force overwrites existing output", async () => {
      setup();
      const globalDir = path.join(tmpDir, "xdg-config", "nas");
      mkdirSync(globalDir, { recursive: true });

      writeFileSync(
        path.join(globalDir, ".agent-sandbox.nix"),
        '{ default = "staging"; }\n',
      );
      writeFileSync(path.join(globalDir, "global.pkl"), "old\n");

      process.chdir(tmpDir);
      const result = await migrateNix2Pkl({ global: true, force: true });

      const content = readFileSync(result.outputPath, "utf8");
      expect(content).toContain('default = "staging"');
    });

    test.skipIf(!hasNix)("errors when .nix is not found", async () => {
      setup();
      // Don't create any Nix file in global dir
      process.chdir(tmpDir);
      await expect(migrateNix2Pkl({ global: true })).rejects.toThrow(
        /Failed to evaluate/,
      );
    });
  });
});
