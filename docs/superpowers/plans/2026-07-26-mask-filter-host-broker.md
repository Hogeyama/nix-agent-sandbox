# Mask Filter Host Broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop exposing the secret frame to the container; mask stdout/stderr on the host over a Unix socket.

**Architecture:** `nas-mask-filter` gains a host-side `--serve <sock>` mode that masks byte streams, multiplexing every connection in one poll loop. The container-side `--supervise` mode becomes a relay. The frame stays a host-only file (hostexec reads it for C3) in a directory that is **never mounted**; the socket lives in a **sibling** directory that is.

**Tech Stack:** Zig 0.15.2 (`src/mask-filter`), Bun + Effect (host TS), POSIX Unix domain sockets, Docker.

## How to read this plan

Two adversarial review rounds found 12 critical defects in this document, almost all in *implementation code written here but never executed*. So this plan deliberately does **not** pretend to be pre-verified source.

For each task it gives: the **behaviour contract**, the **exact tests** (these are executable and have been corrected against measured runtime behaviour), **implementation notes** covering the non-obvious parts, and the **commands that prove it works**. Write the implementation against the compiler and the tests — do not transcribe pseudo-code from here and assume it builds.

Where this plan states a measured fact, it was measured. Trust those. Where it describes an approach, verify it.

## Global Constraints

Read before any task: skill **`security-constraints`** (C1, S1, S2, C2, C3, N1), skill **`test-policy`** (unit `*_test.ts`, Docker `*_integration_test.ts`, co-located; its `deno task` commands are stale — use `bun test`), and the spec `docs/superpowers/specs/2026-07-26-mask-filter-host-broker-design.md` whose "Accepted limitations" are binding — do **not** try to fix the `/proc/<pid>/fd/1` bypass, the stdout/stderr split, the idle-drain seam, `mem.eql` timing, the orphaned daemon, or socket substitution.

Hard rules:

1. **The mounted directory contains only the socket.** The frame directory is never mounted. An earlier draft put both in one directory and mounted it — reintroducing the exact disclosure this work removes.
2. **No unmasked byte may reach the container.** Never "pass through on error".
3. **If _either_ relay connect fails, do not fork the child.**
4. **Diagnostics on the real stderr are constant strings.** That path bypasses masking.
5. **Serve mode never writes stream-derived bytes to its own stdout/stderr.**
6. Exit `121` = "output suppressed". Reserved. Every error path in supervise mode must reach `121`, never a Zig error-return trace.
7. **Every commit must build and pass `zig build test` + the non-Docker part of `bun test src/`.** See "Execution order" below for the one deliberate exception.
8. Preserve: child-exit drain with idle timeout, signal forwarding, exit-status propagation (128+signo), `--argv0`.

## Execution order

**Execute in this order: 1, 2, 3, 5, 6, 7, 4, 8.** Task numbers below are kept as
written; only the order changes.

**Task 7 runs before Task 4.** Task 4's nesting test extracts the `MASK_WRAPPER`
heredoc and runs it with `NAS_MASK_SOCKET` set and no `NAS_MASK_SECRETS_FILE`.
The pre-Task-7 wrapper gates on `[ -f "$NAS_MASK_SECRETS_FILE" ]` and execs
`--supervise` without `--socket`, so it falls through to plain bash and the
`NAS_MASK_SUPERVISED` marker reads `unset` no matter how correct Task 4's Zig
change is. Task 7 depends only on Task 3, so it moves earlier cleanly.

**Docker tests are red from Task 7 until Task 8.** Task 7 flips the install guard
to require `NAS_MASK_SOCKET`, and the Docker mask tests in
`src/stages/launch/integration_test.ts` still set only `NAS_MASK_SECRETS_FILE`
until Task 8 updates them. This is accepted deliberately: Tasks 7 and 4 must keep
`zig build test` and the non-Docker part of `bun test src/` green, and must state
in their reports which Docker tests fail and why. Task 8 restores a fully green
`bun test src/`.

## Measured environment facts

These were verified by execution. They are the landmines that broke two earlier drafts.

