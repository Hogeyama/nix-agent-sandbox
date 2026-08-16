// protocol.zig — hostexec broker client protocol, shared by both container-side
// clients.
//
// There are two ways a command inside the container reaches the broker:
//
//   * `hostexec_intercept.zig` — an LD_PRELOAD shared library that hooks the
//     exec family, used for rules whose argv0 is a relative or absolute path.
//   * `client_main.zig` — a standalone executable that the wrapper directory's
//     symlinks point at, used for rules whose argv0 is a bare command name and
//     which are therefore caught via PATH.
//
// The two interception *mechanisms* cannot be merged: LD_PRELOAD cannot see a
// statically linked caller that issues execve as a raw syscall (any pure-Go
// program), and a PATH symlink cannot see a command invoked by absolute path.
// Everything downstream of "we decided to intercept" is identical, though, and
// lives here — so a fix to the request shape, the stdin policy, or the fallback
// rules lands once instead of twice.
//
// Environment variables consumed:
//   NAS_HOSTEXEC_SOCKET           – path to the broker's Unix domain socket
//   NAS_HOSTEXEC_SESSION_ID       – session identifier sent in every request
//   NAS_HOSTEXEC_INTERCEPT_DEBUG  – if set, emit debug messages to stderr

const std = @import("std");
const linux = std.os.linux;
const json = std.json;
const base64_mod = std.base64.standard;
const Allocator = std.mem.Allocator;
const fd_transport = @import("fd_transport.zig");
const gateway_protocol = @import("gateway_protocol.zig");

// ─── Debug logging ──────────────────────────────────────────────────

const DebugFlag = enum(u8) { unknown = 0, enabled = 1, disabled = 2 };

/// Cached debug flag, atomically accessed for thread safety in LD_PRELOAD context.
var debug_flag_cache: std.atomic.Value(DebugFlag) = std.atomic.Value(DebugFlag).init(.unknown);

pub fn debugEnabled() bool {
    const cached = debug_flag_cache.load(.acquire);
    if (cached != .unknown) return cached == .enabled;
    const val = std.posix.getenv("NAS_HOSTEXEC_INTERCEPT_DEBUG") orelse "";
    const flag: DebugFlag = if (val.len > 0) .enabled else .disabled;
    debug_flag_cache.store(flag, .release);
    return flag == .enabled;
}

pub fn debugLog(comptime fmt: []const u8, args: anytype) void {
    if (!debugEnabled()) return;
    std.debug.print("[hostexec-intercept] " ++ fmt ++ "\n", args);
}

// ─── JSON protocol ──────────────────────────────────────────────────

/// JSON request structure matching the gateway's external ExecuteRequestV2.
const ExecuteRequest = struct {
    version: u32 = 2,
    type: []const u8 = "execute",
    sessionId: []const u8,
    requestId: []const u8,
    argv0: []const u8,
    args: []const []const u8,
    cwd: []const u8,
    tty: bool = false,
    stdinMode: gateway_protocol.StdinMode,
};

/// Build a JSON request string for the broker, terminated with newline.
///
pub fn buildRequest(
    alloc: Allocator,
    session_id: []const u8,
    request_id: []const u8,
    argv0: []const u8,
    args: []const []const u8,
    cwd: []const u8,
    tty: bool,
    stdin_mode: gateway_protocol.StdinMode,
) ![]const u8 {
    const req = ExecuteRequest{
        .sessionId = session_id,
        .requestId = request_id,
        .argv0 = argv0,
        .args = args,
        .cwd = cwd,
        .tty = tty,
        .stdinMode = stdin_mode,
    };

    const json_bytes = try json.Stringify.valueAlloc(alloc, req, .{
        .emit_null_optional_fields = false,
    });
    defer alloc.free(json_bytes);

    // Append newline
    const result = try alloc.alloc(u8, json_bytes.len + 1);
    @memcpy(result[0..json_bytes.len], json_bytes);
    result[json_bytes.len] = '\n';
    return result;
}

