import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  HostExecProcessDiagnostics,
  parseLinuxProcStat,
} from "./process_diagnostics.ts";

test("parseLinuxProcStat: parses identifiers when comm contains spaces and parentheses", () => {
  const identity = parseLinuxProcStat(
    "4321 (forgejo worker (web)) S 123 456 789 34817 456 0 0 0",
  );

  expect(identity).toEqual({
    pid: 4321,
    comm: "forgejo worker (web)",
    state: "S",
    ppid: 123,
    processGroupId: 456,
    sessionId: 789,
    ttyNumber: 34817,
    foregroundProcessGroupId: 456,
  });
});

test("HostExecProcessDiagnostics: appends one JSON object per line", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-diag-"));
  try {
    const diagnostics = new HostExecProcessDiagnostics(
      runtimeDir,
      "sess/example",
    );
    await diagnostics.record("command_spawned", {
      requestId: "req-1",
      command: "forgejow",
      argumentCount: 2,
      process: {
        pid: 4321,
        comm: "forgejow",
        state: "S",
        ppid: 123,
        processGroupId: 456,
        sessionId: 789,
        ttyNumber: 34817,
        foregroundProcessGroupId: 456,
      },
    });

    const contents = await readFile(diagnostics.filePath, "utf8");
    const lines = contents.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]);
    expect(event.event).toBe("command_spawned");
    expect(event.hostexecSessionId).toBe("sess/example");
    expect(event.requestId).toBe("req-1");
    expect(event.process.processGroupId).toBe(456);
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(path.basename(diagnostics.filePath)).toBe("sess_example.jsonl");
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