- **`node:net`'s `sock.end()` is a full close under Bun 1.3.9, not a half-close.** Measured: server's post-EOF `send()` fails `EPIPE`, client receives nothing. `Bun.connect` + `socket.shutdown()` correctly half-closes and receives the flushed tail. **All socket test clients must use `Bun.connect`.** The protocol's entire flush path hangs off half-close, so a `node:net` client reports a correct server as broken.
- **`sock.pause()` under Bun does not stop draining the kernel receive buffer**, so it cannot be used to build a stalled reader. Use a raw non-blocking client that genuinely stops reading (a small Python helper is fine).
- **Zig 0.15.2 APIs that do work as expected** (compiled and run): `posix.getrlimit(.NOFILE)` as an error union with `if (...) |lim| ... else |_| {}`; `posix.fcntl(fd, F.GETFL, 0)` plus `flags | @as(u32, @bitCast(posix.O{.NONBLOCK = true}))`; `posix.shutdown(fd, .send)`; `posix.fchmodat(AT.FDCWD, path, 0o600, 0)` on a socket inode; `std.ArrayList` `.empty` with allocator-per-method; `swapRemove` during descending iteration; `posix.poll` retrying `EINTR` internally.
- **`parseSuperviseArgs` returns `!?SuperviseArgs`** and six tests at `mask_filter.zig:151-187` depend on that. It also must keep accepting invocations **without** `--socket`, or those tests break.
- **Writing to a socket after `shutdown(SHUT_WR)` gives `EPIPE`.** Half-closing while bytes are still queued destroys them.
- **`src/cli.ts:333` already provides `FsService | ProcessService`**, and `stage_builder.ts:47` already supplies `Scope.Scope`, so a session-scoped `acquireRelease` daemon in MaskFilterStage is viable with no pipeline changes.
- **`AF_UNIX` paths are capped at 107 bytes.** The scratch directory used during development already exceeds it — build test socket paths under `/tmp`, not under the session scratch dir.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/mask-filter/serve.zig` | **new** — UDS listener, connection table, poll loop, per-connection `MaskStream`, resource bounds |
| `src/mask-filter/relay.zig` | **new** — client: connect, queued writer, bidirectional pump |
| `src/mask-filter/supervise.zig` | modify — relay instead of local masking; fd hygiene; fail-closed |
| `src/mask-filter/mask_filter.zig` | modify — mode dispatch; keep filter mode + `readSecretsFromFile` (hostexec C3) |
| `src/stages/maskfs/mask_filter_service.ts` | modify — daemon lifecycle, socket-dir mount, env, frame+log removal |
| `src/stages/maskfs/mask_filter_stage.ts` | modify — daemon wiring, readiness, `sun_path` assertion |
| `src/docker/embed/entrypoint.sh` | modify — wrapper passes `--socket`, loses its fallback |
| `src/stages/launch/integration_test.ts` | modify — fixture gains serve/supervise; fallback test inverted |

---

### Task 1: Serve mode

**Files:** create `src/mask-filter/serve.zig`; modify `src/mask-filter/mask_filter.zig`; test in both plus `src/stages/maskfs/mask_filter_integration_test.ts`.

**Ordering constraint (do not violate):** this task must leave `supervise` exactly as it is — same signature, still masking locally, still loading the frame. Only *add* the `--serve` arm. Task 3 changes supervise. A draft that rewrote `main`'s supervise call here left the tree unbuildable.

**Contract:**
- `nas-mask-filter --serve <path>` reads the frame from `NAS_MASK_SECRETS_FILE`, binds `<path>` (0600), listens, and serves until killed.
- Connection = one stream. Client writes raw bytes, reads masked bytes. **Not byte-synchronous** — the server withholds `maxSecretLen - 1` bytes pending more input.
- Client half-closes (`shutdown(SHUT_WR)`); server flushes retained overlap, then closes.
- All connections are multiplexed in **one** poll loop. Handling a connection to completion before accepting the next is forbidden: an agent runs many shells at once, each holding two connections for its whole lifetime, so sequential handling lets one long shell block every other shell.

**Resource bounds** (the server runs on the host, outside the container's cgroup, so every one of these is agent-reachable):
- `MAX_QUEUED_BYTES` per connection; when exceeded, stop polling that connection for **read**. Backpressure then propagates via the socket buffer to the client and via the pipe to the writer.
- `MAX_CONNECTIONS`; **above the cap, accept and immediately close.** Do *not* merely stop polling the listener: the kernel still completes connections into the backlog, so a client that connects is neither served nor refused — measured, a flood of 300 idle connections wedged the next client until timeout. Accept-and-close gives it a clean EOF, which the supervisor turns into a fail-closed `121`.
- Idle reaping must only close connections that have **never delivered a byte**. Reaping merely-quiet connections kills legitimate shells: a supervised `sleep 180` has zero traffic, and closing it makes a working command fail with `121`.
- On `EMFILE`/`ENFILE`, back the listener off for a fixed delay. Re-polling a readable listener that returns `EMFILE` is a permanent 100% CPU spin.
- Allocate each connection's `MaskStream` **on first byte, not on accept** — it reserves ~192 KiB, so accept-time allocation makes one `connect()` worth 192 KiB of host memory.
- Use a finite `poll` timeout so reaping and backoff can run.

**Implementation notes:**
- Take the connection count **before** accepting; accept appends, and indexing the poll array by a post-accept length is an out-of-bounds panic on the very first connection.
- Iterate connections descending and use `swapRemove`; that combination is safe (the swapped-in element comes from an index already visited).
- Raise `RLIMIT_NOFILE` at startup — connections are 2 per shell and `make -j` reaches hundreds.

- [ ] **Step 1: Add the socket test client helpers**

In `src/stages/maskfs/mask_filter_integration_test.ts`. **Use `Bun.connect`** — see Measured environment facts.

```ts
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

/** AF_UNIX paths cap at 107 bytes; the test tmpdir is too long. */
function shortSockPath(tag: string): string {
  return `/tmp/nas-mf-${tag}-${process.pid}-${secretsFileSeq++}.sock`;
}

/**
 * Write `writes` (with optional gaps), half-close, collect until the server
 * closes. node:net's .end() is a FULL close under Bun and loses the flushed
 * tail — Bun.connect + shutdown() is the only correct client here.
 */
function maskOverSocket(
  sockPath: string,
  writes: string[],
  gapMs = 0,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    Bun.connect({
      unix: sockPath,
      socket: {
        async open(s) {
          for (const w of writes) {
            s.write(Buffer.from(w));
            if (gapMs) await Bun.sleep(gapMs);
          }
          s.shutdown();
        },
        data(_s, d) { chunks.push(Buffer.from(d)); },
        close() { resolve(Buffer.concat(chunks).toString()); },
        error(_s, e) { reject(e); },
      },
    }).catch(reject);
  });
}
```

- [ ] **Step 2: Write the failing tests**

```ts
describe("nas-mask-filter --serve", () => {
  test("masks a stream over the socket", async () => {
    if (!binaryPath) return;
    const sockPath = shortSockPath("basic");
    const proc = startServe(writeSecretsFile(["hunter2"]), sockPath);
    try {
      expect(await waitForSocket(sockPath)).toBe(true);
      expect(await maskOverSocket(sockPath, ["pw=hunter2 done"])).toBe("pw=******* done");
    } finally { proc.kill(); await proc.exited; fs.rmSync(sockPath, { force: true }); }
  }, 15000);

  test("masks a secret straddling a socket chunk boundary", async () => {
    if (!binaryPath) return;
    const sockPath = shortSockPath("seam");
    const proc = startServe(writeSecretsFile(["SECRETVALUE"]), sockPath);
    try {
      expect(await waitForSocket(sockPath)).toBe(true);
      // The gap forces the server to process the two halves separately.
      expect(await maskOverSocket(sockPath, ["head SECRE", "TVALUE tail"], 50))
        .toBe("head *********** tail");
    } finally { proc.kill(); await proc.exited; fs.rmSync(sockPath, { force: true }); }
  }, 15000);

  test("keeps per-connection overlap state isolated", async () => {
    if (!binaryPath) return;
    const sockPath = shortSockPath("iso");
    const proc = startServe(writeSecretsFile(["hunter2"]), sockPath);
    try {
      expect(await waitForSocket(sockPath)).toBe(true);
      const [a, b] = await Promise.all([
        maskOverSocket(sockPath, ["aaa hun", "ter2 aaa"], 30),
        maskOverSocket(sockPath, ["bbb hun", "ter2 bbb"], 30),
      ]);
      expect(a).toBe("aaa ******* aaa");
      expect(b).toBe("bbb ******* bbb");
    } finally { proc.kill(); await proc.exited; fs.rmSync(sockPath, { force: true }); }
  }, 15000);
});
```

Run: `bun test src/stages/maskfs/mask_filter_integration_test.ts -t "serve"`
Expected: FAIL — the binary rejects `--serve` (exit 2), so `waitForSocket` is false.

- [ ] **Step 3: Implement `serve.zig` and the `--serve` dispatch**

Mode parsing must keep `parseSuperviseArgs`'s `!?SuperviseArgs` signature and keep supervise working unchanged. Load the frame in the `--serve` arm as well as the existing filter path; **do not** yet remove the unconditional load that supervise still needs.

Add inline Zig tests for the socket-path length guard and for mode parsing (`--serve` with and without its argument; `--serve` plus extra arguments; a bare invocation still meaning filter mode).

- [ ] **Step 4: Register the new file in the Zig test aggregator**

`mask_filter.zig`'s `test { _ = @import(...); }` block currently lists `mask_stream.zig` and `supervise.zig`. Add `serve.zig`, or its inline tests never run and `zig build test` passes while covering nothing.

- [ ] **Step 5: Build and test**

Run: `cd src/mask-filter && zig build && zig build test`
Expected: build succeeds; all tests pass, including the new inline ones.

Run: `bun test src/stages/maskfs/mask_filter_integration_test.ts -t "serve"`
Expected: all three PASS.

Run: `cd /home/hogeyama/repo/nix-agent-sandbox && bun test src/`
Expected: PASS — supervise is untouched, so nothing else may regress.

- [ ] **Step 6: Commit**

```bash
bun run check
git add src/mask-filter/serve.zig src/mask-filter/mask_filter.zig src/stages/maskfs/mask_filter_integration_test.ts
git commit -m "$(cat <<'EOF'
feat(mask-filter): add host-side serve mode

