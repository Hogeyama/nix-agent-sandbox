import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveMaskFilterBinPath } from "./mask_filter_path.ts";
import { encodeMaskSecrets } from "./secrets_frame.ts";

let binaryPath: string | null = null;
let tmpDir: string;

beforeAll(async () => {
  binaryPath = await resolveMaskFilterBinPath();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mask-filter-test-"));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeSecretsFile(secrets: string[]): string {
  const frame = encodeMaskSecrets(secrets);
  const filePath = path.join(tmpDir, `secrets-${Date.now()}`);
  fs.writeFileSync(filePath, frame);
  return filePath;
}

async function runFilter(input: string, secrets: string[]): Promise<string> {
  if (!binaryPath) throw new Error("nas-mask-filter binary not found");
  const secretsFile = writeSecretsFile(secrets);
  const proc = Bun.spawn([binaryPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { NAS_MASK_SECRETS_FILE: secretsFile },
  });
  proc.stdin.write(input);
  proc.stdin.end();
  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`filter exited ${exitCode}: ${stderr}`);
  }
  return output;
}

describe("nas-mask-filter binary", () => {
  test("masks single secret", async () => {
    if (!binaryPath) return; // skip if not built
    const result = await runFilter("password=hunter2 done", ["hunter2"]);
    expect(result).toBe("password=******* done");
  });

  test("masks multiple secrets", async () => {
    if (!binaryPath) return;
    const result = await runFilter("a=tok1 b=tok22 c=tok1", ["tok1", "tok22"]);
    expect(result).toBe("a=**** b=***** c=****");
  });

  test("passes through when no secrets match", async () => {
    if (!binaryPath) return;
    const result = await runFilter("nothing to mask here", ["nonexistent"]);
    expect(result).toBe("nothing to mask here");
  });

  test("handles empty input", async () => {
    if (!binaryPath) return;
    const result = await runFilter("", ["secret"]);
    expect(result).toBe("");
  });

  test("masks secret spanning large input", async () => {
    if (!binaryPath) return;
    // Create input larger than BUF_SIZE (64KB) with secret near the boundary
    const padding = "x".repeat(65530);
    const input = `${padding}SECRET_VALUE${padding}`;
    const result = await runFilter(input, ["SECRET_VALUE"]);
    expect(result).not.toContain("SECRET_VALUE");
    expect(result).toContain("************");
    expect(result.length).toBe(input.length);
  });
});
