# Hostexec stdin FD passing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hostexec's eager stdin snapshot with Linux `SCM_RIGHTS` delegation so supported stdin descriptors retain exact Unix consumption semantics across container-to-host execution.

**Architecture:** A per-session static Zig gateway owns the container-visible exec socket, receives read-only non-TTY fd 0, and spawns approved host commands with that open file description. The TypeScript broker moves behind a host-only internal socket and retains rule resolution, approval, integrity, audit, secret resolution, and output masking; the gateway can forward only broker-produced masked chunks to the container client.

**Tech Stack:** Bun 1.3.x, TypeScript 6 strict mode, Effect 3, Zig 0.15.2, Linux Unix-domain sockets and `SCM_RIGHTS`, Nix flakes.

## Global Constraints

- Read `docs/superpowers/specs/2026-08-16-hostexec-stdin-fd-passing-design.md` before implementing any task.
- Read and apply `security-constraints`, especially C1, C2, C3, S1, and N1.
- Read and apply `effect-separation`; stage `run()` may call only pure planners and intentful stage-facing services. Any new composed Effect must call injected Ops rather than raw I/O.
- Read and apply `test-policy`; tests are co-located, use unique temporary resources, and clean them in `finally`.
- Use `test-driven-development`: add the named failing test, observe the expected failure, implement the minimum production behavior, and observe it pass.
- Use `git-commit` for every commit. The subjects shown below are intended outcomes; the final body must record the reason and remain understandable without this plan or spec.
- Linux is the only supported gateway platform. Broker, gateway, and container must share one kernel; Docker Desktop and remote Docker are out of scope.
- External protocol version is exactly `2`; do not retain a runtime version-1 compatibility branch.
- Pass fd 0 only when it is non-TTY and `F_GETFL & O_ACCMODE == O_RDONLY`.
- A non-TTY `O_RDWR` fd 0 is a terminal client error. Never downgrade it to `stdinMode: "none"` and never locally fall back.
- TTY, closed fd, `O_WRONLY`, and `posix_spawn*` use `stdinMode: "none"` and preserve their existing no-forwarding behavior.
- Only a broker `fallback` received before `start` may trigger local execution. Transport, protocol, spawn, mask-filter, and post-start failures remain fail-closed.
- The gateway must never forward a `raw_chunk` to the external client. Only a broker-originated `masked_chunk` may become an external `chunk`.
- External and internal control messages are limited to 4 MiB. Raw and masked payloads are chunked to at most 64 KiB before base64 encoding.
- The gateway runs as the normal nas user, without additional capabilities or root privileges.

---

## File Structure

### New Zig files

- `src/hostexec/intercept/fd_transport.zig` — fd classification plus `sendmsg` / `recvmsg` ancillary-data primitives. It does not know hostexec JSON shapes.
- `src/hostexec/intercept/gateway_protocol.zig` — external v2 and internal gateway/broker message parsing, encoding, size limits, and direction/state validation.
- `src/hostexec/intercept/gateway_executor.zig` — child setup with delegated stdin, stdout/stderr pipes, process groups, wait, and termination.
- `src/hostexec/intercept/gateway_main.zig` — listener lifecycle, one handler process per external request, broker relay state machine, and readiness message.

### New TypeScript files

- `src/hostexec/gateway_protocol.ts` — Zod schemas and inferred TypeScript types mirroring `gateway_protocol.zig`.
- `src/hostexec/gateway_protocol_test.ts` — pure schema and direction-validation tests.
- `src/hostexec/gateway_execution.ts` — one approved internal connection's raw-stream masking and terminal-result orchestration.
- `src/hostexec/gateway_execution_test.ts` — socket-pair tests with fake gateway messages and real/fake mask-filter processes.
- `src/hostexec/gateway_test_harness.ts` — test-only lifecycle for a real gateway plus a mock internal broker.
- `src/hostexec/fd_gateway_integration_test.ts` — bare and LD_PRELOAD exact-stdin regression tests.

### Existing files with focused changes

- `src/hostexec/intercept/protocol.zig` — external request v2 and `fd_transport.sendLine`; delete eager stdin capture.
- `src/hostexec/intercept/client_main.zig` and `hostexec_intercept.zig` — handle unsupported read/write stdin and import new tests.
- `src/hostexec/intercept/build.zig` — build and test `nas-hostexec-gateway`.
- `src/hostexec/types.ts` — external v2 request shape; no base64 stdin field.
- `src/hostexec/broker.ts` — listen on the internal socket and delegate approved execution to `gateway_execution.ts`; it no longer spawns the host command directly.
- `src/hostexec/registry.ts` — derive the host-only internal socket path.
- `src/stages/hostexec/broker_service.ts` — manage broker plus gateway as one scoped resource through fakeable Ops.
- `src/hostexec/intercept_path.ts`, `src/pipeline/host_env.ts`, and `src/pipeline/types.ts` — probe the gateway artifact once at pipeline startup.
- `src/stages/hostexec/stage.ts` — pure plan carries the gateway path and internal socket without performing I/O.
- `flake.nix` — package the host gateway binary.
- `.github/workflows/ci.yml` — run Docker-free Zig and host-native gateway tests on PRs.

---

### Task 1: Unix FD ancillary transport primitives

**Files:**
- Create: `src/hostexec/intercept/fd_transport.zig`
- Modify: `src/hostexec/intercept/hostexec_intercept.zig`

