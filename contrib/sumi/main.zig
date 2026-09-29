//! sumi: 列挙した値をエージェントに見せない単一バイナリ。
//!
//!   sumi init   --agent claude SOURCE [--root DIR]... [--deny-path P]... [--settings FILE] [--shell PATH]
//!   sumi scan   --agent claude --secrets-file F [--root DIR] [--settings FILE]
//!   sumi hook   --agent claude|codex|copilot post-tool SOURCE
//!   sumi hook   --agent claude|codex prompt SOURCE [--root DIR]... [--deny-path P]...
//!   sumi hook   --agent copilot prompt SOURCE
//!   sumi run    SOURCE [--shell PATH] COMMAND
//!   sumi run    SOURCE [--argv0 NAME] -- PROGRAM [ARGS...]
//!   sumi filter --secrets-file F
//!   sumi --version
//!   sumi --licenses
//!
//! SOURCE は `--secrets-file F` か `--socket SOCKET` のどちらか 1 つ。後者は値の一覧を
//! 読まず、`nas-mask-filter --serve` のブローカーへバイト列を送ってマスクさせる
//! (masker.zig)。
//!
//! 終了コード: 引数の解釈に失敗したときだけ 2。hook サブコマンドはそれ以降どの失敗でも
//! 0 で決定 (withhold / block / deny) を返す。run は子の終了ステータスで終わり、マスク
//! されたと確信できないバイト列が生じたときだけ出力を捨てて 121 で終わる。

const std = @import("std");
const build_options = @import("build_options");
const licenses = @import("licenses");
const supervise = @import("supervise");
const mask_stream = @import("masking").stream;
const secrets = @import("secrets.zig");
const masker = @import("masker.zig");
const shell = @import("shell.zig");
const claude_post = @import("claude/hook_post.zig");
const claude_prompt = @import("claude/hook_prompt.zig");
const claude_init = @import("claude/init.zig");
const claude_scan = @import("claude/scan.zig");
const agent_hooks = @import("agent_hooks.zig");

pub const EXIT_USAGE: u8 = 2;
pub const EXIT_SUPPRESSED: u8 = 121;
pub const PROG: []const u8 = "sumi";
pub const MARKER_ENV: [:0]const u8 = "SUMI_SUPERVISED=1";

const usage_text =
    \\usage: sumi init   --agent claude SOURCE [--root DIR]... [--deny-path P]... [--settings FILE] [--shell PATH]
    \\       sumi scan   --agent claude --secrets-file F [--root DIR] [--settings FILE]
    \\       sumi hook   --agent claude|codex|copilot post-tool SOURCE
    \\       sumi hook   --agent claude|codex prompt SOURCE [--root DIR]... [--deny-path P]...
    \\       sumi hook   --agent copilot prompt SOURCE
    \\       sumi run    SOURCE [--shell PATH] COMMAND
    \\       sumi run    SOURCE [--argv0 NAME] -- PROGRAM [ARGS...]
    \\       sumi filter --secrets-file F
    \\       sumi --version
    \\       sumi --licenses
    \\
    \\SOURCE is exactly one of --secrets-file F or --socket SOCKET.
    \\
;

/// `sumi --licenses` が出す、sumi と静的にリンクした部品の著作権・許諾表示。
const licenses_text =
    "sumi\n====\n\n" ++ licenses.sumi ++
    "\nZig standard library and compiler runtime\n=========================================\n\n" ++ licenses.zig ++
    "\nmusl libc (statically linked)\n=============================\n\n" ++ licenses.musl;

pub fn usage(msg: []const u8) u8 {
    std.debug.print("sumi: {s}\n{s}", .{ msg, usage_text });
    return EXIT_USAGE;
}

pub const Agent = enum { claude, codex, copilot };

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
    mask_stream.streamMask(stdin.deprecatedReader(), stdout.deprecatedWriter(), list) catch |err| {
        std.debug.print("sumi: stream error: {}\n", .{err});
        return 1;
    };
    return 0;
}

const ExecTarget = struct { argv0: []const u8, program: []const u8, args: []const []const u8 };
const RunTarget = union(enum) {
    /// `[--shell PATH] COMMAND`: シェルに 1 つのコマンド文字列を渡す。CLAUDE_CODE_SHELL_PREFIX 向け。
    command: struct { shell_path: ?[]const u8, command: []const u8 },
    /// `[--argv0 NAME] -- PROGRAM [ARGS...]`: 引数をそのまま渡して execve する (PATH 探索はしない)。
    /// bash を丸ごと包むラッパー向け。
    exec: ExecTarget,
};
const RunArgs = struct { source: masker.Source, target: RunTarget };

fn isOptionValue(value: []const u8) bool {
    return value.len != 0 and !std.mem.startsWith(u8, value, "--");
}