/// Parsed broker response.
///
/// Ownership: `data_b64` and `message` are heap-allocated (via the allocator
/// passed to `parseResponse`) only for `.chunk` and `.error` responses
/// respectively. The caller is responsible for freeing each whenever
/// `.len > 0`.
pub const BrokerResponse = struct {
    response_type: ResponseType,
    exit_code: i32,
    data_b64: []const u8,
    fd: i32,
    /// The broker's human-readable reason on an `error` response — "permission
    /// denied by hostexec policy", an integrity failure, and so on. It is the
    /// only explanation the user gets, so it must reach stderr.
    message: []const u8,

    pub const ResponseType = enum { result, chunk, fallback, @"error", unknown };
};

/// Parse a JSON response line from the broker.
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
    var message: []const u8 = "";

    if (response_type == .@"error") {
        if (root.object.get("message")) |m| {
            switch (m) {
                .string => |str| {
                    message = try alloc.dupe(u8, str);
                },
                else => {},
            }
        }
    }

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
        .message = message,
    };
}

// ─── Base64 decode helper ───────────────────────────────────────────

pub fn decodeBase64(alloc: Allocator, encoded: []const u8) ![]const u8 {
    if (encoded.len == 0) return try alloc.dupe(u8, "");
    const decoded_len = base64_mod.Decoder.calcSizeForSlice(encoded) catch {
        debugLog("base64 calcSize failed for input length {d}", .{encoded.len});
        return try alloc.dupe(u8, "");
    };
    const buf = try alloc.alloc(u8, decoded_len);
    base64_mod.Decoder.decode(buf, encoded) catch {
        debugLog("base64 decode failed for input length {d}", .{encoded.len});
        alloc.free(buf);
        return try alloc.dupe(u8, "");
    };
    return buf;
}

// ─── Generate request ID ────────────────────────────────────────────

fn generateRequestId(buf: *[36]u8) []const u8 {
    var random_bytes: [16]u8 = undefined;
    std.crypto.random.bytes(&random_bytes);
    const encoded = std.fmt.bytesToHex(random_bytes, .lower);
    @memcpy(buf[0..encoded.len], encoded[0..]);
    return buf[0..encoded.len];
}

// ─── Broker communication ───────────────────────────────────────────

pub const BrokerCallResult = struct {
    exit_code: i32,
    outcome: Outcome,

    /// What the caller must do next. A boolean "should fall back" cannot
    /// express this: running the command locally is right when hostexec simply
    /// is not in play, and wrong when the broker was supposed to handle it and
    /// something went wrong — those two used to collapse into the same answer,
    /// which made a dead broker silently run the command in the container,
    /// after this process had already drained its stdin.
    pub const Outcome = enum {
        /// The broker ran the command. `exit_code` is the command's own.
        completed,
        /// Run the command locally: the broker said no rule matched and
        /// nothing has been consumed yet.
        fallback,
        /// Do not run the command locally — exit with `exit_code`. The reason
        /// has already been written to stderr.
        failed,
    };
};

pub fn collectArgv(alloc: Allocator, argv: [*:null]const ?[*:0]const u8) ![]const []const u8 {
    // Count args first
    var count: usize = 0;
    while (true) : (count += 1) {
        if (argv[count] == null) break;
    }

    const list = try alloc.alloc([]const u8, count);
    for (0..count) |i| {
        list[i] = std.mem.span(argv[i].?);
    }
    return list;
}