Unix socket で待ち受け、接続ごとに MaskStream を持ってストリームをマスクして
返すモードを追加する。接続 = 1 ストリームで、クライアントが shutdown(SHUT_WR)
したら保持中の overlap をフラッシュして close する。

全接続を単一の poll ループで多重化する。エージェントはシェルを同時に複数
起動し (1 シェルにつき 2 接続)、シェルは分単位で生存しうるため、1 接続を
完了まで処理してから次を accept する実装だと長時間走るシェル 1 本が他の
全シェルをブロックする。

ホスト側で動く以上、消費する資源はコンテナの cgroup の外にある。接続ごとの
未送信バイト数上限、接続数上限、EMFILE 時の listener バックオフを入れる。
接続数上限を超えた分は accept して即 close する。listener の poll を止める
だけだと kernel が backlog へ接続を完了させてしまい、クライアントは応答も
拒否も得られないまま待たされる。MaskStream は最初のバイトを受け取るまで
確保しない (1 本あたり約 192KiB のため)。

素の stdin->stdout フィルタモードと readSecretsFromFile は残す。
src/hostexec/broker.ts がホスト実行コマンドのマスク (C3) に使っている。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Prove the resource bounds

**Files:** test only — `src/stages/maskfs/mask_filter_integration_test.ts` (plus a small Python helper written into the test tmpdir).

**Why this is its own task:** the obvious backpressure test does not work. Measured: `net.Socket.write()` returns `false` at Node's own 16 KiB `highWaterMark` regardless of the server, so counting its return value reports 0 bytes with **and** without the cap; and `sock.pause()` under Bun does not stop draining the receive buffer, so a Bun client cannot stall the server at all. Both give a test that passes before the fix.

**Contract:** with a genuinely stalled reader, server RSS must plateau near the cap. Measured reference on this codebase: **7.8 MB with a 4 MB cap, 45.9 MB uncapped**, after pushing 64 MB. Pick a threshold around **16 MB** — the 48 MB an earlier draft used left a 4% margin against the uncapped case and would flake by machine speed.

- [ ] **Step 1: Write a stalling client helper**

A short Python script (written to the test tmpdir and invoked with `Bun.spawn`) that connects, sets the socket non-blocking, writes as fast as the kernel accepts, and **never reads**. Have it print the number of bytes accepted before it stops making progress.

- [ ] **Step 2: Write the tests**

```ts
function serverRssKb(pid: number): number {
  const m = fs.readFileSync(`/proc/${pid}/status`, "utf8").match(/^VmRSS:\s+(\d+) kB$/m);
  return m ? Number(m[1]) : 0;
}

test("bounds server memory when a client stops reading", async () => {
  if (!binaryPath) return;
  if (!fs.existsSync("/proc/self/status")) return; // Linux only
  const sockPath = shortSockPath("bp");
  const proc = startServe(writeSecretsFile(["hunter2"]), sockPath);
  try {
    expect(await waitForSocket(sockPath)).toBe(true);
    const stall = Bun.spawn(["python3", stallerPath, sockPath, "64"], { stdout: "pipe" });
    await new Response(stall.stdout).text();
    await Bun.sleep(300);
    expect(serverRssKb(proc.pid)).toBeLessThan(16 * 1024);
    stall.kill();
    // Other connections must still be served.
    expect(await maskOverSocket(sockPath, ["pw=hunter2"])).toBe("pw=*******");
  } finally { proc.kill(); await proc.exited; fs.rmSync(sockPath, { force: true }); }
}, 60000);

test("serves a new client while many idle connections are held", async () => {
  if (!binaryPath) return;
  const sockPath = shortSockPath("flood");
  const proc = startServe(writeSecretsFile(["hunter2"]), sockPath);
  const held: any[] = [];
  try {
    expect(await waitForSocket(sockPath)).toBe(true);
    for (let i = 0; i < 300; i++) {
      held.push(await Bun.connect({
        unix: sockPath,
        socket: { data() {}, close() {}, error() {} },
      }).catch(() => null));
    }
    await Bun.sleep(300);
    // Above the cap the server accepts and closes, so this either completes or
    // returns empty — it must never hang.
    const served = await Promise.race([
      maskOverSocket(sockPath, ["pw=hunter2"]).catch(() => "CLOSED"),
      Bun.sleep(5000).then(() => "TIMEOUT"),
    ]);
    expect(served).not.toBe("TIMEOUT");
  } finally {
    for (const s of held) s?.end?.();
    proc.kill(); await proc.exited; fs.rmSync(sockPath, { force: true });
  }
}, 60000);
```

- [ ] **Step 3: Verify the tests are not inert**

Temporarily raise `MAX_QUEUED_BYTES` to `std.math.maxInt(usize)`, rebuild, and confirm the RSS test **fails**. Restore and confirm it passes. A test that passes both ways is worthless — this is the specific failure mode that got past two reviews.

