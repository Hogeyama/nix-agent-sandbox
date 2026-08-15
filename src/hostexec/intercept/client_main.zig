// client_main.zig — `nas-hostexec-client`, the standalone container-side client
// for hostexec rules whose argv0 is a bare command name.
//
// nas creates one symlink per such argv0 (`git`, `nix`, …) in the wrapper
// directory and puts that directory first on PATH inside the container. Every
// symlink points at this binary, so invoking `git` runs this program with
// argv[0] = the symlink. The request is forwarded to the broker; if no rule
// matches, the broker answers `fallback` and this program execs the real binary
// found further along PATH.
//
// It shares `protocol.zig` with the LD_PRELOAD library, so the request shape,
// the stdin policy, and the "never fall back after output was written" rule are
// the same on both paths. The only thing this file adds is the PATH-based
// fallback that the LD_PRELOAD library gets from libc instead.
//
// Built statically against musl: it has to run inside whatever image the agent
// container uses, without assuming a matching libc — or an interpreter.
//
// Environment variables consumed (in addition to protocol.zig's):
//   NAS_HOSTEXEC_WRAPPER_DIR – container path of the wrapper symlink directory

const std = @import("std");
const Allocator = std.mem.Allocator;

const protocol = @import("protocol.zig");

/// Exit code for "the command could not be run at all", matching the shell's
/// convention for a missing binary.
const exit_command_not_found = 127;

pub fn main() void {
    const alloc = std.heap.c_allocator;
    const argv_os = std.os.argv;
    if (argv_os.len == 0) {
        protocol.writeAll(2, "nas-hostexec-client: empty argv\n");
        protocol.doExit(exit_command_not_found);
    }

    // callBroker wants a null-terminated argv; std.os.argv is a plain slice.
    const argv_z = alloc.allocSentinel(?[*:0]const u8, argv_os.len, null) catch {
        protocol.doExit(exit_command_not_found);
    };
    for (argv_os, 0..) |arg, i| argv_z[i] = arg;

    // stdin_capable is true: this process *is* the command the caller asked
    // for, so its fd 0 is the command's stdin.
    const result = protocol.callBroker(argv_os[0], argv_z.ptr, true);
    if (result.outcome != .fallback) {
        protocol.doExit(result.exit_code);
    }
    fallbackExec(alloc, argv_z);
}

/// Exec the real binary that PATH would have found had the wrapper directory
/// not been in front of it.
fn fallbackExec(alloc: Allocator, argv_z: [:null]?[*:0]const u8) noreturn {
    const argv0 = std.mem.span(argv_z[0].?);

    // A relative argv0 reaches the broker through the LD_PRELOAD library, not
    // through a wrapper symlink, so there is no PATH entry to fall back to and
    // guessing one could run a different program than the caller named.
    if (!std.fs.path.isAbsolute(argv0) and std.mem.indexOfScalar(u8, argv0, '/') != null) {
        protocol.writeAll(2, "nas-hostexec-client: relative argv0 fallback is not supported: ");
        protocol.writeAll(2, argv0);
        protocol.writeAll(2, "\n");
        protocol.doExit(1);
    }

    const path_env = std.posix.getenv("PATH") orelse "";
    const wrapper_dir = std.posix.getenv("NAS_HOSTEXEC_WRAPPER_DIR") orelse "";
    const self_real = realpathAlloc(alloc, "/proc/self/exe");
    defer if (self_real) |s| alloc.free(s);

    const binary = findFallbackBinary(alloc, argv0, path_env, wrapper_dir, self_real) catch {
        protocol.writeAll(2, "nas-hostexec-client: fallback binary not found on PATH: ");
        protocol.writeAll(2, std.fs.path.basename(argv0));
        protocol.writeAll(2, "\n");
        protocol.doExit(exit_command_not_found);
    };
    const binary_z = alloc.dupeZ(u8, binary) catch protocol.doExit(exit_command_not_found);

    // Pass the resolved path as argv[0], the same substitution the python
    // wrapper this replaced performed: a command that re-execs itself by
    // argv[0] must not come back through the wrapper symlink.
    argv_z[0] = binary_z.ptr;
    protocol.debugLog("falling back to {s}", .{binary});
    const err = std.posix.execveZ(binary_z.ptr, argv_z.ptr, std.c.environ);
    protocol.debugLog("fallback exec failed: {s}", .{@errorName(err)});
    protocol.doExit(exit_command_not_found);
}

fn realpathAlloc(alloc: Allocator, path: []const u8) ?[]const u8 {
    return std.fs.cwd().realpathAlloc(alloc, path) catch null;
}