/// `stdin_capable`: whether the calling client owns fd 0 on behalf of the
/// command being run. The standalone client and the LD_PRELOAD hooks for
/// execve/execv/execvp/execvpe pass true — the calling process image *becomes*
/// the command, so fd 0 legitimately is its stdin. posix_spawn/posix_spawnp
/// pass false: `posixSpawnViaBroker` ignores `file_actions` and forks, so the
/// child's fd 0 is really the *caller's*, and the caller keeps running (and
/// may read fd 0 itself) after the spawn returns. Passing its fd here would
/// give the host child input owned by a process that continues running.
pub fn callBroker(
    pathname: [*:0]const u8,
    argv: [*:null]const ?[*:0]const u8,
    stdin_capable: bool,
) BrokerCallResult {
    const alloc = std.heap.c_allocator;

    // Reaching either client means hostexec is active: the standalone binary is
    // only entered through a wrapper symlink, and the shared library calls this
    // function only after an intercept-path match. Missing routing metadata is
    // therefore a broken/stripped environment, not permission to bypass the
    // broker and execute the command locally.
    const socket_path = std.posix.getenv("NAS_HOSTEXEC_SOCKET") orelse {
        writeAll(std.posix.STDERR_FILENO, "nas hostexec: broker environment is incomplete (NAS_HOSTEXEC_SOCKET is not set); refusing to run the command locally\n");
        return .{ .exit_code = 1, .outcome = .failed };
    };
    const session_id = std.posix.getenv("NAS_HOSTEXEC_SESSION_ID") orelse {
        writeAll(std.posix.STDERR_FILENO, "nas hostexec: broker environment is incomplete (NAS_HOSTEXEC_SESSION_ID is not set); refusing to run the command locally\n");
        return .{ .exit_code = 1, .outcome = .failed };
    };

    return callBrokerInner(alloc, socket_path, session_id, pathname, argv, stdin_capable) catch |err| {
        // Everything from here on is a broker that was configured but could not
        // be reached or spoke nonsense. Running the command locally would be
        // fail-open — the command was configured to go through the broker, and
        // transport/protocol failures must not silently bypass its policy.
        // The delegated stdin descriptor remains untouched on this path, but
        // there is still no safe way to execute a host-requested command
        // locally after the gateway exchange fails.
        debugLog("broker communication failed: {s}", .{@errorName(err)});
        writeAll(std.posix.STDERR_FILENO, "nas hostexec: cannot reach the broker (");
        writeAll(std.posix.STDERR_FILENO, @errorName(err));
        writeAll(
            std.posix.STDERR_FILENO,
            "); refusing to run the command locally instead\n",
        );
        return .{ .exit_code = 1, .outcome = .failed };
    };
}