**Interfaces:**
- Produces: `selectStdin(fd: fd_t, capable: bool) StdinSelection`
- Produces: `sendLine(socket_fd: fd_t, line: []const u8, stdin_fd: ?fd_t) !void`
- Produces: `receiveLine(allocator: Allocator, socket_fd: fd_t, max_bytes: usize) !ReceivedLine`
- Produces: `ReceivedLine.deinit()` which closes any received fd and frees its line buffer exactly once

- [ ] **Step 1: Add failing fd classification tests**

Create the module with the public types and tests first:

```zig
const std = @import("std");

pub const StdinSelection = union(enum) {
    none,
    pass_fd: std.posix.fd_t,
    reject_read_write,
};

pub fn selectStdin(fd: std.posix.fd_t, capable: bool) StdinSelection {
    _ = fd;
    _ = capable;
    return .none;
}

test "selectStdin passes a read-only pipe" {
    const fds = try std.posix.pipe2(.{ .CLOEXEC = true });
    defer std.posix.close(fds[0]);
    defer std.posix.close(fds[1]);
    try std.testing.expectEqual(
        StdinSelection{ .pass_fd = fds[0] },
        selectStdin(fds[0], true),
    );
}

test "selectStdin rejects a non-tty read-write socket" {
    var fds: [2]std.posix.fd_t = undefined;
    try std.testing.expectEqual(
        @as(c_int, 0),
        std.c.socketpair(
            @intCast(std.posix.AF.UNIX),
            @intCast(std.posix.SOCK.STREAM | std.posix.SOCK.CLOEXEC),
            0,
            &fds,
        ),
    );
    defer std.posix.close(fds[0]);
    defer std.posix.close(fds[1]);
    try std.testing.expectEqual(StdinSelection.reject_read_write, selectStdin(fds[0], true));
}
```

Add cases for `capable == false`, closed fd, `O_WRONLY`, and a PTY when `/dev/ptmx` is available. Import the module from the existing root test block in `hostexec_intercept.zig`:

```zig
test {
    _ = @import("protocol.zig");
    _ = @import("client_main.zig");
    _ = @import("fd_transport.zig");
}
```

- [ ] **Step 2: Run the Zig tests and confirm the red state**

Run:

```bash
cd src/hostexec/intercept
zig build test
```

Expected: the read-only pipe and read-write socket tests fail because the stub always returns `.none`.

- [ ] **Step 3: Implement fd classification without reading fd contents**

Use `isatty` first, then `fcntl(F_GETFL)` and `O_ACCMODE`. The function must return:

```zig
if (!capable) return .none;
if (std.posix.isatty(fd)) return .none;
const flags = std.posix.fcntl(fd, std.posix.F.GETFL, 0) catch return .none;
return switch (flags & 0o3) {
    0o0 => .{ .pass_fd = fd },
    0o2 => .reject_read_write,
    else => .none,
};
```

Do not call `poll`, `read`, `pread`, `lseek`, or `/proc/*/fd`.

- [ ] **Step 4: Add failing `sendLine` / `receiveLine` tests**

Use a Unix `socketpair` and a pipe. Assert all of the following:

```zig
try sendLine(sockets[0], "{\"type\":\"execute\"}\n", pipe_fds[0]);
var received = try receiveLine(alloc, sockets[1], 4096);
defer received.deinit();
try std.testing.expectEqualStrings("{\"type\":\"execute\"}", received.line);
try std.testing.expect(received.stdin_fd != null);

try std.posix.write(pipe_fds[1], "payload");
var buf: [7]u8 = undefined;
try std.testing.expectEqual(@as(usize, 7), try std.posix.read(received.stdin_fd.?, &buf));
try std.testing.expectEqualStrings("payload", &buf);
```

Also test no-FD requests, a line split across the first `recvmsg` and later reads, maximum-size rejection, multiple received descriptors, `MSG_CTRUNC`, and `FD_CLOEXEC` on the received descriptor.

- [ ] **Step 5: Implement ancillary send and receive**

Use `std.posix.sendmsg` / `std.posix.recvmsg` with Linux `cmsghdr` layout. Define alignment helpers instead of scattering arithmetic:

```zig
const scm_rights: i32 = 1;

fn cmsgAlign(n: usize) usize {
    const a = @alignOf(usize);
    return (n + a - 1) & ~(a - 1);
}

fn cmsgLen(payload_len: usize) usize {
    return cmsgAlign(@sizeOf(std.os.linux.cmsghdr)) + payload_len;
}

fn cmsgSpace(payload_len: usize) usize {
    return cmsgAlign(@sizeOf(std.os.linux.cmsghdr)) + cmsgAlign(payload_len);
}
```

`sendLine` attaches ancillary data only to the first successful `sendmsg`; if the line is partially sent, finish with `std.posix.write`. `receiveLine` performs exactly one initial `recvmsg(..., MSG.CMSG_CLOEXEC)`, validates every control header, retains at most one descriptor, then reads until newline. On every error path close all descriptors already extracted.

- [ ] **Step 6: Run focused and complete Zig tests**

Run:

```bash
cd src/hostexec/intercept
zig build test
```

Expected: all Zig tests pass, including the new malformed ancillary and FD-leak cases.

- [ ] **Step 7: Commit Task 1**

Stage only the two Task 1 files and use `git-commit`. Expected subject:

```text
feat(hostexec): add Unix FD transport primitives
```

---

### Task 2: Cross-language gateway protocol contracts

**Files:**
- Create: `src/hostexec/intercept/gateway_protocol.zig`
- Create: `src/hostexec/gateway_protocol.ts`
- Create: `src/hostexec/gateway_protocol_test.ts`
- Modify: `src/hostexec/intercept/hostexec_intercept.zig`

**Interfaces:**
- Produces Zig `ExternalExecuteRequest`, `GatewayToBroker`, `BrokerToGateway`, `GatewayState`, and parse/stringify functions
- Produces TypeScript `ExternalExecuteRequestV2`, `GatewayToBrokerMessage`, `BrokerToGatewayMessage`, `parseGatewayToBroker`, and `parseBrokerToGateway`
- Both implementations use the exact field names and message direction listed below

- [ ] **Step 1: Write failing TypeScript schema tests**

Define tests before schemas. Cover valid messages and reject wrong version, missing fields, payloads over the decoded 64 KiB limit, non-integer PID/exit code, unknown keys on secret-bearing `start`, and a message sent in the wrong state.

```ts
test("external execute requires protocol version 2 and stdinMode", () => {
  expect(() =>
    parseExternalExecute({
      version: 1,
      type: "execute",
      sessionId: "s",
      requestId: "r",
      argv0: "cat",
      args: [],
      cwd: "/work",
      tty: false,
      stdinMode: "fd",
    }),
  ).toThrow(/version/i);
});

test("raw_chunk is gateway-to-broker only after start", () => {
  expect(() =>
    parseGatewayToBroker(
      { type: "raw_chunk", requestId: "r", fd: 1, data: "eA==" },
      "awaiting_decision",
    ),
  ).toThrow(/state/i);
});
```

- [ ] **Step 2: Run the TypeScript test and confirm the red state**

Run:

```bash
bun test src/hostexec/gateway_protocol_test.ts
```

Expected: FAIL because the protocol module does not exist.

- [ ] **Step 3: Implement the TypeScript schemas and types**

Use strict Zod objects. Define these exact messages:

```ts
export type GatewayState =
  | "awaiting_decision"
  | "running"
  | "awaiting_result"
  | "terminal";

export interface ExternalExecuteRequestV2 {
  version: 2;
  type: "execute";
  sessionId: string;
  requestId: string;
  argv0: string;
  args: string[];
  cwd: string;
  tty: boolean;
  stdinMode: "fd" | "none";
}

export type GatewayToBrokerMessage =
  | { type: "execute"; request: ExternalExecuteRequestV2 }
  | { type: "spawned"; requestId: string; pid: number }
  | { type: "raw_chunk"; requestId: string; fd: 1 | 2; data: string }
  | { type: "process_exit"; requestId: string; exitCode: number }
  | { type: "cancelled"; requestId: string; reason: string }
  | { type: "transport_error"; requestId: string; message: string };

export type BrokerToGatewayMessage =
  | { type: "fallback"; requestId: string }
  | { type: "error"; requestId: string; message: string }
  | {
      type: "start";
      requestId: string;
      argv0: string;
      args: string[];
      cwd: string;
      env: Record<string, string>;
    }
  | { type: "masked_chunk"; requestId: string; fd: 1 | 2; data: string }
  | { type: "result"; requestId: string; exitCode: number }
  | { type: "kill"; requestId: string; signal: "SIGTERM" | "SIGKILL" };
```

`parseGatewayToBroker(value, state)` and `parseBrokerToGateway(value, state)` must perform schema and state/direction validation. Base64-decode chunk data solely to check that decoded length is at most 65,536; return the original base64 string.

- [ ] **Step 4: Add matching Zig parse/encode tests**

Import `gateway_protocol.zig` from the root Zig test block. Use the same JSON fixtures as the TypeScript tests for every message variant. Assert external request version `2`, `stdinMode`, 4 MiB line rejection, decoded chunk limit, and state rejection.

- [ ] **Step 5: Implement the Zig protocol module**

Keep allocation ownership explicit:

```zig
pub const max_control_bytes: usize = 4 * 1024 * 1024;
pub const max_chunk_bytes: usize = 64 * 1024;

pub const GatewayState = enum {
    awaiting_decision,
    running,
    awaiting_result,
    terminal,
};

pub const StdinMode = enum { fd, none };

pub const ExternalExecuteRequest = struct {
    version: u32,
    type: []const u8,
    sessionId: []const u8,
    requestId: []const u8,
    argv0: []const u8,
    args: []const []const u8,
    cwd: []const u8,
    tty: bool,
    stdinMode: StdinMode,
};
```

Expose `parseExternalExecute`, `parseGatewayToBroker`, `parseBrokerToGateway`, and `stringifyMessage`. Each parse result owns its `std.json.Parsed(T)` and provides `deinit`; do not return slices into a destroyed parse tree.

- [ ] **Step 6: Run both protocol suites**

Run:

```bash
bun test src/hostexec/gateway_protocol_test.ts
cd src/hostexec/intercept && zig build test
```

Expected: both commands pass.

- [ ] **Step 7: Commit Task 2**

Use `git-commit`. Expected subject:

```text
feat(hostexec): define the FD gateway protocol
```

---

### Task 3: Delegated-stdin child executor

