//! sumi: 列挙した値を Claude Code に見せない単一バイナリ。
//!
//!   sumi init   --agent claude --secrets-file F [--root DIR]... [--deny-path P]... [--settings FILE] [--shell PATH]
//!   sumi hook   --agent claude post-tool --secrets-file F
//!   sumi hook   --agent claude prompt    --secrets-file F [--root DIR]... [--deny-path P]...
//!   sumi run    --secrets-file F [--shell PATH] COMMAND
//!   sumi filter --secrets-file F
//!   sumi --version
//!
//! 終了コード: 引数の解釈に失敗したときだけ 2。hook サブコマンドはそれ以降どの失敗でも
//! 0 で決定 (withhold / block / deny) を返す。run は子の終了ステータスで終わり、マスク
//! されたと確信できないバイト列が生じたときだけ出力を捨てて 121 で終わる。

const std = @import("std");
const build_options = @import("build_options");
const supervise = @import("supervise");
const secrets = @import("secrets.zig");
const shell = @import("shell.zig");
const claude_post = @import("claude/hook_post.zig");
const claude_prompt = @import("claude/hook_prompt.zig");
const claude_init = @import("claude/init.zig");

pub const EXIT_USAGE: u8 = 2;
pub const EXIT_SUPPRESSED: u8 = 121;
pub const PROG: []const u8 = "sumi";
pub const MARKER_ENV: [:0]const u8 = "SUMI_SUPERVISED=1";

const usage_text =
    \\usage: sumi init   --agent claude --secrets-file F [--root DIR]... [--deny-path P]... [--settings FILE] [--shell PATH]
    \\       sumi hook   --agent claude post-tool --secrets-file F
    \\       sumi hook   --agent claude prompt    --secrets-file F [--root DIR]... [--deny-path P]...
    \\       sumi run    --secrets-file F [--shell PATH] COMMAND
    \\       sumi filter --secrets-file F
    \\       sumi --version
    \\
;

pub fn usage(msg: []const u8) u8 {
    std.debug.print("sumi: {s}\n{s}", .{ msg, usage_text });
    return EXIT_USAGE;
}

pub const Agent = enum { claude };

/// `--agent VALUE` を argv から取り出す。無ければ null、未対応の値は error。
pub fn takeAgent(args: []const []const u8) !struct { agent: ?Agent, rest: []const []const u8 } {
    if (args.len >= 2 and std.mem.eql(u8, args[0], "--agent")) {
        const agent = std.meta.stringToEnum(Agent, args[1]) orelse return error.UnsupportedAgent;
        return .{ .agent = agent, .rest = args[2..] };
    }
    return .{ .agent = null, .rest = args };
}

fn filterPath(args: []const []const u8) ?[]const u8 {
    if (args.len != 2 or !std.mem.eql(u8, args[0], "--secrets-file")) return null;
    return args[1];
}

fn runFilter(allocator: std.mem.Allocator, args: []const []const u8) u8 {
    const path = filterPath(args) orelse return usage("filter takes --secrets-file F");
    const list = secrets.load(allocator, path) catch |err| {
        std.debug.print("sumi: {s}\n", .{secrets.describe(err)});
        return 1;
    };
    const stdin = std.fs.File.stdin();
    const stdout = std.fs.File.stdout();
    supervise.mask_stream.streamMask(stdin.deprecatedReader(), stdout.deprecatedWriter(), list) catch |err| {
        std.debug.print("sumi: stream error: {}\n", .{err});
        return 1;
    };
    return 0;
}

const RunArgs = struct { secrets_file: []const u8, shell_path: ?[]const u8, command: []const u8 };

fn parseRunArgs(args: []const []const u8) !RunArgs {
    if (args.len < 3 or !std.mem.eql(u8, args[0], "--secrets-file")) return error.InvalidArguments;
    if (args[1].len == 0 or std.mem.startsWith(u8, args[1], "--")) return error.InvalidArguments;
    if (std.mem.eql(u8, args[2], "--shell")) {
        if (args.len != 5 or args[3].len == 0 or std.mem.startsWith(u8, args[3], "--")) return error.InvalidArguments;
        return .{ .secrets_file = args[1], .shell_path = args[3], .command = args[4] };
    }
    if (args.len != 3) return error.InvalidArguments;
    return .{ .secrets_file = args[1], .shell_path = null, .command = args[2] };
}

fn runSupervised(allocator: std.mem.Allocator, args: []const []const u8) u8 {
    const parsed = parseRunArgs(args) catch return usage("run takes --secrets-file F [--shell PATH] COMMAND");
    const shell_path = if (parsed.shell_path) |path|
        std.fs.cwd().realpathAlloc(allocator, path) catch {
            std.debug.print("sumi: the shell path could not be resolved; output suppressed\n", .{});
            return EXIT_SUPPRESSED;
        }
    else
        (shell.resolveBash(allocator) catch null) orelse {
            std.debug.print("sumi: bash was not found on PATH; output suppressed\n", .{});
            return EXIT_SUPPRESSED;
        };
    if (!shell.isExecutableFile(shell_path)) {
        std.debug.print("sumi: the shell is not a regular executable file; output suppressed\n", .{});
        return EXIT_SUPPRESSED;
    }
    const list = secrets.load(allocator, parsed.secrets_file) catch |err| {
        std.debug.print("sumi: {s}; output suppressed\n", .{secrets.describe(err)});
        return EXIT_SUPPRESSED;
    };
    return supervise.runLocal(allocator, list, shell_path, shell_path, &.{ "-c", parsed.command }, .{
        .prog_name = PROG,
        .marker_env = MARKER_ENV,
    }) catch |err| {
        std.debug.print("sumi: supervise failed: {}; output suppressed\n", .{err});
        return EXIT_SUPPRESSED;
    };
}