fn callBrokerInner(
    alloc: Allocator,
    socket_path: []const u8,
    session_id: []const u8,
    pathname: [*:0]const u8,
    argv: [*:null]const ?[*:0]const u8,
    stdin_capable: bool,
) !BrokerCallResult {
    // Collect argv (skip argv[0], use pathname as argv0)
    const all_args = try collectArgv(alloc, argv);
    defer alloc.free(all_args);

    const argv0 = std.mem.span(pathname);
    const args = if (all_args.len > 1) all_args[1..] else all_args[0..0];

    var cwd_buf: [std.fs.max_path_bytes]u8 = undefined;
    const cwd = std.posix.getcwd(&cwd_buf) catch "/";

    var req_id_buf: [36]u8 = undefined;
    const request_id = generateRequestId(&req_id_buf);

    // `prepareStdin`, not `selectStdin`: a read-write socket on fd 0 is the
    // ordinary shape for any child a libuv-based parent spawns with a piped
    // stdin, so closing its write direction here is what keeps those callers
    // working without handing the host command a channel back into the
    // container. Descriptors whose write direction cannot be closed stay
    // rejected.
    const stdin_fd: ?std.posix.fd_t = switch (fd_transport.prepareStdin(0, stdin_capable)) {
        .none => null,
        .pass_fd => |fd| fd,
        .reject_read_write => {
            writeAll(
                std.posix.STDERR_FILENO,
                "nas hostexec: refusing read-write stdin because it can bypass output masking\n",
            );
            return .{ .exit_code = 1, .outcome = .failed };
        },
        // A distinct reason: this descriptor is not refused for what a host
        // command could write through it, but because it is this process's own
        // output channel and cannot be made stdin-only without breaking that.
        .reject_output_alias => {
            writeAll(
                std.posix.STDERR_FILENO,
                "nas hostexec: refusing read-write stdin that is also stdout or stderr\n",
            );
            return .{ .exit_code = 1, .outcome = .failed };
        },
    };
    const stdin_mode: gateway_protocol.StdinMode = if (stdin_fd == null) .none else .fd;

    const request_json = try buildRequest(
        alloc,
        session_id,
        request_id,
        argv0,
        args,
        cwd,
        std.posix.isatty(0),
        stdin_mode,
    );
    defer alloc.free(request_json);

    debugLog("connecting to broker at {s}", .{socket_path});

    // Connect to Unix socket
    const sock = try std.net.connectUnixSocket(socket_path);
    defer sock.close();

    // Send the request line and, when supported, the still-open fd 0 in one
    // SCM_RIGHTS transport operation. The client never reads stdin itself.
    try fd_transport.sendLine(sock.handle, request_json, stdin_fd);

    // NDJSON streaming loop: the broker emits zero or more `chunk` lines
    // followed by a terminal `result` (or `fallback`/`error`) line.
    var buf: std.ArrayList(u8) = .{};
    defer buf.deinit(alloc);
    var read_buf: [4096]u8 = undefined;

    // Once any chunk has been written to stdout/stderr, we must never fall
    // back to the real binary — that would re-execute the command and
    // duplicate output/side effects. The delegated stdin fd is deliberately
    // not part of this decision: it remains unread until an approved host
    // command receives it, so a pre-start fallback can safely read fd 0. What a
    // fallback cannot do is write to a read-write fd 0, whose write direction
    // `prepareStdin` has closed by then. That costs nothing, because such an
    // fd 0 used to fail the request outright instead of reaching a fallback.
    var wrote_any_chunks: bool = false;

    while (true) {
        // Process all complete lines currently buffered.
        while (std.mem.indexOfScalar(u8, buf.items, '\n')) |nl_pos| {
            const line = buf.items[0..nl_pos];
            const response = parseResponse(alloc, line) catch |err| {
                debugLog("failed to parse broker response: {s}", .{@errorName(err)});
                return err;
            };

            // Shift buffer: drop the processed line plus its newline.
            // TODO: O(n²) — track a read offset instead of shifting on every line.
            const remaining = buf.items[nl_pos + 1 ..];
            std.mem.copyForwards(u8, buf.items[0..remaining.len], remaining);
            buf.items.len = remaining.len;

            switch (response.response_type) {
                .chunk => {
                    if (response.data_b64.len > 0) {
                        defer alloc.free(response.data_b64);
                        if (decodeBase64(alloc, response.data_b64)) |decoded| {
                            defer alloc.free(decoded);
                            if (decoded.len > 0) {
                                const target_fd: ?i32 = switch (response.fd) {
                                    1 => std.posix.STDOUT_FILENO,
                                    2 => std.posix.STDERR_FILENO,
                                    else => null,
                                };
                                if (target_fd) |fd| {
                                    writeAll(fd, decoded);
                                    wrote_any_chunks = true;
                                } else {
                                    debugLog("chunk with unexpected fd {d}, skipping write", .{response.fd});
                                }
                            }
                        } else |_| {}
                    }
                },
                .result => {
                    debugLog("received result: exitCode={d}", .{response.exit_code});
                    return .{ .exit_code = response.exit_code, .outcome = .completed };
                },
                .fallback => {
                    if (wrote_any_chunks) {
                        reportSuppressedFallback();
                        return .{ .exit_code = 1, .outcome = .failed };
                    }
                    debugLog("broker requested fallback", .{});
                    return .{ .exit_code = 0, .outcome = .fallback };
                },
                .@"error" => {
                    // An `error` response is the broker refusing: policy deny,
                    // user deny, or a failed integrity check. Falling back here
                    // would run the very command that was just denied, only
                    // inside the container instead of on the host -- so this
                    // never falls back, whatever was written so far.
                    defer if (response.message.len > 0) alloc.free(response.message);
                    writeAll(std.posix.STDERR_FILENO, "nas hostexec: ");
                    writeAll(std.posix.STDERR_FILENO, if (response.message.len > 0)
                        response.message
                    else
                        "request refused by broker");
                    writeAll(std.posix.STDERR_FILENO, "\n");
                    return .{ .exit_code = 1, .outcome = .failed };
                },
                .unknown => {
                    // The broker and both clients ship together, so an
                    // unrecognised response type is a protocol violation rather
                    // than version skew. Treating it as "run it locally" would
                    // be the same fail-open as an unreachable broker.
                    debugLog("unknown response type from broker", .{});
                    return error.UnknownResponseType;
                },
            }
        }

        // Read more data from the socket.
        const n = sock.read(&read_buf) catch |err| {
            debugLog("socket read failed: {s}", .{@errorName(err)});
            return err;
        };
        if (n == 0) break;
        try buf.appendSlice(alloc, read_buf[0..n]);
    }

    // The broker accepted the request and then went away without a terminal
    // line. Whether or not output was written, this is a broken exchange, not
    // permission to run the command locally.
    debugLog("broker connection closed without result", .{});
    return error.BrokerClosedWithoutResult;
}

