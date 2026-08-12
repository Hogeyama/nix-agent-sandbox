import { expect, test } from "bun:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  decideIntegrity,
  type FileIntegrity,
  readFileIntegrity,
} from "./integrity.ts";

const fi = (over: Partial<FileIntegrity> = {}): FileIntegrity => ({
  inode: 1,
  mtimeMs: 1000,
  size: 3,
  sha256: "aaa",
  ...over,
});

test("decideIntegrity: untracked baseline (undefined) prompts", () => {
  expect(decideIntegrity(undefined, fi())).toBe("prompt");
});

test("decideIntegrity: absent baseline stays absent -> pass", () => {
  expect(decideIntegrity("absent", "absent")).toBe("pass");
});

test("decideIntegrity: absent baseline, file appeared -> prompt", () => {
  expect(decideIntegrity("absent", fi())).toBe("prompt");
});

test("decideIntegrity: file disappeared -> prompt", () => {
  expect(decideIntegrity(fi(), "absent")).toBe("prompt");
});

test("decideIntegrity: same content hash -> pass (inode/mtime ignored)", () => {
  expect(
    decideIntegrity(
      fi({ inode: 1, mtimeMs: 1000 }),
      fi({ inode: 2, mtimeMs: 9999 }),
    ),
  ).toBe("pass");
});

test("decideIntegrity: different content hash -> prompt", () => {
  expect(decideIntegrity(fi({ sha256: "aaa" }), fi({ sha256: "bbb" }))).toBe(
    "prompt",
  );
});

test("readFileIntegrity: reads stat + sha256 of an existing file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-integrity-"));
  try {
    const p = path.join(dir, "f.sh");
    await writeFile(p, "hello");
    const snap = await readFileIntegrity(p);
    expect(snap).not.toBe("absent");
    if (snap === "absent") return;
    expect(snap.size).toBe(5);
    // sha256("hello")
    expect(snap.sha256).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readFileIntegrity: returns 'absent' for a missing file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-integrity-"));
  try {
    const snap = await readFileIntegrity(path.join(dir, "nope"));
    expect(snap).toBe("absent");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readFileIntegrity: non-ENOENT stat error (ENOTDIR) throws instead of returning 'absent'", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-integrity-"));
  try {
    const p = path.join(dir, "f.sh");
    await writeFile(p, "hello");
    // p は通常ファイルなので、これをディレクトリとして扱うパスは stat で
    // ENOTDIR を発生する。ENOENT 以外のエラーは absent にせず throw する。
    await expect(readFileIntegrity(path.join(p, "child"))).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readFileIntegrity: detects an in-place content swap of the same byte length", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-integrity-"));
  try {
    const p = path.join(dir, "f.sh");
    await writeFile(p, "hello");
    const first = await readFileIntegrity(p);
    if (first === "absent") throw new Error("unexpected absent");

    // 同一 byte 長の別内容で上書きし、mtime も攻撃者が touch -r 等で復元した
    // 状況を模して元の値に戻す。同じファイルを書き換えているため inode は
    // 変化しない。fast-path が残存していれば、inode+mtimeMs+size の一致だけを
    // 理由に first をそのまま返却し、この置換を検出できない。
    await writeFile(p, "world");
    await utimes(p, new Date(first.mtimeMs), new Date(first.mtimeMs));

    const second = await readFileIntegrity(p);
    expect(second).not.toBe("absent");
    if (second === "absent") return;
    expect(second.size).toBe(first.size);
    expect(second.mtimeMs).toBe(first.mtimeMs);
    expect(second.inode).toBe(first.inode);
    expect(second.sha256).not.toBe(first.sha256);
    expect(decideIntegrity(first, second)).toBe("prompt");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