/// Search PATH for the real binary behind `argv0`, skipping this program's own
/// wrapper symlinks.
///
/// `self_real` is the canonical path of the running executable (null when it
/// could not be determined). Candidates are tested against `wrapper_dir` both
/// before and after canonicalisation, and against `self_real`, because no one
/// check covers every layout: the wrapper symlinks resolve to a binary
/// *outside* the wrapper directory, so a canonicalised candidate does not carry
/// the directory prefix; a PATH entry could name the wrapper directory by a
/// different-but-equivalent path; and `/proc/self/exe` may be unreadable.
/// Missing all of them means exec'ing the wrapper again — an endless loop that
/// hits the broker on every turn.
pub fn findFallbackBinary(
    alloc: Allocator,
    argv0: []const u8,
    path_env: []const u8,
    wrapper_dir: []const u8,
    self_real: ?[]const u8,
) ![]const u8 {
    const name = std.fs.path.basename(argv0);
    if (name.len == 0) return error.FallbackBinaryNotFound;

    const wrapper_real = realpathAlloc(alloc, wrapper_dir);
    defer if (wrapper_real) |w| alloc.free(w);

    var iter = std.mem.splitScalar(u8, path_env, ':');
    while (iter.next()) |dir| {
        if (dir.len == 0) continue;
        const candidate = try std.fs.path.join(alloc, &.{ dir, name });
        var keep = false;
        defer if (!keep) alloc.free(candidate);

        if (!isExecutableFile(candidate)) continue;

        // Check the candidate before canonicalising it as well: PATH holds the
        // wrapper directory verbatim, so this catches the symlink without
        // needing /proc — the one check that still works if `self_real` could
        // not be determined.
        if (isOwnWrapper(candidate, wrapper_dir, null)) continue;

        const candidate_real = realpathAlloc(alloc, candidate) orelse continue;
        defer alloc.free(candidate_real);
        if (isOwnWrapper(candidate_real, wrapper_real orelse wrapper_dir, self_real)) continue;

        keep = true;
        return candidate;
    }
    return error.FallbackBinaryNotFound;
}

fn isExecutableFile(path: []const u8) bool {
    // access(X_OK) alone is not enough: it succeeds for directories too.
    const stat = std.fs.cwd().statFile(path) catch return false;
    if (stat.kind != .file) return false;
    std.posix.access(path, std.posix.X_OK) catch return false;
    return true;
}

/// Whether a canonicalised PATH candidate is this program (directly or through
/// one of its wrapper symlinks), and would therefore loop back into the broker.
pub fn isOwnWrapper(
    candidate_real: []const u8,
    wrapper_dir: []const u8,
    self_real: ?[]const u8,
) bool {
    if (self_real) |self_path| {
        if (std.mem.eql(u8, candidate_real, self_path)) return true;
    }
    if (wrapper_dir.len == 0) return false;
    // Compare against the directory *plus* a separator so that a sibling
    // directory sharing the prefix (`…/bin2/git` vs `…/bin`) is not skipped.
    if (!std.mem.startsWith(u8, candidate_real, wrapper_dir)) return false;
    const rest = candidate_real[wrapper_dir.len..];
    return rest.len > 0 and rest[0] == '/';
}

// ─── Unit tests ─────────────────────────────────────────────────────

test "isOwnWrapper: candidate inside the wrapper directory" {
    try std.testing.expect(isOwnWrapper("/opt/nas/hostexec/bin/git", "/opt/nas/hostexec/bin", null));
}

test "isOwnWrapper: sibling directory sharing the prefix is not the wrapper dir" {
    try std.testing.expect(!isOwnWrapper("/opt/nas/hostexec/bin2/git", "/opt/nas/hostexec/bin", null));
}

test "isOwnWrapper: the wrapper directory itself is not a candidate" {
    try std.testing.expect(!isOwnWrapper("/opt/nas/hostexec/bin", "/opt/nas/hostexec/bin", null));
}

test "isOwnWrapper: candidate resolving to this executable" {
    // The wrapper symlinks resolve to the client binary, which lives outside
    // the wrapper directory -- so the directory check alone would miss it.
    try std.testing.expect(isOwnWrapper(
        "/opt/nas/hostexec/libexec/nas-hostexec-client",
        "/opt/nas/hostexec/bin",
        "/opt/nas/hostexec/libexec/nas-hostexec-client",
    ));
}

test "isOwnWrapper: unrelated binary" {
    try std.testing.expect(!isOwnWrapper("/usr/bin/git", "/opt/nas/hostexec/bin", "/opt/nas/hostexec/libexec/nas-hostexec-client"));
}

test "isOwnWrapper: no wrapper dir configured" {
    try std.testing.expect(!isOwnWrapper("/usr/bin/git", "", null));
}

