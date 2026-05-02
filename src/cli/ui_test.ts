/**
 * Tests for `runUiCommand` dispatch — focuses on the migration seam:
 * migration must NOT run on the `nas ui stop` path.
 */

import { describe, expect, test } from "bun:test";
import type { MigrationOutcome } from "../ui/state_migration.ts";
import { runUiCommand } from "./ui.ts";

describe("runUiCommand dispatch", () => {
  test("does not invoke migrate when subcommand is `stop`", async () => {
    let migrateCalls = 0;
    let stopCalls = 0;
    const seenPorts: number[] = [];

    const migrate = (): Promise<MigrationOutcome> => {
      migrateCalls++;
      return Promise.resolve({ kind: "noop" });
    };
    const stop = (options: { port: number }): Promise<void> => {
      stopCalls++;
      seenPorts.push(options.port);
      return Promise.resolve();
    };

    await runUiCommand(["stop", "--port", "3939"], { migrate, stop });

    expect(migrateCalls).toBe(0);
    expect(stopCalls).toBe(1);
    expect(seenPorts).toEqual([3939]);
  });
});