**Files:**
- Create: `src/hostexec/intercept/gateway_executor.zig`
- Modify: `src/hostexec/intercept/hostexec_intercept.zig`

**Interfaces:**
- Produces `spawn(allocator, ExecutionSpec, stdin_fd) !ChildHandle`
- Produces `ChildHandle.stdout_fd`, `stderr_fd`, `pid`, `pollExit()`, `wait()`, `terminateGroup(grace_ms)`, and `deinit()`
- Consumes the `start` execution fields from Task 2 without parsing protocol inside the executor

- [ ] **Step 1: Write failing executor tests**

Test with temporary executable scripts and pipes:

```zig
test "child that does not read delegated stdin leaves the pipe untouched" {
    // Write "payload" to the pipe, spawn /bin/true with the read end, wait,
    // then read "payload" from a duplicate of the original read end.
}

test "child consumes only the bytes it reads" {
    // Spawn a script that performs `dd bs=1 count=3`, then assert the sibling
    // descriptor still reads "load" from the original "payload".
}

test "terminateGroup kills a descendant that ignores SIGTERM" {
    // Spawn a script that starts a background child with a TERM trap, record
    // both PIDs, call terminateGroup, and assert kill(pid, 0) returns ESRCH.
}
```

Also cover `stdin_fd == null` producing EOF, missing executable, cwd failure, and environment replacement.

- [ ] **Step 2: Run Zig tests and confirm they fail**

Run `cd src/hostexec/intercept && zig build test`.

Expected: FAIL because `gateway_executor.zig` is not implemented.

- [ ] **Step 3: Implement `ChildHandle` using a per-request single-threaded handler**

Use `std.process.Child` for argv/cwd/env, stdout/stderr pipes, and process-group creation. To give it an arbitrary stdin descriptor safely:

```zig
try std.posix.dup2(stdin_fd, std.posix.STDIN_FILENO);
var child = std.process.Child.init(spec.argv, allocator);
child.cwd = spec.cwd;
child.env_map = &spec.env;
child.stdin_behavior = .Inherit;
child.stdout_behavior = .Pipe;
child.stderr_behavior = .Pipe;
child.pgid = 0;
try child.spawn();
std.posix.close(std.posix.STDIN_FILENO);
```

This code runs only inside the gateway's forked per-request handler, never in the listener process, so temporarily replacing handler fd 0 cannot race another request. For `stdin_fd == null`, set `.stdin_behavior = .Ignore` instead. Transfer stdout/stderr `File` ownership into `ChildHandle` and make all cleanup idempotent.

`terminateGroup` sends `SIGTERM` to `-pgid`, polls `waitpid(WNOHANG)` until the configured deadline, then sends `SIGKILL` and reaps the child. It must tolerate an already-exited group.

- [ ] **Step 4: Run Zig tests and check for leaked processes**

Run:

```bash
cd src/hostexec/intercept
zig build test
```

Expected: PASS. The descendant PID assertions prove cleanup rather than relying only on test-process exit.

- [ ] **Step 5: Commit Task 3**

Use `git-commit`. Expected subject:

```text
feat(hostexec): execute commands with delegated stdin
```

---

### Task 4: Per-session Zig gateway daemon

**Files:**
- Create: `src/hostexec/intercept/gateway_main.zig`
- Modify: `src/hostexec/intercept/build.zig`
- Modify: `src/hostexec/intercept/hostexec_intercept.zig`

**Interfaces:**
- Produces binary `zig-out/bin/nas-hostexec-gateway`
- CLI: `nas-hostexec-gateway --session-id ID --external-socket PATH --internal-socket PATH`
- Stdout readiness line: `{"type":"ready","version":2,"socket":"PATH"}\n`
- Uses Task 1 to receive the external request/FD and Task 2 for all protocol parsing
- Uses Task 3 only after receiving `start`

- [ ] **Step 1: Add a failing gateway integration test in Zig**

The test starts a mock internal Unix server and the gateway main loop in a child process. It then:

1. sends an external v2 request plus a pipe read descriptor;
2. verifies the mock broker receives `execute` without an FD or stdin bytes;
3. sends `start` for a no-read executable;
4. observes `spawned` and `process_exit`;
5. sends `result`;
6. verifies the external client receives `result`; and
7. verifies the original pipe still contains `payload`.

Add separate tests for pre-start fallback, post-start fallback rejection, raw-to-masked directionality, session mismatch, external disconnect cleanup, and internal disconnect cleanup.

- [ ] **Step 2: Add the executable target and confirm the red state**

Add a static musl executable in `build.zig`:

```zig
const gateway_mod = b.createModule(.{
    .root_source_file = b.path("gateway_main.zig"),
    .target = client_target,
    .optimize = optimize,
    .link_libc = true,
});
const gateway = b.addExecutable(.{
    .name = "nas-hostexec-gateway",
    .root_module = gateway_mod,
});
gateway.linkage = .static;
b.installArtifact(gateway);
```

Run `cd src/hostexec/intercept && zig build test`.

Expected: FAIL because the gateway loop and CLI are missing.

- [ ] **Step 3: Implement listener and one handler process per request**

The parent process performs only argument parsing, stale-socket removal, bind/listen, readiness output, accept, fork, and child reaping. For each accepted connection:

- parent forks;
- parent closes the accepted socket and continues accepting;
- handler closes the listener, receives and validates one external line/FD, connects to the internal socket, and runs one request state machine;
- handler exits after its terminal response and closes every owned fd.

