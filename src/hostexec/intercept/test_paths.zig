//! Test-only paths.
//!
//! Normal development uses the conventional host locations. Nix injects a
//! directory containing the explicitly declared test tools so the same tests
//! do not depend on an impure /bin or /usr/bin inside its build sandbox.
//!
//! Also owns the directory tests bind their unix sockets in, because that
//! path has a length limit the rest of the code does not.

const std = @import("std");
const options = @import("hostexec_test_options");

pub fn executable(comptime name: []const u8) []const u8 {
    if (comptime std.mem.eql(u8, name, "true")) return options.true_path;
    if (comptime std.mem.eql(u8, name, "sh")) return options.sh_path;
    if (comptime std.mem.eql(u8, name, "cat")) return options.cat_path;
    if (comptime std.mem.eql(u8, name, "ls")) return options.ls_path;
    if (comptime std.mem.eql(u8, name, "sleep")) return options.sleep_path;
    if (comptime std.mem.eql(u8, name, "env")) return options.env_path;
    @compileError("unknown hostexec test executable: " ++ name);
}

pub fn addToolPath(env: *std.process.EnvMap) !void {
    try env.put("PATH", if (options.bin_dir.len == 0) "/bin:/usr/bin" else options.bin_dir);
}

/// Creates a private directory for a test's unix sockets and returns its path.
///
/// `std.testing.tmpDir` roots at `<cwd>/.zig-cache/tmp/<16 hex>`, so a socket
/// path derived from it carries the length of the checkout path. `sun_path`
/// holds 108 bytes, which a checkout at
/// `/home/runner/work/<repo>/<repo>/src/hostexec/intercept` already overruns
/// while a shorter local checkout does not — that difference is exactly the
/// shape of bug that passes locally and fails only on CI. Rooting the sockets
/// at TMPDIR keeps the length independent of where the repository sits.
///
/// The caller owns the returned path and must release it with
/// `removeSocketDir`.
pub fn makeSocketDir(allocator: std.mem.Allocator) ![]u8 {
    var suffix: [8]u8 = undefined;
    std.crypto.random.bytes(&suffix);
    const hex = std.fmt.bytesToHex(suffix, .lower);
    const base = std.posix.getenv("TMPDIR") orelse "/tmp";
    const path = try std.fmt.allocPrint(allocator, "{s}/nas-hostexec-{s}", .{ base, &hex });
    errdefer allocator.free(path);
    // 0o700 because the sockets inside accept commands: TMPDIR is shared, and
    // the tests are the only party that may reach them.
    try std.posix.mkdir(path, 0o700);
    return path;
}

/// Removes a directory from `makeSocketDir` and frees its path.
pub fn removeSocketDir(allocator: std.mem.Allocator, path: []u8) void {
    std.fs.deleteTreeAbsolute(path) catch {};
    allocator.free(path);
}
