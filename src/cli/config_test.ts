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
import { runConfigCommand } from "./config.ts";

describe("nas config", () => {
  test("errors when no subcommand is given", async () => {
    await expect(runConfigCommand([])).rejects.toThrow(
      "Unknown config subcommand: (none)",
    );
  });

  test("errors on unknown subcommand", async () => {
    await expect(runConfigCommand(["unknown"])).rejects.toThrow(
      "Unknown config subcommand: unknown",
    );
  });

  test("error message lists available subcommands", async () => {
    await expect(runConfigCommand(["bad"])).rejects.toThrow(
      "Available subcommands: init, migrate",
    );
  });

  describe("init subcommand", () => {
    let tmpDir: string;
    let originalCwd: string = process.cwd();
    let originalXdg: string | undefined;

    function setup() {
      tmpDir = mkdtempSync(path.join(tmpdir(), "nas-cli-config-test-"));
      const projectDir = path.join(tmpDir, "project");
      mkdirSync(projectDir, { recursive: true });
      originalCwd = process.cwd();
      process.chdir(projectDir);
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
      if (tmpDir) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("succeeds without throwing", async () => {
      setup();
      await expect(runConfigCommand(["init"])).resolves.toBeUndefined();
    });
  });

  describe("migrate subcommand", () => {
    let tmpDir: string;
    let originalCwd: string = process.cwd();
    let originalXdg: string | undefined;

    function setup() {
      tmpDir = mkdtempSync(path.join(tmpdir(), "nas-cli-migrate-test-"));
      const projectDir = path.join(tmpDir, "project");
      mkdirSync(projectDir, { recursive: true });
      originalCwd = process.cwd();
      process.chdir(projectDir);
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
      if (tmpDir) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("errors when no migrate subcommand is given", async () => {
      await expect(runConfigCommand(["migrate"])).rejects.toThrow(
        "Unknown migrate subcommand: (none)",
      );
    });

    test("errors on unknown migrate subcommand", async () => {
      await expect(runConfigCommand(["migrate", "unknown"])).rejects.toThrow(
        "Unknown migrate subcommand: unknown",
      );
    });

    test("error message lists available migrate subcommands", async () => {
      await expect(runConfigCommand(["migrate", "bad"])).rejects.toThrow(
        "Available subcommands: yml2pkl, nix2pkl",
      );
    });

    test("migrate yml2pkl converts YAML to Pkl in local mode", async () => {
      setup();
      const projectDir = process.cwd();
      const yamlContent =
        'default: "main"\nprofiles:\n  dev:\n    agent: claude\n';
      writeFileSync(path.join(projectDir, ".agent-sandbox.yml"), yamlContent);

      await runConfigCommand(["migrate", "yml2pkl"]);

      const outputPath = path.join(projectDir, ".nas", "config.pkl");
      expect(existsSync(outputPath)).toBe(true);
      const content = readFileSync(outputPath, "utf8");
      expect(content).toContain('amends "Schema.pkl"');
      expect(content).toContain('default = "main"');
    });

    test("migrate yml2pkl --force overwrites existing config.pkl", async () => {
      setup();
      const projectDir = process.cwd();
      const yamlContent =
        'default: "main"\nprofiles:\n  dev:\n    agent: claude\n';
      writeFileSync(path.join(projectDir, ".agent-sandbox.yml"), yamlContent);

      // Create an existing .nas/config.pkl that would block migration
      const nasDir = path.join(projectDir, ".nas");
      mkdirSync(nasDir, { recursive: true });
      writeFileSync(path.join(nasDir, "config.pkl"), "old content");

      // Without --force it should fail
      await expect(runConfigCommand(["migrate", "yml2pkl"])).rejects.toThrow(
        "already exists",
      );

      // With --force it should succeed
      await runConfigCommand(["migrate", "yml2pkl", "--force"]);

      const content = readFileSync(path.join(nasDir, "config.pkl"), "utf8");
      expect(content).toContain('amends "Schema.pkl"');
      expect(content).toContain('default = "main"');
    });

    test("migrate yml2pkl --input reads YAML from a custom path", async () => {
      setup();
      const projectDir = process.cwd();

      // Place YAML at an arbitrary path outside the project directory
      const customYamlPath = path.join(tmpDir, "custom-config.yml");
      const yamlContent =
        'default: "dev"\nprofiles:\n  dev:\n    agent: codex\n';
      writeFileSync(customYamlPath, yamlContent);

      await runConfigCommand(["migrate", "yml2pkl", "--input", customYamlPath]);

      const outputPath = path.join(projectDir, ".nas", "config.pkl");
      expect(existsSync(outputPath)).toBe(true);
      const content = readFileSync(outputPath, "utf8");
      expect(content).toContain('amends "Schema.pkl"');
      expect(content).toContain('default = "dev"');
    });

    test("migrate yml2pkl throws when no YAML file is found", async () => {
      setup();
      // No .agent-sandbox.yml is created — the command should throw
      await expect(runConfigCommand(["migrate", "yml2pkl"])).rejects.toThrow(
        "No .agent-sandbox.yml found",
      );
    });

    test("migrate yml2pkl --global converts YAML to Pkl in global mode", async () => {
      setup();
      const globalDir = path.join(tmpDir, "xdg-config", "nas");
      mkdirSync(globalDir, { recursive: true });
      const yamlContent = 'default: "main"\n';
      writeFileSync(path.join(globalDir, ".agent-sandbox.yml"), yamlContent);

      await runConfigCommand(["migrate", "yml2pkl", "--global"]);

      const outputPath = path.join(globalDir, "global.pkl");
      expect(existsSync(outputPath)).toBe(true);
      const content = readFileSync(outputPath, "utf8");
      expect(content).toContain('amends "Schema.pkl"');
      expect(content).toContain('default = "main"');
    });

    // nix2pkl tests — require `nix` on PATH
    let hasNix = false;
    try {
      const proc = Bun.spawnSync(["nix", "--version"]);
      hasNix = proc.exitCode === 0;
    } catch {}

    test.skipIf(!hasNix)(
      "migrate nix2pkl converts Nix to Pkl in local mode",
      async () => {
        setup();
        const projectDir = process.cwd();
        const nixContent =
          '{ default = "main"; profiles = { dev = { agent = "claude"; }; }; }';
        writeFileSync(path.join(projectDir, ".agent-sandbox.nix"), nixContent);

        await runConfigCommand(["migrate", "nix2pkl"]);

        const outputPath = path.join(projectDir, ".nas", "config.pkl");
        expect(existsSync(outputPath)).toBe(true);
        const content = readFileSync(outputPath, "utf8");
        expect(content).toContain('amends "Schema.pkl"');
        expect(content).toContain('default = "main"');
      },
    );

    test.skipIf(!hasNix)(
      "migrate nix2pkl rejects function-style Nix with guidance",
      async () => {
        setup();
        const projectDir = process.cwd();
        const nixContent = 'super: { default = "main"; }';
        writeFileSync(path.join(projectDir, ".agent-sandbox.nix"), nixContent);

        await expect(runConfigCommand(["migrate", "nix2pkl"])).rejects.toThrow(
          /function-style Nix config.*Migrate manually/s,
        );

        // No output should be written when rejected
        const outputPath = path.join(projectDir, ".nas", "config.pkl");
        expect(existsSync(outputPath)).toBe(false);
      },
    );

    test.skipIf(!hasNix)(
      "migrate nix2pkl --force overwrites existing config.pkl",
      async () => {
        setup();
        const projectDir = process.cwd();
        const nixContent =
          '{ default = "main"; profiles = { dev = { agent = "claude"; }; }; }';
        writeFileSync(path.join(projectDir, ".agent-sandbox.nix"), nixContent);

        // Create an existing .nas/config.pkl that would block migration
        const nasDir = path.join(projectDir, ".nas");
        mkdirSync(nasDir, { recursive: true });
        writeFileSync(path.join(nasDir, "config.pkl"), "old content");

        // Without --force it should fail
        await expect(runConfigCommand(["migrate", "nix2pkl"])).rejects.toThrow(
          "already exists",
        );

        // With --force it should succeed
        await runConfigCommand(["migrate", "nix2pkl", "--force"]);

        const content = readFileSync(path.join(nasDir, "config.pkl"), "utf8");
        expect(content).toContain('amends "Schema.pkl"');
        expect(content).toContain('default = "main"');
      },
    );

    test.skipIf(!hasNix)(
      "migrate nix2pkl --input reads Nix from a custom path",
      async () => {
        setup();
        const projectDir = process.cwd();

        // Place Nix file at an arbitrary path outside the project directory
        const customNixPath = path.join(tmpDir, "custom-config.nix");
        const nixContent =
          '{ default = "dev"; profiles = { dev = { agent = "codex"; }; }; }';
        writeFileSync(customNixPath, nixContent);

        await runConfigCommand([
          "migrate",
          "nix2pkl",
          "--input",
          customNixPath,
        ]);

        const outputPath = path.join(projectDir, ".nas", "config.pkl");
        expect(existsSync(outputPath)).toBe(true);
        const content = readFileSync(outputPath, "utf8");
        expect(content).toContain('amends "Schema.pkl"');
        expect(content).toContain('default = "dev"');
      },
    );

    test.skipIf(!hasNix)(
      "migrate nix2pkl --global converts Nix to Pkl in global mode",
      async () => {
        setup();
        const globalDir = path.join(tmpDir, "xdg-config", "nas");
        mkdirSync(globalDir, { recursive: true });
        const nixContent = '{ default = "main"; }';
        writeFileSync(path.join(globalDir, ".agent-sandbox.nix"), nixContent);

        await runConfigCommand(["migrate", "nix2pkl", "--global"]);

        const outputPath = path.join(globalDir, "global.pkl");
        expect(existsSync(outputPath)).toBe(true);
        const content = readFileSync(outputPath, "utf8");
        expect(content).toContain('amends "Schema.pkl"');
        expect(content).toContain('default = "main"');
      },
    );

    test.skipIf(!hasNix)(
      "migrate nix2pkl throws when no Nix file is found",
      async () => {
        setup();
        // No .agent-sandbox.nix is created — the command should throw
        await expect(runConfigCommand(["migrate", "nix2pkl"])).rejects.toThrow(
          "No .agent-sandbox.nix found",
        );
      },
    );
  });
});
