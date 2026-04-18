import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveAllowEntry } from "./broker.ts";

test("resolveAllowEntry: resolves workspace: and session_tmp: within root", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "nas-broker-ws-"));
  const sessionTmp = await mkdtemp(path.join(tmpdir(), "nas-broker-tmp-"));
  try {
    expect(
      await resolveAllowEntry("workspace:sub", workspace, sessionTmp),
    ).toEqual(path.join(workspace, "sub"));
    expect(
      await resolveAllowEntry("workspace:", workspace, sessionTmp),
    ).toEqual(workspace);
    expect(
      await resolveAllowEntry("session_tmp:foo/bar", workspace, sessionTmp),
    ).toEqual(path.join(sessionTmp, "foo", "bar"));
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
    await rm(sessionTmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("resolveAllowEntry: rejects workspace: entries that escape via ..", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "nas-broker-ws-"));
  const sessionTmp = await mkdtemp(path.join(tmpdir(), "nas-broker-tmp-"));
  try {
    await expect(
      resolveAllowEntry("workspace:../etc", workspace, sessionTmp),
    ).rejects.toThrow(/escapes its root/);
    await expect(
      resolveAllowEntry("workspace:../../../etc/passwd", workspace, sessionTmp),
    ).rejects.toThrow(/escapes its root/);
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
    await rm(sessionTmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("resolveAllowEntry: rejects session_tmp: entries that escape via absolute path", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "nas-broker-ws-"));
  const sessionTmp = await mkdtemp(path.join(tmpdir(), "nas-broker-tmp-"));
  try {
    await expect(
      resolveAllowEntry("session_tmp:/etc/passwd", workspace, sessionTmp),
    ).rejects.toThrow(/escapes its root/);
    await expect(
      resolveAllowEntry("session_tmp:../other", workspace, sessionTmp),
    ).rejects.toThrow(/escapes its root/);
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
    await rm(sessionTmp, { recursive: true, force: true }).catch(() => {});
  }
});