/// Explain a fallback that could not be taken. Without this the command dies
/// with a bare exit 1 and no output at all, which is indistinguishable from
/// the command itself failing.
fn reportSuppressedFallback() void {
    const reason =
        "nas hostexec: no rule matched, but output was already written and the local command cannot be run again\n";
    debugLog("suppressing fallback: {s}", .{reason});
    writeAll(std.posix.STDERR_FILENO, reason);
}

pub fn writeAll(fd: i32, data: []const u8) void {
    var offset: usize = 0;
    while (offset < data.len) {
        const result = linux.write(@bitCast(fd), data[offset..].ptr, data[offset..].len);
        const errno = linux.E.init(result);
        if (errno == .INTR) continue;
        const signed: isize = @bitCast(result);
        if (signed <= 0) break;
        offset += @intCast(signed);
    }
}

pub fn doExit(exit_code: i32) noreturn {
    // Use linux syscall directly to avoid libc exit handlers
    const status: u8 = @truncate(@as(u32, @bitCast(exit_code)));
    std.posix.exit(status);
}

// ─── Unit tests ─────────────────────────────────────────────────────

test "generateRequestId: returns independent 128-bit lowercase hex ids" {
    var first_buf: [36]u8 = undefined;
    var second_buf: [36]u8 = undefined;
    const first = generateRequestId(&first_buf);
    const second = generateRequestId(&second_buf);

    try std.testing.expectEqual(@as(usize, 32), first.len);
    try std.testing.expectEqual(@as(usize, 32), second.len);
    for (first) |char| {
        try std.testing.expect(std.ascii.isDigit(char) or (char >= 'a' and char <= 'f'));
    }
    try std.testing.expect(!std.mem.eql(u8, first, second));
}

test "buildRequest: basic JSON" {
    const alloc = std.testing.allocator;
    const args = [_][]const u8{ "install", "hello" };
    const result = try buildRequest(alloc, "sess-123", "req-001", "/usr/bin/nix", &args, "/home/user", false, .none);
    defer alloc.free(result);

    // Parse it back to verify it's valid JSON
    const parsed = try json.parseFromSlice(json.Value, alloc, result, .{});
    defer parsed.deinit();

    const obj = parsed.value.object;
    try std.testing.expectEqualStrings("execute", obj.get("type").?.string);
    try std.testing.expectEqualStrings("sess-123", obj.get("sessionId").?.string);
    try std.testing.expectEqualStrings("req-001", obj.get("requestId").?.string);
    try std.testing.expectEqualStrings("/usr/bin/nix", obj.get("argv0").?.string);
    try std.testing.expectEqualStrings("/home/user", obj.get("cwd").?.string);
    try std.testing.expectEqual(false, obj.get("tty").?.bool);
    try std.testing.expectEqual(@as(i64, 2), obj.get("version").?.integer);
    try std.testing.expectEqualStrings("none", obj.get("stdinMode").?.string);

    const json_args = obj.get("args").?.array;
    try std.testing.expectEqual(@as(usize, 2), json_args.items.len);
    try std.testing.expectEqualStrings("install", json_args.items[0].string);
    try std.testing.expectEqualStrings("hello", json_args.items[1].string);
}

