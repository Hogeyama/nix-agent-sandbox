# hostexec stdout/stderr ストリーミング Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the full-buffer stdout/stderr relay in hostexec with NDJSON chunk streaming so long-running commands produce visible output immediately.

**Architecture:** Add an `ExecuteChunkResponse` message type to the hostexec protocol. The broker streams ReadableStream chunks as NDJSON lines over the Unix socket. The Zig interceptor and Python wrapper process chunks in a loop, writing each to the correct fd immediately. Secret redaction (`redactSecretsBytes`) is removed entirely.

**Tech Stack:** Bun (TypeScript), Zig (LD_PRELOAD .so), Python 3 (inline wrapper script)

## Global Constraints

- Runtime: Bun (not Node, not Deno)
- Tests: `bun test`. Unit tests as `*_test.ts` co-located with source. Integration tests as `*_integration_test.ts` co-located with source.
- Coding conventions: `effect-separation` (stages don't do I/O directly), `test-policy` (co-location, Docker guards)
- Spec: `docs/superpowers/specs/2026-07-07-hostexec-streaming-design.md`
- Zig tests: run inline via `zig test src/hostexec/intercept/hostexec_intercept.zig` (check if a build.zig or Makefile wraps this)

---

### Task 1: Protocol types — add ExecuteChunkResponse, slim down ExecuteResultResponse

**Files:**
- Modify: `src/hostexec/types.ts:60-97`

**Interfaces:**
- Produces: `ExecuteChunkResponse` type with `{ type: "chunk", requestId: string, fd: 1 | 2, data: string }`, updated `ExecuteResultResponse` without `stdout`/`stderr`, updated `HostExecBrokerResponse` union

- [ ] **Step 1: Add `ExecuteChunkResponse` and update `ExecuteResultResponse`**

In `src/hostexec/types.ts`, add the new type before `ExecuteResultResponse` and remove `stdout`/`stderr` from `ExecuteResultResponse`:

```typescript
export interface ExecuteChunkResponse {
  type: "chunk";
  requestId: string;
  fd: 1 | 2;
  data: string;
}

export interface ExecuteResultResponse {
  type: "result";
  requestId: string;
  exitCode: number;
}
```

- [ ] **Step 2: Update `HostExecBrokerResponse` union**

Add `ExecuteChunkResponse` to the union:

```typescript
export type HostExecBrokerResponse =
  | ExecuteChunkResponse
  | ExecuteResultResponse
  | ExecuteFallbackResponse
  | ExecuteErrorResponse
  | PendingListResponse
  | AckResponse;
```

- [ ] **Step 3: Run type check**

Run: `bun run check`
Expected: Type errors in `broker.ts` and `broker_integration_test.ts` (they reference the old `stdout`/`stderr` fields). These are expected and will be fixed in Tasks 2 and 4.

- [ ] **Step 4: Commit**

```bash
git add src/hostexec/types.ts
git commit -m "feat(hostexec): add ExecuteChunkResponse type, remove stdout/stderr from result"
```

---

### Task 2: Broker — stream chunks to socket, delete secret redaction

**Files:**
- Modify: `src/hostexec/broker.ts:226-247` (handleConnection)
- Modify: `src/hostexec/broker.ts:603-653` (runResolved)
- Delete: `src/hostexec/broker.ts:805-827` (redactSecretsBytes)

**Interfaces:**
- Consumes: `ExecuteChunkResponse` from Task 1
- Produces: `runResolved(request, resolved, socket): Promise<void>` — streams chunks and result directly to socket. `handleConnection` updated to not call `writeJsonLine` for the streaming path.

- [ ] **Step 1: Add `pipeStreamToSocket` helper**

Add this function inside `broker.ts` (above `runResolved`, or at module level as a private helper):

```typescript
async function pipeStreamToSocket(
  stream: ReadableStream<Uint8Array>,
  socket: Socket,
  requestId: string,
  fd: 1 | 2,
): Promise<void> {
  for await (const chunk of stream) {
    await writeJsonLine(socket, {
      type: "chunk",
      requestId,
      fd,
      data: Buffer.from(chunk).toString("base64"),
    });
  }
}
```

- [ ] **Step 2: Rewrite `runResolved` to stream**

Change the signature from `Promise<HostExecBrokerResponse>` to accept `socket: Socket` and return `Promise<void>`. Remove the full-buffer logic, secret redaction, and single-response return. Replace with streaming:

```typescript
private async runResolved(
  request: ExecuteRequest,
  resolved: ResolvedExecution,
  socket: Socket,
): Promise<void> {
  const commandArgv0 =
    isRelativeHostExecArgv0(resolved.rule.match.argv0) ||
    path.isAbsolute(resolved.rule.match.argv0)
      ? request.argv0
      : path.basename(request.argv0);
  const stdin = request.stdin
    ? Uint8Array.from(atob(request.stdin), (c) => c.charCodeAt(0))
    : undefined;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([commandArgv0, ...request.args], {
      cwd: resolved.cwd,
      env: resolved.envVars,
      stdin: stdin ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    const searchedPath = resolved.envVars.PATH ?? "(unset)";
    throw new Error(
      `Command '${commandArgv0}' not found on host. PATH=${searchedPath}`,
    );
  }
  if (stdin && proc.stdin) {
    (proc.stdin as import("bun").FileSink).write(stdin);
    (proc.stdin as import("bun").FileSink).end();
  }
  await Promise.all([
    pipeStreamToSocket(proc.stdout as ReadableStream, socket, request.requestId, 1),
    pipeStreamToSocket(proc.stderr as ReadableStream, socket, request.requestId, 2),
  ]);
  const exitCode = await proc.exited;
  await writeJsonLine(socket, {
    type: "result",
    requestId: request.requestId,
    exitCode,
  });
}
```

- [ ] **Step 3: Update `handleConnection` to pass socket to `runResolved`**

The current flow in `handleConnection` is:
```
const response = await this.handleMessage(message, channel);
await writeJsonLine(socket, response);
```

Change the execute path so `runResolved` writes directly to the socket. The simplest approach: split `handleMessage` for execute vs other types, or have `execute` accept the socket.

Update `handleConnection` (lines 226-247):

```typescript
private async handleConnection(
  socket: Socket,
  channel: "exec" | "control",
): Promise<void> {
  try {
    const line = await readJsonLine(socket);
    if (!line) return;
    const message = JSON.parse(line) as HostExecBrokerMessage;
    if (channel === "exec" && message.type === "execute") {
      try {
        await this.executeStreaming(message, socket);
      } catch (error) {
        try {
          await writeJsonLine(socket, toErrorResponse(message, (error as Error).message));
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "EPIPE" || code === "ECONNRESET") return;
          throw e;
        }
      }
      return;
    }
    const response = await this.handleMessage(message, channel).catch(
      (error) => toErrorResponse(message, (error as Error).message),
    );
    try {
      await writeJsonLine(socket, response);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EPIPE" || code === "ECONNRESET") return;
      throw e;
    }
  } finally {
    socket.destroy();
  }
}
```

Refactor the existing `execute` method (lines 286-354) to accept an optional `socket` parameter. When socket is provided, call `runResolved(request, resolved, socket)` instead of returning the result. For non-streaming responses (fallback, error, pending-queue), write them to the socket via `writeJsonLine(socket, response)` within `handleConnection`'s streaming branch.

The simplest approach: keep `execute` for non-streaming paths (approval responses from control channel), and create a new `executeStreaming(message, socket)` that duplicates the resolution/approval flow but writes responses to the socket:

```typescript
private async executeStreaming(
  message: ExecuteRequest,
  socket: Socket,
): Promise<void> {
  const resolved = await this.resolveRequest(message);
  const { approval, rule } = resolved;
  if (approval === "deny") {
    this.recordAudit(message, resolved, "deny", "policy-deny");
    await writeJsonLine(socket, { type: "error", requestId: message.requestId, message: "permission denied by policy" });
    return;
  }
  if (approval === "allow" || this.approvedCapabilities.has(resolved.capability)) {
    this.recordAudit(message, resolved, "allow", approval === "allow" ? "policy-allow" : "cached-approval");
    await this.runResolved(message, resolved, socket);
    return;
  }
  // approval === "prompt": queue for approval, then resume
  // When the pending request is resolved (approved/denied), the deferred
  // promise settles. On approval, call runResolved with the socket.
  // On denial, writeJsonLine the error.
  // Look at the existing execute() method's pending-queue logic and replicate
  // it here, replacing the return value with socket writes.
}
```

The pending-approval path is the trickiest: the current `execute` returns a Promise that resolves when the user approves/denies. For streaming, the socket must remain open until approval arrives and the command finishes. Read `execute` lines 286-354 carefully — the `pendingRequests` Map and `resolveGroup` method handle the deferred resolution. The streaming version must keep the socket open and call `runResolved(message, resolved, socket)` on approval, or `writeJsonLine(socket, error)` on denial.

- [ ] **Step 4: Delete `redactSecretsBytes`**

Remove the `redactSecretsBytes` function (lines 805-827) and its call sites in the old `runResolved` (already replaced in step 2, so just confirm it's gone). Also remove the `secretValues` collection logic that was in the old `runResolved`.

- [ ] **Step 5: Run type check**

Run: `bun run check`
Expected: PASS (or errors only in test files that still reference old `stdout`/`stderr` — fixed in Task 4).

- [ ] **Step 6: Commit**

```bash
git add src/hostexec/broker.ts
git commit -m "feat(hostexec): stream stdout/stderr chunks over socket, remove secret redaction"
```

---

### Task 3: Zig interceptor — NDJSON chunk loop

**Files:**
- Modify: `src/hostexec/intercept/hostexec_intercept.zig:171-245` (BrokerResponse, parseResponse)
- Modify: `src/hostexec/intercept/hostexec_intercept.zig:312-398` (callBrokerInner)
- Modify: `src/hostexec/intercept/hostexec_intercept.zig:642-801` (existing tests + new tests)

**Interfaces:**
- Consumes: NDJSON protocol from Task 2 (`chunk` lines followed by `result` line)
- Produces: Updated `BrokerResponse` with `.chunk` variant, `parseResponse` supporting chunk type, `callBrokerInner` with NDJSON loop

- [ ] **Step 1: Update `BrokerResponse` struct and `parseResponse`**

Change `BrokerResponse` to support chunk messages:

```zig
pub const BrokerResponse = struct {
    response_type: ResponseType,
    exit_code: i32,
    data_b64: []const u8,
    fd: i32,

    pub const ResponseType = enum { result, chunk, fallback, @"error", unknown };
};
```

Update `parseResponse` to handle `chunk` type:

```zig
pub fn parseResponse(alloc: Allocator, line: []const u8) !BrokerResponse {
    const trimmed = std.mem.trim(u8, line, &[_]u8{ ' ', '\t', '\r', '\n' });
    const parsed = try json.parseFromSlice(json.Value, alloc, trimmed, .{});
    defer parsed.deinit();

    const root = parsed.value;
    if (root != .object) return error.InvalidResponse;

    const type_val = root.object.get("type") orelse return error.InvalidResponse;
    const type_str = switch (type_val) {
        .string => |s| s,
        else => return error.InvalidResponse,
    };

    const response_type: BrokerResponse.ResponseType = blk: {
        if (std.mem.eql(u8, type_str, "result")) break :blk .result;
        if (std.mem.eql(u8, type_str, "chunk")) break :blk .chunk;
        if (std.mem.eql(u8, type_str, "fallback")) break :blk .fallback;
        if (std.mem.eql(u8, type_str, "error")) break :blk .@"error";
        break :blk .unknown;
    };

    var exit_code: i32 = 0;
    var data_b64: []const u8 = "";
    var fd: i32 = 1;

    if (response_type == .result) {
        if (root.object.get("exitCode")) |ec| {
            switch (ec) {
                .integer => |i| {
                    exit_code = std.math.cast(i32, i) orelse 1;
                },
                else => {},
            }
        }
    }

    if (response_type == .chunk) {
        if (root.object.get("data")) |d| {
            switch (d) {
                .string => |str| {
                    data_b64 = try alloc.dupe(u8, str);
                },
                else => {},
            }
        }
        if (root.object.get("fd")) |f| {
            switch (f) {
                .integer => |i| {
                    fd = std.math.cast(i32, i) orelse 1;
                },
                else => {},
            }
        }
    }

    return BrokerResponse{
        .response_type = response_type,
        .exit_code = exit_code,
        .data_b64 = data_b64,
        .fd = fd,
    };
}
```

- [ ] **Step 2: Rewrite `callBrokerInner` response loop**

Replace the single-response read (lines 344-398) with an NDJSON loop:

```zig
fn callBrokerInner(
    alloc: Allocator,
    socket_path: []const u8,
    session_id: []const u8,
    pathname: [*:0]const u8,
    argv: [*:null]const ?[*:0]const u8,
) !BrokerCallResult {
    const all_args = try collectArgv(alloc, argv);
    defer alloc.free(all_args);

    const argv0 = std.mem.span(pathname);
    const args = if (all_args.len > 1) all_args[1..] else all_args[0..0];

    var cwd_buf: [std.fs.max_path_bytes]u8 = undefined;
    const cwd = std.posix.getcwd(&cwd_buf) catch "/";

    var req_id_buf: [36]u8 = undefined;
    const request_id = generateRequestId(&req_id_buf);

    const request_json = try buildRequest(alloc, session_id, request_id, argv0, args, cwd);
    defer alloc.free(request_json);

    debugLog("connecting to broker at {s}", .{socket_path});

    const sock = try std.net.connectUnixSocket(socket_path);
    defer sock.close();

    try sock.writeAll(request_json);

    // NDJSON streaming loop
    var buf: std.ArrayList(u8) = .{};
    defer buf.deinit(alloc);
    var read_buf: [4096]u8 = undefined;

    while (true) {
        // Process all complete lines in buffer
        while (std.mem.indexOfScalar(u8, buf.items, '\n')) |nl_pos| {
            const line = buf.items[0..nl_pos];
            const response = try parseResponse(alloc, line);

            // Shift buffer: remove processed line + newline
            const remaining = buf.items[nl_pos + 1 ..];
            std.mem.copyForwards(u8, buf.items[0..remaining.len], remaining);
            buf.items.len = remaining.len;

            switch (response.response_type) {
                .chunk => {
                    if (response.data_b64.len > 0) {
                        defer alloc.free(response.data_b64);
                        if (decodeBase64(alloc, response.data_b64)) |decoded| {
                            defer alloc.free(decoded);
                            const target_fd: i32 = if (response.fd == 2) std.posix.STDERR_FILENO else std.posix.STDOUT_FILENO;
                            if (decoded.len > 0) writeAll(target_fd, decoded);
                        } else |_| {}
                    }
                },
                .result => {
                    return .{ .exit_code = response.exit_code, .should_fallback = false };
                },
                .fallback => {
                    debugLog("broker requested fallback", .{});
                    return .{ .exit_code = 0, .should_fallback = true };
                },
                .@"error" => {
                    debugLog("broker returned error", .{});
                    return .{ .exit_code = 1, .should_fallback = true };
                },
                .unknown => {
                    debugLog("unknown response type from broker", .{});
                    return .{ .exit_code = 1, .should_fallback = true };
                },
            }
        }

        // Read more data from socket
        const n = try sock.read(&read_buf);
        if (n == 0) break;
        try buf.appendSlice(alloc, read_buf[0..n]);
    }

    debugLog("broker connection closed without result", .{});
    return .{ .exit_code = 1, .should_fallback = true };
}
```

- [ ] **Step 3: Update existing `parseResponse` tests**

The existing tests reference `stdout_b64` and `stderr_b64`. Update them to use the new `data_b64` and `fd` fields.

For the `result` type tests (lines 642-673), the `result` response no longer carries stdout/stderr — update assertions:

```zig
test "parseResponse: result type" {
    const alloc = std.testing.allocator;
    const input =
        \\{"type":"result","requestId":"r1","exitCode":0}
    ;
    const resp = try parseResponse(alloc, input);

    try std.testing.expectEqual(BrokerResponse.ResponseType.result, resp.response_type);
    try std.testing.expectEqual(@as(i32, 0), resp.exit_code);
    try std.testing.expectEqualStrings("", resp.data_b64);
}

test "parseResponse: result with nonzero exit code" {
    const alloc = std.testing.allocator;
    const input =
        \\{"type":"result","requestId":"r2","exitCode":42}
    ;
    const resp = try parseResponse(alloc, input);

    try std.testing.expectEqual(BrokerResponse.ResponseType.result, resp.response_type);
    try std.testing.expectEqual(@as(i32, 42), resp.exit_code);
}
```

- [ ] **Step 4: Add new `parseResponse` chunk tests**

```zig
test "parseResponse: chunk type with stdout" {
    const alloc = std.testing.allocator;
    const input =
        \\{"type":"chunk","requestId":"r1","fd":1,"data":"aGVsbG8="}
    ;
    const resp = try parseResponse(alloc, input);
    defer if (resp.data_b64.len > 0) alloc.free(resp.data_b64);

    try std.testing.expectEqual(BrokerResponse.ResponseType.chunk, resp.response_type);
    try std.testing.expectEqual(@as(i32, 1), resp.fd);
    try std.testing.expectEqualStrings("aGVsbG8=", resp.data_b64);
}

test "parseResponse: chunk type with stderr" {
    const alloc = std.testing.allocator;
    const input =
        \\{"type":"chunk","requestId":"r1","fd":2,"data":"ZXJy"}
    ;
    const resp = try parseResponse(alloc, input);
    defer if (resp.data_b64.len > 0) alloc.free(resp.data_b64);

    try std.testing.expectEqual(BrokerResponse.ResponseType.chunk, resp.response_type);
    try std.testing.expectEqual(@as(i32, 2), resp.fd);
    try std.testing.expectEqualStrings("ZXJy", resp.data_b64);
}
```

- [ ] **Step 5: Run Zig tests**

Run: `zig test src/hostexec/intercept/hostexec_intercept.zig` (or whatever build command the project uses — check `build.zig` or `Makefile` first)
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/hostexec/intercept/hostexec_intercept.zig
git commit -m "feat(hostexec): zig interceptor NDJSON chunk streaming loop"
```

---

### Task 4: Python wrapper — replace `call_broker` with `stream_broker`

**Files:**
- Modify: `src/stages/hostexec/stage.ts:485-587` (buildWrapperScript function)

**Interfaces:**
- Consumes: NDJSON protocol from Task 2
- Produces: Updated Python wrapper script with `stream_broker` function

- [ ] **Step 1: Replace `call_broker` with `stream_broker` and update `main`**

In `src/stages/hostexec/stage.ts`, replace the `call_broker` function and the stdout/stderr handling in `main()` within the `buildWrapperScript()` return string:

Replace the `call_broker` function (Python lines starting at `def call_broker`) with:

```python
def stream_broker(payload: dict):
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(os.environ["NAS_HOSTEXEC_SOCKET"])
    try:
        sock.sendall((json.dumps(payload) + "\\n").encode())
        buf = b""
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                break
            buf += chunk
            while b"\\n" in buf:
                line, buf = buf.split(b"\\n", 1)
                msg = json.loads(line)
                if msg["type"] == "chunk":
                    data = base64.b64decode(msg["data"])
                    if msg["fd"] == 1:
                        sys.stdout.buffer.write(data)
                        sys.stdout.flush()
                    else:
                        sys.stderr.buffer.write(data)
                        sys.stderr.flush()
                elif msg["type"] == "result":
                    return ("result", int(msg.get("exitCode", 0)))
                elif msg["type"] == "fallback":
                    return ("fallback", 0)
                elif msg["type"] == "error":
                    print(msg.get("message", "unknown error"), file=sys.stderr)
                    return ("error", 1)
        return ("error", 1)
    finally:
        sock.close()
```

Replace the `main()` function's broker call and response handling:

```python
def main() -> int:
    argv0 = sys.argv[0]
    payload = {
        "version": 1,
        "type": "execute",
        "sessionId": os.environ.get("NAS_HOSTEXEC_SESSION_ID", ""),
        "requestId": f"req_{os.getpid()}_{os.urandom(4).hex()}",
        "argv0": argv0,
        "args": sys.argv[1:],
        "cwd": os.getcwd(),
        "tty": sys.stdin.isatty(),
    }
    if not sys.stdin.isatty():
        stdin_data = read_available_stdin()
        if stdin_data:
            payload["stdin"] = base64.b64encode(stdin_data).decode()

    result_type, exit_code = stream_broker(payload)
    if result_type == "fallback":
        if (not os.path.isabs(argv0)) and (os.path.sep in argv0):
            print(f"relative argv0 fallback is not supported: {argv0}", file=sys.stderr)
            return 1
        binary = find_fallback_binary(argv0, os.environ["NAS_HOSTEXEC_WRAPPER_DIR"])
        os.execv(binary, [binary, *sys.argv[1:]])
    return exit_code
```

- [ ] **Step 2: Run type check**

Run: `bun run check`
Expected: PASS (the wrapper is a template string, so TS type checking doesn't inspect the Python code)

- [ ] **Step 3: Commit**

```bash
git add src/stages/hostexec/stage.ts
git commit -m "feat(hostexec): python wrapper streams chunks via NDJSON"
```

---

### Task 5: Update integration tests for new protocol

**Files:**
- Modify: `src/hostexec/broker_integration_test.ts`
- Modify: `src/hostexec/intercept_integration_test.ts`

**Interfaces:**
- Consumes: New protocol types from Task 1, streaming broker from Task 2

- [ ] **Step 1: Create a streaming client helper**

The existing `sendHostExecBrokerRequest` reads one JSON line and returns it. For streaming, we need a helper that reads multiple lines. Add at the top of `broker_integration_test.ts`:

```typescript
import {
  connectUnix,
  readJsonLine,
  writeJsonLine,
} from "../lib/unix_socket.ts";
import type { ExecuteChunkResponse } from "./types.ts";

interface StreamingResult {
  chunks: ExecuteChunkResponse[];
  exitCode: number;
}

async function sendStreamingRequest(
  socketPath: string,
  message: ExecuteRequest,
): Promise<StreamingResult> {
  const socket = await connectUnix(socketPath);
  try {
    await writeJsonLine(socket, message);
    const chunks: ExecuteChunkResponse[] = [];
    let exitCode = -1;
    let text = "";
    await new Promise<void>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        text += chunk.toString();
        let nl: number;
        while ((nl = text.indexOf("\n")) !== -1) {
          const line = text.slice(0, nl);
          text = text.slice(nl + 1);
          const msg = JSON.parse(line);
          if (msg.type === "chunk") {
            chunks.push(msg);
          } else if (msg.type === "result") {
            exitCode = msg.exitCode;
            socket.off("data", onData);
            resolve();
            return;
          } else if (msg.type === "fallback" || msg.type === "error") {
            socket.off("data", onData);
            reject(new Error(`unexpected response: ${msg.type}`));
            return;
          }
        }
      };
      socket.on("data", onData);
      socket.on("end", () => resolve());
      socket.on("error", reject);
    });
    return { chunks, exitCode };
  } finally {
    socket.destroy();
  }
}