Run: `bun test src/stages/maskfs/mask_filter_integration_test.ts -t "bounds server memory"`
Run: `bun test src/stages/maskfs/mask_filter_integration_test.ts -t "idle connections"`

- [ ] **Step 4: Commit**

```bash
bun run check
git add src/stages/maskfs/mask_filter_integration_test.ts
git commit -m "$(cat <<'EOF'
test(mask-filter): prove serve-mode resource bounds hold

読み取りを止めたクライアントに対してサーバのメモリが頭打ちになること、
接続を並べられても新しいクライアントが待たされないことを検証する。

クライアント側の write() の戻り値では検証できない。Node の write() は
サーバの状態と無関係に自前の highWaterMark (16KiB) を超えた時点で false を
返し、Bun の pause() は受信バッファの排出を止めないため、どちらも上限あり・
なしで同じ結果になる。実際に読まないクライアントを別に用意し、サーバの
VmRSS を直接見る。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Supervise mode — relay over the socket

**Files:** create `src/mask-filter/relay.zig`; modify `src/mask-filter/supervise.zig`, `src/mask-filter/mask_filter.zig`; test in `src/stages/maskfs/mask_filter_integration_test.ts`.

**Contract:** `--supervise [--argv0 NAME] --socket <path> -- PROGRAM [ARGS...]`. Connects two relays (stdout, stderr) **before fork**; if **either** fails after a small bounded retry, print the constant diagnostic and exit `121` **without forking**. Relays bytes both ways. Preserves signal forwarding, `--argv0`, and exit-status propagation.

After this task the container side must not need `NAS_MASK_SECRETS_FILE` at all, so `main` must load the frame only in the `filter` and `serve` arms. Keep supervise's existing top-level error handling shape: any escaping error must become the constant diagnostic and `121`, never a Zig error-return trace.

**Critical correctness constraints:**

1. **Do not reuse `FdWriter`** (`supervise.zig:87`) for the socket. It swallows write errors and treats a short write as complete — correct for the child's output fd, catastrophic for the socket: dropping bytes splits a secret so neither fragment matches and **both are emitted verbatim**. The relay queues short writes and treats real errors as fatal.
2. **Never `halfClose()` while bytes are still queued.** Writing after `shutdown(SHUT_WR)` gives `EPIPE` → fatal → `121` with all output discarded, on a child that exited 0. Half-close only when that stream's pipe is done **and** its pending queue is empty.
3. **Keep `POLLOUT` armed in the socket-drain phase.** Otherwise a queue that has not fully flushed never will.
4. **Drop relays from the poll set once they report EOF.** A server-closed socket is permanently `POLLIN|POLLHUP`; leaving it armed with an infinite timeout busy-loops on the host CPU for as long as the other stream runs.
5. **Gate the child's pipe `POLLIN` on `pending < RELAY_MAX_PENDING`.** Without it the supervisor reads the pipe forever and the claimed backpressure chain does not exist.
6. **The pipe-idle condition is "armed for `POLLIN` and did not fire", never "poll returned 0".** A pipe that was descheduled by constraint 5 is not in the poll set, so a bare timeout is vacuously "no pipe data" and would half-close while megabytes are still buffered in the pipe — silent data loss with exit 0.
7. **A relay reaching EOF before its stream is finished is truncation, not completion.** Treat an unexpected server close as fatal (`121`), not as "stream complete".

**Termination — three phases.** Track per stream: `pipe_done`, `relay_done`.

- *Phase 1, child alive.* Poll pipes (gated by 5), sig self-pipe, and each live relay (`POLLIN`, plus `POLLOUT` when queued). Timeout `-1`. Pipe EOF → `pipe_done`. Half-close per constraint 2.
- *Phase 2, child exited.* Same, timeout `DRAIN_IDLE_MS`. On idle per constraint 6, mark remaining pipes done. This is what makes `echo before; (sleep 30) & echo after` terminate: the backgrounded process holds the pipe open, so pipe EOF never arrives.
- *Phase 3, both streams half-closed.* Stop polling pipes. Poll relays with a **separate** `SOCKET_DRAIN_MS` deadline — sharing `DRAIN_IDLE_MS` would let a briefly-busy server look like "no more output" and truncate the tail. End on both relays EOF, or exit `121` on deadline.

- [ ] **Step 1: Write the failing test**

```ts
async function runSupervisedOverSocket(
  script: string,
  secrets: string[],
  opts?: { argv0?: string; stdin?: Uint8Array; sockPath?: string },
) {
  const sockPath = opts?.sockPath ?? shortSockPath("sup");
  const server = opts?.sockPath ? null : startServe(writeSecretsFile(secrets), sockPath);
  try {
    if (server && !(await waitForSocket(sockPath))) throw new Error("serve not ready");
    const argv0Args = opts?.argv0 ? ["--argv0", opts.argv0] : [];
    const proc = Bun.spawn(
      [binaryPath!, "--supervise", ...argv0Args, "--socket", sockPath,
       "--", realBashPath(), "-c", script],
      { stdin: opts?.stdin ?? "ignore", stdout: "pipe", stderr: "pipe",
        env: { ...process.env } },  // deliberately NO NAS_MASK_SECRETS_FILE
    );
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { stdout, stderr, exitCode: await proc.exited };
  } finally {
    if (server) { server.kill(); await server.exited; fs.rmSync(sockPath, { force: true }); }
  }
}