fn parseRunArgs(args: []const []const u8) !RunArgs {
    if (args.len < 2 or !masker.SourceOption.isName(args[0]) or !isOptionValue(args[1])) return error.InvalidArguments;
    var source = masker.SourceOption{};
    try source.take(args[0], args[1]);
    const rest = args[2..];
    const src = try source.finish();

    var i: usize = 0;
    var argv0: ?[]const u8 = null;
    if (rest.len >= 2 and std.mem.eql(u8, rest[0], "--argv0")) {
        if (rest[1].len == 0) return error.InvalidArguments;
        argv0 = rest[1];
        i = 2;
    }
    if (i < rest.len and std.mem.eql(u8, rest[i], "--")) {
        if (i + 1 >= rest.len or rest[i + 1].len == 0) return error.InvalidArguments;
        const program = rest[i + 1];
        return .{ .source = src, .target = .{ .exec = .{ .argv0 = argv0 orelse program, .program = program, .args = rest[i + 2 ..] } } };
    }
    if (argv0 != null) return error.InvalidArguments;

    if (rest.len >= 1 and std.mem.eql(u8, rest[0], "--shell")) {
        if (rest.len != 3 or !isOptionValue(rest[1])) return error.InvalidArguments;
        return .{ .source = src, .target = .{ .command = .{ .shell_path = rest[1], .command = rest[2] } } };
    }
    if (rest.len != 1) return error.InvalidArguments;
    return .{ .source = src, .target = .{ .command = .{ .shell_path = null, .command = rest[0] } } };
}

/// run の失敗を伝える診断。この経路はマスクを通らない本物の stderr へ出るので、
/// 子の出力に由来する値を混ぜない。
fn superviseDiagnostic(err: anyerror) []const u8 {
    return switch (err) {
        error.SocketPathInvalid, error.RelayConnectFailed => "sumi: cannot reach the mask broker; output suppressed\n",
        error.RelayClosedEarly => "sumi: mask broker closed early; output suppressed\n",
        error.RelayDrainTimeout => "sumi: mask broker stopped responding; output suppressed\n",
        else => "sumi: supervise failed; output suppressed\n",
    };
}

