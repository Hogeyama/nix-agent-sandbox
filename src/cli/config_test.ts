import { describe, expect, test } from "bun:test";
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
});
