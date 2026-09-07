// hostexec_intercept.zig — LD_PRELOAD shared library that intercepts exec-family
// calls and delegates matching commands to the hostexec broker over a Unix socket.
//
// This is the client for rules whose argv0 is a relative or absolute path,
// including the installed hostexec script. Ordinary bare-command rules are
// caught via PATH by `client_main.zig` instead. Both
// share `protocol.zig` from the point the intercept decision has been made.
//
// Environment variables consumed:
//   NAS_HOSTEXEC_INTERCEPT_PATHS  – newline-separated list of absolute paths to intercept
//   NAS_HOSTEXEC_SOCKET           – path to the broker's Unix domain socket
//   NAS_HOSTEXEC_SESSION_ID       – session identifier sent in every request
//   NAS_HOSTEXEC_INTERCEPT_DEBUG  – if set, emit debug messages to stderr
//   NAS_HOSTEXEC_CLIENT_PATH      – standalone client used for posix_spawn

const std = @import("std");
const posix = @import("posix");
const Allocator = std.mem.Allocator;

const protocol = @import("protocol.zig");
const intercept_paths = @import("intercept_paths.zig");
const callBroker = protocol.callBroker;
const debugLog = protocol.debugLog;
const doExit = protocol.doExit;

// ─── C imports ───────────────────────────────────────────────────────
const c = @cImport({
    @cInclude("dlfcn.h");
    @cInclude("spawn.h");
    @cInclude("errno.h");
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

// ─── Path matching ──────────────────────────────────────────────────

/// Resolve a pathname to an absolute, canonicalised path.
/// Falls back to cwd + pathname if realpath fails.
pub fn resolvePath(alloc: Allocator, pathname: [*:0]const u8) ![]const u8 {
    const path_slice = std.mem.span(pathname);

    // Try realpath first via the libc wrapper
    if (posix.realpathAlloc(alloc, path_slice)) |resolved| {
        return resolved;
    } else |_| {}

    // Fallback: manual resolution
    if (path_slice.len > 0 and path_slice[0] == '/') {
        return try alloc.dupe(u8, path_slice);
    }

    // Relative path: prepend cwd
    var cwd_buf: [std.fs.max_path_bytes]u8 = undefined;
    const cwd = posix.getcwd(&cwd_buf) catch return try alloc.dupe(u8, path_slice);
    const joined = try std.fs.path.join(alloc, &.{ cwd, path_slice });
    return joined;
}

/// Check if `resolved` matches any entry in the newline-separated intercept list.
pub const matchesInterceptPaths = intercept_paths.matchesInterceptPaths;

/// Full intercept decision: resolve the path, then match.
pub fn shouldIntercept(alloc: Allocator, pathname: [*:0]const u8) bool {
    const intercept_paths_env = posix.getenv("NAS_HOSTEXEC_INTERCEPT_PATHS") orelse return false;
    if (intercept_paths_env.len == 0) return false;

    const resolved = resolvePath(alloc, pathname) catch return false;
    defer alloc.free(resolved);

    return matchesInterceptPaths(resolved, intercept_paths_env);
}

/// Resolve the same first executable that libc's PATH search would select.
/// Stop at an unrelated executable: a later installed command must not shadow
/// a caller's earlier PATH entry. execvpe, like execvp, searches the caller's
/// PATH, not the PATH in the environment supplied for the new process.
fn interceptedSearchPath(alloc: Allocator, pathname: [*:0]const u8) ?[:0]u8 {
    const name = std.mem.span(pathname);
    if (std.mem.indexOfScalar(u8, name, '/') != null) {
        if (!shouldIntercept(alloc, pathname)) return null;
        return alloc.dupeZ(u8, name) catch null;
    }
    if (name.len == 0) return null;
    const path_env = posix.getenv("PATH") orelse intercept_paths.default_path;
    const candidate = intercept_paths.findExecutable(alloc, name, path_env) catch return null;
    defer alloc.free(candidate);
    const canonical = posix.realpathAlloc(alloc, candidate) catch return null;
    defer alloc.free(canonical);
    const resolved = alloc.dupeZ(u8, canonical) catch return null;
    if (shouldIntercept(alloc, resolved.ptr)) return resolved;
    alloc.free(resolved);
    return null;
}

// ─── Exported hooks ─────────────────────────────────────────────────

export fn execve(pathname: [*:0]const u8, argv: [*:null]const ?[*:0]const u8, envp: [*:null]const ?[*:0]const u8) callconv(.c) c_int {
    if (shouldIntercept(std.heap.c_allocator, pathname)) {
        debugLog("intercepting execve: {s}", .{std.mem.span(pathname)});
        const result = callBroker(pathname, argv, true);
        if (result.outcome != .fallback) {
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
        const result = callBroker(pathname, argv, true);
        if (result.outcome != .fallback) {
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
    if (interceptedSearchPath(std.heap.c_allocator, pathname)) |resolved| {
        defer std.heap.c_allocator.free(resolved);
        debugLog("intercepting execvp: {s}", .{resolved});
        const result = callBroker(resolved.ptr, argv, true);
        if (result.outcome != .fallback) {
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
    if (interceptedSearchPath(std.heap.c_allocator, pathname)) |resolved| {
        defer std.heap.c_allocator.free(resolved);
        debugLog("intercepting execvpe: {s}", .{resolved});
        const result = callBroker(resolved.ptr, argv, true);
        if (result.outcome != .fallback) {
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
        return posixSpawnViaBroker(pid, pathname, file_actions, attrp, argv, envp, false);
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
    // File actions may chdir/fchdir before libc searches PATH. For configured
    // command names, postpone selection until the relay has received those
    // actions; the parent cwd cannot tell which executable will be selected.
    const configured = posix.getenv("NAS_HOSTEXEC_INTERCEPT_PATHS") orelse "";
    if (file_actions != null and intercept_paths.matchesInterceptName(std.mem.span(pathname), configured)) {
        return posixSpawnViaBroker(pid, pathname, file_actions, attrp, argv, envp, true);
    }
    if (interceptedSearchPath(std.heap.c_allocator, pathname)) |resolved| {
        defer std.heap.c_allocator.free(resolved);
        debugLog("intercepting posix_spawnp: {s}", .{resolved});
        // A differently named symlink may also select an intercepted parent
        // target. Recheck that PATH lookup after cwd-changing file actions.
        const search = file_actions != null and std.mem.indexOfScalar(u8, std.mem.span(pathname), '/') == null;
        return posixSpawnViaBroker(pid, if (search) pathname else resolved.ptr, file_actions, attrp, argv, envp, search);
    }
    const real = getRealPosixSpawnp() orelse return 127;
    return real(pid, pathname, file_actions, attrp, argv, envp);
}

/// Let libc apply all spawn actions/attributes to the actual command process.
/// The standalone client then contacts the broker and can exec the original
/// path on fallback, preserving the returned PID, descriptors and environment.
fn posixSpawnViaBroker(
    pid: *c.pid_t,
    pathname: [*:0]const u8,
    file_actions: ?*const posix_spawn_file_actions_t,
    attrp: ?*const posix_spawnattr_t,
    argv: [*:null]const ?[*:0]const u8,
    envp: [*:null]const ?[*:0]const u8,
    search_in_child: bool,
) c_int {
    const alloc = std.heap.c_allocator;
    const real = getRealPosixSpawn() orelse return c.ENOSYS;
    const client_path: [:0]const u8 = posix.getenv("NAS_HOSTEXEC_CLIENT_PATH") orelse protocol.spawn_client_argv0;
    const original = std.mem.span(argv);
    const prefix_len: usize = if (search_in_child) 7 else 5;
    const forwarded = alloc.allocSentinel(?[*:0]const u8, original.len + prefix_len, null) catch return c.ENOMEM;
    defer alloc.free(forwarded);
    forwarded[0] = protocol.spawn_client_argv0.ptr;
    forwarded[1] = if (search_in_child) protocol.spawn_search_flag.ptr else protocol.spawn_client_flag.ptr;
    // Carry routing separately: envp may deliberately omit all NAS variables.
    // This is session metadata, never secret values, and fallback sees envp
    // unchanged. Missing parent metadata still fails closed in the client.
    const socket_path: [:0]const u8 = posix.getenv("NAS_HOSTEXEC_SOCKET") orelse "";
    const session_id: [:0]const u8 = posix.getenv("NAS_HOSTEXEC_SESSION_ID") orelse "";
    forwarded[2] = socket_path.ptr;
    forwarded[3] = session_id.ptr;
    forwarded[4] = pathname;
    if (search_in_child) {
        const search_path: [:0]const u8 = posix.getenv("PATH") orelse intercept_paths.default_path;
        const configured: [:0]const u8 = posix.getenv("NAS_HOSTEXEC_INTERCEPT_PATHS") orelse "";
        forwarded[5] = search_path.ptr;
        forwarded[6] = configured.ptr;
    }
    @memcpy(forwarded[prefix_len..], original);
    return real(pid, client_path.ptr, file_actions, attrp, forwarded.ptr, envp);
}

// ─── Unit tests ─────────────────────────────────────────────────────

test {
    // Pull the sibling modules' tests into this root's test binary.
    _ = @import("protocol.zig");
    _ = @import("client_main.zig");
    _ = @import("fd_transport.zig");
    _ = @import("gateway_protocol.zig");
    _ = @import("gateway_executor.zig");
    _ = @import("gateway_main.zig");
}

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

test "resolvePath: absolute path" {
    const alloc = std.testing.allocator;
    // Use a path that definitely doesn't exist to test fallback
    const resolved = try resolvePath(alloc, "/nonexistent/test/path");
    defer alloc.free(resolved);

    try std.testing.expectEqualStrings("/nonexistent/test/path", resolved);
}

test "shouldIntercept: matching absolute path" {
    // We can't easily mock getenv, but we can test the underlying functions.
    // shouldIntercept returns false when NAS_HOSTEXEC_INTERCEPT_PATHS is unset.
    const alloc = std.testing.allocator;
    try std.testing.expect(!shouldIntercept(alloc, "/usr/bin/nix"));
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