test("masks supervised output through the socket", async () => {
  if (!binaryPath) return;
  const r = await runSupervisedOverSocket("echo pw=hunter2", ["hunter2"]);
  expect(r.stdout).toBe("pw=*******\n");
  expect(r.exitCode).toBe(0);
});
```

Run: `bun test src/stages/maskfs/mask_filter_integration_test.ts -t "through the socket"`
Expected: FAIL — `--socket` is an unknown option (exit 2).

- [ ] **Step 2: Implement `relay.zig` and rework `supervise.zig`**

Relay members needed by the supervisor and by nothing else: `connect`, `deinit`, `queueWrite`, `pendingLen`, `pumpWritable`, `pumpReadable`, `halfClose`, and the raw `fd`.

`connect` must use a **blocking** `connect(2)` then switch the fd to non-blocking: `AF_UNIX` non-blocking `connect` returns `EAGAIN` for "backlog full, not connected", with no `POLLOUT` completion to wait for, so treating `EAGAIN` as success yields a relay that silently never delivers. Create the socket `SOCK_CLOEXEC` and close both relay fds explicitly in the forked child — a leaked relay fd is an **injection oracle**: inject a byte mid-stream, the match breaks, the original comes back, and the attacker who knows the injected byte recovers the secret.

`writeAllFatal` to the destination fd must poll and retry on `WouldBlock` rather than treating it as fatal; making every write error fatal turns a transient `EAGAIN` into suppressed output.

- [ ] **Step 3: Build and run**

Run: `cd src/mask-filter && zig build && zig build test`
Run: `cd ../.. && bun test src/stages/maskfs/mask_filter_integration_test.ts -t "through the socket"`
Expected: PASS

- [ ] **Step 4: Port every existing supervise test to the socket form**

Rewrite the `nas-mask-filter --supervise` describe block onto `runSupervisedOverSocket`: stderr masking, exit-code propagation, 128+signo, `--argv0`, stdin passthrough, SIGTERM forwarding, and the background-process non-hang case (the phase-2 test — it must still finish under 5 s).

Start **one** serve daemon and pass `sockPath` for the 50-iteration "never loses output" test; per-call daemons would mean 50 spawn/kill cycles in one test.

Run: `bun test src/stages/maskfs/mask_filter_integration_test.ts`
Expected: all PASS.

- [ ] **Step 5: Add the tests that cover the new failure modes**

```ts
test("fails closed when the broker is absent", async () => {
  if (!binaryPath) return;
  const proc = Bun.spawn(
    [binaryPath, "--supervise", "--socket", "/tmp/nas-mf-absent.sock", "--",
     realBashPath(), "-c", "echo pw=hunter2"],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env } },
  );
  const stdout = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(121);
  expect(stdout).toBe("");
});

test("fails closed when the broker dies mid-run", async () => {
  if (!binaryPath) return;
  const sockPath = shortSockPath("mid");
  const server = startServe(writeSecretsFile(["hunter2"]), sockPath);
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
  } finally { server.kill(); await server.exited; fs.rmSync(sockPath, { force: true }); }
}, 15000);

// Constraint 2: a large tail must not be lost to a premature half-close.
test("preserves multi-megabyte output through the socket", async () => {
  if (!binaryPath) return;
  const r = await runSupervisedOverSocket(
    "for i in $(seq 200000); do echo line$i; done", ["hunter2"],
  );
  const lines = r.stdout.split("\n").filter(Boolean);
  expect(lines.length).toBe(200000);
  expect(lines[199999]).toBe("line200000");
  expect(r.exitCode).toBe(0);
}, 60000);

test("does not leak socket fds into the supervised child", async () => {
  if (!binaryPath) return;
  const r = await runSupervisedOverSocket("ls -l /proc/self/fd", ["hunter2"]);
  expect(r.stdout).not.toContain("socket:");
});
```

Run: `bun test src/stages/maskfs/mask_filter_integration_test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
bun run check
git add src/mask-filter/relay.zig src/mask-filter/supervise.zig src/mask-filter/mask_filter.zig src/stages/maskfs/mask_filter_integration_test.ts
git commit -m "$(cat <<'EOF'
feat(mask-filter): relay supervised output to the host broker

supervise はローカルでマスクするのをやめ、子の stdout/stderr を Unix socket
へ中継してマスク済みバイトを書き戻すリレーになる。これでコンテナ内に
シークレットのバイトが不要になる。

socket への書き込みは必ずキューイングする。既存の FdWriter は書き込み
エラーを握り潰し短絡書き込みを完了扱いにするが、これは子の出力 fd 用の
挙動で socket に流用してはいけない。バイトを黙って落とすとシークレットが
分断され、どちらの断片もマッチせず両方が素通しで出てしまう。

キューが残っている状態で half-close してはいけない。shutdown(SHUT_WR) 後の
書き込みは EPIPE になり、子が 0 で終わっていても全出力を捨てて 121 になる。

終了判定を 3 段階に分ける。子のパイプが EOF になっただけでは終われない
(サーバが保持中の末尾をまだ返していない) が、EOF を無条件に待つこともでき
ない (バックグラウンドプロセスがパイプを掴んだままだと EOF が来ない)。
パイプ側はアイドルで打ち切り、half-close 後に socket 側を別の期限で待つ。
期限を共有すると、少し混んだサーバの応答待ちが「もう出力は無い」と誤判定
されて末尾が切れる。アイドル判定は「POLLIN を張ったのに発火しなかった」で
あって「poll が 0 を返した」ではない。バックプレッシャで poll 対象から
外れているパイプを後者で判定すると、未読のまま数 MB を捨てる。

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

**Files:** modify `src/mask-filter/supervise.zig`, `src/docker/embed/entrypoint.sh`; test in `src/stages/maskfs/mask_filter_integration_test.ts`.

**Contract:** the supervisor exports `NAS_MASK_SUPERVISED=1` to its child; the wrapper skips supervision when it is already set.

**Why:** every `bash` in the container is the wrapper — `./configure`, each `make` recipe line, recursive make, npm/cargo build scripts. `make -j16` sustains dozens of live shells and nesting is unbounded, so connections are O(live bash processes) and each layer relays every byte across the boundary again. Suppression costs no coverage: descendants inherit the outermost supervisor's pipes, so their output is already masked, and output that escapes the outermost supervisor (a redirect to a file, `/dev/tty`) escapes every inner layer identically.

**Implementation notes:** build the child's `envp` **before fork** (`supervise.zig:157` requires no allocation in the child) by copying `std.c.environ` and **replacing** any existing `NAS_MASK_SUPERVISED=` entry — appending would leave a duplicate.

**Test design constraint:** masking is idempotent (`*` is not a secret), so a nested run produces byte-identical stdout with one layer or two. Asserting on masked output **cannot** detect the regression. Assert the marker directly.

- [ ] **Step 1: Write the failing test**

Extract the wrapper from the entrypoint heredoc so the guard is actually exercised — running `bash.real` bypasses the wrapper entirely and tests nothing.

