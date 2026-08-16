//! Test-only executable paths.
//!
//! Normal development uses the conventional host locations. Nix injects a
//! directory containing the explicitly declared test tools so the same tests
//! do not depend on an impure /bin or /usr/bin inside its build sandbox.

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
