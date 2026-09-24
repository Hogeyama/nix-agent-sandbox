/**
 * Pure-helper tests for secret_store: path safety and dotenv parsing.
 *
 * assertSafeSecretPath gates file: / dotenv: secret sources, so mistakes
 * here would be a sandbox-escape vector. Worth pinning down exhaustively.
 */

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertSafeSecretPath,
  parseDotEnv,
  resolveSecret,
} from "./secret_store.ts";

// ---------------------------------------------------------------------------
// assertSafeSecretPath — positive cases
// ---------------------------------------------------------------------------

test("assertSafeSecretPath: allows paths within HOME", () => {
  expect(() =>
    assertSafeSecretPath("/home/alice/.secrets/token", {
      HOME: "/home/alice",
    }),
  ).not.toThrow();
});

test("assertSafeSecretPath: allows paths within XDG_CONFIG_HOME", () => {
  expect(() =>
    assertSafeSecretPath("/home/alice/.config/nas/token", {
      HOME: "/unused",
      XDG_CONFIG_HOME: "/home/alice/.config",
    }),
  ).not.toThrow();
});

test("assertSafeSecretPath: allows /var/lib/<user>/subdir", () => {
  // /var/lib is sensitive, but /var/lib/<user>/... is allowed.
  expect(() =>
    assertSafeSecretPath("/var/lib/myservice/secrets/token", {
      HOME: "/home/alice",
    }),
  ).not.toThrow();
});

test("assertSafeSecretPath: allows /root as HOME", () => {
  expect(() =>
    assertSafeSecretPath("/root/.token", {
      HOME: "/root",
    }),
  ).not.toThrow();
});

// ---------------------------------------------------------------------------
// assertSafeSecretPath — negative cases
// ---------------------------------------------------------------------------

test("assertSafeSecretPath: empty path throws", () => {
  expect(() => assertSafeSecretPath("", { HOME: "/home/a" })).toThrow(
    /must not be empty/,
  );
});

test("assertSafeSecretPath: '..' segments rejected before resolve", () => {
  expect(() =>
    assertSafeSecretPath("/home/alice/../etc/shadow", { HOME: "/home/alice" }),
  ).toThrow(/\.\./);
});

test("assertSafeSecretPath: rejects /etc paths", () => {
  expect(() =>
    assertSafeSecretPath("/etc/shadow", { HOME: "/home/alice" }),
  ).toThrow(/\/etc/);
});

test("assertSafeSecretPath: rejects other sensitive prefixes", () => {
  for (const p of [
    "/proc/self/environ",
    "/sys/class",
    "/dev/random",
    "/boot/grub",
    "/var/log/auth.log",
  ]) {
    expect(() => assertSafeSecretPath(p, { HOME: "/home/alice" })).toThrow();
  }
});

test("assertSafeSecretPath: rejects /root when HOME is elsewhere", () => {
  expect(() =>
    assertSafeSecretPath("/root/secret", { HOME: "/home/alice" }),
  ).toThrow(/\/root/);
});

test("assertSafeSecretPath: rejects bare /var/lib/file (needs <user>/subdir)", () => {
  expect(() =>
    assertSafeSecretPath("/var/lib/token", { HOME: "/home/a" }),
  ).toThrow(/\/var\/lib/);
});

test("assertSafeSecretPath: rejects /var/lib/onlyuser (<2 segments)", () => {
  // Exactly one segment beneath /var/lib is treated as a bare dir and rejected.
  expect(() =>
    assertSafeSecretPath("/var/lib/onlyuser", { HOME: "/home/a" }),
  ).toThrow(/\/var\/lib/);
});

// ---------------------------------------------------------------------------
// assertSafeSecretPath — credential stores beneath HOME
// ---------------------------------------------------------------------------

test("assertSafeSecretPath: rejects well-known credential stores beneath HOME", () => {
  const env = { HOME: "/home/alice" };
  for (const p of [
    "/home/alice/.ssh/id_rsa",
    "/home/alice/.ssh",
    "/home/alice/.gnupg/private-keys-v1.d/key",
    "/home/alice/.aws/credentials",
    "/home/alice/.kube/config",
    "/home/alice/.docker/config.json",
    "/home/alice/.netrc",
    "/home/alice/.git-credentials",
    "/home/alice/.config/gcloud/application_default_credentials.json",
    "/home/alice/.config/gh/hosts.yml",
    "/home/alice/.claude/.credentials.json",
    "/home/alice/.codex/auth.json",
  ]) {
    expect(() => assertSafeSecretPath(p, env)).toThrow(
      /sensitive credential location/,
    );
  }
});

test("assertSafeSecretPath: a relative path that resolves into ~/.ssh is rejected", () => {
  const cwd = process.cwd();
  expect(() =>
    assertSafeSecretPath("x/.ssh/id_rsa", { HOME: path.join(cwd, "x") }),
  ).toThrow(/sensitive credential location/);
});

