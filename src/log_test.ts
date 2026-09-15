import { expect, test } from "bun:test";
import { formatElapsed } from "./log.ts";

test("formatElapsed: sub-second uses ms unit", () => {
  const start = performance.now();
  const result = formatElapsed(start);
  expect(result).toMatch(/^\d+ms$/);
});

test("formatElapsed: large elapsed uses seconds with 2 decimal places", () => {
  const start = performance.now() - 2500;
  const result = formatElapsed(start);
  expect(result).toMatch(/^\d+\.\d{2}s$/);
});

test("diagnostic file is private, append-only and independent of stdout data", async () => {
  const { mkdtemp, readFile, stat, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { openDiagnosticLog, logInfo, logWarn, setLogLevel, diagnosticLogger } =
    await import("./log.ts");
  const { Effect } = await import("effect");
  const dir = await mkdtemp(join(tmpdir(), "nas-log-"));
  try {
    const file = join(dir, "nas.log");
    setLogLevel("info");
    const close = openDiagnosticLog(file);
    try {
      logInfo("first");
      await Effect.runPromise(
        Effect.logWarning("cleanup warning").pipe(
          Effect.provide(diagnosticLogger),
        ),
      );
      console.log("data-output-must-not-be-captured");
    } finally {
      close();
    }
    const closeAgain = openDiagnosticLog(file);
    try {
      logWarn("second");
    } finally {
      closeAgain();
    }
    expect(await readFile(file, "utf8")).toBe(
      "first\ncleanup warning\nsecond\n",
    );
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(() => openDiagnosticLog(join(dir, "missing", "nas.log"))).toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