```ts
function writeWrapperScript(): string {
  const entry = fs.readFileSync(
    path.join(import.meta.dir, "../../docker/embed/entrypoint.sh"), "utf8");
  const m = entry.match(/<< 'MASK_WRAPPER'\n([\s\S]*?)\nMASK_WRAPPER\n/);
  if (!m) throw new Error("MASK_WRAPPER heredoc not found");
  const body = m[1].replaceAll("/tmp/nas-bash-override/bash.real", realBashPath());
  const p = path.join(tmpDir, `wrapper-${secretsFileSeq++}.sh`);
  fs.writeFileSync(p, `${body}\n`, { mode: 0o755 });
  return p;
}

test("supervises exactly one layer when wrappers nest", async () => {
  if (!binaryPath) return;
  const sockPath = shortSockPath("nest");
  const server = startServe(writeSecretsFile(["hunter2"]), sockPath);
  try {
    expect(await waitForSocket(sockPath)).toBe(true);
    const wrapper = writeWrapperScript();
    const proc = Bun.spawn(
      [wrapper, "-c", `${wrapper} -c 'echo inner=[\${NAS_MASK_SUPERVISED:-unset}] pw=hunter2'`],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe",
        env: { ...process.env, NAS_MASK_FILTER: binaryPath, NAS_MASK_SOCKET: sockPath } },
    );
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    // The marker proves the outer layer supervised; masking proves the inner
    // shell's output still went through it.
    expect(stdout).toBe("inner=[1] pw=*******\n");
  } finally { server.kill(); await server.exited; fs.rmSync(sockPath, { force: true }); }
}, 15000);
```

Run: `bun test src/stages/maskfs/mask_filter_integration_test.ts -t "exactly one layer"`
Expected: FAIL — the marker is `unset` because nothing exports it yet.

- [ ] **Step 2: Implement, then run**

Run: `bun test src/stages/maskfs/mask_filter_integration_test.ts -t "exactly one layer"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
bun run check
git add src/mask-filter/supervise.zig src/docker/embed/entrypoint.sh src/stages/maskfs/mask_filter_integration_test.ts
git commit -m "$(cat <<'EOF'
feat(mask-filter): suppress nested supervision layers

コンテナ内の bash はすべてラッパーなので、./configure や make の各レシピ行、
再帰 make、npm/cargo のビルドスクリプトも supervise される。make -j16 では
同時生存シェルが数十本になり、接続数は「数シェル」ではなく生存 bash
プロセス数に比例する。入れ子の深さだけ全バイトがコンテナとホストの間を
往復し、その分だけ出力保持による遅延も積み上がる。

supervisor が NAS_MASK_SUPERVISED=1 を子へ渡し、ラッパーはそれが設定済み
なら素の bash を exec する。子の環境は fork 前に構築し、既存の同名変数は
追加ではなく置換する。

抑止してもカバレッジは減らない。子孫はすべて最外周 supervisor のパイプを
継承するので出力は既にマスクされており、最外周から逃げる出力は内側の層
からも同様に逃げる。

テストはマスク結果ではなくマーカーを見る。マスクは冪等なので (* は
シークレットではない)、層が 1 つでも 2 つでも stdout は同一になり、
出力を見ても回帰を検出できない。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: MaskFilterService — daemon lifecycle, mounts, env

**Files:** modify `src/stages/maskfs/mask_filter_service.ts`; rewrite `src/stages/maskfs/mask_filter_service_test.ts`.

**Contract:**
```ts
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
Mounts: `{source: socketDir, target: socketDir, readOnly: true}` plus the binary read-only. Env: `NAS_MASK_SOCKET`, `NAS_MASK_FILTER`. `MASK_SECRETS_CONTAINER_PATH` is deleted. The Layer type becomes `Layer.Layer<MaskFilterService, never, FsService | ProcessService>`.

**The socket directory is mounted read-only.** `connect(2)` succeeds through a
read-only bind mount while `unlink`/`create` return `EROFS` — measured; see the
spec's "Socket substitution" limitation for the table. Read-write would let the
agent delete `mask.sock` and bind an echo listener in its place, disabling
masking while `--supervise` still reports success. The daemon creates and unlinks
the socket host-side, where the mount flag does not apply.

Keep writing the frame (`0600` in a `0700` dir) — hostexec reads it for C3. Spawn `--serve` with `NAS_MASK_SECRETS_FILE` in the **daemon's own env** (host-side process, not a container variable). `acquireRelease` on release: kill the daemon, then remove frame, socket, **and log**. `chmod` the log to `0600` after spawn — `ProcessService.spawn` opens it with `openSync(path,"a")`, i.e. `0644`.

- [ ] **Step 1: Rewrite the service test**

The C1 guard must assert **reachability**, not substrings. An earlier draft used `expect(m.source).not.toContain("mask-secrets")`, which passes when the mount is the frame's *parent directory* — exactly the bug it was meant to catch.

```ts
const SESSION_DIR = "/run/user/1000/nas/mask-filter/sess_x";
const SOCKET_DIR = "/run/user/1000/nas/mask-filter/sess_x-sock";
const FRAME = `${SESSION_DIR}/mask-secrets`;
const SOCKET = `${SOCKET_DIR}/mask.sock`;
const LOG = `${SESSION_DIR}/serve.log`;

function reachable(target: string, mountSource: string): boolean {
  const src = mountSource.endsWith("/") ? mountSource : `${mountSource}/`;
  return target === mountSource || target.startsWith(src);
}

test("no mount can reach the secrets frame (C1)", async () => {
  const result = await run();
  for (const m of result.mounts) expect(reachable(FRAME, m.source)).toBe(false);
});

test("no mount can reach the serve log", async () => {
  const result = await run();
  for (const m of result.mounts) expect(reachable(LOG, m.source)).toBe(false);
});

test("no container env names the frame (S1)", async () => {
  const result = await run();
  expect(result.envVars.NAS_MASK_SECRETS_FILE).toBeUndefined();
  expect(JSON.stringify(result.envVars)).not.toContain("mask-secrets");
});

test("writes the frame host-side (hostexec C3 depends on it)", async () => {
  const { written } = await runCapturing();
  expect(written.map((w) => w.path)).toContain(FRAME);
});

test("mounts the socket directory read-only and spawns the daemon", async () => {
  const { result, spawns } = await runCapturing();
  expect(result.mounts.some((m) =>
    m.source === SOCKET_DIR && m.target === SOCKET_DIR && m.readOnly === true
  )).toBe(true);
  expect(result.envVars.NAS_MASK_SOCKET).toBe(SOCKET);
  expect(spawns).toEqual([{ command: "/usr/local/bin/nas-mask-filter", args: ["--serve", SOCKET] }]);
});
```