test("assertSafeSecretPath: rejects nas's own state and runtime dirs", () => {
  const env = {
    HOME: "/home/alice",
    XDG_CONFIG_HOME: "/cfg",
    XDG_DATA_HOME: "/data",
    XDG_STATE_HOME: "/state",
    XDG_RUNTIME_DIR: "/run/user/1000",
  };
  for (const p of [
    "/cfg/nas/trusted.json",
    "/home/alice/.config/nas/trusted.json",
    "/data/nas/audit/2026-09-24.jsonl",
    "/home/alice/.local/share/nas/history.db",
    "/state/nas/recent_dirs.json",
    "/run/user/1000/nas/hostexec/brokers/s/mask-secrets.frame",
  ]) {
    expect(() => assertSafeSecretPath(p, env)).toThrow(
      /sensitive credential location/,
    );
  }
});

test("assertSafeSecretPath: other files in HOME and ~/.config/nas stay allowed", () => {
  const env = { HOME: "/home/alice" };
  for (const p of [
    "/home/alice/.config/nas/token",
    "/home/alice/project/.env",
    "/home/alice/.sshrc",
    "/home/alice/.aws-notes",
    "/home/alice/.docker/other.json",
  ]) {
    expect(() => assertSafeSecretPath(p, env)).not.toThrow();
  }
});

// ---------------------------------------------------------------------------
// resolveSecret — symlinks are resolved before the path check
// ---------------------------------------------------------------------------

async function withFakeHome(
  body: (home: string) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), "nas-secret-store-home-"));
  try {
    await mkdir(path.join(home, ".ssh"));
    await writeFile(path.join(home, ".ssh", "id_rsa"), "PRIVATE KEY\n");
    await body(home);
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
}

test("resolveSecret: rejects a symlink in HOME that points into ~/.ssh", async () => {
  await withFakeHome(async (home) => {
    await symlink(path.join(home, ".ssh", "id_rsa"), path.join(home, "token"));
    for (const source of [
      "file:~/token",
      "lines:~/token",
      "dotenv:~/token#K",
    ]) {
      await expect(resolveSecret(source, { HOME: home })).rejects.toThrow(
        /sensitive credential location/,
      );
    }
  });
});

test("resolveSecret: rejects a symlinked directory in HOME that leads into ~/.ssh", async () => {
  await withFakeHome(async (home) => {
    await symlink(path.join(home, ".ssh"), path.join(home, "keys"));
    await expect(
      resolveSecret("file:~/keys/id_rsa", { HOME: home }),
    ).rejects.toThrow(/sensitive credential location/);
  });
});

