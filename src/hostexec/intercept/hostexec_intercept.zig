// hostexec_intercept.zig — LD_PRELOAD shared library that intercepts exec-family
// calls and delegates matching commands to the hostexec broker over a Unix socket.
//
// This is the client for rules whose argv0 is a relative or absolute path;
// bare-command rules are caught via PATH by `client_main.zig` instead. Both
// share `protocol.zig` from the point the intercept decision has been made.
//
// Environment variables consumed:
//   NAS_HOSTEXEC_INTERCEPT_PATHS  – newline-separated list of absolute paths to intercept
//   NAS_HOSTEXEC_SOCKET           – path to the broker's Unix domain socket
//   NAS_HOSTEXEC_SESSION_ID       – session identifier sent in every request
//   NAS_HOSTEXEC_INTERCEPT_DEBUG  – if set, emit debug messages to stderr

const std = @import("std");
const posix = std.posix;
const Allocator = std.mem.Allocator;

const protocol = @import("protocol.zig");
const callBroker = protocol.callBroker;
const debugLog = protocol.debugLog;
const doExit = protocol.doExit;

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
    const path_slice = std.mem.span(pathname);
    // Intercept if pathname contains '/' (POSIX: any slash means path, not PATH lookup)
    const should_check = std.mem.indexOfScalar(u8, path_slice, '/') != null;

    if (should_check and shouldIntercept(std.heap.c_allocator, pathname)) {
        debugLog("intercepting execvp: {s}", .{path_slice});
        const result = callBroker(pathname, argv, true);
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
    const path_slice = std.mem.span(pathname);
    // Intercept if pathname contains '/' (POSIX: any slash means path, not PATH lookup)
    const should_check = std.mem.indexOfScalar(u8, path_slice, '/') != null;

    if (should_check and shouldIntercept(std.heap.c_allocator, pathname)) {
        debugLog("intercepting execvpe: {s}", .{path_slice});
        const result = callBroker(pathname, argv, true);
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
        // Child process. stdin_capable is false: this child was forked, not
        // exec'd, so its fd 0 is the spawn caller's — draining it here would
        // steal input from a process that keeps running after posix_spawn
        // returns.
        const result = callBroker(pathname, argv, false);
        if (result.outcome == .fallback) {
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

test {
    // Pull the sibling modules' tests into this root's test binary.
    _ = @import("protocol.zig");
    _ = @import("client_main.zig");
    _ = @import("fd_transport.zig");
    _ = @import("gateway_protocol.zig");
    _ = @import("gateway_executor.zig");
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