Install SIGTERM/SIGINT handling in the parent. On shutdown, stop accepting, signal all handler process groups, reap them, and remove the external socket.

- [ ] **Step 4: Implement the handler state machine**

Use an explicit enum and reject messages not legal in the current state:

```zig
const HandlerState = enum {
    awaiting_decision,
    running,
    awaiting_result,
    terminal,
};
```

Required transitions:

```text
awaiting_decision + fallback/error -> terminal
awaiting_decision + start          -> running
running + masked_chunk             -> running (forward as external chunk)
running + kill                     -> running (signal process group)
running + child exit + raw EOF     -> awaiting_result
awaiting_result + masked_chunk     -> awaiting_result
awaiting_result + result/error     -> terminal
any post-start fallback            -> kill + terminal protocol error
```

While running, poll the internal socket, external socket hangup, child stdout, and child stderr. Send `raw_chunk` only to the internal socket. Forward only `masked_chunk`, converted to external `chunk`, to the external socket.

- [ ] **Step 5: Run gateway and complete Zig tests**

Run:

```bash
cd src/hostexec/intercept
zig build
zig build test
file zig-out/bin/nas-hostexec-gateway
```

Expected: build and tests pass; `file` reports a statically linked executable.

- [ ] **Step 6: Commit Task 4**

Use `git-commit`. Expected subject:

```text
feat(hostexec): add a per-session exec gateway
```

---

### Task 5: TypeScript gateway execution and broker integration

**Files:**
- Create: `src/hostexec/gateway_execution.ts`
- Create: `src/hostexec/gateway_execution_test.ts`
- Modify: `src/hostexec/types.ts`
- Modify: `src/hostexec/broker.ts`
- Modify: `src/hostexec/broker_test.ts`
- Modify: `src/hostexec/broker_integration_test.ts`

**Interfaces:**
- Produces `runGatewayExecution(options: GatewayExecutionOptions): Promise<void>`
- Changes `HostExecBroker.start(internalSocketPath, controlSocketPath)` so the broker never listens on the container-visible external socket
- Changes pending waiters to retain an internal gateway socket
- Removes broker-side host-command `Bun.spawn`; only mask-filter subprocesses remain in TypeScript

- [ ] **Step 1: Write failing `runGatewayExecution` tests**

Use a Unix socket pair or temporary server and send realistic gateway messages. Test identity mode without mask config first:

```ts
await writeJsonLine(gatewaySocket, {
  type: "spawned",
  requestId: "r1",
  pid: process.pid,
});
await writeJsonLine(gatewaySocket, {
  type: "raw_chunk",
  requestId: "r1",
  fd: 1,
  data: Buffer.from("hello").toString("base64"),
});
await writeJsonLine(gatewaySocket, {
  type: "process_exit",
  requestId: "r1",
  exitCode: 7,
});
```

Assert the broker side first sends `start`, converts raw bytes into `masked_chunk`, and sends `result` only after `process_exit`. Add tests for separate fd 1/2 streams, split-secret masking, mask-filter non-zero exit, `cancelled`, request-ID mismatch, unknown message, and disconnect before terminal state.

- [ ] **Step 2: Run the new TypeScript test and confirm the red state**

Run `bun test src/hostexec/gateway_execution_test.ts`.

Expected: FAIL because `runGatewayExecution` does not exist.

- [ ] **Step 3: Implement gateway execution orchestration**

Define:

```ts
export interface GatewayExecutionOptions {
  readonly socket: Socket;
  readonly requestId: string;
  readonly start: Extract<BrokerToGatewayMessage, { type: "start" }>;
  readonly maskFilter?: MaskFilterConfig;
  readonly onSpawned: (pid: number) => Promise<void>;
}

export async function runGatewayExecution(
  options: GatewayExecutionOptions,
): Promise<void>;
```

The function sends `start`, creates one mask pipeline per fd, reads validated gateway messages, and feeds raw bytes to the corresponding filter. With no mask config, use an identity pipeline owned by TypeScript that still emits `masked_chunk`; do not ask the gateway to forward raw messages. On `process_exit`, close both filter inputs, await both filtered outputs and filter exit codes, then send `result`. On any error, send `kill` if the command was spawned, stop filters, and throw so the broker emits a terminal `error`.

- [ ] **Step 4: Change the external request type to version 2**

Replace the old `stdin?: string` field:

```ts
export interface ExecuteRequest {
  version: 2;
  type: "execute";
  sessionId: string;
  requestId: string;
  argv0: string;
  args: string[];
  cwd: string;
  tty: boolean;
  stdinMode: "fd" | "none";
}
```

Update TypeScript request fixtures to include `stdinMode`. Do not add a v1 union.

- [ ] **Step 5: Refactor HostExecBroker to the internal gateway channel**

Change `start()` to listen on `internalSocketPath` plus `controlSocketPath`. The internal connection's first message must validate as `{ type: "execute", request }`; the control channel contract remains unchanged.

Replace `runResolved` with a method that computes the same command argv0 and resolved env, then calls:

```ts
await runGatewayExecution({
  socket,
  requestId: request.requestId,
  start: {
    type: "start",
    requestId: request.requestId,
    argv0: commandArgv0,
    args: request.args,
    cwd: resolved.cwd,
    env: resolved.envVars,
  },
  maskFilter: this.maskFilter,
  onSpawned: async (pid) => {
    const processIdentity = await readProcessIdentity(pid);
    await this.diagnostics.record("command_spawned", {
      requestId: request.requestId,
      command: commandArgv0,
      argumentCount: request.args.length,
      process: processIdentity,
    });
  },
});
```

Delete request-stdin base64 decoding and direct host-command `Bun.spawn`. Keep mask-filter spawning in `gateway_execution.ts`. Pending approval stores the internal socket, so approval resumes by sending `start` over the same connection.

- [ ] **Step 6: Update broker integration tests to act as a fake gateway**

Every execute test connects to the internal socket and sends `{ type: "execute", request }`. For allow cases, read `start`, spawn or simulate raw messages, and assert masked responses. Fallback and deny cases must receive terminal decisions without a `start`. Preserve all control-socket self-approval tests.

- [ ] **Step 7: Run broker and type checks**

Run:

```bash
bun test src/hostexec/gateway_protocol_test.ts src/hostexec/gateway_execution_test.ts src/hostexec/broker_test.ts src/hostexec/broker_integration_test.ts
bun run check
```

Expected: all selected tests and strict type checking pass.

- [ ] **Step 8: Commit Task 5**

Use `git-commit`. Expected subject:

```text
refactor(hostexec): route approved execution through the gateway
```

---

### Task 6: Wire the session stack and remove eager stdin capture

**Files:**
- Create: `src/hostexec/gateway_test_harness.ts`
- Create: `src/hostexec/fd_gateway_integration_test.ts`
- Modify: `src/hostexec/intercept/protocol.zig`
- Modify: `src/hostexec/intercept/client_main.zig`
- Modify: `src/hostexec/intercept/hostexec_intercept.zig`
- Modify: `src/hostexec/client_integration_test.ts`
- Modify: `src/hostexec/intercept_integration_test.ts`
- Modify: `src/hostexec/registry.ts`
- Modify: `src/hostexec/intercept_path.ts`
- Modify: `src/hostexec/intercept_path_test.ts`
- Modify: `src/pipeline/host_env.ts`
- Modify: `src/pipeline/types.ts`
- Modify: every `ProbeResults` fixture reported by `rg -l 'hostexecClientPath' src --glob '*_test.ts'`
- Modify: `src/stages/hostexec/broker_service.ts`
- Modify: `src/stages/hostexec/stage.ts`
- Modify: `src/stages/hostexec/stage_test.ts`

**Interfaces:**
- Produces probe field `hostexecGatewayPath: string | null`
- Produces `hostExecInternalSocketPath(paths, sessionId): string`
- Extends `HostExecBrokerConfig` with `gatewayBinaryPath` and `internalSocketPath`
- `HostExecBrokerService.start` starts the TypeScript broker first, then the gateway, and returns only after the gateway readiness line
- `protocol.callBroker` sends v2 plus optional fd and contains no eager stdin read path

- [ ] **Step 1: Write the two failing exact-semantics regressions**

The test harness builds artifacts once, starts a real gateway, and supplies a mock internal broker that returns a `start` spec. Add both cases:

```ts
test.skipIf(!artifacts)(
  "bare hostexec leaves unread stdin for the next command",
  async () => {
    const result = await runBareShell(
      `printf payload | { intercepted-no-read; cat; }`,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("payload");
  },
);

test.skipIf(!artifacts)(
  "LD_PRELOAD hostexec leaves unread stdin for the next command",
  async () => {
    const result = await runInterceptedShell(
      `printf payload | { '${interceptedNoReadPath}'; cat; }`,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("payload");
  },
);
```

The host execution spec must run a no-read executable such as `true`; the local fallback binary must be distinct so an accidental fallback fails the assertion.

- [ ] **Step 2: Run regressions and confirm the red state**

Run `bun test src/hostexec/fd_gateway_integration_test.ts`.

Expected: FAIL because the current clients send v1 snapshots and the runtime stack does not start the gateway.

- [ ] **Step 3: Add gateway artifact and internal socket probes**

Add:

```ts
export const HOSTEXEC_GATEWAY_BINARY_NAME = "nas-hostexec-gateway";

export async function resolveHostExecGatewayPath(opts?: {
  assetDir?: string;
}): Promise<string | null> {
  return resolveAssetBinary(
    "hostexec/nas-hostexec-gateway",
    import.meta.url,
    "./intercept/zig-out/bin/nas-hostexec-gateway",
    opts,
  );
}
```

Add `hostexecGatewayPath` to `ProbeResults`, resolve it in `resolveProbes`, and update every fixture with either a fake path or `null`. Add a pure registry helper returning `path.join(hostExecSessionBrokerDir(paths, sessionId), "gateway.sock")`; this path must never appear in container mounts or env.

- [ ] **Step 4: Make the HostExecBrokerService stack fakeable and ordered**

Introduce file-private Ops for the composed start/close workflow. The D2 orchestration must call only injected operations:

```ts
export interface HostExecStackOpsShape {
  startBroker(config: HostExecBrokerConfig): Effect.Effect<HostExecBroker>;
  spawnGateway(config: HostExecBrokerConfig): Effect.Effect<GatewayProcess>;
  awaitGatewayReady(process: GatewayProcess): Effect.Effect<void>;
  writeRegistry(config: HostExecBrokerConfig): Effect.Effect<void>;
  stopGateway(process: GatewayProcess): Effect.Effect<void>;
  closeBroker(broker: HostExecBroker): Effect.Effect<void>;
  removeRegistry(config: HostExecBrokerConfig): Effect.Effect<void>;
  removePending(config: HostExecBrokerConfig): Effect.Effect<void>;
}
```

