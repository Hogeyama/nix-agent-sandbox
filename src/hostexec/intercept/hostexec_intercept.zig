// hostexec_intercept.zig — LD_PRELOAD shared library that intercepts exec-family
// calls and delegates matching commands to the hostexec broker over a Unix socket.
//
// Environment variables consumed:
//   NAS_HOSTEXEC_INTERCEPT_PATHS  – newline-separated list of absolute paths to intercept
//   NAS_HOSTEXEC_SOCKET           – path to the broker's Unix domain socket
//   NAS_HOSTEXEC_SESSION_ID       – session identifier sent in every request
//   NAS_HOSTEXEC_INTERCEPT_DEBUG  – if set, emit debug messages to stderr

const std = @import("std");
const posix = std.posix;
const linux = std.os.linux;
const json = std.json;
const base64_mod = std.base64.standard;
const Allocator = std.mem.Allocator;

// ─── C imports ───────────────────────────────────────────────────────
const c = @cImport({
    @cInclude("dlfcn.h");
    @cInclude("spawn.h");
});

// ─── libc types ──────────────────────────────────────────────────────
const posix_spawn_file_actions_t = c.posix_spawn_file_actions_t;
const posix_spawnattr_t = c.posix_spawnattr_t;

// ─── Resolve real functions via RTLD_NEXT ────────────────────────────
fn dlsymNext(comptime name: [*:0]const u8) ?*anyopaque {
    return c.dlsym(c.RTLD_NEXT, name);
}

const RealExecveFn = *const fn ([*:0]const u8, [*:null]const ?[*:0]const u8, [*:null]const ?[*:0]const u8) callconv(.c) c_int;
const RealExecvFn = *const fn ([*:0]const u8, [*:null]const ?[*:0]const u8) callconv(.c) c_int;
const RealExecvpFn = *const fn ([*:0]const u8, [*:null]const ?[*:0]const u8) callconv(.c) c_int;
const RealExecvpeFn = *const fn ([*:0]const u8, [*:null]const ?[*:0]const u8, [*:null]const ?[*:0]const u8) callconv(.c) c_int;
const RealPosixSpawnFn = *const fn (*c.pid_t, [*:0]const u8, ?*const posix_spawn_file_actions_t, ?*const posix_spawnattr_t, [*:null]const ?[*:0]const u8, [*:null]const ?[*:0]const u8) callconv(.c) c_int;

fn getRealExecve() ?RealExecveFn {
    const ptr = dlsymNext("execve") orelse return null;
    return @ptrCast(@alignCast(ptr));
}
fn getRealExecv() ?RealExecvFn {
    const ptr = dlsymNext("execv") orelse return null;
    return @ptrCast(@alignCast(ptr));
}
fn getRealExecvp() ?RealExecvpFn {
    const ptr = dlsymNext("execvp") orelse return null;
    return @ptrCast(@alignCast(ptr));
}
fn getRealExecvpe() ?RealExecvpeFn {
    const ptr = dlsymNext("execvpe") orelse return null;
    return @ptrCast(@alignCast(ptr));
}
fn getRealPosixSpawn() ?RealPosixSpawnFn {
    const ptr = dlsymNext("posix_spawn") orelse return null;
    return @ptrCast(@alignCast(ptr));
}
fn getRealPosixSpawnp() ?RealPosixSpawnFn {
    const ptr = dlsymNext("posix_spawnp") orelse return null;
    return @ptrCast(@alignCast(ptr));
}

// ─── Debug logging ──────────────────────────────────────────────────

const DebugFlag = enum(u8) { unknown = 0, enabled = 1, disabled = 2 };

/// Cached debug flag, atomically accessed for thread safety in LD_PRELOAD context.
var debug_flag_cache: std.atomic.Value(DebugFlag) = std.atomic.Value(DebugFlag).init(.unknown);