fn runSupervised(allocator: std.mem.Allocator, args: []const []const u8) u8 {
    const parsed = parseRunArgs(args) catch return usage("run takes (--secrets-file F | --socket SOCKET) [--shell PATH] COMMAND, or [--argv0 NAME] -- PROGRAM [ARGS...]");
    const target: ExecTarget = switch (parsed.target) {
        .exec => |e| e,
        .command => |c| blk: {
            const shell_path = if (c.shell_path) |path|
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
            const shell_args = allocator.dupe([]const u8, &.{ "-c", c.command }) catch {
                std.debug.print("sumi: out of memory; output suppressed\n", .{});
                return EXIT_SUPPRESSED;
            };
            break :blk .{ .argv0 = shell_path, .program = shell_path, .args = shell_args };
        },
    };
    const opts: supervise.Options = .{ .prog_name = PROG, .marker_env = MARKER_ENV };
    switch (parsed.source) {
        .secrets_file => |path| {
            const list = secrets.load(allocator, path) catch |err| {
                std.debug.print("sumi: {s}; output suppressed\n", .{secrets.describe(err)});
                return EXIT_SUPPRESSED;
            };
            return supervise.runLocal(allocator, list, target.argv0, target.program, target.args, opts) catch |err| {
                std.debug.print("{s}", .{superviseDiagnostic(err)});
                return EXIT_SUPPRESSED;
            };
        },
        .socket => |path| return supervise.run(allocator, path, target.argv0, target.program, target.args, opts) catch |err| {
            std.debug.print("{s}", .{superviseDiagnostic(err)});
            return EXIT_SUPPRESSED;
        },
    }
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
    if (std.mem.eql(u8, sub, "--licenses")) {
        try std.fs.File.stdout().writeAll(licenses_text);
        return 0;
    }
    if (std.mem.eql(u8, sub, "filter")) return runFilter(allocator, args);
    if (std.mem.eql(u8, sub, "run")) return runSupervised(allocator, args);

    if (std.mem.eql(u8, sub, "hook") or std.mem.eql(u8, sub, "init") or std.mem.eql(u8, sub, "scan")) {
        const taken = takeAgent(args) catch return usage("unsupported --agent value (expected claude, codex or copilot)");
        const agent = taken.agent orelse return usage("--agent is required");
        switch (agent) {
            .codex, .copilot => {
                if (!std.mem.eql(u8, sub, "hook")) return usage("init and scan only support --agent claude");
                if (taken.rest.len == 0) return usage("hook needs a subcommand: post-tool | prompt");
                const hook = taken.rest[0];
                const hook_args = taken.rest[1..];
                if (std.mem.eql(u8, hook, "post-tool")) return switch (agent) {
                    .codex => agent_hooks.main(allocator, .codex, .post_tool, hook_args),
                    .copilot => agent_hooks.main(allocator, .copilot, .post_tool, hook_args),
                    else => unreachable,
                };
                if (std.mem.eql(u8, hook, "prompt")) return switch (agent) {
                    .codex => claude_prompt.mainForAgent(.codex, allocator, hook_args),
                    .copilot => agent_hooks.main(allocator, .copilot, .prompt, hook_args),
                    else => unreachable,
                };
                return usage("unknown hook subcommand");
            },
            .claude => {
                if (std.mem.eql(u8, sub, "init")) {
                    const self = resolve_self_path(allocator) catch {
                        std.debug.print("sumi: executable path could not be resolved\n", .{});
                        return 1;
                    };
                    return claude_init.main(allocator, taken.rest, self);
                }
                if (std.mem.eql(u8, sub, "scan")) return claude_scan.main(allocator, taken.rest);
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
    _ = @import("agent_hooks.zig");
    _ = @import("secrets.zig");
    _ = @import("shell.zig");
    _ = @import("jsonio.zig");
    _ = @import("masker.zig");
    _ = @import("claude/hook_post.zig");
    _ = @import("claude/hook_prompt.zig");
    _ = @import("claude/init.zig");
    _ = @import("claude/scan.zig");
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
    try testing.expectEqualStrings("/s", defaulted.source.secrets_file);
    try testing.expectEqual(@as(?[]const u8, null), defaulted.target.command.shell_path);
    try testing.expectEqualStrings("echo 'a b'; exit 3", defaulted.target.command.command);
    const selected = try parseRunArgs(&.{ "--socket", "/sock", "--shell", "/bin/zsh", "echo ok" });
    try testing.expectEqualStrings("/sock", selected.source.socket);
    try testing.expectEqualStrings("/bin/zsh", selected.target.command.shell_path.?);
    try testing.expectError(error.InvalidArguments, parseRunArgs(&.{ "--secrets-file", "/s" }));
    try testing.expectError(error.InvalidArguments, parseRunArgs(&.{ "--secrets-file", "/s", "true", "extra" }));
    try testing.expectError(error.InvalidArguments, parseRunArgs(&.{ "--secrets-file", "/s", "--socket", "/sock", "true" }));
}

test "run arguments in exec form pass every argument through" {
    const got = try parseRunArgs(&.{ "--socket", "/sock", "--argv0", "-bash", "--", "/bin/bash.real", "-c", "echo hi", "--socket" });
    try testing.expectEqualStrings("-bash", got.target.exec.argv0);
    try testing.expectEqualStrings("/bin/bash.real", got.target.exec.program);
    try testing.expectEqualSlices([]const u8, &.{ "-c", "echo hi", "--socket" }, got.target.exec.args);
    const bare = try parseRunArgs(&.{ "--socket", "/sock", "--", "/bin/bash" });
    try testing.expectEqualStrings("/bin/bash", bare.target.exec.argv0);
    try testing.expectEqual(@as(usize, 0), bare.target.exec.args.len);
    try testing.expectError(error.InvalidArguments, parseRunArgs(&.{ "--socket", "/sock", "--" }));
    try testing.expectError(error.InvalidArguments, parseRunArgs(&.{ "--socket", "/sock", "--argv0", "x", "echo" }));
}

test "takeAgent: claude is accepted and consumed" {
    const t = try takeAgent(&.{ "--agent", "claude", "post-tool" });
    try testing.expectEqual(Agent.claude, t.agent.?);
    try testing.expectEqual(@as(usize, 1), t.rest.len);
}

test "licenses_text carries every bundled notice" {
    try testing.expect(std.mem.indexOf(u8, licenses_text, "Copyright (c) 2026 Hogeyama") != null);
    try testing.expect(std.mem.indexOf(u8, licenses_text, "Copyright (c) Zig contributors") != null);
    try testing.expect(std.mem.indexOf(u8, licenses_text, "Rich Felker") != null);
    // musl の個別表示 (TRE など) も MIT 本文と一緒に落とさない。
    try testing.expect(std.mem.indexOf(u8, licenses_text, "Ville Laurikari") != null);
}

test "takeAgent: missing --agent yields null" {
    const t = try takeAgent(&.{"post-tool"});
    try testing.expectEqual(@as(?Agent, null), t.agent);
}

test "takeAgent: unsupported agent is an error" {
    try testing.expectError(error.UnsupportedAgent, takeAgent(&.{ "--agent", "unknown" }));
}

test "filter arguments have one fixed form" {
    try testing.expectEqual(@as(?[]const u8, null), filterPath(&.{}));
    try testing.expectEqual(@as(?[]const u8, null), filterPath(&.{ "--secrets-file", "/x", "--unsupported" }));
    try testing.expectEqualStrings("/x", filterPath(&.{ "--secrets-file", "/x" }).?);
}
