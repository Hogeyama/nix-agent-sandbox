import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureConfigTrusted, recordConfigTrust } from "./trust.ts";

test("noninteractive trust rejects untrusted and changed configs even on a TTY", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nas-trust-noninteractive-"));
  const oldBypass = process.env.NAS_CONFIG_TRUST_ALL;
  const oldConfigHome = process.env.XDG_CONFIG_HOME;
  const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const originalConfirm = globalThis.confirm;
  let confirms = 0;
  try {
    delete process.env.NAS_CONFIG_TRUST_ALL;
    process.env.XDG_CONFIG_HOME = join(dir, "global");
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
    globalThis.confirm = () => {
      confirms++;
      throw new Error("unexpected interactive trust prompt");
    };
    const configPath = join(dir, "config.pkl");
    await writeFile(configPath, "// initial\n");
    await expect(
      ensureConfigTrusted(dir, configPath, { nonInteractive: true }),
    ).rejects.toThrow("nas config trust");
    await recordConfigTrust(dir);
    await ensureConfigTrusted(dir, configPath, { nonInteractive: true });
    await writeFile(configPath, "// changed\n");
    await expect(
      ensureConfigTrusted(dir, configPath, { nonInteractive: true }),
    ).rejects.toThrow("nas config trust");
    expect(confirms).toBe(0);
  } finally {
    globalThis.confirm = originalConfirm;
    if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY);
    else Reflect.deleteProperty(process.stdin, "isTTY");
    if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
    else Reflect.deleteProperty(process.stdout, "isTTY");
    if (oldBypass === undefined) delete process.env.NAS_CONFIG_TRUST_ALL;
    else process.env.NAS_CONFIG_TRUST_ALL = oldBypass;
    if (oldConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldConfigHome;
    await rm(dir, { recursive: true, force: true });
  }
});
