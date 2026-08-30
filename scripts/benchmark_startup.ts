import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMarkerScanner,
  summarizeSamples,
} from "../src/benchmark/startup.ts";

const BENCHMARK_MARKER = `nas-startup-benchmark-${crypto.randomUUID()}`;
const SAMPLE_COUNT = 5;
const SAMPLE_TIMEOUT_MS = 30_000;

if (import.meta.main) {
  await runBenchmark();
}

async function runBenchmark(): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "nas-startup-"));

  try {
    await writeCopilotStub(tempDir, BENCHMARK_MARKER);
    const benchmarkEnv = createBenchmarkEnv(tempDir);

    await runBuild();

    const samples: number[] = [];
    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      samples.push(await measureStartupSample(benchmarkEnv, BENCHMARK_MARKER));
    }

    const summary = summarizeSamples(samples);
    for (const [index, sample] of samples.entries()) {
      console.log(`sample ${index + 1}: ${sample.toFixed(2)} ms`);
    }
    console.log(`min: ${summary.min.toFixed(2)} ms`);
    console.log(`median: ${summary.median.toFixed(2)} ms`);
    console.log(`max: ${summary.max.toFixed(2)} ms`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function writeCopilotStub(
  tempDir: string,
  marker: string,
): Promise<void> {
  const stubPath = join(tempDir, "copilot");
  await writeFile(
    stubPath,
    ["#!/bin/sh", `printf '%s' ${shellSingleQuote(marker)}`, ""].join("\n"),
  );
  await chmod(stubPath, 0o755);
}

function createBenchmarkEnv(tempDir: string): Record<string, string> {
  return {
    ...process.env,
    PATH:
      process.env.PATH && process.env.PATH.length > 0
        ? `${tempDir}:${process.env.PATH}`
        : tempDir,
  };
}

async function runBuild(): Promise<void> {
  const build = Bun.spawn(["nix", "build", ".#default"], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  const exitCode = await build.exited;
  if (exitCode !== 0) {
    throw new Error(`nix build .#default exited with code ${exitCode}`);
  }
}

async function measureStartupSample(
  env: Record<string, string>,
  marker: string,
): Promise<number> {
  const startedAt = performance.now();
  const child = Bun.spawn(["nix", "run", ".#default", "--", "copilot"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
    env,
  });

  const stdout = child.stdout as ReadableStream<Uint8Array> | null;
  if (stdout === null) {
    throw new Error("benchmark sample stdout is unavailable");
  }

  return await new Promise<number>((resolve, reject) => {
    const decoder = new TextDecoder();
    const reader = stdout.getReader();
    const scanner = createMarkerScanner(marker, (text) => {
      process.stdout.write(text);
    });
    let markerElapsedMs: number | null = null;
    let settled = false;

    const settleResolve = (value: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(value);
    };

    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      reject(error);
    };

    const timeoutId = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      settleReject(new Error(timeoutMessage(markerElapsedMs !== null)));
    }, SAMPLE_TIMEOUT_MS);

    void (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          if (scanner.push(text) && markerElapsedMs === null) {
            markerElapsedMs = performance.now() - startedAt;
          }
        }

        const remaining = decoder.decode();
        if (
          remaining.length > 0 &&
          scanner.push(remaining) &&
          markerElapsedMs === null
        ) {
          markerElapsedMs = performance.now() - startedAt;
        }
        scanner.finish();

        const exitCode = await child.exited;
        if (markerElapsedMs !== null) {
          settleResolve(markerElapsedMs);
          return;
        }
        settleReject(new Error(exitBeforeMarkerMessage(exitCode)));
      } catch (error) {
        settleReject(error instanceof Error ? error : new Error(String(error)));
      } finally {
        reader.releaseLock();
      }
    })();
  });
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function timeoutMessage(markerObserved: boolean): string {
  return markerObserved
    ? `startup marker observed, but process did not exit within ${SAMPLE_TIMEOUT_MS} ms`
    : `startup marker not observed within ${SAMPLE_TIMEOUT_MS} ms`;
}

function exitBeforeMarkerMessage(exitCode: number): string {
  return `startup marker not observed before process exited with code ${exitCode}`;
}
