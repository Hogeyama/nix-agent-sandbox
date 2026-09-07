const std = @import("std");
const posix = @import("posix");

pub const default_path: [:0]const u8 = "/bin:/usr/bin";

pub fn matchesInterceptPaths(resolved: []const u8, intercept_paths: []const u8) bool {
    var iter = std.mem.splitScalar(u8, intercept_paths, '\n');
    while (iter.next()) |entry| {
        const trimmed = std.mem.trim(u8, entry, &[_]u8{ ' ', '\t', '\r' });
        if (trimmed.len > 0 and std.mem.eql(u8, resolved, trimmed)) return true;
    }
    return false;
}

/// Only candidate command names need a spawn relay before PATH can be searched
/// in the child cwd. Leave unrelated commands with libc, including its errors.
pub fn matchesInterceptName(name: []const u8, intercept_paths: []const u8) bool {
    if (name.len == 0 or std.mem.indexOfScalar(u8, name, '/') != null) return false;
    var iter = std.mem.splitScalar(u8, intercept_paths, '\n');
    while (iter.next()) |entry| {
        const trimmed = std.mem.trim(u8, entry, &[_]u8{ ' ', '\t', '\r' });
        if (trimmed.len > 0 and std.mem.eql(u8, name, std.fs.path.basename(trimmed))) return true;
    }
    return false;
}

/// Search in the current cwd using the supplied caller PATH, without changing
/// the process environment. Empty PATH elements mean the current directory.
pub fn findExecutable(alloc: std.mem.Allocator, name: []const u8, path_env: []const u8) ![:0]u8 {
    var dirs = std.mem.splitScalar(u8, path_env, ':');
    while (dirs.next()) |dir| {
        const candidate = try std.fs.path.join(alloc, &.{ if (dir.len == 0) "." else dir, name });
        defer alloc.free(candidate);
        if (!posix.isRegularFile(candidate)) continue;
        posix.access(candidate, posix.X_OK) catch continue;
        return alloc.dupeZ(u8, candidate);
    }
    return error.FileNotFound;
}