fn debugEnabled() bool {
    const cached = debug_flag_cache.load(.acquire);
    if (cached != .unknown) return cached == .enabled;
    const val = std.posix.getenv("NAS_HOSTEXEC_INTERCEPT_DEBUG") orelse "";
    const flag: DebugFlag = if (val.len > 0) .enabled else .disabled;
    debug_flag_cache.store(flag, .release);
    return flag == .enabled;
}

fn debugLog(comptime fmt: []const u8, args: anytype) void {
    if (!debugEnabled()) return;
    std.debug.print("[hostexec-intercept] " ++ fmt ++ "\n", args);
}

// ─── Path matching ──────────────────────────────────────────────────

/// Resolve a pathname to an absolute, canonicalised path.
/// Falls back to cwd + pathname if realpath fails.
pub fn resolvePath(alloc: Allocator, pathname: [*:0]const u8) ![]const u8 {
    const path_slice = std.mem.span(pathname);

    // Try realpath first via the libc wrapper
    if (std.fs.cwd().realpathAlloc(alloc, path_slice)) |resolved| {
        return resolved;
    } else |_| {}

    // Fallback: manual resolution
    if (path_slice.len > 0 and path_slice[0] == '/') {
        return try alloc.dupe(u8, path_slice);
    }

    // Relative path: prepend cwd
    var cwd_buf: [std.fs.max_path_bytes]u8 = undefined;
    const cwd = std.posix.getcwd(&cwd_buf) catch return try alloc.dupe(u8, path_slice);
    const joined = try std.fs.path.join(alloc, &.{ cwd, path_slice });
    return joined;
}

/// Check if `resolved` matches any entry in the newline-separated intercept list.
pub fn matchesInterceptPaths(resolved: []const u8, intercept_paths_env: []const u8) bool {
    var iter = std.mem.splitScalar(u8, intercept_paths_env, '\n');
    while (iter.next()) |entry| {
        const trimmed = std.mem.trim(u8, entry, &[_]u8{ ' ', '\t', '\r' });
        if (trimmed.len == 0) continue;
        if (std.mem.eql(u8, resolved, trimmed)) return true;
    }
    return false;
}

/// Full intercept decision: resolve the path, then match.
pub fn shouldIntercept(alloc: Allocator, pathname: [*:0]const u8) bool {
    const intercept_paths_env = std.posix.getenv("NAS_HOSTEXEC_INTERCEPT_PATHS") orelse return false;
    if (intercept_paths_env.len == 0) return false;

    const resolved = resolvePath(alloc, pathname) catch return false;
    defer alloc.free(resolved);

    return matchesInterceptPaths(resolved, intercept_paths_env);
}

// ─── JSON protocol ──────────────────────────────────────────────────

/// JSON request structure matching the broker's ExecuteRequest.
const ExecuteRequest = struct {
    version: u32 = 1,
    type: []const u8 = "execute",
    sessionId: []const u8,
    requestId: []const u8,
    argv0: []const u8,
    args: []const []const u8,
    cwd: []const u8,
    tty: bool = false,
};

/// Build a JSON request string for the broker, terminated with newline.
pub fn buildRequest(
    alloc: Allocator,
    session_id: []const u8,
    request_id: []const u8,
    argv0: []const u8,
    args: []const []const u8,
    cwd: []const u8,
) ![]const u8 {
    const req = ExecuteRequest{
        .sessionId = session_id,
        .requestId = request_id,
        .argv0 = argv0,
        .args = args,
        .cwd = cwd,
    };

    const json_bytes = try json.Stringify.valueAlloc(alloc, req, .{});
    defer alloc.free(json_bytes);

    // Append newline
    const result = try alloc.alloc(u8, json_bytes.len + 1);
    @memcpy(result[0..json_bytes.len], json_bytes);
    result[json_bytes.len] = '\n';
    return result;
}

