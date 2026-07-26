# Mask Filter Host Broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop exposing the secret frame to the container; mask stdout/stderr on the host over a Unix socket instead.

**Architecture:** `nas-mask-filter` gains a host-side `--serve <sock>` mode that listens on a Unix socket and masks byte streams, multiplexing every connection in one poll loop. The container-side `--supervise` mode stops masking locally and becomes a relay. The secret frame stays a host-only file (hostexec reads it directly for C3 masking) in a directory that is **never mounted**; the socket lives in a **separate** directory that is.

**Tech Stack:** Zig 0.15.2 (`src/mask-filter`), Bun + Effect (host-side TS), POSIX Unix domain sockets, Docker.

## Global Constraints

Read before implementing any task:

- **Skill `security-constraints`** — C1 (do not expose secrets to the container), S1 (secrets host-side only), S2 (frame deleted at session end), C2, C3 (hostexec output masked too), N1.
- **Skill `test-policy`** — unit `*_test.ts`, Docker-dependent `*_integration_test.ts`, co-located. Guard on Docker availability, clean up in `finally`. Its `deno task` commands are stale; use `bun test`.
- **Spec** — `docs/superpowers/specs/2026-07-26-mask-filter-host-broker-design.md`. Its "Accepted limitations" are binding: do **not** try to fix the `/proc/<pid>/fd/1` bypass, the stdout/stderr split, the idle-drain seam, `mem.eql` timing, or the orphaned-daemon case.

Hard rules, every task:

- **THE DIRECTORY MOUNTED INTO THE CONTAINER MUST CONTAIN ONLY THE SOCKET.** The frame directory is never mounted. An earlier draft of this plan put both in one directory and mounted it, which reintroduced the exact disclosure this work removes.
- **No unmasked byte may reach the container.** Never "pass through on error".
- **If _either_ relay connect fails, do not fork the child.** Not "both".
- **Diagnostics on the real stderr are constant strings.** That path bypasses masking.
- **Serve mode never writes stream-derived bytes to its own stdout/stderr.** Its stdout/stderr go to a log file that `MaskFsService.defaultWaitReady` splices into user-visible errors.
- Exit code `121` = "output suppressed". Reserved.
- Preserve: child-exit drain with idle timeout, signal forwarding, exit-status propagation (128+signo), `--argv0`.
- Commit after every task; run `bun run check` first.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/mask-filter/serve.zig` | **new** — UDS listener, connection table, poll loop, per-connection `MaskStream`, resource bounds |
| `src/mask-filter/relay.zig` | **new** — client side: connect, queued writer, bidirectional pump |
| `src/mask-filter/supervise.zig` | modify — relay instead of local masking; fd hygiene; fail-closed |
| `src/mask-filter/mask_filter.zig` | modify — mode dispatch; keep filter mode + `readSecretsFromFile` (hostexec C3) |
| `src/stages/maskfs/mask_filter_service.ts` | modify — daemon lifecycle, socket-dir mount, env, frame+log removal |
| `src/stages/maskfs/mask_filter_stage.ts` | modify — daemon wiring, readiness, `sun_path` assertion |
| `src/docker/embed/entrypoint.sh` | modify — wrapper passes `--socket`, loses its fallback |
| `src/stages/launch/integration_test.ts` | modify — fixture gains serve/supervise; fallback test inverted |

---

### Task 1: Serve mode — listener, poll loop, masking relay

**Files:**
- Create: `src/mask-filter/serve.zig`
- Modify: `src/mask-filter/mask_filter.zig`
- Test: `src/mask-filter/serve.zig` (inline), `src/stages/maskfs/mask_filter_integration_test.ts`

**Interfaces:**
- Consumes: `mask_stream.MaskStream` — `init(allocator, secrets)`, `deinit(allocator)`, `readBuf()`, `push(n, writer)`, `finish(writer)`; `mask_stream.BUF_SIZE`.
- Produces: `serve.run(allocator, secrets, socket_path) !u8`; CLI `nas-mask-filter --serve <path>`, frame from `NAS_MASK_SECRETS_FILE`.

**Protocol contract** (Tasks 3 and 8 depend on it exactly):
- Connection = one stream. Client writes raw bytes, reads masked bytes.
- **Not byte-synchronous** — the server withholds `maxSecretLen - 1` bytes.
- Client signals end with `shutdown(SHUT_WR)`; server flushes retained overlap, then closes.

- [ ] **Step 1: Write the failing integration test**

Add to `src/stages/maskfs/mask_filter_integration_test.ts`:

```ts
import * as net from "node:net";

function startServe(secretsFile: string, sockPath: string) {
  return Bun.spawn([binaryPath!, "--serve", sockPath], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, NAS_MASK_SECRETS_FILE: secretsFile },
  });
}

async function waitForSocket(sockPath: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(sockPath)) return true;
    await Bun.sleep(20);
  }
  return false;
}

/** Send `input` on one connection, half-close, collect until the server closes. */
function maskOverSocket(sockPath: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const sock = net.createConnection(sockPath);
    sock.on("connect", () => sock.end(Buffer.from(input)));
    sock.on("data", (d) => chunks.push(d));
    sock.on("end", () => resolve(Buffer.concat(chunks).toString()));
    sock.on("error", reject);
  });
}

