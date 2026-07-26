# Mask Filter Host Broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop bind-mounting the secret frame into the container; mask stdout/stderr on the host over a Unix socket instead.

**Architecture:** `nas-mask-filter` gains a host-side `--serve <sock>` mode that listens on a Unix socket and masks byte streams, multiplexing every connection in one poll loop. The container-side `--supervise` mode stops masking locally and becomes a relay: it forwards the child's stdout/stderr to the socket and writes back what the server returns. The secret frame stays a host-only file (hostexec reads it directly for C3 masking) but is no longer mounted or named in container environment variables.

**Tech Stack:** Zig 0.15.2 (`src/mask-filter`), Bun + Effect (host-side TS), POSIX Unix domain sockets, Docker.

## Global Constraints

Read before implementing any task:

- **Skill `security-constraints`** — the invariants this work exists to satisfy. C1 (do not mount secrets into the container), S1 (secrets resolved host-side only), S2 (frame deleted at session end), C2 (only least-privileged endpoints exposed to the container), C3 (hostexec output is masked too), N1 (container→host only via mounted Unix socket).
- **Skill `test-policy`** — unit tests are `*_test.ts`, Docker-dependent tests are `*_integration_test.ts`, both co-located with their source. Integration tests must guard on Docker availability and clean up in `finally`. Note: the skill's command examples are stale (`deno task ...`); this project uses `bun test`.
- **Spec** — `docs/superpowers/specs/2026-07-26-mask-filter-host-broker-design.md`. Its "Accepted limitations" section is binding: do not attempt to fix the `/proc/<pid>/fd/1` bypass, the stdout/stderr split, or the idle-drain seam in this work.

Hard rules, every task:

- **No unmasked byte may reach the container.** Any error path either emits nothing or fails. Never "pass through on error".
- **Diagnostics on the real stderr are constant strings.** They bypass masking, so they must be incapable of carrying secret-derived data. Never interpolate stream bytes, secret values, or secret lengths.
- **Serve mode never writes stream-derived bytes to its own stdout/stderr.** `ProcessService.spawn` points both at the session log file, and `MaskFsService.defaultWaitReady` splices the log tail into user-visible errors.
- Exit code `121` means "output suppressed". Reserved; never reuse.
- Existing behaviour that must not regress: supervise mode's child-exit drain with idle timeout, signal forwarding to the direct child, exit-status propagation (128+signo), and `--argv0`.
- Commit after every task. Run `bun run check` before each commit.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/mask-filter/serve.zig` | **new** — UDS listener, connection table, poll loop, per-connection `MaskStream`, resource bounds |
| `src/mask-filter/relay.zig` | **new** — client side: socket connect, queued writer, bidirectional pump used by supervise |
| `src/mask-filter/supervise.zig` | modify — replace local masking with `relay`, add socket fd hygiene, fail-closed exits |
| `src/mask-filter/mask_filter.zig` | modify — argument parsing for `--serve` / `--socket`; keep filter mode and `readSecretsFromFile` (hostexec depends on them) |
| `src/mask-filter/mask_stream.zig` | unchanged — reused by `serve.zig` |
| `src/stages/maskfs/mask_filter_service.ts` | modify — daemon lifecycle, socket-dir mount, env change, frame removal on scope close |
| `src/stages/maskfs/mask_filter_stage.ts` | modify — wire the daemon, readiness wait, `sun_path` assertion |
| `src/docker/embed/entrypoint.sh` | modify — wrapper passes `--socket`, loses its runtime fallback |
| `src/stages/launch/integration_test.ts` | modify — Python fixture grows `--serve`/`--supervise`; fallback test inverted |

---

### Task 1: Serve mode — listener, poll loop, masking relay

**Files:**
- Create: `src/mask-filter/serve.zig`
- Modify: `src/mask-filter/mask_filter.zig`
- Test: `src/mask-filter/serve.zig` (inline Zig tests), `src/stages/maskfs/mask_filter_integration_test.ts`

**Interfaces:**
- Consumes: `mask_stream.MaskStream` (`init(allocator, secrets)`, `readBuf()`, `push(n, writer)`, `finish(writer)`), `BUF_SIZE = 64 * 1024`.
- Produces: `serve.run(allocator, secrets, socket_path) !u8`; CLI form `nas-mask-filter --serve <path>` reading the frame from `NAS_MASK_SECRETS_FILE`.

**Protocol contract** (later tasks depend on it exactly):
- Client connects, writes raw bytes, reads masked bytes. Not byte-synchronous — the server withholds `maxSecretLen - 1` bytes.
- Client signals end with `shutdown(SHUT_WR)`. Server flushes retained overlap, then `close`s.
- One connection carries exactly one stream.

- [ ] **Step 1: Write the failing integration test**

Add to `src/stages/maskfs/mask_filter_integration_test.ts`:

```ts
import * as net from "node:net";