Build the fakes from `FsService` and `ProcessService` (`spawn` returning `{kill, exited, pid}`), wrap the effect in `Effect.scoped`, and follow the existing test file's shape for the `host` object.

- [ ] **Step 2: Run to verify failure, implement, run again**

Run: `bun test src/stages/maskfs/mask_filter_service_test.ts`

- [ ] **Step 3: Commit**

```bash
bun run check
git add src/stages/maskfs/mask_filter_service.ts src/stages/maskfs/mask_filter_service_test.ts
git commit -m "$(cat <<'EOF'
fix(mask-filter): stop exposing the secrets frame to the container

シークレットフレームは 0600 だが所有者がエージェント自身の UID なので、
コンテナから見える場所に置いている限り保護になっていない。cat 一発で
セッション中の全シークレットの索引が読める。C1 と S1 に反する。

マウントとコンテナ env を廃止し、ホスト側で --serve デーモンを起動して
socket だけをコンテナへ見せる。socket はセッションディレクトリとは別の
ディレクトリに置き、そこだけを読み取り専用でマウントする。同居させると
フレームごとコンテナへ渡すことになる。

読み取り専用にするのは socket の差し替えを防ぐため。読み書き可能だと
エージェントが mask.sock を削除して素通しのエコーサーバを同じパスに立て
られ、以降のシェルはマスクされないまま --supervise が成功を報告する。
connect(2) は読み取り専用バインドマウント越しでも成功する (書き込み権限は
socket の inode に対して必要なだけで、マウントの読み取り専用フラグは
名前空間の変更のみを止める) ため、この制約でプロトコルは何も失わない。
デーモンによる socket の作成と削除はホスト側で行われるので影響を受けない。

フレームファイル自体はホスト専用ディレクトリに残す。C1 はこの配置を明示的に
許容しており、src/hostexec/broker.ts が C3 のマスクで直読みしている。

回帰ガードは部分文字列一致ではなく到達可能性で判定する。マウント元が
フレームの親ディレクトリのとき、部分文字列一致は通過してしまう。

あわせて S2 の穴を塞ぐ。フレームの削除は現状 hostexec broker だけが行って
おり、mask.filter 有効かつ hostexec 無効の構成では残っていた。ログも 0600 に
落として削除対象に含める。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: MaskFilterStage — wire the daemon

**Files:** modify `src/stages/maskfs/mask_filter_stage.ts`, `src/stages/maskfs/mask_filter_stage_test.ts`.

**Contract:** derive `sessionDir = ${runtimeDir}/${sessionId}`, `secretsFramePath = ${sessionDir}/mask-secrets`, `socketDir = ${runtimeDir}/${sessionId}-sock`, `socketPath = ${socketDir}/mask.sock`, `logFile = ${sessionDir}/serve.log`. Fail the stage when the socket path exceeds **107 bytes** (`sun_path`), reporting the byte length. Wait for socket readiness before the container starts. Update the module header — the stage now owns a daemon.

**Test constraint:** `createMaskFilterStage.run` returns `{}` immediately unless `profile.mask` is set with `filter: true` and a non-empty `values`, so a test that omits it gets a *success* and cannot detect anything. Every existing test in that file sets `input.profile.mask` after constructing the input — follow that shape, and pass `options.resolveBinPath` so the real binary lookup does not decide the outcome.

- [ ] **Step 1: Write the failing tests**

Read `mask_filter_stage_test.ts` first and reuse its helpers. Two tests: the socket directory must be a sibling of (not inside) the frame directory, and an over-long socket path must fail the stage with a message containing `socket path too long`. Import `Exit` from `effect` and inspect the failure with `Exit.isFailure` plus `Cause` rather than stringifying.

- [ ] **Step 2: Run, implement, run**

Run: `bun test src/stages/maskfs/`

- [ ] **Step 3: Commit**

```bash
bun run check
git add src/stages/maskfs/mask_filter_stage.ts src/stages/maskfs/mask_filter_stage_test.ts
git commit -m "$(cat <<'EOF'
feat(mask-filter): give MaskFilterStage a daemon lifecycle

ステージが --serve デーモンをセッションスコープで起動し、socket が listen
状態になるまで待ってからコンテナを起動する。起動レースをクライアント側の
リトライで誤魔化すのではなく構造的に潰すため。

socket はセッションディレクトリと別のディレクトリに置く。マウントするのは
socket のあるディレクトリなので、同居させるとフレームごとコンテナへ渡す。

socket パスが sun_path の 108 バイト制限を超える場合はステージで失敗させる。
放置するとデーモン内の bind(2) が不可解に失敗するだけで原因が分からない。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: entrypoint.sh wrapper

**Files:** modify `src/docker/embed/entrypoint.sh`.

**Contract:** the install guard keys off `NAS_MASK_FILTER` + `NAS_MASK_SOCKET`. The wrapper keeps its `/entrypoint.sh` bypass and the `NAS_MASK_SUPERVISED` guard, then unconditionally execs the supervisor with `--socket "$NAS_MASK_SOCKET"`.

The runtime fallback is **removed**, not translated. "The socket exists" would keep a fail-open path where a dead serve process silently yields unmasked shells. Leave the `/entrypoint.sh` branch alone — it keeps a TTY for entrypoint re-entry and shell mode execs `$NAS_REAL_BASH` unmasked by design; narrowing it is a separate hardening item, out of scope.

- [ ] **Step 1: Update the heredoc and guard**

- [ ] **Step 2: Verify the generated wrapper without Docker**

```bash
cd /home/hogeyama/repo/nix-agent-sandbox
BIN=$PWD/src/mask-filter/zig-out/bin/nas-mask-filter
WORK=$(mktemp -d /tmp/nas-wrap-XXXX)          # short path: sun_path is 107 bytes
printf '\x01\x00\x00\x00\x07\x00\x00\x00hunter2' > "$WORK/frame"
NAS_MASK_SECRETS_FILE="$WORK/frame" "$BIN" --serve "$WORK/mask.sock" &
SERVE=$!
until [ -S "$WORK/mask.sock" ]; do sleep 0.05; done

sed -n "/<< 'MASK_WRAPPER'/,/^MASK_WRAPPER$/p" src/docker/embed/entrypoint.sh \
  | sed '1d;$d' > "$WORK/bash"
sed -i "s#/tmp/nas-bash-override/bash.real#$(command -v bash)#g" "$WORK/bash"
chmod +x "$WORK/bash"
export NAS_MASK_FILTER="$BIN" NAS_MASK_SOCKET="$WORK/mask.sock"

"$WORK/bash" -c 'printf "cmd %s pw=hunter2\n" "$0"'
"$WORK/bash" -lc 'printf "login %s pw=hunter2\n" "$0"'
printf 'printf "script %%s pw=hunter2\\n" "$0"\n' > "$WORK/s.sh"
"$WORK/bash" "$WORK/s.sh"

kill $SERVE; rm -rf "$WORK"
```