test "buildRequest: carries the tty flag" {
    const alloc = std.testing.allocator;
    const args = [_][]const u8{};
    const result = try buildRequest(alloc, "s", "r", "/bin/ls", &args, "/", true, .none);
    defer alloc.free(result);

    const parsed = try json.parseFromSlice(json.Value, alloc, result, .{});
    defer parsed.deinit();
    try std.testing.expectEqual(true, parsed.value.object.get("tty").?.bool);
}

test "buildRequest: carries delegated stdin mode" {
    const alloc = std.testing.allocator;
    const args = [_][]const u8{};
    const result = try buildRequest(alloc, "s", "r", "/bin/cat", &args, "/", false, .fd);
    defer alloc.free(result);

    const parsed = try json.parseFromSlice(json.Value, alloc, result, .{});
    defer parsed.deinit();
    try std.testing.expectEqualStrings("fd", parsed.value.object.get("stdinMode").?.string);
}

test "buildRequest: empty args" {
    const alloc = std.testing.allocator;
    const args = [_][]const u8{};
    const result = try buildRequest(alloc, "sess-1", "req-1", "/usr/bin/ls", &args, "/tmp", false, .none);
    defer alloc.free(result);

    const parsed = try json.parseFromSlice(json.Value, alloc, result, .{});
    defer parsed.deinit();

    const json_args = parsed.value.object.get("args").?.array;
    try std.testing.expectEqual(@as(usize, 0), json_args.items.len);
}

test "buildRequest: special characters in args" {
    const alloc = std.testing.allocator;
    const args = [_][]const u8{ "hello world", "foo\"bar", "a\nb" };
    const result = try buildRequest(alloc, "s", "r", "/bin/echo", &args, "/", false, .none);
    defer alloc.free(result);

    const parsed = try json.parseFromSlice(json.Value, alloc, result, .{});
    defer parsed.deinit();

    const json_args = parsed.value.object.get("args").?.array;
    try std.testing.expectEqual(@as(usize, 3), json_args.items.len);
    try std.testing.expectEqualStrings("hello world", json_args.items[0].string);
    try std.testing.expectEqualStrings("foo\"bar", json_args.items[1].string);
    try std.testing.expectEqualStrings("a\nb", json_args.items[2].string);
}

test "buildRequest: ends with newline" {
    const alloc = std.testing.allocator;
    const args = [_][]const u8{};
    const result = try buildRequest(alloc, "s", "r", "/bin/ls", &args, "/", false, .none);
    defer alloc.free(result);

    try std.testing.expect(result.len > 0);
    try std.testing.expectEqual(@as(u8, '\n'), result[result.len - 1]);
}

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

test "parseResponse: fallback type" {
    const alloc = std.testing.allocator;
    const input =
        \\{"type":"fallback","requestId":"r3"}
    ;
    const resp = try parseResponse(alloc, input);

    try std.testing.expectEqual(BrokerResponse.ResponseType.fallback, resp.response_type);
}

test "parseResponse: error type carries the broker's reason" {
    const alloc = std.testing.allocator;
    const input =
        \\{"type":"error","requestId":"r4","message":"permission denied by hostexec policy"}
    ;
    const resp = try parseResponse(alloc, input);
    defer if (resp.message.len > 0) alloc.free(resp.message);

    try std.testing.expectEqual(BrokerResponse.ResponseType.@"error", resp.response_type);
    // The reason is the only explanation the user gets for a denied command,
    // so it has to survive parsing rather than being dropped with the rest of
    // the response object.
    try std.testing.expectEqualStrings("permission denied by hostexec policy", resp.message);
}