function startServe(secretsFile: string, sockPath: string) {
  return Bun.spawn([binaryPath!, "--serve", sockPath], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
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

/** Send `input` on one connection, half-close, collect until server closes. */
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
      expect(await maskOverSocket(sockPath, "pw=hunter2 done")).toBe(
        "pw=******* done",
      );
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 15000);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/stages/maskfs/mask_filter_integration_test.ts -t "masks a stream over the socket"`
Expected: FAIL — the binary rejects `--serve` (usage error, exit 2), so `waitForSocket` returns false.

- [ ] **Step 3: Implement `serve.zig`**

```zig
//! serve モード: Unix socket で待ち受け、接続ごとにストリームをマスクして返す。
//!
//! 接続 = 1 ストリーム。クライアントは生バイトを書き、マスク済みバイトを読む。
//! マスクは末尾 maxSecretLen-1 バイトを次チャンクに備えて保持するため、
//! 返信は遅延し「N 書いたら N 返る」ではない。クライアントが shutdown(SHUT_WR)
//! したら残りをフラッシュして close する。
//!
//! 全接続を単一の poll ループで多重化する。1 接続を完了まで処理してから次を
//! accept する実装は禁止 — 長時間走るシェル 1 本がコンテナ内の全シェルを
//! ブロックしてしまう。

const std = @import("std");
const posix = std.posix;
const mask_stream = @import("mask_stream.zig");

pub const MAX_CONNECTIONS: usize = 256;

const Conn = struct {
    fd: posix.fd_t,
    stream: mask_stream.MaskStream,
    /// マスク済みで、まだクライアントへ書けていないバイト列。
    out: std.ArrayList(u8),
    /// クライアントが shutdown(SHUT_WR) 済み (これ以上入力が来ない)。
    read_closed: bool = false,
    /// finish() 済みで、out を吐き切ったら close してよい。
    flushed: bool = false,
};

/// Conn.out へ書き込む writer。MaskStream は writeAll しか使わない。
const QueueWriter = struct {
    out: *std.ArrayList(u8),
    allocator: std.mem.Allocator,

    pub fn writeAll(self: QueueWriter, bytes: []const u8) !void {
        try self.out.appendSlice(self.allocator, bytes);
    }
};

pub fn run(
    allocator: std.mem.Allocator,
    secrets: []const []const u8,
    socket_path: []const u8,
) !u8 {
    var addr = posix.sockaddr.un{ .family = posix.AF.UNIX, .path = undefined };
    if (socket_path.len >= addr.path.len) return error.SocketPathTooLong;
    @memset(&addr.path, 0);
    @memcpy(addr.path[0..socket_path.len], socket_path);

    // 前回のセッションの残骸があると bind に失敗する。
    posix.unlink(socket_path) catch {};

    const listener = try posix.socket(
        posix.AF.UNIX,
        posix.SOCK.STREAM | posix.SOCK.CLOEXEC | posix.SOCK.NONBLOCK,
        0,
    );
    defer posix.close(listener);
    try posix.bind(listener, @ptrCast(&addr), @sizeOf(posix.sockaddr.un));
    // 接続は同時多発する (シェル 1 本につき 2 本) ので backlog は広めに取る。
    try posix.listen(listener, 128);
    // socket は同一 UID からのみ触れれば十分。
    try posix.fchmodat(posix.AT.FDCWD, socket_path, 0o600, 0);

    var conns: std.ArrayList(*Conn) = .empty;
    defer conns.deinit(allocator);

    var pollfds: std.ArrayList(posix.pollfd) = .empty;
    defer pollfds.deinit(allocator);

    while (true) {
        pollfds.clearRetainingCapacity();
        // index 0 は常に listener。接続数が上限に達したら listener を
        // poll から外す。EMFILE を返す listener を readable のまま
        // poll し続けると 100% CPU のスピンになる。
        try pollfds.append(allocator, .{
            .fd = listener,
            .events = if (conns.items.len < MAX_CONNECTIONS) posix.POLL.IN else 0,
            .revents = 0,
        });
        for (conns.items) |c| {
            var events: i16 = 0;
            if (!c.read_closed) events |= posix.POLL.IN;
            if (c.out.items.len > 0) events |= posix.POLL.OUT;
            try pollfds.append(allocator, .{ .fd = c.fd, .events = events, .revents = 0 });
        }

        _ = posix.poll(pollfds.items, -1) catch |err| switch (err) {
            error.SystemResources => continue,
            else => return err,
        };

        if (pollfds.items[0].revents & posix.POLL.IN != 0) {
            acceptOne(allocator, listener, secrets, &conns) catch {};
        }

        var i: usize = conns.items.len;
        while (i > 0) {
            i -= 1;
            const pfd = pollfds.items[i + 1];
            const c = conns.items[i];
            const done = serviceConn(allocator, c, pfd.revents) catch true;
            if (done) {
                posix.close(c.fd);
                c.stream.deinit(allocator);
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
    secrets: []const []const u8,
    conns: *std.ArrayList(*Conn),
) !void {
    const fd = posix.accept(listener, null, null, posix.SOCK.CLOEXEC | posix.SOCK.NONBLOCK) catch |err| switch (err) {
        // fd 枯渇。accept せずに戻る。次周回は接続数が上限未満なら再挑戦する。
        error.SystemFdQuotaExceeded, error.ProcessFdQuotaExceeded => return,
        error.WouldBlock => return,
        else => return err,
    };
    errdefer posix.close(fd);
    const c = try allocator.create(Conn);
    errdefer allocator.destroy(c);
    c.* = .{
        .fd = fd,
        .stream = try mask_stream.MaskStream.init(allocator, secrets),
        .out = .empty,
    };
    try conns.append(allocator, c);
}

/// 1 接続を 1 回分だけ進める。close してよければ true。
fn serviceConn(allocator: std.mem.Allocator, c: *Conn, revents: i16) !bool {
    const writer = QueueWriter{ .out = &c.out, .allocator = allocator };

    if (revents & posix.POLL.OUT != 0 and c.out.items.len > 0) {
        const n = posix.write(c.fd, c.out.items) catch |err| switch (err) {
            error.WouldBlock => 0,
            else => return true,
        };
        if (n > 0) {
            std.mem.copyForwards(u8, c.out.items[0 .. c.out.items.len - n], c.out.items[n..]);
            c.out.shrinkRetainingCapacity(c.out.items.len - n);
        }
    }

    if (!c.read_closed and revents & (posix.POLL.IN | posix.POLL.HUP) != 0) {
        const n = posix.read(c.fd, c.stream.readBuf()) catch |err| switch (err) {
            error.WouldBlock => return false,
            else => return true,
        };
        if (n == 0) {
            // shutdown(SHUT_WR) を受けた。保持中の overlap を吐いて終わりにする。
            c.read_closed = true;
            try c.stream.finish(writer);
            c.flushed = true;
        } else {
            try c.stream.push(n, writer);
        }
    }

    if (revents & (posix.POLL.ERR | posix.POLL.NVAL) != 0) return true;
    return c.flushed and c.out.items.len == 0;
}
```

- [ ] **Step 4: Wire `--serve` into `mask_filter.zig`**

Extend the argument parser. `--serve` is mutually exclusive with `--supervise`.

```zig
pub const Mode = union(enum) {
    filter,
    serve: []const u8,
    supervise: SuperviseArgs,
};

pub fn parseMode(argv: []const []const u8) !Mode {
    if (argv.len == 0) return .filter;
    if (std.mem.eql(u8, argv[0], "--serve")) {
        if (argv.len < 2) return error.MissingOptionValue;
        if (argv.len > 2) return error.UnknownOption;
        return .{ .serve = argv[1] };
    }
    if (std.mem.eql(u8, argv[0], "--supervise")) {
        return .{ .supervise = try parseSuperviseArgs(argv) };
    }
    return error.UnknownOption;
}
```

`main` dispatches on it. Keep `readSecretsFromFile` and the existing filter mode
untouched — `src/hostexec/broker.ts:741` spawns the binary in filter mode with
`NAS_MASK_SECRETS_FILE`, and deleting either would break C3 masking.

- [ ] **Step 5: Build and run the Zig tests**

Run: `cd src/mask-filter && zig build && zig build test`
Expected: build succeeds, all existing tests pass.

Zig 0.15 std APIs are fiddly (`ArrayList` takes an allocator per call, `poll`
retries `EINTR` internally). Iterate against the compiler rather than assuming.

- [ ] **Step 6: Run the integration test**

Run: `bun test src/stages/maskfs/mask_filter_integration_test.ts -t "masks a stream over the socket"`
Expected: PASS

- [ ] **Step 7: Add a per-connection isolation test**

```ts
test("keeps per-connection overlap state isolated", async () => {
  if (!binaryPath) return;
  const secretsFile = writeSecretsFile(["hunter2"]);
  const sockPath = path.join(tmpDir, `serve-iso-${secretsFileSeq}.sock`);
  const proc = startServe(secretsFile, sockPath);
  try {
    expect(await waitForSocket(sockPath)).toBe(true);
    // Interleaved connections must not share MaskStream state.
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
```

Run: `bun test src/stages/maskfs/mask_filter_integration_test.ts -t "isolated"`
Expected: PASS

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
複数起動し (1 シェルにつき stdout/stderr の 2 接続)、シェルは分単位で
生存しうるため、1 接続を完了まで処理してから次を accept する実装だと
長時間走るシェル 1 本が他の全シェルをブロックする。

接続数が上限に達したら listener を poll 対象から外す。EMFILE を返す
listener を readable のまま poll し続けると恒久的な 100% CPU スピンに
なるため。

素の stdin->stdout フィルタモードと readSecretsFromFile は残す。
src/hostexec/broker.ts がホスト実行コマンドのマスク (C3) にそれらを
使っているため、削除するとホスト側マスクが全滅する。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Serve mode — output cap and backpressure

**Files:**
- Modify: `src/mask-filter/serve.zig`
- Test: `src/stages/maskfs/mask_filter_integration_test.ts`

**Interfaces:**
- Consumes: `Conn`, `serviceConn` from Task 1.
- Produces: `MAX_QUEUED_BYTES` constant; `Conn.out` is bounded.

**Why:** the server runs on the host, outside the container's cgroup. A client that stops reading (because it is blocked writing to its own stdout) while its child keeps producing lets `Conn.out` grow without bound — agent-controlled host memory. The fix is to stop reading from that connection once the queue is full; backpressure then propagates through the socket buffer to the supervisor and through the pipe to the writer.

- [ ] **Step 1: Write the failing test**

```ts
test("applies backpressure instead of buffering without bound", async () => {
  if (!binaryPath) return;
  const secretsFile = writeSecretsFile(["hunter2"]);
  const sockPath = path.join(tmpDir, `serve-bp-${secretsFileSeq}.sock`);
  const proc = startServe(secretsFile, sockPath);
  try {
    expect(await waitForSocket(sockPath)).toBe(true);

    // Connect, write hard, never read. The server must stop accepting our
    // bytes rather than queueing them, so our writes eventually stop draining.
    const sock = net.createConnection(sockPath);
    await new Promise((r) => sock.on("connect", r));
    sock.pause(); // never read

    const chunk = Buffer.alloc(256 * 1024, "x");
    let written = 0;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (!sock.write(chunk)) break; // kernel buffer full => backpressure reached
      written += chunk.length;
      if (written > 256 * 1024 * 1024) break; // 256MB with no backpressure = unbounded
      await Bun.sleep(0);
    }
    sock.destroy();

    expect(written).toBeLessThan(256 * 1024 * 1024);

    // The server must still be alive and serving other connections.
    expect(await maskOverSocket(sockPath, "pw=hunter2")).toBe("pw=*******");
  } finally {
    proc.kill();
    await proc.exited;
  }
}, 30000);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/stages/maskfs/mask_filter_integration_test.ts -t "backpressure"`
Expected: FAIL — without a cap the server keeps consuming and queueing, so `written` reaches the 256MB ceiling (and host RSS climbs).

- [ ] **Step 3: Add the cap**

In `serve.zig`:

```zig
/// 接続ごとの未送信バイト数の上限。これを超えたらその接続の読み取りを
/// 止め、socket バッファ経由でクライアントへ、さらにパイプ経由で
/// 書き手へバックプレッシャを伝播させる。ホストのメモリをエージェントに
/// 制御させないための上限。
pub const MAX_QUEUED_BYTES: usize = 4 * 1024 * 1024;
```

In the poll-set construction, gate `POLL.IN` on the queue:

```zig
for (conns.items) |c| {
    var events: i16 = 0;
    if (!c.read_closed and c.out.items.len < MAX_QUEUED_BYTES) events |= posix.POLL.IN;
    if (c.out.items.len > 0) events |= posix.POLL.OUT;
    try pollfds.append(allocator, .{ .fd = c.fd, .events = events, .revents = 0 });
}
```

and in `serviceConn`, guard the read the same way so a `POLL.HUP` cannot bypass it:

```zig
if (!c.read_closed and c.out.items.len < MAX_QUEUED_BYTES and
    revents & (posix.POLL.IN | posix.POLL.HUP) != 0)
```

- [ ] **Step 4: Run the test**

Run: `bun test src/stages/maskfs/mask_filter_integration_test.ts -t "backpressure"`
Expected: PASS — `written` stops well below the ceiling and the second connection still works.

- [ ] **Step 5: Raise `RLIMIT_NOFILE` at serve startup**

At the top of `serve.run`, before `listen`:

```zig
// 接続はシェル 1 本につき 2 本。make -j のようなワークロードでは
// 数百本に達するので、既定の soft limit (よく 1024) では足りない。
var lim = posix.getrlimit(.NOFILE) catch null;
if (lim) |*l| {
    l.cur = l.max;
    posix.setrlimit(.NOFILE, l.*) catch {};
}
```

- [ ] **Step 6: Build and test**

Run: `cd src/mask-filter && zig build && zig build test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
bun run check
git add src/mask-filter/serve.zig src/stages/maskfs/mask_filter_integration_test.ts
git commit -m "$(cat <<'EOF'
feat(mask-filter): bound serve-mode memory with backpressure

serve はホスト側で動くため、消費するメモリはコンテナの cgroup の外に
ある。読み取りを止めたクライアント (自分の stdout への書き込みでブロック
している supervisor) の接続に子が書き続けると、未送信キューが際限なく
伸び、エージェントがホストのメモリを制御できてしまう。

接続ごとの未送信バイト数に上限を設け、超えたらその接続を poll の読み取り
対象から外す。バックプレッシャが socket バッファ経由でクライアントへ、
さらにパイプ経由で書き手へ伝播する。

RLIMIT_NOFILE も起動時に引き上げる。接続はシェル 1 本につき 2 本で、
make -j のようなワークロードでは数百本に達するため。

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
- Consumes: `serve` protocol from Task 1; `SuperviseArgs` gains `socket: []const u8`.
- Produces: `relay.Relay` with `connect(path) !Relay`, `queueWrite(bytes) !void`, `pumpWritable() !void`, `pumpReadable(dst_fd) !ReadResult`, `halfClose() void`, `deinit()`.

**Critical correctness note:** the existing `FdWriter` in `supervise.zig` swallows write errors and treats a short write as complete. That is correct for the child's output fd (never block the child) and **catastrophic for the socket**: silently dropping bytes `[i, i+k)` splits a secret so neither fragment matches, and both fragments are then emitted verbatim. The relay must use a queueing writer whose real errors are fatal.

- [ ] **Step 1: Write the failing test**

```ts
async function runSupervisedOverSocket(
  script: string,
  secrets: string[],
  opts?: { argv0?: string },
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
      { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env } },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { stdout, stderr, exitCode: await proc.exited, sockPath, server };
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

Note `NAS_MASK_SECRETS_FILE` is deliberately absent from the supervisor's env — after this task the container side must not need it.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/stages/maskfs/mask_filter_integration_test.ts -t "through the socket"`
Expected: FAIL — `--socket` is an unknown option (exit 2).

- [ ] **Step 3: Implement `relay.zig`**

```zig
//! relay — supervise モードのクライアント側。子の出力を socket へ送り、
//! マスク済みバイトを受け取って出力先 fd へ書く。
//!
//! 書き込みは必ずキューイングする。短絡書き込みを完了扱いにしたり
//! エラーを握り潰したりすると、シークレットが分断されて「どちらの断片も
//! マッチしない」状態になり、両方が素通しで出てしまう。

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
        // CLOEXEC 必須: この fd が子へ漏れると注入オラクルになる。
        // 攻撃者がストリーム途中に 1 バイト差し込むとマッチが崩れ、原文が返る。
        const fd = try posix.socket(
            posix.AF.UNIX,
            posix.SOCK.STREAM | posix.SOCK.CLOEXEC | posix.SOCK.NONBLOCK,
            0,
        );
        errdefer posix.close(fd);
        posix.connect(fd, @ptrCast(&addr), @sizeOf(posix.sockaddr.un)) catch |err| switch (err) {
            error.WouldBlock => {},
            else => return RelayError.ConnectFailed,
        };
        return .{ .fd = fd, .allocator = allocator, .pending = .empty };
    }

    pub fn deinit(self: *Relay) void {
        self.pending.deinit(self.allocator);
        posix.close(self.fd);
    }

    pub fn queueWrite(self: *Relay, bytes: []const u8) !void {
        try self.pending.appendSlice(self.allocator, bytes);
    }

    pub fn wantsWrite(self: *const Relay) bool {
        return self.pending.items.len > 0 or
            (self.write_closed == false and self.shutdown_pending);
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
    /// 戻り値 true = サーバが close した (このストリームは完了)。
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

/// 出力先 fd への完全書き込み。ここでの取りこぼしは
/// 「マスク済みバイトの欠落」なので、握り潰さず致命的に扱う。
fn writeAllFatal(fd: posix.fd_t, bytes: []const u8) !void {
    var i: usize = 0;
    while (i < bytes.len) {
        const n = posix.write(fd, bytes[i..]) catch |err| switch (err) {
            error.WouldBlock => continue,
            else => return RelayError.WriteFailed,
        };
        if (n == 0) return RelayError.WriteFailed;
        i += n;
    }
}
```

- [ ] **Step 4: Rework `supervise.zig`**

Replace the local `MaskStream` per pump with a `Relay`. Structure:

1. Parse `--socket <path>` (required in supervise mode).
2. **Before fork**, connect both relays with a small bounded retry:

```zig
const CONNECT_ATTEMPTS: usize = 5;
const CONNECT_BACKOFF_NS: u64 = 20 * std.time.ns_per_ms;

fn connectWithRetry(allocator: std.mem.Allocator, path: []const u8) !relay.Relay {
    var attempt: usize = 0;
    while (true) : (attempt += 1) {
        return relay.Relay.connect(allocator, path) catch |err| {
            if (attempt + 1 >= CONNECT_ATTEMPTS) return err;
            std.Thread.sleep(CONNECT_BACKOFF_NS);
            continue;
        };
    }
}
```

If both connects fail, print the constant diagnostic and return `EXIT_OUTPUT_SUPPRESSED` **without forking the child**.

3. In the child branch, close the relay fds in addition to the pipe fds (belt and braces — they are already `CLOEXEC`).
4. The poll set becomes: child stdout pipe, child stderr pipe, sig self-pipe, and for each relay its socket fd with `POLL.IN`, plus `POLL.OUT` when `pending` is non-empty. Child pipe reads `queueWrite` into the matching relay instead of masking locally.
5. When a child pipe hits EOF, call `relay.halfClose()` for that stream.
6. The loop ends when both relays report EOF (server closed) — not when the child pipes close. The existing child-exit idle-timeout drain still governs the **pipe** side.
7. Any `RelayError` is fatal: stop writing output and exit `EXIT_OUTPUT_SUPPRESSED`.

```zig
/// 出力を握り潰したことを呼び出し元に伝える専用コード。
/// 子が 0 で終わっていても、出力を失ったなら 0 を返してはならない。
pub const EXIT_OUTPUT_SUPPRESSED: u8 = 121;

const DIAG_BROKER_UNAVAILABLE = "nas-mask-filter: mask broker unavailable; output suppressed\n";
```

Diagnostics must stay constant strings — that path bypasses masking.

- [ ] **Step 5: Build and run the socket test**

Run: `cd src/mask-filter && zig build && cd ../.. && bun test src/stages/maskfs/mask_filter_integration_test.ts -t "through the socket"`
Expected: PASS

- [ ] **Step 6: Port the existing supervise tests to the socket form**

Every test in the `nas-mask-filter --supervise` describe block must now go
through `runSupervisedOverSocket`: stderr masking, exit code propagation,
128+signo, `--argv0`, output larger than the pipe buffer, no loss across 50
repeated runs, stdin passthrough, SIGTERM forwarding, and the background-process
non-hang case.

Run: `bun test src/stages/maskfs/mask_filter_integration_test.ts`
Expected: all PASS

- [ ] **Step 7: Add the fail-closed and fd-hygiene tests**

```ts
test("fails closed when the broker is gone", async () => {
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
  expect(stdout).not.toContain("hunter2");
});

test("does not leak socket fds into the supervised child", async () => {
  if (!binaryPath) return;
  const r = await runSupervisedOverSocket("ls /proc/self/fd", ["hunter2"]);
  const fds = r.stdout.split("\n").filter(Boolean).sort();
  // ls itself holds one extra descriptor for the directory it is reading.
  expect(fds.filter((f) => Number(f) <= 2)).toEqual(["0", "1", "2"]);
  expect(fds.filter((f) => Number(f) > 3)).toEqual([]);
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

socket fd は CLOEXEC で作り、子側でも明示的に閉じる。子へ漏れると単なる
情報漏洩ではなく注入オラクルになる: ストリーム途中に 1 バイト差し込むと
マッチが崩れて原文が返るため、差し込んだ値を知っていれば原文を復元できる。

broker へ到達できない場合は子を起動せず 121 で終了する。子が 0 で終わって
いても出力を失ったなら 0 を返してはならないため、専用コードを充てる。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Suppress nested supervision

**Files:**
- Modify: `src/mask-filter/supervise.zig`, `src/docker/embed/entrypoint.sh`
- Test: `src/stages/maskfs/mask_filter_integration_test.ts`

**Interfaces:**
- Produces: env var `NAS_MASK_SUPERVISED=1` exported to the child.

**Why:** every `bash` in the container is the wrapper, including `./configure`, each `make` recipe line, recursive make, and npm/cargo build scripts. `make -j16` sustains dozens of live shells and nesting is unbounded — so connections are O(live bash processes), and each nested layer relays every byte across the boundary again.

Suppression costs no coverage: all descendants inherit the outermost supervisor's pipes, so their output is already masked. Output that escapes the outermost supervisor (a redirect to a file, a write to `/dev/tty`) escapes every inner layer identically.

- [ ] **Step 1: Write the failing test**

```ts
test("nests exactly one supervision layer", async () => {
  if (!binaryPath) return;
  const r = await runSupervisedOverSocket(
    `${realBashPath()} -c 'echo inner=hunter2'; echo outer=hunter2`,
    ["hunter2"],
  );
  expect(r.stdout).toBe("inner=*******\nouter=*******\n");
  expect(r.stderr).toBe("");
});
```

This passes trivially today; the guard is Step 5's Docker test. Keep it as a
correctness check that suppression does not lose masking.

- [ ] **Step 2: Export the marker from the supervisor**

In `supervise.zig`, before `execveZ` in the child, set `NAS_MASK_SUPERVISED=1`.
Build the child envp by copying `std.c.environ` and appending the marker rather
than mutating the parent's environment.

- [ ] **Step 3: Add the wrapper guard**

In `entrypoint.sh`'s `MASK_WRAPPER` heredoc, before the supervise exec:

```sh
if [ -n "${NAS_MASK_SUPERVISED:-}" ]; then
  exec -a "$0" /tmp/nas-bash-override/bash.real "$@"
fi
```

- [ ] **Step 4: Run the test**

Run: `bun test src/stages/maskfs/mask_filter_integration_test.ts -t "nests exactly one"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
bun run check
git add src/mask-filter/supervise.zig src/docker/embed/entrypoint.sh src/stages/maskfs/mask_filter_integration_test.ts
git commit -m "$(cat <<'EOF'
feat(mask-filter): suppress nested supervision layers

コンテナ内の bash はすべてラッパーなので、./configure や make の各
レシピ行、再帰 make、npm/cargo のビルドスクリプトも supervise される。
make -j16 では同時生存シェルが数十本になり、接続数は「数シェル」ではなく
生存 bash プロセス数に比例する。入れ子の深さだけ全バイトがコンテナと
ホストの間を往復し、その分だけ出力保持による遅延も積み上がる。

supervisor が NAS_MASK_SUPERVISED=1 を子へ渡し、ラッパーはそれが設定
済みなら素の bash を exec する。

抑止してもカバレッジは減らない。子孫はすべて最外周 supervisor のパイプを
継承するので出力は既にマスクされており、最外周から逃げる出力 (ファイルへの
リダイレクト、/dev/tty への書き込み) は内側の層からも同様に逃げるため、
内側の層が守っていたものは元から無い。

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
- Consumes: `ProcessService.spawn(command, args, { logFile, env, stdinData })`, `FsService`.
- Produces:
  ```ts
  export const MASK_FILTER_CONTAINER_PATH = "/opt/nas/mask-filter/nas-mask-filter";
  export interface MaskFilterPreparePlan {
    readonly secretsFramePath: string;   // host-only, NOT mounted
    readonly filterBinaryHostPath: string;
    readonly socketPath: string;         // host path; mounted at the same path
    readonly logFile: string;
    readonly timeoutMs: number;
    readonly pollIntervalMs: number;
  }
  prepareMaskFilter(plan, secrets): Effect<MaskFilterResult, unknown, Scope.Scope>
  ```

**Mount shape:** mount the socket's **containing directory** at the same absolute path inside the container, matching `src/stages/hostexec/stage.ts:330` (`addMount(mounts, execSocketDir, execSocketDir)`). Mounting the socket file itself makes startup order load-bearing: `compileLaunchOpts` emits `-v src:dst` and Docker *creates a directory* when the source is missing, which would silently yield a directory at the socket path.

- [ ] **Step 1: Rewrite the service test**

Replace `mask_filter_service_test.ts` wholesale. The C1/S1 regression guard is the point of this task.

```ts
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { FsService } from "../../services/fs.ts";
import { ProcessService } from "../../services/process.ts";
import { MaskFilterService, MaskFilterServiceLive } from "./mask_filter_service.ts";

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
            secretsFramePath: "/run/user/1000/nas/mask-filter/sess_x/mask-secrets",
            filterBinaryHostPath: "/usr/local/bin/nas-mask-filter",
            socketPath: "/run/user/1000/nas/mask-filter/sess_x/mask.sock",
            logFile: "/run/user/1000/nas/mask-filter/sess_x/serve.log",
            timeoutMs: 5000, pollIntervalMs: 25,
          }, secrets);
        }),
        MaskFilterServiceLive.pipe(Layer.provide(Layer.merge(fakeFs(written), fakeProc(spawns)))),
      ),
    ),
  );
}

describe("MaskFilterServiceLive.prepareMaskFilter", () => {
  test("writes the frame host-side but never mounts it (C1/S1)", async () => {
    const written: any[] = []; const spawns: any[] = [];
    const result = await run(written, spawns);

    // hostexec (C3) reads this file directly, so it must still be written.
    expect(written.map((w) => w.path)).toContain(
      "/run/user/1000/nas/mask-filter/sess_x/mask-secrets",
    );

    // C1: no mount may expose the frame.
    for (const m of result.mounts) {
      expect(m.source).not.toContain("mask-secrets");
      expect(m.target).not.toContain("mask-secrets");
    }
    // S1: no container env may name it.
    expect(result.envVars.NAS_MASK_SECRETS_FILE).toBeUndefined();
    expect(JSON.stringify(result.envVars)).not.toContain("mask-secrets");
  });

  test("mounts the socket directory and exports the socket path", async () => {
    const written: any[] = []; const spawns: any[] = [];
    const result = await run(written, spawns);
    const dir = "/run/user/1000/nas/mask-filter/sess_x";
    expect(result.mounts.some((m) => m.source === dir && m.target === dir)).toBe(true);
    expect(result.envVars.NAS_MASK_SOCKET).toBe(`${dir}/mask.sock`);
    expect(result.envVars.NAS_MASK_FILTER).toBe("/opt/nas/mask-filter/nas-mask-filter");
  });

  test("spawns the serve daemon", async () => {
    const written: any[] = []; const spawns: any[] = [];
    await run(written, spawns);
    expect(spawns.length).toBe(1);
    expect(spawns[0].command).toBe("/usr/local/bin/nas-mask-filter");
    expect(spawns[0].args).toEqual([
      "--serve", "/run/user/1000/nas/mask-filter/sess_x/mask.sock",
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/stages/maskfs/mask_filter_service_test.ts`
Expected: FAIL — `prepareMaskFilter` has no `socketPath`, spawns nothing, and still emits `NAS_MASK_SECRETS_FILE`.

- [ ] **Step 3: Rewrite the service**

Key changes to `mask_filter_service.ts`:

- Drop `MASK_SECRETS_CONTAINER_PATH`; add nothing to replace it (the socket dir is mounted at its host path).
- `prepareMaskFilter` now requires `Scope.Scope` and `ProcessService`.
- Keep writing the frame (`mode: 0o600`) into a `0o700` directory — hostexec reads it.
- Spawn `--serve`, passing `NAS_MASK_SECRETS_FILE` **in the daemon's own env only** (host-side process; this is not a container env var).
- `Effect.acquireRelease`: on release, `kill()` the daemon, then `rm` the frame and the socket.

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
    ),
);
yield* proc.waitForFileExists(plan.socketPath, plan.timeoutMs, plan.pollIntervalMs);
```

Mounts and env:

```ts
const socketDir = path.dirname(plan.socketPath);
const mounts: MountSpec[] = [
  { source: socketDir, target: socketDir },
  { source: plan.filterBinaryHostPath, target: MASK_FILTER_CONTAINER_PATH, readOnly: true },
];
const envVars: Record<string, string> = {
  NAS_MASK_SOCKET: plan.socketPath,
  NAS_MASK_FILTER: MASK_FILTER_CONTAINER_PATH,
};
```

Update `makeMaskFilterServiceFake` to match the new signature.

- [ ] **Step 4: Run the tests**

Run: `bun test src/stages/maskfs/mask_filter_service_test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
bun run check
git add src/stages/maskfs/mask_filter_service.ts src/stages/maskfs/mask_filter_service_test.ts
git commit -m "$(cat <<'EOF'
fix(mask-filter): stop mounting the secrets frame into the container

シークレットフレームは 0600 だが所有者がエージェント自身の UID なので、
コンテナへマウントしている限り保護になっていない。cat 一発でセッション中の
全シークレットの索引が読める。security-constraints の C1 と S1 に反する。

マウントとコンテナ env を廃止し、代わりにホスト側で --serve デーモンを
起動して socket ディレクトリだけをマウントする。socket ではなく親
ディレクトリをマウントするのは hostexec と同じ形。compileLaunchOpts が
出す -v はソースが存在しないと Docker がディレクトリを作ってしまうため、
socket ファイル自体をマウントすると起動順序が正しさに効いてしまう。

フレームファイル自体はホスト専用ディレクトリに残す。C1 はこの配置を明示的に
許容しており、src/hostexec/broker.ts がホスト実行コマンドのマスク (C3) で
このファイルを直読みしているため、消すと C3 が壊れる。

あわせて S2 の穴を塞ぐ。フレームの削除は現状 hostexec broker だけが行って
おり、mask.filter 有効かつ hostexec 無効の構成ではセッション終了後も
フレームが残っていた。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: MaskFilterStage — wire the daemon

**Files:**
- Modify: `src/stages/maskfs/mask_filter_stage.ts`
- Test: `src/stages/maskfs/mask_filter_stage_test.ts`

**Interfaces:**
- Consumes: `prepareMaskFilter` from Task 5.
- Produces: unchanged stage output shape (`{ container }`).

- [ ] **Step 1: Write the failing test**

Add to `mask_filter_stage_test.ts`:

```ts
test("rejects a socket path longer than sun_path", async () => {
  const longHome = `/${"x".repeat(120)}`;
  // Build a host whose runtime dir forces a >107 byte socket path, then
  // assert the stage fails with a clear message rather than letting bind(2)
  // fail obscurely inside the daemon.
  // ... construct shared input with that host ...
  const result = await Effect.runPromiseExit(/* stage.run(...) */);
  expect(String(result)).toContain("socket path too long");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/stages/maskfs/mask_filter_stage_test.ts -t "sun_path"`
Expected: FAIL — no such check exists.

- [ ] **Step 3: Update the stage**

```ts
const SOCKET_READY_TIMEOUT_MS = 10_000;
const SOCKET_READY_POLL_MS = 25;
/** sun_path は 108 バイト (終端含む)。超えると bind(2) が不可解に失敗する。 */
const MAX_SOCKET_PATH_BYTES = 107;

const sessionDir = `${runtimeDir}/${shared.sessionId}`;
const secretsFramePath = `${sessionDir}/mask-secrets`;
const socketPath = `${sessionDir}/mask.sock`;

if (new TextEncoder().encode(socketPath).byteLength > MAX_SOCKET_PATH_BYTES) {
  return yield* Effect.fail(
    new Error(
      `[nas] mask: socket path too long (${socketPath.length} > ${MAX_SOCKET_PATH_BYTES}): ${socketPath}`,
    ),
  );
}
```

Pass `socketPath`, `logFile: ${sessionDir}/serve.log`, and the readiness knobs
into `prepareMaskFilter`. Update the module header comment: the stage now owns a
daemon and is no longer "デーモンを持たない 1 回限りの準備作業".

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
listen 状態になるまで待ってからコンテナを起動する。起動レースを
クライアント側のリトライで誤魔化すのではなく構造的に潰すため。

socket パスが sun_path の 108 バイト制限を超える場合はステージで
失敗させる。放置するとデーモン内の bind(2) が不可解に失敗するだけで
原因が分からない。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: entrypoint.sh wrapper

**Files:**
- Modify: `src/docker/embed/entrypoint.sh`

**Interfaces:**
- Consumes: `NAS_MASK_SOCKET`, `NAS_MASK_FILTER`, `NAS_MASK_SUPERVISED` (Task 4).

**Why the fallback goes away:** translating "the secret file is readable" into "the socket exists" would preserve a **fail-open** path — a dead serve process would silently yield unmasked shells, which is the disclosure this work exists to prevent.

- [ ] **Step 1: Update the wrapper heredoc**

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

Also update the installation guard above the heredoc: it currently keys off
`NAS_MASK_SECRETS_FILE`, which is no longer a container variable.

```sh
if [ -n "${NAS_MASK_FILTER:-}" ] && [ -n "${NAS_MASK_SOCKET:-}" ]; then
```

Leave the `/entrypoint.sh` branch alone. It exists so entrypoint re-entry keeps a
TTY, and entrypoint's shell mode execs `$NAS_REAL_BASH` unmasked by design.
Narrowing it is a separate hardening item (see the spec) and is **out of scope**.

- [ ] **Step 2: Verify the generated wrapper locally**

Extract the heredoc and run it against a real serve process without Docker:

```bash
cd /home/hogeyama/repo/nix-agent-sandbox
# start a serve daemon on a temp socket, export NAS_MASK_FILTER / NAS_MASK_SOCKET,
# then run the extracted wrapper with -c / -lc / a script file and confirm
# masking plus $0 for each form.
```

Expected: all three invocation forms mask, and `$0` is the wrapper path for
`-c`/`-lc` and the script path for a script file.

- [ ] **Step 3: Commit**

```bash
bun run check
git add src/docker/embed/entrypoint.sh
git commit -m "$(cat <<'EOF'
fix(mask-filter): remove the wrapper's fail-open fallback

ラッパーは secrets ファイルが読めなければ素の bash に fallback して
いた。これを socket の存在チェックに翻訳すると、serve が死んだときに
無言でマスク無しのシェルが起動する fail-open 経路がそのまま残る。

判定自体を廃止し、常に supervisor を exec する。到達できなければ
supervisor 側が fail-closed で落ちる。マスクが設定されている構成でのみ
ラッパーが設置されるため、判定は元から冗長だった。

なお先頭の /entrypoint.sh バイパスは別物なので残す。entrypoint 再入時に
TTY を保つためのもので、shell モードは設計上 bash.real を直接 exec する。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Docker integration tests

**Files:**
- Modify: `src/stages/launch/integration_test.ts`

**Interfaces:**
- Consumes: the Task 1 protocol and the Task 7 wrapper.

The Python fixture must grow a `--serve` socket server and a `--supervise` relay
client. It is kept rather than replaced by the real Zig binary because it lets
these tests run without a Zig build prerequisite — the property it exists for.

- [ ] **Step 1: Extend `MASK_FILTER_FIXTURE`**

Add to the existing fixture: when `argv[1] == "--serve"`, bind the given path,
`listen`, and serve each connection on its own thread (a thread per connection is
acceptable in a test fixture; the single-poll-loop requirement is on the real
implementation). Each connection masks line-wise and, on client half-close,
flushes and closes. When `argv[1] == "--supervise"`, parse `--argv0` and
`--socket`, spawn the child with pipes, and relay each stream over its own
connection.

- [ ] **Step 2: Start the fixture daemon in the tests**

The tests currently only bind-mount the fixture. They must now also start it in
`--serve` mode on the host before `dockerRun`, bind-mount the socket directory,
and pass `NAS_MASK_SOCKET`. Stop it in `finally`.

- [ ] **Step 3: Invert the fallback test**

`"absolute /bin/bash preserves output when the secrets frame is missing"` becomes
`"absolute /bin/bash fails closed when the mask socket is missing"`:

```ts
expect(result.code).toEqual(121);
expect(result.stdout).not.toContain("fallback-stdout");
```

- [ ] **Step 4: Add a nesting test**

```ts
// Nested bash must produce exactly one supervision layer (Task 4).
const nested = await dockerRun(
  ["/bin/bash", "-c", `/bin/bash -c 'echo inner=${secret}'`],
  { /* ... same env/mounts ... */ },
);
expect(nested.stdout).toContain(`inner=${masked}`);
expect(nested.stdout).not.toContain(secret);
```

- [ ] **Step 5: Run the Docker suite**

Run: `bun test src/stages/launch/integration_test.ts`
Expected: PASS, or all-skip if Docker is unavailable. **If it skips, say so
explicitly in the task report — do not report untested code as verified.**

- [ ] **Step 6: Run everything**

Run: `bun test src/` then `cd src/mask-filter && zig build test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
bun run check
git add src/stages/launch/integration_test.ts
git commit -m "$(cat <<'EOF'
test(mask-filter): cover the socket-based wrapper end to end

Python フィクスチャに --serve と --supervise を実装し、Docker テストを
socket 経由の構成に合わせる。フィクスチャを実 Zig バイナリに置き換えな
かったのは、これらのテストを Zig ビルド無しで走らせるためという存在理由
そのものを保つため。

secrets frame 欠如時のフォールバックを検証していたテストは、socket 欠如時に
fail-closed することの検証に反転させる。

入れ子 bash が supervise 層を 1 つだけ作ることも検証する。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| Container-visible surface (mount/env change) | 5 |
| Mount the directory, not the socket file | 5 |
| `sun_path` assertion | 6 |
| Frame lifetime (S2) | 5 |
| Nested supervision | 4 |
| Protocol (half-close, non-synchronous reply) | 1, 3 |
| Resource bounds (queue cap, conn cap, EMFILE, RLIMIT) | 1, 2 |
| Failure handling (connect retry, mid-stream fatal, partial write) | 3 |
| fd hygiene (`SOCK_CLOEXEC`, child close) | 3 |
| Serve-mode output invariant | Global Constraints + 1 |
| Drain semantics preserved | 3 (Step 6 ports existing tests) |
| Wrapper bypass branch left alone | 7 |
| hostexec C3 preserved | 1 (Step 4), 5 |
| Testing plan | 1, 2, 3, 5, 6, 8 |

Gap accepted: the spec's "hostexec regression — an existing hostexec masking test
must still pass" is covered by running `bun test src/` in Task 8 Step 6 rather
than by a new test, since the existing suite already covers it.

**Type consistency:** `MaskFilterPreparePlan` gains `socketPath`, `logFile`,
`timeoutMs`, `pollIntervalMs` in Task 5 and is consumed with exactly those names
in Task 6. `relay.Relay` methods used in Task 3 Step 4 match Step 3's
definitions. `EXIT_OUTPUT_SUPPRESSED = 121` is used in Task 3 and asserted in
Tasks 3 and 8.

**Known rough edge:** `Relay.wantsWrite` in Task 3 Step 3 references a
`shutdown_pending` field that the struct does not declare. The implementer
should drop that clause — `pending.items.len > 0` is the whole condition, and
`halfClose` acts immediately rather than being deferred.