/// Parsed broker response.
///
/// Ownership: `stdout_b64` and `stderr_b64` are heap-allocated (via the
/// allocator passed to `parseResponse`) only when `response_type == .result`.
/// The caller is responsible for freeing each field whose `.len > 0`.
pub const BrokerResponse = struct {
    response_type: ResponseType,
    exit_code: i32,
    stdout_b64: []const u8,
    stderr_b64: []const u8,

    pub const ResponseType = enum { result, fallback, @"error", unknown };
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
        if (std.mem.eql(u8, type_str, "fallback")) break :blk .fallback;
        if (std.mem.eql(u8, type_str, "error")) break :blk .@"error";
        break :blk .unknown;
    };

    var exit_code: i32 = 0;
    var stdout_b64: []const u8 = "";
    var stderr_b64: []const u8 = "";

    if (response_type == .result) {
        if (root.object.get("exitCode")) |ec| {
            switch (ec) {
                .integer => |i| {
                    exit_code = std.math.cast(i32, i) orelse 1;
                },
                else => {},
            }
        }
        if (root.object.get("stdout")) |s| {
            switch (s) {
                .string => |str| {
                    stdout_b64 = try alloc.dupe(u8, str);
                },
                else => {},
            }
        }
        errdefer if (stdout_b64.len > 0) alloc.free(stdout_b64);
        if (root.object.get("stderr")) |s| {
            switch (s) {
                .string => |str| {
                    stderr_b64 = try alloc.dupe(u8, str);
                },
                else => {},
            }
        }
    }

    return BrokerResponse{
        .response_type = response_type,
        .exit_code = exit_code,
        .stdout_b64 = stdout_b64,
        .stderr_b64 = stderr_b64,
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
    const ts_i128 = std.time.nanoTimestamp();
    const ts: u64 = @truncate(@as(u128, @bitCast(ts_i128)));
    const result = std.fmt.bufPrint(buf, "{x:0>16}-intercept", .{ts}) catch return "unknown-request";
    return result;
}

// ─── Broker communication ───────────────────────────────────────────

const BrokerCallResult = struct {
    exit_code: i32,
    should_fallback: bool,
};