Unit-test these sequences with fake Ops:

```text
startBroker -> spawnGateway -> awaitGatewayReady -> writeRegistry
close: stopGateway -> closeBroker -> removeRegistry -> removePending
gateway readiness failure rollback: stopGateway -> closeBroker
registry failure rollback: stopGateway -> closeBroker
```

Each Live Ops method is a D1 wrapper around one intentful primitive. `spawnGateway` uses:

```ts
Bun.spawn([
  config.gatewayBinaryPath,
  "--session-id", config.sessionId,
  "--external-socket", config.execSocketPath,
  "--internal-socket", config.internalSocketPath,
], {
  stdin: "ignore",
  stdout: "pipe",
  stderr: "inherit",
});
```

`awaitGatewayReady` reads one bounded JSON line with a timeout and verifies version, session socket, and child liveness. Never treat socket-file existence alone as readiness.

- [ ] **Step 5: Wire the pure stage plan**

Require `input.probes.hostexecGatewayPath`; if absent, throw an actionable build/reinstall error. Add `gatewayBinaryPath` and `internalSocketPath` to the broker plan/config. Keep the existing external exec directory as the only socket mount and assert the internal path is absent from `mounts`, `dockerArgs`, and `envVars`.

- [ ] **Step 6: Replace the eager request path in `protocol.zig`**

Delete `stdin_read_size`, both wait constants, `readAvailableStdin`, `readAvailableFd`, base64 stdin request fields, consumed-stdin fallback suppression, and their tests.

Build request v2 with `stdinMode`. Before connecting:

```zig
const selection = fd_transport.selectStdin(0, stdin_capable);
const stdin_fd: ?std.posix.fd_t = switch (selection) {
    .none => null,
    .pass_fd => |fd| fd,
    .reject_read_write => {
        writeAll(2, "nas hostexec: refusing read-write stdin because it can bypass output masking\n");
        return .{ .exit_code = 1, .outcome = .failed };
    },
};
const stdin_mode: gateway_protocol.StdinMode = if (stdin_fd == null) .none else .fd;
const request_json = try buildRequestV2(..., stdin_mode);
try fd_transport.sendLine(sock.handle, request_json, stdin_fd);
```

`sendLine` replaces `sock.writeAll(request_json)`. Explicit pre-start fallback no longer checks consumed stdin; output-written suppression remains unchanged.

- [ ] **Step 7: Update existing client/interceptor suites to use a real gateway**

Node's `net.Server` cannot receive `SCM_RIGHTS`, so both integration suites must put the real gateway between the client and their mock internal broker. Reuse `gateway_test_harness.ts`; do not silently skip individual assertions. Preserve the existing top-level Zig build and diagnostic skip pattern.

- [ ] **Step 8: Run the core integration and unit suites**

Run:

```bash
bun test \
  src/hostexec/fd_gateway_integration_test.ts \
  src/hostexec/client_integration_test.ts \
  src/hostexec/intercept_integration_test.ts \
  src/hostexec/broker_integration_test.ts \
  src/stages/hostexec/stage_test.ts \
  src/pipeline/host_env_integration_test.ts
cd src/hostexec/intercept && zig build test
bun run check
```

Expected: all selected tests and checks pass. The no-read regressions must report `payload`, not an empty string.

- [ ] **Step 9: Commit Task 6**

Use `git-commit`. Expected subject:

```text
feat(hostexec): preserve stdin through delegated execution
```

---

### Task 7: Complete failure, backpressure, masking, and cleanup coverage

**Files:**
- Modify: `src/hostexec/fd_gateway_integration_test.ts`
- Modify: `src/hostexec/gateway_execution_test.ts`
- Modify: `src/hostexec/client_integration_test.ts`
- Modify: `src/hostexec/intercept_integration_test.ts`
- Modify: `src/stages/hostexec/broker_service.ts`
- Modify: `src/stages/hostexec/stage_test.ts`

**Interfaces:**
- No new public production interfaces unless a failing acceptance test exposes a missing cleanup operation
- Completes every host-native acceptance case from the spec

- [ ] **Step 1: Add partial-read and slow-producer regressions**

Use a host command that reads exactly three bytes and a shell-side trailing `cat`; assert `payload` becomes `payload` across the combined outputs without duplication or loss. Add a producer that writes `a`, waits at least 400 ms, then writes `b`; the host `cat` must output `ab`.

- [ ] **Step 2: Add a bounded-memory/backpressure regression**

Send at least 16 MiB through a slow host consumer while sampling client and gateway RSS from `/proc/<pid>/status`. Assert output hash and byte count, and assert neither process grows by the full payload size. Use a generous fixed ceiling documented in the test so allocator noise does not make it flaky.

- [ ] **Step 3: Add fallback and approval-wait regressions**

- explicit broker fallback runs the distinct local binary and preserves the complete stdin;
- before an approval is issued, a nonblocking duplicate of the pipe read end still observes the original first byte;
- after approval, the host child consumes the data normally.

- [ ] **Step 4: Add security and transport failure regressions**

