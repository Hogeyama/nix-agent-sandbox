import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandSuites, summarize } from "./run_tests.ts";

test("aggregates expand in order without running shared suites twice", () => {
  expect(
    expandSuites(["all"], {
      all: "bun run scripts/run_tests.ts unit integration",
      unit: "bun run scripts/run_tests.ts a b",
      integration: "bun run scripts/run_tests.ts b c",
      a: "bun test a",
      b: "bun test b",
      c: "bun test c",
    }),
  ).toEqual(["a", "b", "c"]);
});

test("invalid aggregate definitions fail before starting suites", () => {
  expect(() => expandSuites(["missing"], {})).toThrow("Unknown test script");
  expect(() =>
    expandSuites(["loop"], {
      loop: "bun run scripts/run_tests.ts loop",
    }),
  ).toThrow("Circular test aggregate");
});

test("summaries retain skips and distinguish cached Zig successes", () => {
  expect(summarize("  12 pass\n  3 skip\n  0 fail\n")).toBe(
    "12 pass, 3 skip, 0 fail",
  );
  expect(
    summarize("Build Summary: 3/3 steps succeeded\n+- run test cached\n"),
  ).toBe("3/3 steps succeeded (cached)");
  expect(
    summarize(
      "Build Summary: 3/3 steps succeeded; 25/25 tests passed\n+- run test 25 passed\n",
    ),
  ).toBe("3/3 steps succeeded; 25/25 tests passed");
  expect(summarize("unrecognized output")).toBe("");
});

for (const fail of [false, true]) {
  test(`runner preserves logs and continues to the final suite (failure=${fail})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "nas-runner-test-"));
    try {
      const logs = join(dir, "logs");
      await mkdir(logs);
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          scripts: { first: "bun first.ts", last: "bun last.ts" },
        }),
      );
      await writeFile(
        join(dir, "first.ts"),
        `console.log("first stdout"); console.error("first stderr"); process.exit(${fail ? 7 : 0});`,
      );
      await writeFile(join(dir, "last.ts"), 'console.log("last stdout");');
      const entry = join(dir, "run.ts");
      await writeFile(
        entry,
        `import { runSuites } from ${JSON.stringify(join(import.meta.dir, "run_tests.ts"))};
process.exitCode = await runSuites(["first", "last"], ${JSON.stringify(dir)}, ${JSON.stringify(logs)});`,
      );
      const child = Bun.spawn([process.execPath, entry], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(code).toBe(fail ? 1 : 0);
      expect(stdout).toContain(
        fail ? "FAIL (exit 7)" : "Suites: 2 passed, 0 failed, 2 total",
      );
      expect(stdout).toContain("[2/2] last");
      expect(stdout.includes("first stderr")).toBe(fail);
      expect(stdout).not.toContain("last stdout");
      expect(await readFile(join(logs, "first.log"), "utf8")).toContain(
        "first stderr",
      );
      expect(await readFile(join(logs, "first.log"), "utf8")).toContain(
        "first stdout",
      );
      expect(await readFile(join(logs, "last.log"), "utf8")).toContain(
        "last stdout",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
