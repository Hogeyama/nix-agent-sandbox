import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import packageJson from "../package.json";

const runner = "bun run scripts/run_tests.ts ";

// Keep aggregate membership in package.json, expanding it before running anything.
export function expandSuites(
  names: string[],
  scripts: Record<string, string>,
  ancestors: string[] = [],
): string[] {
  return [
    ...new Set(
      names.flatMap((name) => {
        const command = scripts[name];
        if (!command) throw new Error(`Unknown test script: ${name}`);
        if (ancestors.includes(name)) {
          throw new Error(
            `Circular test aggregate: ${[...ancestors, name].join(" -> ")}`,
          );
        }
        return command.startsWith(runner)
          ? expandSuites(
              command.slice(runner.length).trim().split(/\s+/),
              scripts,
              [...ancestors, name],
            )
          : [name];
      }),
    ),
  ];
}

export function summarize(log: string): string {
  const plain = stripVTControlCharacters(log);
  const counts = [...plain.matchAll(/^\s*(\d+) (pass|skip|fail)\s*$/gm)].map(
    (match) => `${match[1]} ${match[2]}`,
  );
  if (counts.length) return counts.join(", ");
  const zig = plain.match(/^Build Summary: (.+)$/m);
  if (zig) {
    const cached = /\brun test.*\bcached\b/.test(plain);
    return `${zig[1]}${cached ? " (cached)" : ""}`;
  }
  return "";
}

export async function runSuites(
  names: string[],
  cwd: string,
  logs?: string,
): Promise<number> {
  const logDir = logs ?? (await mkdtemp(join(tmpdir(), "nas-tests-")));
  const results: {
    name: string;
    code: number;
    seconds: string;
    summary: string;
  }[] = [];
  console.log(`Logs: ${logDir}\n`);
  for (const [index, name] of names.entries()) {
    console.log(`[${index + 1}/${names.length}] ${name}`);
    const logPath = join(logDir, `${name.replaceAll(":", "-")}.log`);
    const fd = openSync(logPath, "w", 0o600);
    const start = performance.now();
    let code: number;
    try {
      code = await new Promise<number>((resolveExit, reject) => {
        const child = spawn(process.execPath, ["run", name], {
          cwd,
          stdio: ["ignore", fd, fd],
          env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
        });
        child.once("error", reject);
        child.once("close", (exitCode, signal) => {
          resolveExit(exitCode ?? (signal === "SIGINT" ? 130 : 1));
        });
      });
    } finally {
      closeSync(fd);
    }
    const seconds = ((performance.now() - start) / 1000).toFixed(2);
    const log = await readFile(logPath, "utf8");
    const summary = summarize(log);
    results.push({ name, code, seconds, summary });
    console.log(
      `  ${code === 0 ? "PASS" : `FAIL (exit ${code})`}  ${seconds}s${summary ? `  ${summary}` : ""}`,
    );
    if (code !== 0) {
      console.log(
        `\n--- ${name}: failure log ---\n${log}\n--- end ${name} ---`,
      );
    }
  }
  console.log("\nTest results:");
  const width = Math.max(...names.map((name) => name.length));
  for (const { name, code, seconds, summary } of results) {
    console.log(
      `  ${code === 0 ? "PASS" : "FAIL"}  ${name.padEnd(width)}  ${seconds.padStart(6)}s  ${summary}`.trimEnd(),
    );
  }
  const failed = results.filter(({ code }) => code !== 0).length;
  console.log(
    `\nSuites: ${results.length - failed} passed, ${failed} failed, ${results.length} total`,
  );
  console.log(`Full logs: ${logDir}`);
  return failed ? 1 : 0;
}

if (import.meta.main) {
  const names = process.argv.slice(2);
  if (!names.length)
    throw new Error("Usage: bun run scripts/run_tests.ts <test script>...");
  const suites = expandSuites(names, packageJson.scripts);
  process.exitCode = await runSuites(suites, resolve(import.meta.dir, ".."));
}