- `O_RDWR` socketpair exits non-zero with the masking-bypass diagnostic, sends no request, and runs no local binary;
- missing gateway socket and internal broker disconnect leave stdin unread but fail-closed;
- `start` followed by `fallback` kills the child and returns a protocol error;
- mismatched request IDs and oversized messages close the connection and leak no FD.

- [ ] **Step 5: Add masking and lifecycle regressions**

- a secret split across multiple raw chunks is never visible externally and appears only masked;
- corrupt/missing mask frame produces terminal failure even when the host command exits zero;
- external client disconnect kills a descendant that ignores SIGTERM;
- session service close while approval is pending removes the waiter, gateway handler, received FD, sockets, and pending entry;
- unexpected gateway exit does not leave mask-filter processes running.

- [ ] **Step 6: Run all hostexec tests repeatedly**

Run:

```bash
for i in 1 2 3; do
  bun test src/hostexec/ src/stages/hostexec/
done
cd src/hostexec/intercept && zig build test
```

Expected: all three Bun runs and Zig tests pass with no intermittent timeout or leaked-process failures.

- [ ] **Step 7: Commit Task 7**

Use `git-commit`. Expected subject:

```text
test(hostexec): cover FD gateway failure boundaries
```

---

### Task 8: Docker proof, packaging, CI, and final verification

**Files:**
- Create: `src/hostexec/gateway_docker_integration_test.ts`
- Modify: `src/hostexec/intercept_dev_build.ts`
- Modify: `flake.nix`
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/todo/security.md`

**Interfaces:**
- Nix hostexec derivation installs `bin/nas-hostexec-gateway`
- nas asset bundle contains `hostexec/nas-hostexec-gateway`
- CI executes Zig tests plus Docker-free gateway integrations

- [ ] **Step 1: Add the Docker namespace proof**

Guard on Docker availability and clean every container/temp directory in `finally`. Start the gateway on the host, bind-mount only the external exec socket directory and static client into a minimal Linux container, then run:

```sh
printf payload | nas-hostexec-client-backed-cat
```

The mock internal broker returns a `start` spec for host `cat`. Assert the container receives `payload`. Also inspect container mounts and assert the internal gateway/broker socket and control socket paths are absent.

- [ ] **Step 2: Update dev-build and artifact diagnostics**

`buildInterceptArtifactsForDev()` already runs one `zig build`; extend its comments and resolver assertions so client, interceptor, and gateway are resolved together. Add a gateway-specific diagnostic test that passes only when the artifact is absent and tells the developer to run `cd src/hostexec/intercept && zig build`.

- [ ] **Step 3: Package the gateway in Nix**

Install and copy the new binary:

```nix
installPhase = ''
  mkdir -p $out/lib $out/bin
  cp zig-out/lib/libhostexec_intercept.so $out/lib/hostexec_intercept.so
  cp zig-out/bin/nas-hostexec-client $out/bin/
  cp zig-out/bin/nas-hostexec-gateway $out/bin/
'';
```

Add `${hostexecIntercept}/bin/nas-hostexec-gateway` to `$out/hostexec/` beside the existing client. Update the security todo entry so it describes the static client plus per-session gateway rather than only the client.

- [ ] **Step 4: Add Docker-free PR checks**

Add CI steps after unit tests:

```yaml
- name: Hostexec Zig tests
  run: nix develop -c bash -lc 'cd src/hostexec/intercept && zig build test'

- name: Hostexec native integration
  run: >-
    nix develop -c bun test
    src/hostexec/fd_gateway_integration_test.ts
    src/hostexec/client_integration_test.ts
    src/hostexec/intercept_integration_test.ts
```

Do not put the Docker integration in the PR job unless the workflow gains an explicit Docker service/cache budget.

- [ ] **Step 5: Run complete verification**

Run in this order:

```bash
bun run fmt
bun run lint
bun run lint:composed-effects
bun run check
bun test
cd src/hostexec/intercept && zig build && zig build test
nix build 'path:.#default' --no-link
```

Then run the Docker test when Docker is available:

```bash
bun test src/hostexec/gateway_docker_integration_test.ts
```

Expected: format/lint/type checks pass; all available Bun/Zig tests pass; the path flake build contains all uncommitted files; Docker proof passes or is reported as an explicit skip.

- [ ] **Step 6: Commit Task 8**

Use `git-commit`. Expected subject:

```text
build(hostexec): package and verify the FD gateway
```

---

## Final Acceptance Checklist

- [ ] `printf payload | { intercepted-no-read; cat; }` prints `payload` through both bare and LD_PRELOAD interception.
- [ ] Client and gateway never read delegated stdin; only the approved host child does.
- [ ] Explicit pre-start fallback preserves stdin and all other failures remain fail-closed.
- [ ] Non-TTY `O_RDWR` stdin is rejected before any broker request or local execution.
- [ ] Container mounts expose neither the internal gateway/broker socket nor the control socket.
- [ ] Raw host output cannot reach the external client without TypeScript broker masking.
- [ ] Approval wait, disconnect, shutdown, filter failure, and descendant cleanup leave no process, FD, socket, or pending-entry leak.
- [ ] Gateway artifact is built, probed, packaged, and exercised in Docker-free PR CI.
- [ ] Full Bun, Zig, type, lint, composed-effect, Nix, and available Docker checks pass.