test "parseResponse: error type without a message" {
    const alloc = std.testing.allocator;
    const resp = try parseResponse(alloc, "{\"type\":\"error\",\"requestId\":\"r5\"}");
    defer if (resp.message.len > 0) alloc.free(resp.message);

    try std.testing.expectEqual(BrokerResponse.ResponseType.@"error", resp.response_type);
    try std.testing.expectEqualStrings("", resp.message);
}

test "decodeBase64: standard string" {
    const alloc = std.testing.allocator;
    const decoded = try decodeBase64(alloc, "aGVsbG8gd29ybGQ=");
    defer alloc.free(decoded);

    try std.testing.expectEqualStrings("hello world", decoded);
}

test "decodeBase64: empty string" {
    const alloc = std.testing.allocator;
    const decoded = try decodeBase64(alloc, "");
    defer alloc.free(decoded);

    try std.testing.expectEqual(@as(usize, 0), decoded.len);
}

test "decodeBase64: simple" {
    const alloc = std.testing.allocator;
    const decoded = try decodeBase64(alloc, "Zm9v");
    defer alloc.free(decoded);

    try std.testing.expectEqualStrings("foo", decoded);
}

test "collectArgv: multiple arguments" {
    const alloc = std.testing.allocator;
    const arg0: [*:0]const u8 = "/usr/bin/nix";
    const arg1: [*:0]const u8 = "build";
    const arg2: [*:0]const u8 = "--no-link";
    const argv_array: [:null]const ?[*:0]const u8 = &.{ arg0, arg1, arg2 };

    const result = try collectArgv(alloc, argv_array);
    defer alloc.free(result);

    try std.testing.expectEqual(@as(usize, 3), result.len);
    try std.testing.expectEqualStrings("/usr/bin/nix", result[0]);
    try std.testing.expectEqualStrings("build", result[1]);
    try std.testing.expectEqualStrings("--no-link", result[2]);
}

test "collectArgv: single argument" {
    const alloc = std.testing.allocator;
    const arg0: [*:0]const u8 = "/bin/ls";
    const argv_array: [:null]const ?[*:0]const u8 = &.{arg0};

    const result = try collectArgv(alloc, argv_array);
    defer alloc.free(result);

    try std.testing.expectEqual(@as(usize, 1), result.len);
    try std.testing.expectEqualStrings("/bin/ls", result[0]);
}

test "collectArgv: no arguments (null-terminated immediately)" {
    const alloc = std.testing.allocator;
    const argv_array: [:null]const ?[*:0]const u8 = &.{};

    const result = try collectArgv(alloc, argv_array);
    defer alloc.free(result);

    try std.testing.expectEqual(@as(usize, 0), result.len);
}

test "parseResponse: non-JSON input returns error" {
    const alloc = std.testing.allocator;
    const result = parseResponse(alloc, "this is not json");
    try std.testing.expectError(error.SyntaxError, result);
}

test "parseResponse: missing type field returns error" {
    const alloc = std.testing.allocator;
    const result = parseResponse(alloc, "{\"exitCode\":0}");
    try std.testing.expectError(error.InvalidResponse, result);
}

test "parseResponse: non-object JSON returns error" {
    const alloc = std.testing.allocator;
    const result = parseResponse(alloc, "[1,2,3]");
    try std.testing.expectError(error.InvalidResponse, result);
}

test "parseResponse: type field is not a string returns error" {
    const alloc = std.testing.allocator;
    const result = parseResponse(alloc, "{\"type\":42}");
    try std.testing.expectError(error.InvalidResponse, result);
}

test "parseResponse: unknown type returns unknown" {
    const alloc = std.testing.allocator;
    const resp = try parseResponse(alloc, "{\"type\":\"something_else\"}");
    try std.testing.expectEqual(BrokerResponse.ResponseType.unknown, resp.response_type);
}

test "decodeBase64: invalid input returns empty string" {
    const alloc = std.testing.allocator;
    const decoded = try decodeBase64(alloc, "!!!not-base64!!!");
    defer alloc.free(decoded);

    try std.testing.expectEqual(@as(usize, 0), decoded.len);
}