fn collectArgv(alloc: Allocator, argv: [*:null]const ?[*:0]const u8) ![]const []const u8 {
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

fn callBroker(pathname: [*:0]const u8, argv: [*:null]const ?[*:0]const u8) BrokerCallResult {
    const alloc = std.heap.c_allocator;

    const socket_path = std.posix.getenv("NAS_HOSTEXEC_SOCKET") orelse {
        debugLog("NAS_HOSTEXEC_SOCKET not set, falling back", .{});
        return .{ .exit_code = 1, .should_fallback = true };
    };
    const session_id = std.posix.getenv("NAS_HOSTEXEC_SESSION_ID") orelse {
        debugLog("NAS_HOSTEXEC_SESSION_ID not set, falling back", .{});
        return .{ .exit_code = 1, .should_fallback = true };
    };

    return callBrokerInner(alloc, socket_path, session_id, pathname, argv) catch |err| {
        debugLog("broker communication failed: {s}, falling back", .{@errorName(err)});
        return .{ .exit_code = 1, .should_fallback = true };
    };
}

fn callBrokerInner(
    alloc: Allocator,
    socket_path: []const u8,
    session_id: []const u8,
    pathname: [*:0]const u8,
    argv: [*:null]const ?[*:0]const u8,
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

    const request_json = try buildRequest(alloc, session_id, request_id, argv0, args, cwd);
    defer alloc.free(request_json);

    debugLog("connecting to broker at {s}", .{socket_path});

    // Connect to Unix socket
    const sock = try std.net.connectUnixSocket(socket_path);
    defer sock.close();

    // Set 30-second send/receive timeouts so we don't block forever
    const timeout = std.posix.timeval{ .sec = 30, .usec = 0 };
    const timeout_bytes = std.mem.asBytes(&timeout);
    std.posix.setsockopt(sock.handle, std.os.linux.SOL.SOCKET, std.os.linux.SO.RCVTIMEO, timeout_bytes) catch |err| {
        debugLog("failed to set SO_RCVTIMEO: {s}", .{@errorName(err)});
    };
    std.posix.setsockopt(sock.handle, std.os.linux.SOL.SOCKET, std.os.linux.SO.SNDTIMEO, timeout_bytes) catch |err| {
        debugLog("failed to set SO_SNDTIMEO: {s}", .{@errorName(err)});
    };

    // Send request
    try sock.writeAll(request_json);

    // Read response (dynamically sized)
    var response_buf: std.ArrayList(u8) = .{};
    defer response_buf.deinit(alloc);

    var read_buf: [4096]u8 = undefined;
    while (true) {
        const n = try sock.read(&read_buf);
        if (n == 0) break;
        try response_buf.appendSlice(alloc, read_buf[0..n]);
        // Check for newline (end of JSON line)
        if (std.mem.indexOfScalar(u8, response_buf.items, '\n') != null) break;
    }

    if (response_buf.items.len == 0) {
        debugLog("empty response from broker", .{});
        return .{ .exit_code = 1, .should_fallback = true };
    }

    debugLog("received response: {d} bytes", .{response_buf.items.len});

    const response = try parseResponse(alloc, response_buf.items);

    switch (response.response_type) {
        .fallback => {
            debugLog("broker requested fallback", .{});
            return .{ .exit_code = 0, .should_fallback = true };
        },
        .@"error" => {
            debugLog("broker returned error", .{});
            return .{ .exit_code = 1, .should_fallback = true };
        },
        .result => {
            // Decode and write stdout
            if (response.stdout_b64.len > 0) {
                defer alloc.free(response.stdout_b64);
                if (decodeBase64(alloc, response.stdout_b64)) |stdout_data| {
                    defer alloc.free(stdout_data);
                    if (stdout_data.len > 0) writeAll(std.posix.STDOUT_FILENO, stdout_data);
                } else |_| {}
            }
            // Decode and write stderr
            if (response.stderr_b64.len > 0) {
                defer alloc.free(response.stderr_b64);
                if (decodeBase64(alloc, response.stderr_b64)) |stderr_data| {
                    defer alloc.free(stderr_data);
                    if (stderr_data.len > 0) writeAll(std.posix.STDERR_FILENO, stderr_data);
                } else |_| {}
            }
            return .{ .exit_code = response.exit_code, .should_fallback = false };
        },
        .unknown => {
            debugLog("unknown response type from broker", .{});
            return .{ .exit_code = 1, .should_fallback = true };
        },
    }
}

fn writeAll(fd: i32, data: []const u8) void {
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

fn doExit(exit_code: i32) noreturn {
    // Use linux syscall directly to avoid libc exit handlers
    const status: u8 = @truncate(@as(u32, @bitCast(exit_code)));
    std.posix.exit(status);
}

// ─── Exported hooks ─────────────────────────────────────────────────

export fn execve(pathname: [*:0]const u8, argv: [*:null]const ?[*:0]const u8, envp: [*:null]const ?[*:0]const u8) callconv(.c) c_int {
    if (shouldIntercept(std.heap.c_allocator, pathname)) {
        debugLog("intercepting execve: {s}", .{std.mem.span(pathname)});
        const result = callBroker(pathname, argv);
        if (!result.should_fallback) {
            doExit(result.exit_code);
        }
        debugLog("falling back to real execve", .{});
    }
    const real = getRealExecve() orelse {
        doExit(127);
    };
    return real(pathname, argv, envp);
}

export fn execv(pathname: [*:0]const u8, argv: [*:null]const ?[*:0]const u8) callconv(.c) c_int {
    if (shouldIntercept(std.heap.c_allocator, pathname)) {
        debugLog("intercepting execv: {s}", .{std.mem.span(pathname)});
        const result = callBroker(pathname, argv);
        if (!result.should_fallback) {
            doExit(result.exit_code);
        }
        debugLog("falling back to real execv", .{});
    }
    const real = getRealExecv() orelse {
        doExit(127);
    };
    return real(pathname, argv);
}

export fn execvp(pathname: [*:0]const u8, argv: [*:null]const ?[*:0]const u8) callconv(.c) c_int {
    const path_slice = std.mem.span(pathname);
    // Intercept if pathname contains '/' (POSIX: any slash means path, not PATH lookup)
    const should_check = std.mem.indexOfScalar(u8, path_slice, '/') != null;

    if (should_check and shouldIntercept(std.heap.c_allocator, pathname)) {
        debugLog("intercepting execvp: {s}", .{path_slice});
        const result = callBroker(pathname, argv);
        if (!result.should_fallback) {
            doExit(result.exit_code);
        }
        debugLog("falling back to real execvp", .{});
    }
    const real = getRealExecvp() orelse {
        doExit(127);
    };
    return real(pathname, argv);
}

export fn execvpe(pathname: [*:0]const u8, argv: [*:null]const ?[*:0]const u8, envp: [*:null]const ?[*:0]const u8) callconv(.c) c_int {
    const path_slice = std.mem.span(pathname);
    // Intercept if pathname contains '/' (POSIX: any slash means path, not PATH lookup)
    const should_check = std.mem.indexOfScalar(u8, path_slice, '/') != null;

    if (should_check and shouldIntercept(std.heap.c_allocator, pathname)) {
        debugLog("intercepting execvpe: {s}", .{path_slice});
        const result = callBroker(pathname, argv);
        if (!result.should_fallback) {
            doExit(result.exit_code);
        }
        debugLog("falling back to real execvpe", .{});
    }
    const real = getRealExecvpe() orelse {
        doExit(127);
    };
    return real(pathname, argv, envp);
}

export fn posix_spawn(
    pid: *c.pid_t,
    pathname: [*:0]const u8,
    file_actions: ?*const posix_spawn_file_actions_t,
    attrp: ?*const posix_spawnattr_t,
    argv: [*:null]const ?[*:0]const u8,
    envp: [*:null]const ?[*:0]const u8,
) callconv(.c) c_int {
    if (shouldIntercept(std.heap.c_allocator, pathname)) {
        debugLog("intercepting posix_spawn: {s}", .{std.mem.span(pathname)});
        return posixSpawnViaBroker(pid, pathname, argv);
    }
    const real = getRealPosixSpawn() orelse return 127;
    return real(pid, pathname, file_actions, attrp, argv, envp);
}

export fn posix_spawnp(
    pid: *c.pid_t,
    pathname: [*:0]const u8,
    file_actions: ?*const posix_spawn_file_actions_t,
    attrp: ?*const posix_spawnattr_t,
    argv: [*:null]const ?[*:0]const u8,
    envp: [*:null]const ?[*:0]const u8,
) callconv(.c) c_int {
    const path_slice = std.mem.span(pathname);
    // Intercept if pathname contains '/' (POSIX: any slash means path, not PATH lookup)
    const should_check = std.mem.indexOfScalar(u8, path_slice, '/') != null;

    if (should_check and shouldIntercept(std.heap.c_allocator, pathname)) {
        debugLog("intercepting posix_spawnp: {s}", .{path_slice});
        return posixSpawnViaBroker(pid, pathname, argv);
    }
    const real = getRealPosixSpawnp() orelse return 127;
    return real(pid, pathname, file_actions, attrp, argv, envp);
}

/// posix_spawn wrapper: fork(), child calls broker + _exit(), parent gets child pid.
fn posixSpawnViaBroker(
    pid: *c.pid_t,
    pathname: [*:0]const u8,
    argv: [*:null]const ?[*:0]const u8,
) c_int {
    const fork_result = std.posix.fork() catch {
        debugLog("fork failed in posix_spawn wrapper", .{});
        return 127;
    };

    if (fork_result == 0) {
        // Child process
        const result = callBroker(pathname, argv);
        if (result.should_fallback) {
            // Cannot fallback in posix_spawn child; exit with error
            doExit(127);
        }
        doExit(result.exit_code);
    }

    // Parent process
    pid.* = @intCast(fork_result);
    return 0;
}

// ─── Unit tests ─────────────────────────────────────────────────────

test "matchesInterceptPaths: exact match" {
    try std.testing.expect(matchesInterceptPaths("/usr/bin/nix", "/usr/bin/nix\n/usr/bin/git"));
    try std.testing.expect(matchesInterceptPaths("/usr/bin/git", "/usr/bin/nix\n/usr/bin/git"));
}

test "matchesInterceptPaths: no match" {
    try std.testing.expect(!matchesInterceptPaths("/usr/bin/curl", "/usr/bin/nix\n/usr/bin/git"));
}

test "matchesInterceptPaths: empty list" {
    try std.testing.expect(!matchesInterceptPaths("/usr/bin/nix", ""));
}

test "matchesInterceptPaths: single entry" {
    try std.testing.expect(matchesInterceptPaths("/usr/bin/nix", "/usr/bin/nix"));
}

test "matchesInterceptPaths: trailing newline" {
    try std.testing.expect(matchesInterceptPaths("/usr/bin/nix", "/usr/bin/nix\n"));
}

test "matchesInterceptPaths: whitespace trimming" {
    try std.testing.expect(matchesInterceptPaths("/usr/bin/nix", "  /usr/bin/nix  \n"));
}

test "buildRequest: basic JSON" {
    const alloc = std.testing.allocator;
    const args = [_][]const u8{ "install", "hello" };
    const result = try buildRequest(alloc, "sess-123", "req-001", "/usr/bin/nix", &args, "/home/user");
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
    try std.testing.expectEqual(@as(i64, 1), obj.get("version").?.integer);

    const json_args = obj.get("args").?.array;
    try std.testing.expectEqual(@as(usize, 2), json_args.items.len);
    try std.testing.expectEqualStrings("install", json_args.items[0].string);
    try std.testing.expectEqualStrings("hello", json_args.items[1].string);
}

test "buildRequest: empty args" {
    const alloc = std.testing.allocator;
    const args = [_][]const u8{};
    const result = try buildRequest(alloc, "sess-1", "req-1", "/usr/bin/ls", &args, "/tmp");
    defer alloc.free(result);

    const parsed = try json.parseFromSlice(json.Value, alloc, result, .{});
    defer parsed.deinit();

    const json_args = parsed.value.object.get("args").?.array;
    try std.testing.expectEqual(@as(usize, 0), json_args.items.len);
}

test "buildRequest: special characters in args" {
    const alloc = std.testing.allocator;
    const args = [_][]const u8{ "hello world", "foo\"bar", "a\nb" };
    const result = try buildRequest(alloc, "s", "r", "/bin/echo", &args, "/");
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
    const result = try buildRequest(alloc, "s", "r", "/bin/ls", &args, "/");
    defer alloc.free(result);

    try std.testing.expect(result.len > 0);
    try std.testing.expectEqual(@as(u8, '\n'), result[result.len - 1]);
}

test "parseResponse: result type" {
    const alloc = std.testing.allocator;
    const input =
        \\{"type":"result","requestId":"r1","exitCode":0,"stdout":"aGVsbG8=","stderr":""}
    ;
    const resp = try parseResponse(alloc, input);
    defer {
        if (resp.stdout_b64.len > 0) alloc.free(resp.stdout_b64);
        if (resp.stderr_b64.len > 0) alloc.free(resp.stderr_b64);
    }

    try std.testing.expectEqual(BrokerResponse.ResponseType.result, resp.response_type);
    try std.testing.expectEqual(@as(i32, 0), resp.exit_code);
    try std.testing.expectEqualStrings("aGVsbG8=", resp.stdout_b64);
    try std.testing.expectEqualStrings("", resp.stderr_b64);
}

test "parseResponse: result with nonzero exit code" {
    const alloc = std.testing.allocator;
    const input =
        \\{"type":"result","requestId":"r2","exitCode":42,"stdout":"","stderr":"ZXJy"}
    ;
    const resp = try parseResponse(alloc, input);
    defer {
        if (resp.stdout_b64.len > 0) alloc.free(resp.stdout_b64);
        if (resp.stderr_b64.len > 0) alloc.free(resp.stderr_b64);
    }

    try std.testing.expectEqual(BrokerResponse.ResponseType.result, resp.response_type);
    try std.testing.expectEqual(@as(i32, 42), resp.exit_code);
    try std.testing.expectEqualStrings("ZXJy", resp.stderr_b64);
}

test "parseResponse: fallback type" {
    const alloc = std.testing.allocator;
    const input =
        \\{"type":"fallback","requestId":"r3"}
    ;
    const resp = try parseResponse(alloc, input);

    try std.testing.expectEqual(BrokerResponse.ResponseType.fallback, resp.response_type);
}

test "parseResponse: error type" {
    const alloc = std.testing.allocator;
    const input =
        \\{"type":"error","requestId":"r4","message":"denied"}
    ;
    const resp = try parseResponse(alloc, input);

    try std.testing.expectEqual(BrokerResponse.ResponseType.@"error", resp.response_type);
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

test "resolvePath: absolute path" {
    const alloc = std.testing.allocator;
    // Use a path that definitely doesn't exist to test fallback
    const resolved = try resolvePath(alloc, "/nonexistent/test/path");
    defer alloc.free(resolved);

    try std.testing.expectEqualStrings("/nonexistent/test/path", resolved);
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

test "shouldIntercept: matching absolute path" {
    // We can't easily mock getenv, but we can test the underlying functions.
    // shouldIntercept returns false when NAS_HOSTEXEC_INTERCEPT_PATHS is unset.
    const alloc = std.testing.allocator;
    try std.testing.expect(!shouldIntercept(alloc, "/usr/bin/nix"));
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

test "resolvePath: relative path resolves to cwd-based absolute path" {
    const alloc = std.testing.allocator;
    const resolved = try resolvePath(alloc, "./foo");
    defer alloc.free(resolved);

    // Must be absolute
    try std.testing.expect(resolved.len > 0);
    try std.testing.expectEqual(@as(u8, '/'), resolved[0]);
    // Must end with /foo (cwd + ./foo joined)
    try std.testing.expect(std.mem.endsWith(u8, resolved, "/foo"));
}

test "resolvePath: relative path without ./ prefix resolves to cwd-based absolute path" {
    const alloc = std.testing.allocator;
    const resolved = try resolvePath(alloc, "contrib/exodus/docker/vne/bin/up");
    defer alloc.free(resolved);

    // Must be absolute
    try std.testing.expect(resolved.len > 0);
    try std.testing.expectEqual(@as(u8, '/'), resolved[0]);
    // Must end with the relative path appended to cwd
    try std.testing.expect(std.mem.endsWith(u8, resolved, "/contrib/exodus/docker/vne/bin/up"));
}

test "matchesInterceptPaths: relative path resolved to absolute matches" {
    const alloc = std.testing.allocator;

    // Simulate: cwd is /workspace, relative path is contrib/bin/up
    // resolvePath would produce /workspace/contrib/bin/up (or similar)
    const resolved = try resolvePath(alloc, "contrib/bin/up");
    defer alloc.free(resolved);

    // The intercept paths env should contain the resolved absolute path
    try std.testing.expect(matchesInterceptPaths(resolved, resolved));
}
