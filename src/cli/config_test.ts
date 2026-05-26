import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
      "Available subcommands: init",
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
});