test "findFallbackBinary: skips the wrapper symlink even without /proc/self/exe" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    const root = try tmp.dir.realpathAlloc(alloc, ".");
    defer alloc.free(root);

    try tmp.dir.makeDir("wrapper");
    try tmp.dir.makeDir("real");
    const wrapper_dir = try std.fs.path.join(alloc, &.{ root, "wrapper" });
    defer alloc.free(wrapper_dir);
    const real_dir = try std.fs.path.join(alloc, &.{ root, "real" });
    defer alloc.free(real_dir);

    try writeExecutable(tmp.dir, "nas-hostexec-client");
    try writeExecutable(tmp.dir, "real/git");
    const client_path = try std.fs.path.join(alloc, &.{ root, "nas-hostexec-client" });
    defer alloc.free(client_path);
    try tmp.dir.symLink(client_path, "wrapper/git", .{});

    const path_env = try std.mem.join(alloc, ":", &.{ wrapper_dir, real_dir });
    defer alloc.free(path_env);

    // self_real = null simulates an unreadable /proc/self/exe. Returning the
    // wrapper symlink here would re-exec this program forever.
    const found = try findFallbackBinary(alloc, "git", path_env, wrapper_dir, null);
    defer alloc.free(found);

    const expected = try std.fs.path.join(alloc, &.{ real_dir, "git" });
    defer alloc.free(expected);
    try std.testing.expectEqualStrings(expected, found);
}

test "findFallbackBinary: skips the wrapper directory and returns the real binary" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    const root = try tmp.dir.realpathAlloc(alloc, ".");
    defer alloc.free(root);

    try tmp.dir.makeDir("wrapper");
    try tmp.dir.makeDir("real");
    const wrapper_dir = try std.fs.path.join(alloc, &.{ root, "wrapper" });
    defer alloc.free(wrapper_dir);
    const real_dir = try std.fs.path.join(alloc, &.{ root, "real" });
    defer alloc.free(real_dir);

    // The client binary lives outside both directories; the wrapper entry is a
    // symlink to it, exactly as nas lays it out in the container.
    try writeExecutable(tmp.dir, "nas-hostexec-client");
    try writeExecutable(tmp.dir, "real/git");
    const client_path = try std.fs.path.join(alloc, &.{ root, "nas-hostexec-client" });
    defer alloc.free(client_path);
    try tmp.dir.symLink(client_path, "wrapper/git", .{});

    const path_env = try std.mem.join(alloc, ":", &.{ wrapper_dir, real_dir });
    defer alloc.free(path_env);

    const found = try findFallbackBinary(alloc, "git", path_env, wrapper_dir, client_path);
    defer alloc.free(found);

    const expected = try std.fs.path.join(alloc, &.{ real_dir, "git" });
    defer alloc.free(expected);
    try std.testing.expectEqualStrings(expected, found);
}

test "findFallbackBinary: takes the basename of an absolute argv0" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    const root = try tmp.dir.realpathAlloc(alloc, ".");
    defer alloc.free(root);
    try writeExecutable(tmp.dir, "git");

    // argv[0] is the wrapper symlink's absolute path; the search is for `git`.
    const argv0 = try std.fs.path.join(alloc, &.{ "/opt/nas/hostexec/bin", "git" });
    defer alloc.free(argv0);

    const found = try findFallbackBinary(alloc, argv0, root, "", null);
    defer alloc.free(found);
    try std.testing.expect(std.mem.endsWith(u8, found, "/git"));
}

test "findFallbackBinary: skips directories and non-executable files" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    const root = try tmp.dir.realpathAlloc(alloc, ".");
    defer alloc.free(root);

    // `a/git` is a directory, `b/git` is a non-executable file, `c/git` is the
    // real one. access(X_OK) succeeds on directories, so the first entry is the
    // one that catches a missing kind check.
    try tmp.dir.makePath("a/git");
    try tmp.dir.makePath("b");
    try tmp.dir.writeFile(.{ .sub_path = "b/git", .data = "not executable" });
    try tmp.dir.makePath("c");
    try writeExecutable(tmp.dir, "c/git");

    const path_env = try std.fmt.allocPrint(alloc, "{s}/a:{s}/b:{s}/c", .{ root, root, root });
    defer alloc.free(path_env);

    const found = try findFallbackBinary(alloc, "git", path_env, "", null);
    defer alloc.free(found);
    try std.testing.expect(std.mem.endsWith(u8, found, "/c/git"));
}

test "findFallbackBinary: reports not found when PATH has no match" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    const root = try tmp.dir.realpathAlloc(alloc, ".");
    defer alloc.free(root);

    try std.testing.expectError(
        error.FallbackBinaryNotFound,
        findFallbackBinary(alloc, "git", root, "", null),
    );
}

test "findFallbackBinary: empty PATH entries are skipped" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    const root = try tmp.dir.realpathAlloc(alloc, ".");
    defer alloc.free(root);
    try writeExecutable(tmp.dir, "git");

    const path_env = try std.fmt.allocPrint(alloc, "::{s}:", .{root});
    defer alloc.free(path_env);

    const found = try findFallbackBinary(alloc, "git", path_env, "", null);
    defer alloc.free(found);
    try std.testing.expect(std.mem.endsWith(u8, found, "/git"));
}

fn writeExecutable(dir: std.fs.Dir, sub_path: []const u8) !void {
    var file = try dir.createFile(sub_path, .{ .mode = 0o755 });
    defer file.close();
    try file.writeAll("#!/bin/sh\n");
}
