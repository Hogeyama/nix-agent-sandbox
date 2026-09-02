import { expect, test } from "bun:test";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  type DocumentFileHandle,
  type DocumentFileOps,
  MAX_DOCUMENT_BYTES,
  makeDocumentReader,
} from "./document_reader_service";

test("opens a UTF-8 Markdown document inside the worktree", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "nas-document-reader-"));
  try {
    const worktree = path.join(tempRoot, "worktree");
    await mkdir(path.join(worktree, "docs"), { recursive: true });
    await writeFile(
      path.join(worktree, "docs", "design.md"),
      "# Title\nbody\n",
    );

    const reader = makeDocumentReader();

    expect(await reader.open(worktree, "docs/design.md:2")).toEqual({
      path: "docs/design.md",
      content: "# Title\nbody\n",
      line: 2,
      column: null,
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("opens an absolute Markdown path whose target is inside the worktree", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "nas-document-reader-"));
  try {
    const worktree = path.join(tempRoot, "worktree");
    const documentPath = path.join(worktree, "docs", "design.md");
    await mkdir(path.dirname(documentPath), { recursive: true });
    await writeFile(documentPath, "# Absolute\n");

    expect(await makeDocumentReader().open(worktree, documentPath)).toEqual({
      path: "docs/design.md",
      content: "# Absolute\n",
      line: null,
      column: null,
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("rejects paths outside the worktree", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "nas-document-reader-"));
  try {
    const worktree = path.join(tempRoot, "worktree");
    const outsidePath = path.join(tempRoot, "outside.md");
    await mkdir(worktree);
    await writeFile(outsidePath, "outside\n");

    await expect(
      makeDocumentReader().open(worktree, outsidePath),
    ).rejects.toMatchObject({ code: "outside-worktree" });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("rejects a final symlink", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "nas-document-reader-"));
  try {
    const worktree = path.join(tempRoot, "worktree");
    const outsidePath = path.join(tempRoot, "outside.md");
    await mkdir(worktree);
    await writeFile(outsidePath, "outside\n");
    await symlink(outsidePath, path.join(worktree, "final-link.md"));

    await expect(
      makeDocumentReader().open(worktree, "final-link.md"),
    ).rejects.toMatchObject({ code: "not-regular-file" });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("rejects a FIFO without blocking during open", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "nas-document-reader-"));
  const fifoPath = path.join(tempRoot, "worktree", "pipe.md");
  let openAttempt: Promise<unknown> | undefined;
  try {
    await mkdir(path.dirname(fifoPath));
    const mkfifo = Bun.spawn(["mkfifo", fifoPath]);
    expect(await mkfifo.exited).toBe(0);

    openAttempt = makeDocumentReader().open(path.dirname(fifoPath), "pipe.md");
    const outcome = await Promise.race([
      openAttempt.then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      ),
      Bun.sleep(250).then(() => ({ status: "timed-out" as const })),
    ]);

    expect(outcome).toMatchObject({
      status: "rejected",
      error: { code: "not-regular-file" },
    });
  } finally {
    const writer = await open(
      fifoPath,
      constants.O_WRONLY | constants.O_NONBLOCK,
    ).catch(() => null);
    await writer?.close();
    await openAttempt?.catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("rejects a document reached through an intermediate symlink", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "nas-document-reader-"));
  try {
    const worktree = path.join(tempRoot, "worktree");
    const outsideDir = path.join(tempRoot, "outside");
    await mkdir(worktree);
    await mkdir(outsideDir);
    await writeFile(path.join(outsideDir, "secret.md"), "outside\n");
    await symlink(outsideDir, path.join(worktree, "through-link"));

    await expect(
      makeDocumentReader().open(worktree, "through-link/secret.md"),
    ).rejects.toMatchObject({ code: "outside-worktree" });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("rejects invalid UTF-8", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "nas-document-reader-"));
  try {
    const worktree = path.join(tempRoot, "worktree");
    await mkdir(worktree);
    await writeFile(
      path.join(worktree, "invalid.md"),
      new Uint8Array([0xc3, 0x28]),
    );

    await expect(
      makeDocumentReader().open(worktree, "invalid.md"),
    ).rejects.toMatchObject({ code: "unreadable" });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("rejects documents larger than the byte limit", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "nas-document-reader-"));
  try {
    const worktree = path.join(tempRoot, "worktree");
    await mkdir(worktree);
    await writeFile(
      path.join(worktree, "large.md"),
      new Uint8Array(MAX_DOCUMENT_BYTES + 1),
    );

    await expect(
      makeDocumentReader().open(worktree, "large.md"),
    ).rejects.toMatchObject({ code: "too-large" });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

interface FakeReaderOptions {
  readonly bytes?: Uint8Array;
  readonly statSize?: number;
  readonly statError?: Error;
  readonly isFile?: boolean;
  readonly target?: string;
  readonly identityError?: Error;
  readonly readError?: Error;
  readonly closeError?: Error;
}

function makeFakeReader(options: FakeReaderOptions = {}) {
  const root = "/worktree";
  const bytes = options.bytes ?? new TextEncoder().encode("# Title\n");
  let cursor = 0;
  let readCalls = 0;
  let closeCalls = 0;
  let openFlags: number | null = null;
  const handle: DocumentFileHandle = {
    fd: 37,
    async stat() {
      if (options.statError) throw options.statError;
      return {
        isFile: () => options.isFile ?? true,
        size: options.statSize ?? bytes.length,
      };
    },
    async read(buffer, offset, length) {
      readCalls += 1;
      if (options.readError) throw options.readError;
      const next = bytes.subarray(cursor, cursor + length);
      buffer.set(next, offset);
      cursor += next.length;
      return { bytesRead: next.length };
    },
    async close() {
      closeCalls += 1;
      if (options.closeError) throw options.closeError;
    },
  };
  const ops: DocumentFileOps = {
    async realpath(value) {
      if (value === root) return root;
      if (value === "/proc/self/fd/37") {
        if (options.identityError) throw options.identityError;
        return options.target ?? "/worktree/docs/design.md";
      }
      throw new Error(`unexpected realpath call: ${value}`);
    },
    async open(_value, flags) {
      openFlags = flags;
      return handle;
    },
  };
  return {
    reader: makeDocumentReader(ops),
    readCalls: () => readCalls,
    closeCalls: () => closeCalls,
    openFlags: () => openFlags,
  };
}

test("reads and closes the descriptor exactly once on success", async () => {
  const fake = makeFakeReader();

  expect(await fake.reader.open("/worktree", "docs/design.md:2:3")).toEqual({
    path: "docs/design.md",
    content: "# Title\n",
    line: 2,
    column: 3,
  });
  expect(fake.readCalls()).toBeGreaterThan(0);
  expect(fake.closeCalls()).toBe(1);
  expect(fake.openFlags()).toBe(
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
});

test("does not read a descriptor whose resolved target escaped", async () => {
  const outsideBytes = new TextEncoder().encode("outside secret\n");
  const fake = makeFakeReader({
    bytes: outsideBytes,
    target: "/outside/secret.md",
  });

  await expect(
    fake.reader.open("/worktree", "docs/design.md"),
  ).rejects.toMatchObject({ code: "outside-worktree" });
  expect(fake.readCalls()).toBe(0);
  expect(fake.closeCalls()).toBe(1);
});

test("rejects a pinned descriptor whose target is not Markdown", async () => {
  const fake = makeFakeReader({ target: "/worktree/docs/design.txt" });

  await expect(
    fake.reader.open("/worktree", "docs/design.md"),
  ).rejects.toMatchObject({ code: "unsupported-type" });
  expect(fake.readCalls()).toBe(0);
  expect(fake.closeCalls()).toBe(1);
});

test("closes without reading when descriptor identity cannot be verified", async () => {
  const fake = makeFakeReader({ identityError: new Error("proc unavailable") });

  await expect(
    fake.reader.open("/worktree", "docs/design.md"),
  ).rejects.toMatchObject({
    code: "unreadable",
    message: "Document identity could not be verified",
  });
  expect(fake.readCalls()).toBe(0);
  expect(fake.closeCalls()).toBe(1);
});

test("closes without reading when stat reports an oversized file", async () => {
  const fake = makeFakeReader({ statSize: MAX_DOCUMENT_BYTES + 1 });

  await expect(
    fake.reader.open("/worktree", "docs/design.md"),
  ).rejects.toMatchObject({ code: "too-large" });
  expect(fake.readCalls()).toBe(0);
  expect(fake.closeCalls()).toBe(1);
});

test("maps descriptor stat failures to a closed error and closes once", async () => {
  const statError = new Error("sensitive stat failure");
  const fake = makeFakeReader({ statError });

  try {
    await fake.reader.open("/worktree", "docs/design.md");
    throw new Error("expected document stat to fail");
  } catch (error) {
    expect(error).toMatchObject({
      code: "unreadable",
      message: "Document metadata could not be read",
      cause: statError,
    });
  }
  expect(fake.readCalls()).toBe(0);
  expect(fake.closeCalls()).toBe(1);
});

test("bounds the read when descriptor size grows after stat", async () => {
  const fake = makeFakeReader({
    bytes: new Uint8Array(MAX_DOCUMENT_BYTES + 1),
    statSize: MAX_DOCUMENT_BYTES,
  });

  await expect(
    fake.reader.open("/worktree", "docs/design.md"),
  ).rejects.toMatchObject({ code: "too-large" });
  expect(fake.closeCalls()).toBe(1);
});

test("maps descriptor read failures to a closed error and closes once", async () => {
  const readError = new Error("sensitive read failure");
  const fake = makeFakeReader({ readError });

  try {
    await fake.reader.open("/worktree", "docs/design.md");
    throw new Error("expected document read to fail");
  } catch (error) {
    expect(error).toMatchObject({
      code: "unreadable",
      message: "Document could not be read",
      cause: readError,
    });
  }
  expect(fake.closeCalls()).toBe(1);
});

test("closes the descriptor exactly once after decoding fails", async () => {
  const fake = makeFakeReader({ bytes: new Uint8Array([0xc3, 0x28]) });

  await expect(
    fake.reader.open("/worktree", "docs/design.md"),
  ).rejects.toMatchObject({ code: "unreadable" });
  expect(fake.closeCalls()).toBe(1);
});

test("fails with a closed error when close rejects after successful work", async () => {
  const closeError = new Error("sensitive close failure");
  const fake = makeFakeReader({ closeError });

  await expect(
    fake.reader.open("/worktree", "docs/design.md"),
  ).rejects.toMatchObject({
    code: "unreadable",
    message: "Document could not be closed",
    cause: closeError,
  });
  expect(fake.closeCalls()).toBe(1);
});

test("preserves a primary error and emits a generic warning when close also rejects", async () => {
  const fake = makeFakeReader({
    target: "/outside/secret.md",
    closeError: new Error("sensitive close failure"),
  });
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    await expect(
      fake.reader.open("/worktree", "docs/design.md"),
    ).rejects.toMatchObject({
      code: "outside-worktree",
      message: "Document is outside the session worktree",
    });
  } finally {
    console.warn = originalWarn;
  }

  expect(warnings).toEqual([
    ["Document descriptor close failed after an earlier error"],
  ]);
  expect(fake.readCalls()).toBe(0);
  expect(fake.closeCalls()).toBe(1);
});

test("closes without reading a non-regular descriptor", async () => {
  const fake = makeFakeReader({ isFile: false });

  await expect(
    fake.reader.open("/worktree", "docs/design.md"),
  ).rejects.toMatchObject({ code: "not-regular-file" });
  expect(fake.readCalls()).toBe(0);
  expect(fake.closeCalls()).toBe(1);
});