test("resolveSecret: rejects a file reached through a symlinked ~/.ssh", async () => {
  // ~/.ssh -> ~/dotfiles/ssh: the key's real home is outside the literal
  // ~/.ssh, but it is still the SSH key.
  const home = await mkdtemp(path.join(tmpdir(), "nas-secret-store-home-"));
  try {
    await mkdir(path.join(home, "dotfiles", "ssh"), { recursive: true });
    await writeFile(path.join(home, "dotfiles", "ssh", "id_rsa"), "KEY\n");
    await symlink(path.join(home, "dotfiles", "ssh"), path.join(home, ".ssh"));
    await expect(
      resolveSecret("file:~/dotfiles/ssh/id_rsa", { HOME: home }),
    ).rejects.toThrow(/sensitive credential location/);
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
});

test("resolveSecret: rejects a symlink in HOME that points at a system path", async () => {
  await withFakeHome(async (home) => {
    await symlink("/etc/passwd", path.join(home, "token"));
    await expect(resolveSecret("file:~/token", { HOME: home })).rejects.toThrow(
      // macOS resolves /etc to /private/etc.
      /sensitive prefix (\/private)?\/etc/,
    );
  });
});

test("resolveSecret: rejects ~/.ssh reached through a symlinked HOME", async () => {
  await withFakeHome(async (realHome) => {
    const linkParent = await mkdtemp(
      path.join(tmpdir(), "nas-secret-store-link-"),
    );
    try {
      const linkedHome = path.join(linkParent, "home");
      await symlink(realHome, linkedHome);
      // HOME names the symlink; the source names the real directory.
      await expect(
        resolveSecret(`file:${realHome}/.ssh/id_rsa`, { HOME: linkedHome }),
      ).rejects.toThrow(/sensitive credential location/);
    } finally {
      await rm(linkParent, { recursive: true, force: true }).catch(() => {});
    }
  });
});

test("resolveSecret: follows a harmless symlink and reads its target", async () => {
  await withFakeHome(async (home) => {
    await writeFile(path.join(home, "real-token"), "ok-value\n");
    await symlink(path.join(home, "real-token"), path.join(home, "token"));
    expect(await resolveSecret("file:~/token", { HOME: home })).toEqual(
      "ok-value",
    );
  });
});

// ---------------------------------------------------------------------------
// parseDotEnv
// ---------------------------------------------------------------------------

test("parseDotEnv: basic KEY=VALUE", () => {
  expect(parseDotEnv("FOO=bar\nBAZ=qux\n")).toEqual({
    FOO: "bar",
    BAZ: "qux",
  });
});

test("parseDotEnv: trims surrounding whitespace around key and value", () => {
  expect(parseDotEnv("  FOO  =  bar  \n")).toEqual({ FOO: "bar" });
});

test("parseDotEnv: strips 'export ' prefix", () => {
  expect(parseDotEnv("export FOO=bar\n")).toEqual({ FOO: "bar" });
});

test('parseDotEnv: strips double quotes and interprets \\" and \\\\', () => {
  expect(parseDotEnv('FOO="he said \\"hi\\""\n')).toEqual({
    FOO: 'he said "hi"',
  });
  expect(parseDotEnv('FOO="a\\\\b"\n')).toEqual({ FOO: "a\\b" });
});

test("parseDotEnv: strips single quotes but does NOT interpret escapes", () => {
  expect(parseDotEnv("FOO='raw\\nvalue'\n")).toEqual({ FOO: "raw\\nvalue" });
});

test("parseDotEnv: ignores comments and blank lines", () => {
  expect(
    parseDotEnv("# comment\n\nFOO=bar\n  # indented comment\nBAZ=qux\n"),
  ).toEqual({ FOO: "bar", BAZ: "qux" });
});

test("parseDotEnv: handles CRLF line endings", () => {
  expect(parseDotEnv("FOO=bar\r\nBAZ=qux\r\n")).toEqual({
    FOO: "bar",
    BAZ: "qux",
  });
});

test("parseDotEnv: ignores lines with no equals sign", () => {
  expect(parseDotEnv("FOO\nBAR=baz\n")).toEqual({ BAR: "baz" });
});

test("parseDotEnv: ignores lines starting with '='", () => {
  // equalsIndex <= 0 → skipped
  expect(parseDotEnv("=bad\nFOO=ok\n")).toEqual({ FOO: "ok" });
});

test("parseDotEnv: last value wins when a key is repeated", () => {
  expect(parseDotEnv("FOO=first\nFOO=second\n")).toEqual({ FOO: "second" });
});

test("parseDotEnv: value may contain '='", () => {
  expect(parseDotEnv("KEY=a=b=c\n")).toEqual({ KEY: "a=b=c" });
});

test("parseDotEnv: empty value becomes empty string", () => {
  expect(parseDotEnv("FOO=\n")).toEqual({ FOO: "" });
});

// ---------------------------------------------------------------------------
// resolveSecret: lines:
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// resolveSecret: tilde expansion
// ---------------------------------------------------------------------------

test("resolveSecret: file: expands ~ to HOME", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-secret-store-tilde-"));
  try {
    const filePath = path.join(tmpDir, "token");
    await writeFile(filePath, "my-secret-value\n");

    const result = await resolveSecret(`file:~/token`, { HOME: tmpDir });

    expect(result).toEqual("my-secret-value");
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("resolveSecret: dotenv: expands ~ to HOME", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-secret-store-tilde-"));
  try {
    const filePath = path.join(tmpDir, "secrets.env");
    await writeFile(filePath, "TOKEN=abc123\n");

    const result = await resolveSecret(`dotenv:~/secrets.env#TOKEN`, {
      HOME: tmpDir,
    });

    expect(result).toEqual("abc123");
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("resolveSecret: lines: expands ~ to HOME", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-secret-store-tilde-"));
  try {
    const filePath = path.join(tmpDir, "tokens.txt");
    await writeFile(filePath, "first\nsecond\n");

    const result = await resolveSecret(`lines:~/tokens.txt`, { HOME: tmpDir });

    expect(result).toEqual(["first", "second"]);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("resolveSecret: file: rejects tilde path with .. traversal", async () => {
  await expect(
    resolveSecret("file:~/../../../etc/shadow", { HOME: "/home/alice" }),
  ).rejects.toThrow(/\.\./);
});

// ---------------------------------------------------------------------------
// resolveSecret: lines:
// ---------------------------------------------------------------------------

test("resolveSecret: lines: reads a file and returns one string per non-empty line", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-secret-store-lines-"));
  try {
    const filePath = path.join(tmpDir, "tokens.txt");
    await writeFile(filePath, "first-secret\n\nsecond-secret\nthird-secret\n");

    const result = await resolveSecret(`lines:${filePath}`, {});

    expect(result).toEqual(["first-secret", "second-secret", "third-secret"]);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// resolveSecret: cmd:
// ---------------------------------------------------------------------------

test("resolveSecret: cmd: returns the first line of the command output", async () => {
  const result = await resolveSecret("cmd:printf 'tok-1\\nnoise\\n'", {});

  expect(result).toEqual("tok-1");
});

test("resolveSecret: cmd: reports a failing command instead of returning its output", async () => {
  await expect(
    resolveSecret("cmd:printf 'partial\\n'; exit 3", {}),
  ).rejects.toThrow(/status 3/);
});

test("resolveSecret: cmd: treats no output as an unavailable secret", async () => {
  expect(await resolveSecret("cmd:true", {})).toBeNull();
});

test("resolveSecret: cmd: rejects an empty command", async () => {
  await expect(resolveSecret("cmd:   ", {})).rejects.toThrow(/name a command/);
});