describe("nas-mask-filter --serve", () => {
  test("masks a stream over the socket", async () => {
    if (!binaryPath) return;
    const secretsFile = writeSecretsFile(["hunter2"]);
    const sockPath = path.join(tmpDir, `serve-${secretsFileSeq}.sock`);
    const proc = startServe(secretsFile, sockPath);
    try {
      expect(await waitForSocket(sockPath)).toBe(true);
      expect(await maskOverSocket(sockPath, "pw=hunter2 done")).toBe("pw=******* done");
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 15000);

  test("masks a secret straddling a socket chunk boundary", async () => {
    if (!binaryPath) return;
    const secretsFile = writeSecretsFile(["SECRETVALUE"]);
    const sockPath = path.join(tmpDir, `serve-seam-${secretsFileSeq}.sock`);
    const proc = startServe(secretsFile, sockPath);
    try {
      expect(await waitForSocket(sockPath)).toBe(true);
      const out = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const s = net.createConnection(sockPath);
        s.on("connect", async () => {
          // Split the secret across two writes with a gap, forcing the seam.
          s.write(Buffer.from("head SECRE"));
          await Bun.sleep(50);
          s.end(Buffer.from("TVALUE tail"));
        });
        s.on("data", (d) => chunks.push(d));
        s.on("end", () => resolve(Buffer.concat(chunks).toString()));
        s.on("error", reject);
      });
      expect(out).toBe("head *********** tail");
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 15000);

  test("keeps per-connection overlap state isolated", async () => {
    if (!binaryPath) return;
    const secretsFile = writeSecretsFile(["hunter2"]);
    const sockPath = path.join(tmpDir, `serve-iso-${secretsFileSeq}.sock`);
    const proc = startServe(secretsFile, sockPath);
    try {
      expect(await waitForSocket(sockPath)).toBe(true);
      const [a, b] = await Promise.all([
        maskOverSocket(sockPath, "aaa hunter2 aaa"),
        maskOverSocket(sockPath, "bbb hunter2 bbb"),
      ]);
      expect(a).toBe("aaa ******* aaa");
      expect(b).toBe("bbb ******* bbb");
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 15000);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/stages/maskfs/mask_filter_integration_test.ts -t "serve"`
Expected: FAIL — the binary rejects `--serve` (exit 2), so `waitForSocket` returns false.

- [ ] **Step 3: Implement `serve.zig`**

```zig
//! serve モード: Unix socket で待ち受け、接続ごとにストリームをマスクして返す。
//!
//! 接続 = 1 ストリーム。クライアントは生バイトを書き、マスク済みバイトを読む。
//! マスクは末尾 maxSecretLen-1 バイトを次チャンクに備えて保持するため、返信は
//! 遅延し「N 書いたら N 返る」ではない。shutdown(SHUT_WR) を受けたら残りを
//! フラッシュして close する。
//!
//! 全接続を単一の poll ループで多重化する。1 接続を完了まで処理してから次を
//! accept する実装は禁止 — 長時間走るシェル 1 本が他の全シェルをブロックする。

const std = @import("std");
const posix = std.posix;
const mask_stream = @import("mask_stream.zig");

pub const MAX_CONNECTIONS: usize = 256;
/// 接続ごとの未送信バイト数の上限。超えたら読み取りを止め、socket バッファ
/// 経由でクライアントへバックプレッシャを伝える。ホストのメモリをエージェント
/// に制御させないための上限。
pub const MAX_QUEUED_BYTES: usize = 4 * 1024 * 1024;
/// 無通信のまま切らずに保持する上限。エージェントは socket ディレクトリへ
/// 到達できるので、idle 接続を並べるだけで接続枠を占有できてしまう。
pub const IDLE_TIMEOUT_MS: i64 = 120_000;
/// EMFILE 時に listener の poll を止めておく時間。readable のまま poll し
/// 続けると accept が失敗し続けて 100% CPU のスピンになる。
const EMFILE_BACKOFF_MS: i64 = 250;

const Conn = struct {
    fd: posix.fd_t,
    /// 最初のバイトを受け取るまで確保しない。MaskStream は 1 本あたり
    /// 約 192KiB (combined + scratch + mask_buf) 使うため、accept 時点で
    /// 確保すると connect() 一回が 192KiB のホストメモリを意味してしまう。
    stream: ?mask_stream.MaskStream = null,
    out: std.ArrayList(u8),
    last_progress_ms: i64,
    read_closed: bool = false,
    flushed: bool = false,
};

const QueueWriter = struct {
    out: *std.ArrayList(u8),
    allocator: std.mem.Allocator,
    pub fn writeAll(self: QueueWriter, bytes: []const u8) !void {
        try self.out.appendSlice(self.allocator, bytes);
    }
};

fn nowMs() i64 {
    return std.time.milliTimestamp();
}

pub fn run(
    allocator: std.mem.Allocator,
    secrets: []const []const u8,
    socket_path: []const u8,
) !u8 {
    var addr = posix.sockaddr.un{ .family = posix.AF.UNIX, .path = undefined };
    if (socket_path.len >= addr.path.len) return error.SocketPathTooLong;
    @memset(&addr.path, 0);
    @memcpy(addr.path[0..socket_path.len], socket_path);

    posix.unlink(socket_path) catch {};

    // 接続はシェル 1 本につき 2 本。make -j では数百本に達するので soft limit
    // (よく 1024) を上げておく。
    if (posix.getrlimit(.NOFILE)) |lim| {
        var raised = lim;
        raised.cur = lim.max;
        posix.setrlimit(.NOFILE, raised) catch {};
    } else |_| {}

    const listener = try posix.socket(
        posix.AF.UNIX,
        posix.SOCK.STREAM | posix.SOCK.CLOEXEC | posix.SOCK.NONBLOCK,
        0,
    );
    defer posix.close(listener);
    try posix.bind(listener, @ptrCast(&addr), @sizeOf(posix.sockaddr.un));
    try posix.listen(listener, 128);
    try posix.fchmodat(posix.AT.FDCWD, socket_path, 0o600, 0);

    var conns: std.ArrayList(*Conn) = .empty;
    defer conns.deinit(allocator);
    var pollfds: std.ArrayList(posix.pollfd) = .empty;
    defer pollfds.deinit(allocator);

    var listener_backoff_until: i64 = 0;

    while (true) {
        const now = nowMs();
        const listener_ready = conns.items.len < MAX_CONNECTIONS and now >= listener_backoff_until;

        pollfds.clearRetainingCapacity();
        try pollfds.append(allocator, .{
            .fd = listener,
            .events = if (listener_ready) posix.POLL.IN else 0,
            .revents = 0,
        });
        for (conns.items) |c| {
            var events: i16 = 0;
            if (!c.read_closed and c.out.items.len < MAX_QUEUED_BYTES) events |= posix.POLL.IN;
            if (c.out.items.len > 0) events |= posix.POLL.OUT;
            try pollfds.append(allocator, .{ .fd = c.fd, .events = events, .revents = 0 });
        }

        // idle 接続の刈り取りと EMFILE バックオフのため、必ず有限の timeout を使う。
        _ = posix.poll(pollfds.items, 1000) catch |err| switch (err) {
            error.SystemResources => continue,
            else => return err,
        };

        // accept は conns を伸ばすので、走査対象の件数を先に固定する。
        // これを忘れると pollfds[i+1] が範囲外になり最初の接続でパニックする。
        const n_polled = conns.items.len;

        if (listener_ready and pollfds.items[0].revents & posix.POLL.IN != 0) {
            acceptOne(allocator, listener, &conns) catch |err| switch (err) {
                error.FdQuota => listener_backoff_until = nowMs() + EMFILE_BACKOFF_MS,
                else => {},
            };
        }

        var i: usize = n_polled;
        while (i > 0) {
            i -= 1;
            const c = conns.items[i];
            const revents = pollfds.items[i + 1].revents;
            const done = serviceConn(allocator, c, revents, secrets) catch true;
            const idle = nowMs() - c.last_progress_ms > IDLE_TIMEOUT_MS;
            if (done or idle) {
                posix.close(c.fd);
                if (c.stream) |*s| s.deinit(allocator);
                c.out.deinit(allocator);
                allocator.destroy(c);
                _ = conns.swapRemove(i);
            }
        }
    }
}

fn acceptOne(
    allocator: std.mem.Allocator,
    listener: posix.fd_t,
    conns: *std.ArrayList(*Conn),
) !void {
    const fd = posix.accept(listener, null, null, posix.SOCK.CLOEXEC | posix.SOCK.NONBLOCK) catch |err| switch (err) {
        error.SystemFdQuotaExceeded, error.ProcessFdQuotaExceeded => return error.FdQuota,
        error.WouldBlock => return,
        else => return err,
    };
    errdefer posix.close(fd);
    const c = try allocator.create(Conn);
    errdefer allocator.destroy(c);
    c.* = .{ .fd = fd, .out = .empty, .last_progress_ms = nowMs() };
    try conns.append(allocator, c);
}

/// 1 接続を 1 回分だけ進める。close してよければ true。
fn serviceConn(
    allocator: std.mem.Allocator,
    c: *Conn,
    revents: i16,
    secrets: []const []const u8,
) !bool {
    if (revents & (posix.POLL.ERR | posix.POLL.NVAL) != 0) return true;
    const writer = QueueWriter{ .out = &c.out, .allocator = allocator };

    if (revents & posix.POLL.OUT != 0 and c.out.items.len > 0) {
        const n = posix.write(c.fd, c.out.items) catch |err| switch (err) {
            error.WouldBlock => 0,
            else => return true,
        };
        if (n > 0) {
            std.mem.copyForwards(u8, c.out.items[0 .. c.out.items.len - n], c.out.items[n..]);
            c.out.shrinkRetainingCapacity(c.out.items.len - n);
            c.last_progress_ms = nowMs();
        }
    }

    if (!c.read_closed and c.out.items.len < MAX_QUEUED_BYTES and
        revents & (posix.POLL.IN | posix.POLL.HUP) != 0)
    {
        if (c.stream == null) c.stream = try mask_stream.MaskStream.init(allocator, secrets);
        const s = &c.stream.?;
        const n = posix.read(c.fd, s.readBuf()) catch |err| switch (err) {
            error.WouldBlock => return false,
            else => return true,
        };
        c.last_progress_ms = nowMs();
        if (n == 0) {
            c.read_closed = true;
            try s.finish(writer);
            c.flushed = true;
        } else {
            try s.push(n, writer);
        }
    }

    return c.flushed and c.out.items.len == 0;
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

const testing = std.testing;

test "serve: rejects a socket path that cannot fit in sun_path" {
    const long = "/" ++ "x" ** 200;
    try testing.expectError(
        error.SocketPathTooLong,
        run(testing.allocator, &.{}, long),
    );
}
```

- [ ] **Step 4: Restructure mode dispatch in `mask_filter.zig`**

Two existing facts constrain this — both break the build if ignored:

1. `parseSuperviseArgs` returns `!?SuperviseArgs` (optional), and six tests at
   `mask_filter.zig:147-187` depend on that signature. Do **not** change it.
2. `main` currently reads `NAS_MASK_SECRETS_FILE` **before** dispatch and returns 2
   when unset. Supervise mode must no longer require it.

```zig
pub const Mode = union(enum) { filter, serve: []const u8, supervise: SuperviseArgs };

pub fn parseMode(argv: []const []const u8) !Mode {
    if (argv.len == 0) return .filter;
    if (std.mem.eql(u8, argv[0], "--serve")) {
        if (argv.len < 2) return error.MissingOptionValue;
        if (argv.len > 2) return error.UnknownOption;
        return .{ .serve = argv[1] };
    }
    // parseSuperviseArgs は optional を返す。null は「supervise ではない」。
    if (try parseSuperviseArgs(argv)) |sa| return .{ .supervise = sa };
    return error.UnknownOption;
}
```

In `main`, load the frame **only** in the `.filter` and `.serve` arms:

```zig
const mode = parseMode(argv[1..]) catch |err| {
    std.debug.print("nas-mask-filter: {}\n{s}", .{ err, usage_text });
    return 2;
};
switch (mode) {
    .supervise => |sa| return supervise.run(arena_alloc, sa),
    .serve => |sock| {
        const secrets = try loadSecretsOrExit();
        return serve.run(arena_alloc, secrets, sock);
    },
    .filter => {
        const secrets = try loadSecretsOrExit();
        // ...existing stdin->stdout path, unchanged...
    },
}
```

Keep `readSecretsFromFile` and the filter mode. `src/hostexec/broker.ts:741`
spawns the binary in filter mode with `NAS_MASK_SECRETS_FILE` for C3 masking;
deleting either kills host-side masking.

- [ ] **Step 5: Register the new files in the Zig test aggregator**

`mask_filter.zig` currently has `test { _ = @import("mask_stream.zig"); _ = @import("supervise.zig"); }`.
Add both new files, or their inline tests never run:

```zig
test {
    _ = @import("mask_stream.zig");
    _ = @import("supervise.zig");
    _ = @import("serve.zig");
    _ = @import("relay.zig");
}
```

(`relay.zig` arrives in Task 3; add its import then.)

- [ ] **Step 6: Build and test**

Run: `cd src/mask-filter && zig build && zig build test`
Expected: build succeeds; all tests pass.

Zig 0.15 `ArrayList` takes an allocator per method and starts as `.empty`;
`posix.poll` retries `EINTR` internally. Iterate against the compiler.

- [ ] **Step 7: Run the integration tests**

Run: `bun test src/stages/maskfs/mask_filter_integration_test.ts -t "serve"`
Expected: all three PASS.

- [ ] **Step 8: Commit**

```bash
cd /home/hogeyama/repo/nix-agent-sandbox
bun run check
git add src/mask-filter/serve.zig src/mask-filter/mask_filter.zig src/stages/maskfs/mask_filter_integration_test.ts
git commit -m "$(cat <<'EOF'
feat(mask-filter): add host-side serve mode

Unix socket で待ち受け、接続ごとに MaskStream を持ってストリームを
マスクして返すモードを追加する。接続 = 1 ストリームで、クライアントが
shutdown(SHUT_WR) したら保持中の overlap をフラッシュして close する。

全接続を単一の poll ループで多重化する。エージェントはシェルを同時に
複数起動し (1 シェルにつき 2 接続)、シェルは分単位で生存しうるため、
1 接続を完了まで処理してから次を accept する実装だと長時間走るシェル
1 本が他の全シェルをブロックする。

ホスト側で動く以上、消費する資源はコンテナの cgroup の外にある。
接続数上限、接続ごとの未送信バイト数上限、idle 接続の刈り取り、
EMFILE 時の listener バックオフを入れる。MaskStream は最初のバイトを
受け取るまで確保しない (1 本あたり約 192KiB のため、accept 時確保だと
connect() 一回が同量のホストメモリを意味してしまう)。

素の stdin->stdout フィルタモードと readSecretsFromFile は残す。
src/hostexec/broker.ts がホスト実行コマンドのマスク (C3) に使っており、
削除するとホスト側マスクが全滅する。あわせて main の構造を変え、
シークレットフレームを読むのを filter と serve のモードに限定する。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Verify the resource bounds actually bound

**Files:**
- Test: `src/stages/maskfs/mask_filter_integration_test.ts`

The bounds were implemented in Task 1. This task proves they work, because the
obvious test does not.

**Why the obvious test is useless:** `net.Socket.write()` returns `false` as soon
as Node's own 16 KiB `highWaterMark` is exceeded — which a 256 KiB chunk does on
the first call, regardless of the server. A loop that counts only `true` returns
measures nothing; it reports 0 bytes with **and** without the cap. Measure the
**server's RSS** instead.

- [ ] **Step 1: Write the failing test**

```ts
function serverRssKb(pid: number): number {
  const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
  const m = status.match(/^VmRSS:\s+(\d+) kB$/m);
  return m ? Number(m[1]) : 0;
}

test("bounds server memory when a client stops reading", async () => {
  if (!binaryPath) return;
  if (!fs.existsSync("/proc/self/status")) return; // Linux only
  const secretsFile = writeSecretsFile(["hunter2"]);
  const sockPath = path.join(tmpDir, `serve-bp-${secretsFileSeq}.sock`);
  const proc = startServe(secretsFile, sockPath);
  try {
    expect(await waitForSocket(sockPath)).toBe(true);
    const sock = net.createConnection(sockPath);
    await new Promise((r) => sock.on("connect", r));
    sock.pause();

    // Push far more than the 4MB cap, ignoring write()'s backpressure signal —
    // we want the kernel to accept as much as it will.
    const chunk = Buffer.alloc(1024 * 1024, "x");
    const deadline = Date.now() + 5000;
    let pushed = 0;
    while (Date.now() < deadline && pushed < 64 * 1024 * 1024) {
      sock.write(chunk);
      pushed += chunk.length;
      await Bun.sleep(5);
    }
    await Bun.sleep(500);

    // 4MB queue + 2x64KB MaskStream buffers + runtime. 64MB pushed; an
    // unbounded server tracks the client.
    expect(serverRssKb(proc.pid)).toBeLessThan(48 * 1024);

    sock.destroy();
    // The server must still serve other connections.
    expect(await maskOverSocket(sockPath, "pw=hunter2")).toBe("pw=*******");
  } finally {
    proc.kill();
    await proc.exited;
  }
}, 30000);

test("survives a flood of idle connections", async () => {
  if (!binaryPath) return;
  const secretsFile = writeSecretsFile(["hunter2"]);
  const sockPath = path.join(tmpDir, `serve-flood-${secretsFileSeq}.sock`);
  const proc = startServe(secretsFile, sockPath);
  const idle: net.Socket[] = [];
  try {
    expect(await waitForSocket(sockPath)).toBe(true);
    for (let i = 0; i < 300; i++) {
      const s = net.createConnection(sockPath);
      s.on("error", () => {});
      idle.push(s);
    }
    await Bun.sleep(500);
    // Beyond MAX_CONNECTIONS the server must not wedge: a real client either
    // gets served or gets a clean EOF. It must never hang.
    const served = await Promise.race([
      maskOverSocket(sockPath, "pw=hunter2"),
      Bun.sleep(5000).then(() => "TIMEOUT"),
    ]);
    expect(served).not.toBe("TIMEOUT");
  } finally {
    for (const s of idle) s.destroy();
    proc.kill();
    await proc.exited;
  }
}, 30000);
```

- [ ] **Step 2: Run and confirm both pass**

Run: `bun test src/stages/maskfs/mask_filter_integration_test.ts -t "bounds server memory"`
Run: `bun test src/stages/maskfs/mask_filter_integration_test.ts -t "flood of idle"`
Expected: PASS with Task 1's bounds.

To confirm the tests are not inert, temporarily raise `MAX_QUEUED_BYTES` to
`std.math.maxInt(usize)`, rebuild, and check the RSS test **fails**. Restore
afterwards.

- [ ] **Step 3: Commit**

```bash
bun run check
git add src/stages/maskfs/mask_filter_integration_test.ts
git commit -m "$(cat <<'EOF'
test(mask-filter): prove serve-mode resource bounds hold

読み取りを止めたクライアントに対してサーバのメモリが頭打ちになること、
接続を並べられても他のクライアントが待たされないことを検証する。

クライアント側の write() の戻り値では検証できない。Node の write() は
サーバの状態と無関係に自前の highWaterMark (16KiB) を超えた時点で false を
返すため、返り値を数える方式は上限あり・なしの両方で同じ値になり、
回帰を検出できない。サーバの VmRSS を直接見る。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Supervise mode — relay over the socket

**Files:**
- Create: `src/mask-filter/relay.zig`
- Modify: `src/mask-filter/supervise.zig`, `src/mask-filter/mask_filter.zig`
- Test: `src/stages/maskfs/mask_filter_integration_test.ts`

**Interfaces:**
- Consumes: Task 1's protocol; `SuperviseArgs` gains `socket: []const u8`.
- Produces exactly these `relay.Relay` members (no others are referenced anywhere):
  `connect(allocator, path) !Relay`, `deinit()`, `queueWrite(bytes) !void`,
  `pending_len() usize`, `pumpWritable() !void`, `pumpReadable(dst_fd) !bool`,
  `halfClose() void`, field `fd`.

**Correctness note:** the existing `FdWriter` (`supervise.zig:87`) swallows write
errors and treats a short write as complete. Correct for the child's output fd,
**catastrophic for the socket**: dropping bytes `[i, i+k)` splits a secret so
neither fragment matches, and both are then emitted verbatim.

- [ ] **Step 1: Write the failing test**

```ts
async function runSupervisedOverSocket(
  script: string,
  secrets: string[],
  opts?: { argv0?: string; stdin?: Uint8Array },
) {
  const secretsFile = writeSecretsFile(secrets);
  const sockPath = path.join(tmpDir, `sup-${secretsFileSeq}.sock`);
  const server = startServe(secretsFile, sockPath);
  try {
    if (!(await waitForSocket(sockPath))) throw new Error("serve not ready");
    const argv0Args = opts?.argv0 ? ["--argv0", opts.argv0] : [];
    const proc = Bun.spawn(
      [binaryPath!, "--supervise", ...argv0Args, "--socket", sockPath,
       "--", realBashPath(), "-c", script],
      {
        stdin: opts?.stdin ?? "ignore",
        stdout: "pipe", stderr: "pipe",
        env: { ...process.env },  // deliberately NO NAS_MASK_SECRETS_FILE
      },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { stdout, stderr, exitCode: await proc.exited };
  } finally {
    server.kill();
    await server.exited;
  }
}

test("masks supervised output through the socket", async () => {
  if (!binaryPath) return;
  const r = await runSupervisedOverSocket("echo pw=hunter2", ["hunter2"]);
  expect(r.stdout).toBe("pw=*******\n");
  expect(r.exitCode).toBe(0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/stages/maskfs/mask_filter_integration_test.ts -t "through the socket"`
Expected: FAIL — `--socket` is an unknown option (exit 2).

- [ ] **Step 3: Implement `relay.zig`**

```zig
//! relay — supervise モードのクライアント側。子の出力を socket へ送り、
//! マスク済みバイトを受け取って出力先 fd へ書く。
//!
//! 書き込みは必ずキューイングする。短絡書き込みを完了扱いにしたりエラーを
//! 握り潰したりすると、シークレットが分断されて「どちらの断片もマッチしない」
//! 状態になり、両方が素通しで出てしまう。

const std = @import("std");
const posix = std.posix;

pub const RelayError = error{ ConnectFailed, PeerGone, WriteFailed };

pub const Relay = struct {
    fd: posix.fd_t,
    allocator: std.mem.Allocator,
    pending: std.ArrayList(u8),
    write_closed: bool = false,
    eof: bool = false,

    pub fn connect(allocator: std.mem.Allocator, socket_path: []const u8) !Relay {
        var addr = posix.sockaddr.un{ .family = posix.AF.UNIX, .path = undefined };
        if (socket_path.len >= addr.path.len) return error.SocketPathTooLong;
        @memset(&addr.path, 0);
        @memcpy(addr.path[0..socket_path.len], socket_path);
        // CLOEXEC 必須。この fd が子へ漏れると単なる情報漏洩ではなく注入
        // オラクルになる: ストリーム途中に 1 バイト差し込むとマッチが崩れて
        // 原文が返るため、差し込んだ値を知っていれば原文を復元できる。
        const fd = try posix.socket(
            posix.AF.UNIX,
            posix.SOCK.STREAM | posix.SOCK.CLOEXEC,
            0,
        );
        errdefer posix.close(fd);
        // ブロッキングのまま connect する。AF_UNIX の非ブロッキング connect が
        // 返す EAGAIN は「backlog が一杯でまだ繋がっていない」であって
        // POLLOUT で完了を待てるものではないため、成功扱いにすると
        // 何も届かない relay になる。接続後に非ブロッキングへ切り替える。
        posix.connect(fd, @ptrCast(&addr), @sizeOf(posix.sockaddr.un)) catch {
            return RelayError.ConnectFailed;
        };
        const flags = try posix.fcntl(fd, posix.F.GETFL, 0);
        _ = try posix.fcntl(fd, posix.F.SETFL, flags | @as(u32, @bitCast(posix.O{ .NONBLOCK = true })));
        return .{ .fd = fd, .allocator = allocator, .pending = .empty };
    }

    pub fn deinit(self: *Relay) void {
        self.pending.deinit(self.allocator);
        posix.close(self.fd);
    }

    pub fn pending_len(self: *const Relay) usize {
        return self.pending.items.len;
    }

    pub fn queueWrite(self: *Relay, bytes: []const u8) !void {
        try self.pending.appendSlice(self.allocator, bytes);
    }

    /// POLLOUT 時に呼ぶ。短絡書き込みはキューに残す。実エラーは致命的。
    pub fn pumpWritable(self: *Relay) !void {
        if (self.pending.items.len == 0) return;
        const n = posix.write(self.fd, self.pending.items) catch |err| switch (err) {
            error.WouldBlock => return,
            else => return RelayError.WriteFailed,
        };
        if (n == 0) return RelayError.PeerGone;
        std.mem.copyForwards(u8, self.pending.items[0 .. self.pending.items.len - n], self.pending.items[n..]);
        self.pending.shrinkRetainingCapacity(self.pending.items.len - n);
    }

    /// POLLIN 時に呼ぶ。マスク済みバイトを dst_fd へ書く。
    /// true = サーバが close した (このストリームは完了)。
    pub fn pumpReadable(self: *Relay, dst_fd: posix.fd_t) !bool {
        var buf: [64 * 1024]u8 = undefined;
        const n = posix.read(self.fd, &buf) catch |err| switch (err) {
            error.WouldBlock => return false,
            else => return RelayError.PeerGone,
        };
        if (n == 0) {
            self.eof = true;
            return true;
        }
        try writeAllFatal(dst_fd, buf[0..n]);
        return false;
    }

    /// 入力終了をサーバへ伝える。サーバは保持中の overlap をフラッシュする。
    pub fn halfClose(self: *Relay) void {
        if (self.write_closed) return;
        self.write_closed = true;
        posix.shutdown(self.fd, .send) catch {};
    }
};

/// 出力先 fd への完全書き込み。ここでの取りこぼしはマスク済みバイトの欠落
/// なので、握り潰さず致命的に扱う。dst_fd は常にブロッキング (supervisor が
/// 継承した stdout/stderr) である前提。
fn writeAllFatal(fd: posix.fd_t, bytes: []const u8) !void {
    var i: usize = 0;
    while (i < bytes.len) {
        const n = posix.write(fd, bytes[i..]) catch {
            return RelayError.WriteFailed;
        };
        if (n == 0) return RelayError.WriteFailed;
        i += n;
    }
}

const testing = std.testing;

test "relay: rejects a socket path that cannot fit in sun_path" {
    const long = "/" ++ "x" ** 200;
    try testing.expectError(error.SocketPathTooLong, Relay.connect(testing.allocator, long));
}
```

- [ ] **Step 4: Rework `supervise.zig` — the three-phase termination machine**

This is the subtle part. Write it exactly as specified.

Parse `--socket <path>` (required). Connect both relays **before fork** with a
bounded retry; **if either fails**, print the constant diagnostic and return
`EXIT_OUTPUT_SUPPRESSED` without forking.

```zig
pub const EXIT_OUTPUT_SUPPRESSED: u8 = 121;
const DIAG_BROKER_UNAVAILABLE = "nas-mask-filter: mask broker unavailable; output suppressed\n";
const CONNECT_ATTEMPTS: usize = 5;
const CONNECT_BACKOFF_NS: u64 = 20 * std.time.ns_per_ms;
/// relay へ積んだまま送れていないバイト数の上限。これを超えたら子のパイプの
/// 読み取りを止める。止めないとパイプが埋まらず子も止まらないので、
/// バックプレッシャの連鎖が成立しない。
const RELAY_MAX_PENDING: usize = 4 * 1024 * 1024;
/// 両ストリームを half-close した後、サーバが残りを返すのを待つ上限。
/// 子のパイプ用の DRAIN_IDLE_MS とは別物。混ぜると、少し混んだサーバの
/// 応答待ちが「もう出力は無い」と誤判定されて末尾が切れる。
const SOCKET_DRAIN_MS: i64 = 5_000;

fn connectWithRetry(allocator: std.mem.Allocator, path: []const u8) !relay.Relay {
    var attempt: usize = 0;
    while (true) : (attempt += 1) {
        if (relay.Relay.connect(allocator, path)) |r| return r else |err| {
            if (attempt + 1 >= CONNECT_ATTEMPTS) return err;
            std.Thread.sleep(CONNECT_BACKOFF_NS);
        }
    }
}
```

In the child branch, close both relay fds in addition to the pipe fds (they are
already `CLOEXEC`; this is belt and braces).

The parent loop runs three phases. Track per stream: `pipe_done`, `relay_done`.

- **Phase 1 — child alive.** Poll: child stdout pipe, child stderr pipe, sig
  self-pipe, and each relay fd (`POLL.IN`, plus `POLL.OUT` when
  `pending_len() > 0`). Timeout `-1`.
  - A child pipe is polled for `POLL.IN` only while its relay's
    `pending_len() < RELAY_MAX_PENDING`.
  - Pipe read → `relay.queueWrite`. Pipe EOF → `pipe_done = true`,
    `relay.halfClose()`, stop polling that pipe.
  - Relay readable → `pumpReadable(dst_fd)`; true → `relay_done = true`.
- **Phase 2 — child exited, pipes draining.** Same as phase 1 but the poll
  timeout becomes `DRAIN_IDLE_MS`. **If poll times out with no pipe data, treat
  every not-yet-done pipe as done** — `halfClose()` its relay and stop polling
  it. This is what makes `echo before; (sleep 30) & echo after` terminate: the
  backgrounded process holds the pipe open forever, so pipe EOF never arrives
  and only the idle timeout can end phase 2.
- **Phase 3 — both relays half-closed.** Stop polling pipes entirely. Poll only
  the relay fds with a deadline of `SOCKET_DRAIN_MS` from entry. End when both
  relays report EOF, or the deadline expires (then exit
  `EXIT_OUTPUT_SUPPRESSED`, because the server's retained tail was lost).

Any `RelayError` at any phase is fatal: stop writing output, exit
`EXIT_OUTPUT_SUPPRESSED`.

Do **not** end the loop on child-pipe EOF alone — the server still owes the
retained `maxSecretLen - 1` bytes, which only arrive after the half-close.

- [ ] **Step 5: Build and run the socket test**

Run: `cd src/mask-filter && zig build && cd ../.. && bun test src/stages/maskfs/mask_filter_integration_test.ts -t "through the socket"`
Expected: PASS

- [ ] **Step 6: Port every existing supervise test to the socket form**

Rewrite the `nas-mask-filter --supervise` describe block to use
`runSupervisedOverSocket`: stderr masking, exit-code propagation, 128+signo,
`--argv0`, output larger than the pipe buffer, stdin passthrough, SIGTERM
forwarding, and **the background-process non-hang case** (the phase-2 test).

Change the "never loses output across repeated short runs" test to start **one**
serve daemon and reuse it for all 50 iterations — the helper above spawns a
daemon per call, which would be 50 spawn/kill cycles inside one test.

Run: `bun test src/stages/maskfs/mask_filter_integration_test.ts`
Expected: all PASS. The background case must still finish in under 5 s.

- [ ] **Step 7: Add fail-closed, mid-run-death, and fd-hygiene tests**

```ts
test("fails closed when the broker is absent", async () => {
  if (!binaryPath) return;
  const sockPath = path.join(tmpDir, `sup-dead-${secretsFileSeq}.sock`);
  const proc = Bun.spawn(
    [binaryPath, "--supervise", "--socket", sockPath, "--",
     realBashPath(), "-c", "echo pw=hunter2"],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env } },
  );
  const stdout = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(121);
  expect(stdout).toBe("");
});

test("fails closed when the broker dies mid-run", async () => {
  if (!binaryPath) return;
  const secretsFile = writeSecretsFile(["hunter2"]);
  const sockPath = path.join(tmpDir, `sup-mid-${secretsFileSeq}.sock`);
  const server = startServe(secretsFile, sockPath);
  try {
    expect(await waitForSocket(sockPath)).toBe(true);
    const proc = Bun.spawn(
      [binaryPath, "--supervise", "--socket", sockPath, "--",
       realBashPath(), "-c", "sleep 0.5; echo pw=hunter2"],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env } },
    );
    await Bun.sleep(150);
    server.kill();
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(121);
    expect(stdout).not.toContain("hunter2");
  } finally {
    server.kill();
    await server.exited;
  }
}, 15000);

test("does not leak socket fds into the supervised child", async () => {
  if (!binaryPath) return;
  const r = await runSupervisedOverSocket("ls -l /proc/self/fd", ["hunter2"]);
  // A leaked relay fd shows up as a socket: entry. Assert the invariant
  // directly rather than counting descriptor numbers.
  expect(r.stdout).not.toContain("socket:");
});
```

Run: `bun test src/stages/maskfs/mask_filter_integration_test.ts -t "fails closed"`
Run: `bun test src/stages/maskfs/mask_filter_integration_test.ts -t "leak socket fds"`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
bun run check
git add src/mask-filter/relay.zig src/mask-filter/supervise.zig src/mask-filter/mask_filter.zig src/stages/maskfs/mask_filter_integration_test.ts
git commit -m "$(cat <<'EOF'
feat(mask-filter): relay supervised output to the host broker

supervise はローカルでマスクするのをやめ、子の stdout/stderr を Unix
socket へ中継してマスク済みバイトを書き戻すリレーになる。これでコンテナ
内にシークレットのバイトが不要になる。

socket への書き込みは必ずキューイングする。既存の FdWriter は書き込み
エラーを握り潰し短絡書き込みを完了扱いにするが、これは子の出力 fd 用の
挙動で socket に流用してはいけない。バイトを黙って落とすとシークレットが
分断され、どちらの断片もマッチせず両方が素通しで出てしまう。

終了判定を 3 段階に分ける。子のパイプが EOF になっただけでは終われない
(サーバが保持中の末尾をまだ返していない) が、EOF を無条件に待つことも
できない (バックグラウンドプロセスがパイプを掴んだままだと EOF が来ない)。
パイプ側はアイドルタイムアウトで打ち切り、half-close 後に socket 側だけを
別の期限で待つ。両者の期限を共有すると、少し混んだサーバの応答待ちが
「もう出力は無い」と誤判定されて末尾が切れる。

socket fd は CLOEXEC で作り子側でも明示的に閉じる。子へ漏れると注入
オラクルになる: ストリーム途中に 1 バイト差し込むとマッチが崩れて原文が
返るため、差し込んだ値を知っていれば原文を復元できる。

どちらか一方でも接続に失敗したら子を起動せず 121 で終了する。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Suppress nested supervision

**Files:**
- Modify: `src/mask-filter/supervise.zig`, `src/docker/embed/entrypoint.sh`
- Test: `src/stages/maskfs/mask_filter_integration_test.ts`

**Why:** every `bash` in the container is the wrapper — `./configure`, each
`make` recipe line, recursive make, npm/cargo build scripts. `make -j16`
sustains dozens of live shells and nesting is unbounded, so connections are
O(live bash processes) and each layer relays every byte across the boundary
again.

Suppression costs no coverage: descendants inherit the outermost supervisor's
pipes, so their output is already masked. Output that escapes the outermost
supervisor (a redirect to a file, a write to `/dev/tty`) escapes every inner
layer identically.

- [ ] **Step 1: Write the failing test**

The test must go through **the wrapper**, not `bash.real` — the guard lives in
the wrapper. Build a wrapper stand-in from the entrypoint heredoc:

```ts
/** Extract the MASK_WRAPPER heredoc from entrypoint.sh into a runnable script. */
function writeWrapperScript(sockPath: string): string {
  const entry = fs.readFileSync(
    path.join(import.meta.dir, "../../docker/embed/entrypoint.sh"), "utf8",
  );
  const m = entry.match(/<< 'MASK_WRAPPER'\n([\s\S]*?)\nMASK_WRAPPER\n/);
  if (!m) throw new Error("MASK_WRAPPER heredoc not found");
  // The heredoc hardcodes /tmp/nas-bash-override/bash.real; point it at the
  // real bash for host-side testing.
  const body = m[1].replaceAll("/tmp/nas-bash-override/bash.real", realBashPath());
  const p = path.join(tmpDir, `wrapper-${secretsFileSeq}.sh`);
  fs.writeFileSync(p, `${body}\n`, { mode: 0o755 });
  return p;
}

test("nests exactly one supervision layer", async () => {
  if (!binaryPath) return;
  const secretsFile = writeSecretsFile(["hunter2"]);
  const sockPath = path.join(tmpDir, `nest-${secretsFileSeq}.sock`);
  const server = startServe(secretsFile, sockPath);
  try {
    expect(await waitForSocket(sockPath)).toBe(true);
    const wrapper = writeWrapperScript(sockPath);
    // Outer wrapper runs an inner wrapper. Only one layer may supervise, and
    // masking must still apply to both.
    const proc = Bun.spawn(
      [wrapper, "-c", `${wrapper} -c 'echo inner=hunter2'; echo outer=hunter2`],
      {
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
        env: { ...process.env, NAS_MASK_FILTER: binaryPath, NAS_MASK_SOCKET: sockPath },
      },
    );
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toBe("inner=*******\nouter=*******\n");
  } finally {
    server.kill();
    await server.exited;
  }
}, 15000);
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/stages/maskfs/mask_filter_integration_test.ts -t "nests exactly one"`
Expected: FAIL — without the guard the inner wrapper supervises too, producing a
second layer (and the wrapper does not yet accept `--socket`-based invocation
until Task 7 updates the heredoc; if the heredoc is still the old form, this test
fails on that instead — either way it is red).

- [ ] **Step 3: Export the marker from the supervisor**

In `supervise.zig`, build the child's `envp` **before fork** (the file's existing
comment at `:157` requires it: no allocation in the child). Copy
`std.c.environ`, **replacing** any existing `NAS_MASK_SUPERVISED=` entry rather
than appending — appending would leave a duplicate that later `getenv` calls may
or may not see:

```zig
fn buildChildEnvp(allocator: std.mem.Allocator) ![*:null]const ?[*:0]const u8 {
    const MARKER = "NAS_MASK_SUPERVISED=1";
    var list: std.ArrayList(?[*:0]const u8) = .empty;
    defer list.deinit(allocator);
    var i: usize = 0;
    while (std.c.environ[i]) |entry| : (i += 1) {
        const slice = std.mem.span(entry);
        if (std.mem.startsWith(u8, slice, "NAS_MASK_SUPERVISED=")) continue;
        try list.append(allocator, entry);
    }
    try list.append(allocator, (try allocator.dupeZ(u8, MARKER)).ptr);
    const owned = try allocator.allocSentinel(?[*:0]const u8, list.items.len, null);
    @memcpy(owned[0..list.items.len], list.items);
    return owned.ptr;
}
```

Pass the result to `execveZ` in place of `@ptrCast(std.c.environ)`.

- [ ] **Step 4: Add the wrapper guard**

In `entrypoint.sh`'s `MASK_WRAPPER` heredoc, before the supervise exec:

```sh
if [ -n "${NAS_MASK_SUPERVISED:-}" ]; then
  exec -a "$0" /tmp/nas-bash-override/bash.real "$@"
fi
```

- [ ] **Step 5: Run the test**

Run: `bun test src/stages/maskfs/mask_filter_integration_test.ts -t "nests exactly one"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
bun run check
git add src/mask-filter/supervise.zig src/docker/embed/entrypoint.sh src/stages/maskfs/mask_filter_integration_test.ts
git commit -m "$(cat <<'EOF'
feat(mask-filter): suppress nested supervision layers

コンテナ内の bash はすべてラッパーなので、./configure や make の各レシピ
行、再帰 make、npm/cargo のビルドスクリプトも supervise される。make -j16
では同時生存シェルが数十本になり、接続数は「数シェル」ではなく生存 bash
プロセス数に比例する。入れ子の深さだけ全バイトがコンテナとホストの間を
往復し、その分だけ出力保持による遅延も積み上がる。

supervisor が NAS_MASK_SUPERVISED=1 を子へ渡し、ラッパーはそれが設定済み
なら素の bash を exec する。子の環境は fork 前に構築し、既存の同名変数は
追加ではなく置換する。

抑止してもカバレッジは減らない。子孫はすべて最外周 supervisor のパイプを
継承するので出力は既にマスクされており、最外周から逃げる出力 (ファイルへの
リダイレクト、/dev/tty への書き込み) は内側の層からも同様に逃げる。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: MaskFilterService — daemon lifecycle, mounts, env

**Files:**
- Modify: `src/stages/maskfs/mask_filter_service.ts`
- Test: `src/stages/maskfs/mask_filter_service_test.ts`

**Interfaces:**
```ts
export const MASK_FILTER_CONTAINER_PATH = "/opt/nas/mask-filter/nas-mask-filter";
export interface MaskFilterPreparePlan {
  readonly secretsFramePath: string;  // host-only; its directory is NEVER mounted
  readonly filterBinaryHostPath: string;
  readonly socketDir: string;         // mounted; MUST contain only the socket
  readonly socketPath: string;        // `${socketDir}/mask.sock`
  readonly logFile: string;           // MUST NOT live under socketDir
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
}
prepareMaskFilter(plan, secrets): Effect<MaskFilterResult, unknown, Scope.Scope>
```

**THE CRITICAL CONSTRAINT.** `socketDir` must be a directory of its own,
containing nothing but the socket. The frame lives in the session directory,
which is **not** mounted. Putting both in one directory and mounting it — as an
earlier draft did — hands the agent the frame again, and worse: the mount is
read-write, so the agent could delete the socket, bind its own listener at that
path, and have every subsequent shell connect to an echo server. That is a
silent, total masking bypass that still reports success.

Also update the Layer type — `prepareMaskFilter` now needs `ProcessService`:
```ts
export const MaskFilterServiceLive: Layer.Layer<MaskFilterService, never, FsService | ProcessService>
```
(`src/cli.ts:314,333` already provides both.)

- [ ] **Step 1: Rewrite the service test**

Replace `mask_filter_service_test.ts` wholesale.

```ts
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { FsService } from "../../services/fs.ts";
import { ProcessService } from "../../services/process.ts";
import { MaskFilterService, MaskFilterServiceLive } from "./mask_filter_service.ts";

const SESSION_DIR = "/run/user/1000/nas/mask-filter/sess_x";
const SOCKET_DIR = "/run/user/1000/nas/mask-filter/sess_x-sock";
const FRAME = `${SESSION_DIR}/mask-secrets`;
const SOCKET = `${SOCKET_DIR}/mask.sock`;

function fakeFs(written: Array<{ path: string; data: Uint8Array }>) {
  return Layer.succeed(FsService, FsService.of({
    writeFile: (p, data) => Effect.sync(() => {
      written.push({ path: p, data: data instanceof Uint8Array ? data : new TextEncoder().encode(String(data)) });
    }),
    mkdir: () => Effect.void, readFile: () => Effect.succeed(""),
    chmod: () => Effect.void, symlink: () => Effect.void, rm: () => Effect.void,
    rename: () => Effect.void,
    stat: () => Effect.succeed({ isFile: () => true, isDirectory: () => false, mode: 0o600, size: 0 } as any),
    exists: () => Effect.succeed(true), mkdtemp: () => Effect.succeed("/tmp/fake"),
  }));
}

function fakeProc(spawns: Array<{ command: string; args: string[] }>) {
  return Layer.succeed(ProcessService, ProcessService.of({
    spawn: (command, args) => Effect.sync(() => {
      spawns.push({ command, args });
      return { kill: () => {}, exited: Effect.succeed(0), pid: 4242 };
    }),
    waitForFileExists: () => Effect.void,
    exec: () => Effect.succeed(""),
  }));
}

const host = {
  home: "/home/u", user: "u", uid: 1000, gid: 1000, isWSL: false,
  env: new Map([["TEST_SECRET", "hunter2secret"]]),
} as any;

function run(written: any[], spawns: any[]) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* MaskFilterService;
          const secrets = yield* svc.resolveSecrets([{ source: "env:TEST_SECRET" }], host);
          return yield* svc.prepareMaskFilter({
            secretsFramePath: FRAME,
            filterBinaryHostPath: "/usr/local/bin/nas-mask-filter",
            socketDir: SOCKET_DIR,
            socketPath: SOCKET,
            logFile: `${SESSION_DIR}/serve.log`,
            timeoutMs: 5000, pollIntervalMs: 25,
          }, secrets);
        }),
        MaskFilterServiceLive.pipe(Layer.provide(Layer.merge(fakeFs(written), fakeProc(spawns)))),
      ),
    ),
  );
}

describe("MaskFilterServiceLive.prepareMaskFilter", () => {
  test("writes the frame host-side (hostexec C3 depends on it)", async () => {
    const written: any[] = []; const spawns: any[] = [];
    await run(written, spawns);
    expect(written.map((w) => w.path)).toContain(FRAME);
  });

  // C1 regression guard. Substring checks are NOT enough: mounting the frame's
  // *parent directory* exposes it while passing any `not.toContain("mask-secrets")`
  // assertion. Assert reachability instead.
  test("no mount can reach the secrets frame (C1)", async () => {
    const written: any[] = []; const spawns: any[] = [];
    const result = await run(written, spawns);
    for (const m of result.mounts) {
      const src = m.source.endsWith("/") ? m.source : `${m.source}/`;
      expect(FRAME === m.source || FRAME.startsWith(src)).toBe(false);
    }
  });

  test("no container env names the frame (S1)", async () => {
    const written: any[] = []; const spawns: any[] = [];
    const result = await run(written, spawns);
    expect(result.envVars.NAS_MASK_SECRETS_FILE).toBeUndefined();
    expect(JSON.stringify(result.envVars)).not.toContain("mask-secrets");
  });

  test("mounts only the socket directory and exports the socket path", async () => {
    const written: any[] = []; const spawns: any[] = [];
    const result = await run(written, spawns);
    expect(result.mounts.some((m) => m.source === SOCKET_DIR && m.target === SOCKET_DIR)).toBe(true);
    expect(result.envVars.NAS_MASK_SOCKET).toBe(SOCKET);
    expect(result.envVars.NAS_MASK_FILTER).toBe("/opt/nas/mask-filter/nas-mask-filter");
  });

  test("keeps the log out of the mounted directory", async () => {
    const written: any[] = []; const spawns: any[] = [];
    const result = await run(written, spawns);
    for (const m of result.mounts) {
      const src = m.source.endsWith("/") ? m.source : `${m.source}/`;
      expect(`${SESSION_DIR}/serve.log`.startsWith(src)).toBe(false);
    }
  });

  test("spawns the serve daemon", async () => {
    const written: any[] = []; const spawns: any[] = [];
    await run(written, spawns);
    expect(spawns.length).toBe(1);
    expect(spawns[0].command).toBe("/usr/local/bin/nas-mask-filter");
    expect(spawns[0].args).toEqual(["--serve", SOCKET]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/stages/maskfs/mask_filter_service_test.ts`
Expected: FAIL — no `socketDir`, no spawn, and `NAS_MASK_SECRETS_FILE` still emitted.

- [ ] **Step 3: Rewrite the service**

- Delete `MASK_SECRETS_CONTAINER_PATH`.
- Keep writing the frame at `mode: 0o600` in a `0o700` directory (hostexec reads it).
- `mkdir` the socket directory at `0o700`.
- Spawn `--serve`, passing `NAS_MASK_SECRETS_FILE` in the **daemon's own env**
  (a host-side process; this is not a container variable).
- `Effect.acquireRelease`: on release kill the daemon, then remove the frame, the
  socket, and the log.

```ts
const handle = yield* Effect.acquireRelease(
  proc.spawn(plan.filterBinaryHostPath, ["--serve", plan.socketPath], {
    logFile: plan.logFile,
    env: { NAS_MASK_SECRETS_FILE: plan.secretsFramePath },
  }),
  (h) =>
    Effect.sync(() => h.kill()).pipe(
      // S2: the frame must not outlive the session. Today only the hostexec
      // broker removes it, so with mask.filter on and hostexec off it leaks.
      Effect.andThen(fs.rm(plan.secretsFramePath).pipe(Effect.catchAllCause(() => Effect.void))),
      Effect.andThen(fs.rm(plan.socketPath).pipe(Effect.catchAllCause(() => Effect.void))),
      Effect.andThen(fs.rm(plan.logFile).pipe(Effect.catchAllCause(() => Effect.void))),
    ),
);
// ProcessService.spawn opens the log with openSync(path,"a") => 0644.
// Tighten it: MaskFsService.defaultWaitReady splices the log tail into
// user-visible errors, so it must not be world-readable.
yield* fs.chmod(plan.logFile, 0o600).pipe(Effect.catchAllCause(() => Effect.void));
yield* proc.waitForFileExists(plan.socketPath, plan.timeoutMs, plan.pollIntervalMs);
```

```ts
const mounts: MountSpec[] = [
  { source: plan.socketDir, target: plan.socketDir },
  { source: plan.filterBinaryHostPath, target: MASK_FILTER_CONTAINER_PATH, readOnly: true },
];
const envVars: Record<string, string> = {
  NAS_MASK_SOCKET: plan.socketPath,
  NAS_MASK_FILTER: MASK_FILTER_CONTAINER_PATH,
};
```

Update `makeMaskFilterServiceFake` to the new signature.

- [ ] **Step 4: Run the tests**

Run: `bun test src/stages/maskfs/mask_filter_service_test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
bun run check
git add src/stages/maskfs/mask_filter_service.ts src/stages/maskfs/mask_filter_service_test.ts
git commit -m "$(cat <<'EOF'
fix(mask-filter): stop exposing the secrets frame to the container

シークレットフレームは 0600 だが所有者がエージェント自身の UID なので、
コンテナから見える場所に置いている限り保護になっていない。cat 一発で
セッション中の全シークレットの索引が読める。security-constraints の
C1 と S1 に反する。

フレームのマウントとコンテナ env を廃止し、ホスト側で --serve デーモンを
起動して socket だけをコンテナへ見せる。socket はセッションディレクトリ
とは別のディレクトリに置き、そのディレクトリだけをマウントする。
socket をフレームと同じディレクトリに置いてそこをマウントすると、
フレームを再び渡すことになるうえ、マウントは読み書き可能なので
エージェントが socket を差し替えて素通しのエコーサーバを立てられる。
それはマスクの完全な無効化でありながら supervise は成功を報告する。

フレームファイル自体はホスト専用ディレクトリに残す。C1 はこの配置を明示的
に許容しており、src/hostexec/broker.ts がホスト実行コマンドのマスク (C3)
でこのファイルを直読みしているため、消すと C3 が壊れる。

あわせて S2 の穴を塞ぐ。フレームの削除は現状 hostexec broker だけが行って
おり、mask.filter 有効かつ hostexec 無効の構成ではセッション終了後も
フレームが残っていた。ログも 0600 に落として削除対象に含める。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: MaskFilterStage — wire the daemon

**Files:**
- Modify: `src/stages/maskfs/mask_filter_stage.ts`
- Test: `src/stages/maskfs/mask_filter_stage_test.ts`

- [ ] **Step 1: Write the failing tests**

Use the helpers already in `mask_filter_stage_test.ts` (`makeStageInput`,
`makeMaskFilterServiceFake`, `emptyContainerPlan`) — read the file first and
follow its existing shape exactly.

```ts
test("derives a socket directory separate from the frame directory", async () => {
  const captured: any[] = [];
  const fake = makeMaskFilterServiceFake({
    prepareMaskFilter: (plan) => {
      captured.push(plan);
      return Effect.succeed({ mounts: [], envVars: {} });
    },
    resolveSecrets: () => Effect.succeed(["hunter2secret"]),
  });
  // ...run the stage with makeStageInput(...) and provide `fake`...
  const plan = captured[0];
  const frameDir = plan.secretsFramePath.slice(0, plan.secretsFramePath.lastIndexOf("/"));
  expect(plan.socketDir).not.toBe(frameDir);
  expect(plan.socketPath.startsWith(`${plan.socketDir}/`)).toBe(true);
  expect(plan.secretsFramePath.startsWith(`${plan.socketDir}/`)).toBe(false);
});

test("rejects a socket path longer than sun_path", async () => {
  // A long session id pushes the socket path past 107 bytes.
  const longSessionId = `sess_${"x".repeat(120)}`;
  // ...run the stage with makeStageInput({ sessionId: longSessionId })...
  const exit = await Effect.runPromiseExit(/* the stage effect */);
  expect(Exit.isFailure(exit)).toBe(true);
  expect(JSON.stringify(exit)).toContain("socket path too long");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test src/stages/maskfs/mask_filter_stage_test.ts -t "socket"`
Expected: FAIL — the stage has no `socketDir` and no length check.

- [ ] **Step 3: Update the stage**

```ts
const SOCKET_READY_TIMEOUT_MS = 10_000;
const SOCKET_READY_POLL_MS = 25;
/** sun_path は 108 バイト (終端含む)。超えると bind(2) が不可解に失敗する。 */
const MAX_SOCKET_PATH_BYTES = 107;

const sessionDir = `${runtimeDir}/${shared.sessionId}`;
const secretsFramePath = `${sessionDir}/mask-secrets`;
// socket はコンテナへマウントするディレクトリに置く。フレームと同居させて
// はいけない — そのディレクトリごとコンテナへ渡すことになる。
const socketDir = `${runtimeDir}/${shared.sessionId}-sock`;
const socketPath = `${socketDir}/mask.sock`;

const socketPathBytes = new TextEncoder().encode(socketPath).byteLength;
if (socketPathBytes > MAX_SOCKET_PATH_BYTES) {
  return yield* Effect.fail(
    new Error(
      `[nas] mask: socket path too long (${socketPathBytes} > ${MAX_SOCKET_PATH_BYTES} bytes): ${socketPath}`,
    ),
  );
}
```

Pass `socketDir`, `socketPath`, `logFile: ${sessionDir}/serve.log`, and the
readiness knobs to `prepareMaskFilter`. Update the module header comment — the
stage now owns a daemon and is no longer "デーモンを持たない 1 回限りの準備作業".

- [ ] **Step 4: Run the tests**

Run: `bun test src/stages/maskfs/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
bun run check
git add src/stages/maskfs/mask_filter_stage.ts src/stages/maskfs/mask_filter_stage_test.ts
git commit -m "$(cat <<'EOF'
feat(mask-filter): give MaskFilterStage a daemon lifecycle

ステージが --serve デーモンをセッションスコープで起動し、socket が
listen 状態になるまで待ってからコンテナを起動する。起動レースをクライアント
側のリトライで誤魔化すのではなく構造的に潰すため。

socket はセッションディレクトリと別のディレクトリに置く。マウントするのは
socket のあるディレクトリなので、フレームと同居させるとフレームごと
コンテナへ渡してしまう。

socket パスが sun_path の 108 バイト制限を超える場合はステージで失敗させる。
放置するとデーモン内の bind(2) が不可解に失敗するだけで原因が分からない。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: entrypoint.sh wrapper

**Files:**
- Modify: `src/docker/embed/entrypoint.sh`

- [ ] **Step 1: Update the wrapper heredoc and its install guard**

```sh
if [ -n "${NAS_MASK_FILTER:-}" ] && [ -n "${NAS_MASK_SOCKET:-}" ]; then
```

```sh
#!/tmp/nas-bash-override/bash.real
if [ "${1:-}" = "/entrypoint.sh" ]; then
  exec -a "$0" /tmp/nas-bash-override/bash.real "$@"
fi
if [ -n "${NAS_MASK_SUPERVISED:-}" ]; then
  exec -a "$0" /tmp/nas-bash-override/bash.real "$@"
fi
exec "$NAS_MASK_FILTER" --supervise --argv0 "$0" --socket "$NAS_MASK_SOCKET" -- \
  /tmp/nas-bash-override/bash.real "$@"
```

The runtime fallback is gone on purpose: translating "the secret file is
readable" into "the socket exists" would keep a **fail-open** path where a dead
serve process silently yields unmasked shells.

Leave the `/entrypoint.sh` branch alone — it keeps a TTY for entrypoint re-entry,
and entrypoint's shell mode execs `$NAS_REAL_BASH` unmasked by design. Narrowing
it is a separate hardening item (see the spec) and is **out of scope**.

- [ ] **Step 2: Verify the generated wrapper without Docker**

```bash
cd /home/hogeyama/repo/nix-agent-sandbox
BIN=src/mask-filter/zig-out/bin/nas-mask-filter
WORK=$(mktemp -d)
# secrets frame: u32le count=1, u32le len=7, "hunter2"
printf '\x01\x00\x00\x00\x07\x00\x00\x00hunter2' > "$WORK/frame"
NAS_MASK_SECRETS_FILE="$WORK/frame" "$BIN" --serve "$WORK/mask.sock" &
SERVE=$!
until [ -S "$WORK/mask.sock" ]; do sleep 0.05; done

sed -n "/<< 'MASK_WRAPPER'/,/^MASK_WRAPPER$/p" src/docker/embed/entrypoint.sh \
  | sed '1d;$d' > "$WORK/bash"
sed -i "s#/tmp/nas-bash-override/bash.real#$(command -v bash)#g" "$WORK/bash"
chmod +x "$WORK/bash"
export NAS_MASK_FILTER="$PWD/$BIN" NAS_MASK_SOCKET="$WORK/mask.sock"

"$WORK/bash" -c 'printf "cmd %s pw=hunter2\n" "$0"'
"$WORK/bash" -lc 'printf "login %s pw=hunter2\n" "$0"'
printf 'printf "script %%s pw=hunter2\\n" "$0"\n' > "$WORK/s.sh"
"$WORK/bash" "$WORK/s.sh"

kill $SERVE; rm -rf "$WORK"
```

Expected: three lines, each ending `pw=*******`; `$0` is the wrapper path for
`-c`/`-lc` and `$WORK/s.sh` for the script form.

- [ ] **Step 3: Commit**

```bash
bun run check
git add src/docker/embed/entrypoint.sh
git commit -m "$(cat <<'EOF'
fix(mask-filter): remove the wrapper's fail-open fallback

ラッパーは secrets ファイルが読めなければ素の bash に fallback していた。
これを socket の存在チェックに翻訳すると、serve が死んだときに無言で
マスク無しのシェルが起動する fail-open 経路がそのまま残る。

判定自体を廃止し、常に supervisor を exec する。到達できなければ supervisor
側が fail-closed で落ちる。マスクが設定されている構成でのみラッパーが設置
されるため、判定は元から冗長だった。

先頭の /entrypoint.sh バイパスは別物なので残す。entrypoint 再入時に TTY を
保つためのもので、shell モードは設計上 bash.real を直接 exec する。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Docker integration tests

**Files:**
- Modify: `src/stages/launch/integration_test.ts`

Read the whole file first. Four existing facts will break this task if ignored:

1. `MASK_FILTER_FIXTURE` reads `os.environ["NAS_MASK_SECRETS_FILE"]` **at module
   top level** (`:76`). After Task 7 that variable is gone from the container, so
   every `--supervise` invocation would die with `KeyError`. The frame read must
   move inside the `--serve` branch.
2. The mask tests mount the fixture dir `:ro` (e.g. `:578`). A socket directory
   cannot be read-only for our purposes, so the socket needs its **own**
   read-write mount, separate from the fixture mount.
3. `USING_DIND` (`:45`) means host paths ≠ daemon paths; under DinD the socket
   must live under the shared tmp dir.
4. The fixture must **not** mask line-wise in serve mode — the Task 1 protocol is
   byte-stream with a `maxSecretLen-1` tail withheld until half-close. A
   line-wise server withholds a final unterminated line forever.

- [ ] **Step 1: Restructure the fixture**

```python
#!/usr/bin/env python3
import os, socket, struct, subprocess, sys, threading

def load_secrets():
    frame = memoryview(open(os.environ["NAS_MASK_SECRETS_FILE"], "rb").read())
    count = struct.unpack_from("<I", frame, 0)[0]
    offset, out = 4, []
    for _ in range(count):
        length = struct.unpack_from("<I", frame, offset)[0]
        offset += 4
        out.append(bytes(frame[offset:offset + length]))
        offset += length
    return out

def mask(data, secrets):
    for s in secrets:
        if s:
            data = data.replace(s, b"*" * len(s))
    return data

def serve(path, secrets):
    maxlen = max((len(s) for s in secrets), default=0)
    overlap = max(maxlen - 1, 0)
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(path)
    srv.listen(128)

    def handle(conn):
        buf = b""
        with conn:
            while True:
                chunk = conn.recv(65536)
                if not chunk:
                    conn.sendall(mask(buf, secrets))  # flush retained tail
                    return
                buf += chunk
                if len(buf) > overlap:
                    emit, buf = buf[:len(buf) - overlap], buf[len(buf) - overlap:]
                    conn.sendall(mask(emit, secrets))

    while True:
        conn, _ = srv.accept()
        threading.Thread(target=handle, args=(conn,), daemon=True).start()

def supervise(argv):
    argv0, sock_path = None, None
    while argv:
        if argv[0] == "--argv0":
            argv0, argv = argv[1], argv[2:]
        elif argv[0] == "--socket":
            sock_path, argv = argv[1], argv[2:]
        elif argv[0] == "--":
            argv = argv[1:]
            break
        else:
            break
    program, rest = argv[0], argv[1:]

    def pump(src, dst_fd):
        conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        conn.connect(sock_path)
        done = threading.Event()

        def reader():
            while True:
                data = conn.recv(65536)
                if not data:
                    break
                os.write(dst_fd, data)
            done.set()

        t = threading.Thread(target=reader, daemon=True)
        t.start()
        for block in iter(lambda: src.read(65536), b""):
            conn.sendall(block)
        conn.shutdown(socket.SHUT_WR)
        done.wait()
        conn.close()

    child = subprocess.Popen(
        [argv0 or program] + rest, executable=program,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    threads = [
        threading.Thread(target=pump, args=(child.stdout, 1)),
        threading.Thread(target=pump, args=(child.stderr, 2)),
    ]
    for t in threads:
        t.start()
    status = child.wait()
    for t in threads:
        t.join()
    sys.exit(status if status >= 0 else 128 - status)

args = sys.argv[1:]
if args and args[0] == "--serve":
    serve(args[1], load_secrets())
elif args and args[0] == "--supervise":
    supervise(args[1:])
else:
    secrets = load_secrets()
    for data in sys.stdin.buffer:
        sys.stdout.buffer.write(mask(data, secrets))
        sys.stdout.buffer.flush()
```

- [ ] **Step 2: Start the fixture daemon and mount its socket directory**

Add a helper next to `writeMaskFilterFixture`:

```ts
async function startFixtureServe(fixtureDir: string, secretsPath: string) {
  // Under DinD the daemon's socket must be reachable by the Docker daemon,
  // so it lives under the shared tmp dir rather than an arbitrary host path.
  const base = USING_DIND ? SHARED_TMP : fixtureDir;
  const sockDir = await mkdtemp(path.join(base, "nas-mask-sock-"));
  await chmod(sockDir, 0o777); // the container user must be able to connect
  const sockPath = path.join(sockDir, "mask.sock");
  const proc = Bun.spawn(
    [path.join(fixtureDir, "nas-mask-filter"), "--serve", sockPath],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore",
      env: { ...process.env, NAS_MASK_SECRETS_FILE: secretsPath } },
  );
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !existsSync(sockPath)) await Bun.sleep(20);
  return { proc, sockDir, sockPath };
}
```

In each mask test, start it before `dockerRun`, add
`"-v", `${sockDir}:${sockDir}`` to `extraArgs` (read-write, **separate** from the
`:ro` fixture mount), set `NAS_MASK_SOCKET: sockPath` in `envVars`, drop
`NAS_MASK_SECRETS_FILE`, and in `finally` `proc.kill()` + `rm(sockDir, ...)`.

- [ ] **Step 3: Invert the fallback test**

Replace `"absolute /bin/bash preserves output when the secrets frame is missing"`
with two cases:

```ts
// Socket configured but no daemon behind it: the wrapper is installed and
// must fail closed rather than emit unmasked output.
const dead = await dockerRun(
  ["/bin/bash", "-c", "printf 'fallback-stdout\\n'"],
  { workDir,
    envVars: {
      NAS_MASK_FILTER: `${containerFixtureDir}/nas-mask-filter`,
      NAS_MASK_SOCKET: `${containerFixtureDir}/absent.sock`,
    },
    extraArgs: ["-v", `${fixtureDir}:${containerFixtureDir}:ro`] },
);
expect(dead.stdout).not.toContain("fallback-stdout");
expect(dead.code).not.toEqual(0);

// NAS_MASK_SOCKET unset: entrypoint never installs the wrapper at all, so
// this is plain bash by construction, not a masking bypass.
const unset = await dockerRun(
  ["/bin/bash", "-c", "printf 'nomask-stdout\\n'"],
  { workDir, envVars: { NAS_MASK_FILTER: `${containerFixtureDir}/nas-mask-filter` },
    extraArgs: ["-v", `${fixtureDir}:${containerFixtureDir}:ro`] },
);
expect(unset.code).toEqual(0);
expect(unset.stdout).toContain("nomask-stdout");
```

- [ ] **Step 4: Add the nesting test**

Inside the existing mask test's `try` block, after the invocation loop:

```ts
const nested = await dockerRun(
  ["/bin/bash", "-c", `/bin/bash -c 'printf "inner=${secret}\\n"'`],
  { workDir,
    envVars: {
      NAS_MASK_FILTER: `${containerFixtureDir}/nas-mask-filter`,
      NAS_MASK_SOCKET: sockPath,
    },
    extraArgs: [
      "-v", `${fixtureDir}:${containerFixtureDir}:ro`,
      "-v", `${sockDir}:${sockDir}`,
    ] },
);
expect(nested.code).toEqual(0);
expect(nested.stdout).toContain(`inner=${masked}`);
expect(nested.stdout).not.toContain(secret);
```

- [ ] **Step 5: Run the Docker suite**

Run: `bun test src/stages/launch/integration_test.ts`
Expected: PASS, or all-skip when Docker is unavailable. **If it skips, say so
explicitly in the task report — do not report untested code as verified.**

- [ ] **Step 6: Run everything**

Run: `bun test src/` then `cd src/mask-filter && zig build test`
Expected: PASS. The existing hostexec masking tests must still pass — they are
the C3 regression guard.

- [ ] **Step 7: Commit**

```bash
bun run check
git add src/stages/launch/integration_test.ts
git commit -m "$(cat <<'EOF'
test(mask-filter): cover the socket-based wrapper end to end

Python フィクスチャに --serve と --supervise を実装し、Docker テストを
socket 経由の構成に合わせる。フィクスチャを実 Zig バイナリに置き換えなかった
のは、これらのテストを Zig ビルド無しで走らせるためという存在理由を保つため。

フレームの読み込みをモジュール先頭から --serve の分岐内へ移す。先頭のままだと
コンテナから NAS_MASK_SECRETS_FILE が消えた後、--supervise 側が KeyError で
即死する。serve はバイトストリームとして扱い、末尾 maxSecretLen-1 バイトを
half-close まで保持する。行単位で実装すると終端の無い最終行が永久に返らない。

socket ディレクトリはフィクスチャの :ro マウントとは別に読み書き可能で
マウントする。DinD ではホストとデーモンのパスが異なるため共有 tmp に置く。

secrets frame 欠如時のフォールバックを検証していたテストは、socket が死んで
いるときに fail-closed することの検証に反転させる。NAS_MASK_SOCKET 未設定の
場合はラッパー自体が設置されないので、素の bash になることを別ケースで示す。

入れ子 bash が supervise 層を 1 つだけ作ることも検証する。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
| --- | --- |
| Mount/env change; frame not reachable from container | 5, 6 |
| Mount the socket directory, not the socket file | 5 |
| `sun_path` assertion | 6 |
| Frame lifetime (S2) + log removal | 5 |
| Nested supervision | 4 |
| Protocol (half-close, non-synchronous reply) | 1, 3 |
| Resource bounds: queue cap, conn cap, EMFILE, RLIMIT, lazy `MaskStream` | 1, verified in 2 |
| Failure handling: connect retry, either-fails, mid-stream fatal, partial write | 3 |
| fd hygiene | 3 |
| Serve-mode output invariant | Global Constraints, 1 |
| Drain semantics preserved | 3 Step 4 (three phases), 3 Step 6 |
| Wrapper bypass branch left alone | 7 |
| hostexec C3 preserved | 1 Step 4, 5, 8 Step 6 |
| Zig unit tests: serve arg parsing, per-connection isolation | 1 Steps 3/5/7 |
| Tests: chunk-boundary seam, conn cap, concurrent shells, mid-run death | 1, 2, 3 |

**Type consistency:** `MaskFilterPreparePlan` gains `socketDir`, `socketPath`,
`logFile`, `timeoutMs`, `pollIntervalMs` in Task 5 and is consumed with exactly
those names in Task 6. `relay.Relay`'s member list in the Task 3 interface block
matches its definition — `pending_len` is used by the `RELAY_MAX_PENDING` gate;
there is no `wantsWrite` and no `ReadResult`. `EXIT_OUTPUT_SUPPRESSED = 121` is
defined in Task 3 and asserted in Tasks 3 and 8.

**Known residual risk, accepted:** the socket directory is mounted read-write, so
an agent can delete the socket and bind its own listener there, silently
disabling masking for shells started afterwards. A read-only mount is the
structural fix if `connect(2)` works through one; Task 8 Step 2 is the natural
place to find out. This is **not** a regression — today's frame mount is strictly
worse — but it should be recorded in the spec's "Accepted limitations" before
this ships, and revisited.