function collectStdout(result: StreamingResult): string {
  return Buffer.from(
    result.chunks
      .filter((c) => c.fd === 1)
      .map((c) => c.data)
      .join(""),
    "base64",
  ).toString("utf-8");
}
```

Wait — the chunks' `data` fields are individually base64-encoded, not concatenated then decoded. Fix the helper:

```typescript
function collectStdout(result: StreamingResult): string {
  return result.chunks
    .filter((c) => c.fd === 1)
    .map((c) => Buffer.from(c.data, "base64").toString("utf-8"))
    .join("");
}
```

- [ ] **Step 2: Replace `decodeStdout` and update existing tests**

Remove the old `decodeStdout` helper. Update every test that uses `sendHostExecBrokerRequest` for execute requests to use `sendStreamingRequest` instead.

Key tests to update:

**"prompts and resumes after approve" (line 98):** This test currently checks `decodeStdout(response).trim() === "[REDACTED]"`. Since secret redaction is removed, the output will be the raw secret value. Update:
- Remove the `HOSTEXEC_TEST_TOKEN` env setup
- Use `sendStreamingRequest` after approval
- Check `collectStdout(result).trim() === "super-secret-value"` (or change the command to output a non-secret value instead)

Actually, this test specifically tests secret redaction. Since that feature is being removed, simplify the test: change the `env` binding from `"secret:test_token"` to a plain value, or just test that the command output arrives correctly via streaming. The simplest fix: change the command to `console.log('approved')` and check for `"approved"`.

**"argv0-only rule matches any args" (line 523):** Change from:
```typescript
expect(decodeStdout(response).trim()).toEqual("ok");
```
to:
```typescript
const result = await sendStreamingRequest(execSocketPath, request(["-e", "console.log('ok')"], workspace, "req_any"));
expect(collectStdout(result).trim()).toEqual("ok");
```

Apply this pattern to all tests that check stdout content: lines 523, 570, 621, 670, 871, 1126.

For tests that only check `response.type` (fallback, error, etc.), the existing `sendHostExecBrokerRequest` still works since those responses are single JSON lines.

- [ ] **Step 3: Update intercept integration test mock broker**

In `src/hostexec/intercept_integration_test.ts`, update `startMockBroker` to send streaming responses:

```typescript
function startMockBroker(
  socketPath: string,
  handler: (request: ExecuteRequest) => { stdout?: string; stderr?: string; exitCode: number },
): Promise<Server> {
  return createUnixServer(socketPath, async (socket) => {
    try {
      const line = await readJsonLine(socket);
      if (line) {
        const request = JSON.parse(line) as ExecuteRequest;
        const { stdout, stderr, exitCode } = handler(request);
        if (stdout) {
          await writeJsonLine(socket, {
            type: "chunk",
            requestId: request.requestId,
            fd: 1,
            data: Buffer.from(stdout).toString("base64"),
          });
        }
        if (stderr) {
          await writeJsonLine(socket, {
            type: "chunk",
            requestId: request.requestId,
            fd: 2,
            data: Buffer.from(stderr).toString("base64"),
          });
        }
        await writeJsonLine(socket, {
          type: "result",
          requestId: request.requestId,
          exitCode,
        });
      }
    } catch (err) {
      console.error("mock broker handler error:", err);
    } finally {
      socket.end();
    }
  });
}
```

Update the test handlers:

**"broker returns exitCode=0 with stdout and stderr" (line 68):**
```typescript
const server = await startMockBroker(socketPath, () => ({
  stdout: expectedStdout,
  stderr: expectedStderr,
  exitCode: 0,
}));
```

**"broker returns non-zero exit code" (line 114):**
```typescript
const server = await startMockBroker(socketPath, () => ({
  exitCode: 42,
}));
```

- [ ] **Step 4: Run all tests**

Run: `bun test src/hostexec/`
Expected: All unit tests PASS. Integration tests PASS (if Docker / Zig .so are available; otherwise skipped).

- [ ] **Step 5: Commit**

```bash
git add src/hostexec/broker_integration_test.ts src/hostexec/intercept_integration_test.ts
git commit -m "test(hostexec): update integration tests for streaming protocol"
```

---

### Task 6: Add streaming-specific tests

**Files:**
- Modify: `src/hostexec/broker_integration_test.ts` (add new test)

**Interfaces:**
- Consumes: Streaming broker from Task 2, `sendStreamingRequest` from Task 5

- [ ] **Step 1: Add streaming end-to-end test**

Add a test that verifies multi-chunk output arrives correctly:

```typescript
test("HostExecBroker: streaming produces chunks for multi-line output", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "node-any",
          match: { argv0: "node" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "allow",
          fallback: "container",
        },
      ],
    }),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await broker.start(execSocketPath, controlSocketPath);
  try {
    const result = await sendStreamingRequest(
      execSocketPath,
      request(
        ["-e", "console.log('line1'); console.error('err1'); console.log('line2')"],
        workspace,
        "req_stream",
      ),
    );
    expect(result.exitCode).toEqual(0);
    expect(result.chunks.length).toBeGreaterThan(0);
    const stdout = collectStdout(result);
    expect(stdout).toContain("line1");
    expect(stdout).toContain("line2");
    const stderr = result.chunks
      .filter((c) => c.fd === 2)
      .map((c) => Buffer.from(c.data, "base64").toString("utf-8"))
      .join("");
    expect(stderr).toContain("err1");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});
```

- [ ] **Step 2: Add test for no-output command**

```typescript
test("HostExecBroker: streaming produces zero chunks for silent command", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "true-any",
          match: { argv0: "true" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "allow",
          fallback: "container",
        },
      ],
    }),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await broker.start(execSocketPath, controlSocketPath);
  try {
    const result = await sendStreamingRequest(
      execSocketPath,
      request([], workspace, "req_silent", "true"),
    );
    expect(result.exitCode).toEqual(0);
    expect(result.chunks.length).toEqual(0);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});
```

- [ ] **Step 3: Run integration tests**

Run: `bun test src/hostexec/broker_integration_test.ts`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/hostexec/broker_integration_test.ts
git commit -m "test(hostexec): add streaming-specific integration tests"
```

---

### Task 7: Clean up TODO doc and run full test suite

**Files:**
- Delete: `docs/TODO-hostexec-streaming.md`

**Interfaces:** None (cleanup task)

- [ ] **Step 1: Delete the TODO document**

```bash
rm docs/TODO-hostexec-streaming.md
```

- [ ] **Step 2: Run full test suite**

Run: `bun test src/`
Expected: All unit tests PASS

Run: `bun run check`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: remove TODO-hostexec-streaming.md (implemented)"
```