fn selfPath(allocator: std.mem.Allocator) ![]u8 {
    return std.fs.selfExePathAlloc(allocator);
}

fn processArgs(allocator: std.mem.Allocator) ?[][:0]u8 {
    return std.process.argsAlloc(allocator) catch {
        std.debug.print("sumi: process arguments could not be read\n", .{});
        return null;
    };
}

const SelfPathFn = *const fn (std.mem.Allocator) anyerror![]u8;

fn dispatch(allocator: std.mem.Allocator, argv: []const []const u8, resolve_self_path: SelfPathFn) !u8 {
    if (argv.len < 2) return usage("no subcommand");
    const sub = argv[1];
    const args: []const []const u8 = @ptrCast(argv[2..]);

    if (std.mem.eql(u8, sub, "--version")) {
        try std.fs.File.stdout().writeAll("sumi ");
        try std.fs.File.stdout().writeAll(build_options.version);
        try std.fs.File.stdout().writeAll("\n");
        return 0;
    }
    if (std.mem.eql(u8, sub, "filter")) return runFilter(allocator, args);
    if (std.mem.eql(u8, sub, "run")) return runSupervised(allocator, args);

    if (std.mem.eql(u8, sub, "hook") or std.mem.eql(u8, sub, "init")) {
        const taken = takeAgent(args) catch return usage("unsupported --agent value (only 'claude' is implemented)");
        const agent = taken.agent orelse return usage("--agent is required");
        switch (agent) {
            .claude => {
                if (std.mem.eql(u8, sub, "init")) {
                    const self = resolve_self_path(allocator) catch {
                        std.debug.print("sumi: executable path could not be resolved\n", .{});
                        return 1;
                    };
                    return claude_init.main(allocator, taken.rest, self);
                }
                if (taken.rest.len == 0) return usage("hook needs a subcommand: post-tool | prompt");
                const hook = taken.rest[0];
                const hook_args = taken.rest[1..];
                if (std.mem.eql(u8, hook, "post-tool")) return claude_post.main(allocator, hook_args);
                if (std.mem.eql(u8, hook, "prompt")) return claude_prompt.main(allocator, hook_args);
                return usage("unknown hook subcommand");
            },
        }
    }
    return usage("unknown subcommand");
}

pub fn main() !u8 {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const argv = processArgs(allocator) orelse return 1;
    return dispatch(allocator, argv, selfPath);
}

test {
    _ = @import("secrets.zig");
    _ = @import("shell.zig");
    _ = @import("jsonio.zig");
    _ = @import("claude/hook_post.zig");
    _ = @import("claude/hook_prompt.zig");
    _ = @import("claude/init.zig");
}

const testing = std.testing;

fn unavailableSelfPath(_: std.mem.Allocator) ![]u8 {
    return error.Unavailable;
}

test "argument allocation failure becomes a handled startup failure" {
    try testing.expectEqual(@as(?[][:0]u8, null), processArgs(testing.failing_allocator));
}

test "post-tool and prompt dispatch do not resolve the executable path" {
    try testing.expectEqual(@as(u8, EXIT_USAGE), try dispatch(testing.allocator, &.{ "sumi", "hook", "--agent", "claude", "post-tool", "--invalid", "x" }, unavailableSelfPath));
    try testing.expectEqual(@as(u8, EXIT_USAGE), try dispatch(testing.allocator, &.{ "sumi", "hook", "--agent", "claude", "prompt", "--invalid", "x" }, unavailableSelfPath));
}

test "run arguments carry one complete command and optional shell" {
    const defaulted = try parseRunArgs(&.{ "--secrets-file", "/s", "echo 'a b'; exit 3" });
    try testing.expectEqualStrings("/s", defaulted.secrets_file);
    try testing.expectEqual(@as(?[]const u8, null), defaulted.shell_path);
    try testing.expectEqualStrings("echo 'a b'; exit 3", defaulted.command);
    const selected = try parseRunArgs(&.{ "--secrets-file", "/s", "--shell", "/bin/zsh", "echo ok" });
    try testing.expectEqualStrings("/bin/zsh", selected.shell_path.?);
    try testing.expectError(error.InvalidArguments, parseRunArgs(&.{ "--secrets-file", "/s" }));
    try testing.expectError(error.InvalidArguments, parseRunArgs(&.{ "--secrets-file", "/s", "true", "extra" }));
}

test "takeAgent: claude is accepted and consumed" {
    const t = try takeAgent(&.{ "--agent", "claude", "post-tool" });
    try testing.expectEqual(Agent.claude, t.agent.?);
    try testing.expectEqual(@as(usize, 1), t.rest.len);
}

test "takeAgent: missing --agent yields null" {
    const t = try takeAgent(&.{"post-tool"});
    try testing.expectEqual(@as(?Agent, null), t.agent);
}

test "takeAgent: unsupported agent is an error" {
    try testing.expectError(error.UnsupportedAgent, takeAgent(&.{ "--agent", "copilot" }));
}

test "filter arguments have one fixed form" {
    try testing.expectEqual(@as(?[]const u8, null), filterPath(&.{}));
    try testing.expectEqual(@as(?[]const u8, null), filterPath(&.{ "--secrets-file", "/x", "--unsupported" }));
    try testing.expectEqualStrings("/x", filterPath(&.{ "--secrets-file", "/x" }).?);
}