Expected: three lines each ending `pw=*******`; `$0` is the wrapper path for `-c`/`-lc` and `$WORK/s.sh` for the script form.

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

**Files:** modify `src/stages/launch/integration_test.ts`.

Read the whole file first. Five existing facts will break this task if ignored:

1. `MASK_FILTER_FIXTURE` reads `os.environ["NAS_MASK_SECRETS_FILE"]` **at module top level** (`:76`). After Task 7 that variable is gone from the container, so `--supervise` would die with `KeyError`. Move the frame read into the `--serve` branch.
2. The mask tests mount the fixture dir `:ro` (e.g. `:578`). The socket needs its **own** mount, separate from that — also `:ro`, per Task 5.
3. `USING_DIND` (`:45`) means host paths ≠ daemon paths; the socket must then live under the shared tmp dir. `SHARED_TMP` is `string | undefined` — reuse the existing `makeTempDir()` helper (`:52-62`), which already handles the DinD sticky-bit, rather than reinventing it.
4. `existsSync` (node:fs) and `mkdtemp` (node:fs/promises) are **not imported** in that file. Add them or use what is already imported.
5. Two further mask tests (`:609` shell re-entry/TTY, `:673` nix launch) still set only `NAS_MASK_SECRETS_FILE`. After Task 7's guard change, entrypoint silently stops installing the wrapper and both keep passing while testing nothing. Update them too.

**Fixture requirements — both were wrong in an earlier draft:**

- **`--serve` must mask the combined buffer, mirroring `MaskStream`.** Masking only the emitted prefix never sees a match straddling the retained overlap: verified, input `pw=hunter2 done` with `overlap=6` produced `pw=hunter2 done` — the fixture leaked the secret verbatim. Mask `overlap + new` together, emit the safe prefix, and carry the original trailing bytes (plus their confirmed-match marks) forward, as `mask_stream.zig:81-118` does.
- **`--supervise` must be fail-closed.** Connect **both** sockets before `Popen` and `sys.exit(121)` if either fails. An earlier draft connected inside worker threads, so a failure killed a thread while `child.wait()` still returned 0 — the fail-closed assertion would have failed.
- `--supervise` must also export `NAS_MASK_SUPERVISED=1` to the child, or the nesting test exercises nothing.

- [ ] **Step 1: Restructure the fixture** (serve + supervise + filter modes)
- [ ] **Step 2: Start the daemon per mask test, mount its socket dir `:ro`, set `NAS_MASK_SOCKET`, drop `NAS_MASK_SECRETS_FILE`, clean up in `finally`**
- [ ] **Step 3: Invert the fallback test** — socket configured but dead ⇒ non-zero exit and no `fallback-stdout`; `NAS_MASK_SOCKET` unset ⇒ wrapper never installed, plain bash, exit 0 (that is not a bypass, it is the feature being off)
- [ ] **Step 4: Add the nesting test**, asserting the `NAS_MASK_SUPERVISED` marker as in Task 4 — asserting masked output cannot detect the regression
- [ ] **Step 5: Update the two stale mask tests at `:609` and `:673`**

- [ ] **Step 6: Run**

Run: `bun test src/stages/launch/integration_test.ts`
Expected: PASS, or all-skip without Docker. **If it skips, say so explicitly in the task report — do not report untested code as verified.**

Run: `bun test src/` and `cd src/mask-filter && zig build test`
Expected: PASS. The existing hostexec masking tests are the C3 regression guard.

- [ ] **Step 7: Commit**

```bash
bun run check
git add src/stages/launch/integration_test.ts
git commit -m "$(cat <<'EOF'
test(mask-filter): cover the socket-based wrapper end to end

Python フィクスチャに --serve と --supervise を実装し、Docker テストを
socket 経由の構成に合わせる。実 Zig バイナリに置き換えないのは、これらの
テストを Zig ビルド無しで走らせるためという存在理由を保つため。

フレームの読み込みをモジュール先頭から --serve の分岐内へ移す。先頭のまま
だとコンテナから NAS_MASK_SECRETS_FILE が消えた後、--supervise 側が
KeyError で即死する。

--serve は overlap と新規バイトを連結した全体をマスクする。emit 部分だけを
マスクすると境界を跨ぐマッチが検出されず、シークレットが素通しで出る。
--supervise は Popen の前に両方の接続を確立し、片方でも失敗したら 121 で
落ちる。ワーカースレッド内で接続すると、失敗してもスレッドが死ぬだけで
child.wait() は 0 を返してしまう。

socket ディレクトリはフィクスチャの :ro マウントとは別に読み書き可能で
マウントする。DinD ではホストとデーモンのパスが異なるため共有 tmp に置く。

フォールバック検証は fail-closed の検証に反転させる。NAS_MASK_SOCKET 未設定
の場合はラッパー自体が設置されないので、素の bash になることを別ケースで
示す。入れ子の検証はマーカーで行う (マスクは冪等なので出力では判定不能)。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Spec coverage

| Spec requirement | Task |
| --- | --- |
| Frame unreachable from container; mount/env change | 5, 6 |
| Socket in its own directory; mount the directory | 5, 6 |
| Socket directory mounted read-only (blocks substitution) | 5, 8 |
| `sun_path` assertion | 6 |
| Frame + log lifetime (S2) | 5 |
| Nested supervision | 4 |
| Protocol: half-close, non-synchronous reply | 1, 3 |
| Resource bounds: queue cap, conn cap, EMFILE, RLIMIT, lazy `MaskStream` | 1, proven in 2 |
| Failure handling: either-connect-fails, mid-stream fatal, partial write | 3 |
| fd hygiene | 3 |
| Serve-mode output invariant | Global Constraints, 1 |
| Drain semantics preserved (three phases) | 3 |
| Wrapper bypass branch left alone | 7 |
| hostexec C3 preserved | 1, 5, 8 |
| Zig unit tests: mode parsing, path guard | 1 |
| Tests: chunk seam, conn cap, stalled reader, mid-run death, multi-MB output | 1, 2, 3 |
