import { expect, test } from "bun:test";
import { existsSync, promises as fs, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  dtachHasSession,
  dtachListSessions,
  dtachNewSession,
  gcDtachRuntime,
  probeDtachSocket,
  socketPathFor,
} from "./client.ts";

async function withUnixServer<T>(
  socketPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    return await fn();
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

test("probeDtachSocket returns true for a live unix socket", async () => {
  const runtimeDir = await fs.mkdtemp(path.join(tmpdir(), "nas-dtach-test-"));
  const socketPath = socketPathFor("sess-live", runtimeDir);
  await fs.mkdir(path.dirname(socketPath), { recursive: true });

  try {
    await withUnixServer(socketPath, async () => {
      expect(await probeDtachSocket(socketPath)).toBe(true);
      expect(await dtachHasSession(socketPath)).toBe(true);
      const sessions = await dtachListSessions(runtimeDir);
      expect(sessions.map((session) => session.name)).toEqual(["sess-live"]);
    });
  } finally {
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});

test("socketPathFor rejects traversal via ..", () => {
  expect(() => socketPathFor("../x", "/tmp/nas-dtach")).toThrow(
    /path traversal detected/,
  );
});

test("socketPathFor rejects deeper traversal via ../..", () => {
  expect(() =>
    socketPathFor("../../../var/run/docker", "/tmp/nas-dtach"),
  ).toThrow(/path traversal detected/);
});

test("socketPathFor accepts a plain sessionId", () => {
  const p = socketPathFor("sess_abc123", "/tmp/nas-dtach");
  expect(p).toBe("/tmp/nas-dtach/sess_abc123.sock");
});

// ---------------------------------------------------------------------------
// Test-time guard
//
// dtach -n はデタッチ起動なので、テストが誤って本物のセッションを作ると
// テストランナー終了後もホストに残り続ける (実際に src/ui/launch_test.ts が
// 1 回の実行で 13 セッション残していた)。セッション起動の唯一の通り道である
// dtachNewSession に関門を置き、テスト実行中は明示的な opt-in なしに起動
// できないようにする。
// ---------------------------------------------------------------------------

test("dtachNewSession refuses to spawn a real session during tests", async () => {
  const runtimeDir = await fs.mkdtemp(path.join(tmpdir(), "nas-dtach-test-"));
  try {
    await expect(
      dtachNewSession(socketPathFor("sess-guard", runtimeDir), "true"),
    ).rejects.toThrow(/NAS_TEST_ALLOW_DTACH/);
    expect(existsSync(socketPathFor("sess-guard", runtimeDir))).toBe(false);
  } finally {
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});

test("NAS_TEST_ALLOW_DTACH=1 opts a test back into real dtach spawning", async () => {
  const runtimeDir = await fs.mkdtemp(path.join(tmpdir(), "nas-dtach-test-"));
  const saved = process.env.NAS_TEST_ALLOW_DTACH;
  process.env.NAS_TEST_ALLOW_DTACH = "1";
  try {
    // opt-in 後は関門を通り抜けて実際に dtach を起動しようとする。存在しない
    // cwd を渡して起動そのものを失敗させるので、セッションは残らない。
    // 失敗メッセージは dtach の有無で変わる (dtach の non-zero exit / spawn の
    // ENOENT) ため、「関門のエラーではない」ことだけを確かめる。
    const error = await dtachNewSession(
      socketPathFor("sess-optin", runtimeDir),
      "true",
      { cwd: "/definitely/does/not/exist/for/nas/test" },
    ).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error).not.toBeNull();
    expect(error?.message).not.toMatch(/NAS_TEST_ALLOW_DTACH/);
  } finally {
    if (saved === undefined) delete process.env.NAS_TEST_ALLOW_DTACH;
    else process.env.NAS_TEST_ALLOW_DTACH = saved;
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});

test("gcDtachRuntime removes stale sockets and keeps live ones", async () => {
  const runtimeDir = await fs.mkdtemp(path.join(tmpdir(), "nas-dtach-test-"));
  const staleSocketPath = socketPathFor("sess-stale", runtimeDir);
  const liveSocketPath = socketPathFor("sess-live", runtimeDir);
  await fs.mkdir(path.dirname(staleSocketPath), { recursive: true });

  try {
    writeFileSync(staleSocketPath, "not-a-socket");

    await withUnixServer(liveSocketPath, async () => {
      const removed = await gcDtachRuntime(runtimeDir);
      expect(removed).toEqual(["sess-stale"]);
      expect(existsSync(staleSocketPath)).toBe(false);

      const sessions = await dtachListSessions(runtimeDir);
      expect(sessions.map((session) => session.name)).toEqual(["sess-live"]);
      expect(await dtachHasSession(staleSocketPath)).toBe(false);
    });
  } finally {
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});
