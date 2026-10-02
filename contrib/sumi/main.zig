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
//!   sumi serve  --secrets-file F --listen ADDR
//!   sumi --version
//!   sumi --licenses
//!
//! SOURCE は `--secrets-file F` か `--server ADDR` のどちらか 1 つ。後者は値の一覧を
//! 読まず、ブローカーへバイト列を送ってマスクさせる (masker.zig)。ブローカーは
//! `sumi serve` か nas の `nas-mask-filter --serve` で、どちらも一覧をホスト側に持つ。
//! ADDR は Unix ソケットのパス、`unix:///path`、`tcp://127.0.0.1:PORT`、
//! `tcp://[::1]:PORT` のどれか (supervise.address)。
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
/// ブローカーへ接続できなかった run が stderr へ出す診断。init の自己検査は、
/// これを「設定は正しいがブローカーが動いていない」の印として読む。
pub const UNREACHABLE_DIAGNOSTIC = "sumi: cannot reach the mask broker; output suppressed\n";
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
    \\       sumi serve  --secrets-file F --listen ADDR
    \\       sumi --version
    \\       sumi --licenses
    \\
    \\SOURCE is exactly one of --secrets-file F or --server ADDR.
    \\ADDR is a Unix socket path, unix:///PATH, tcp://127.0.0.1:PORT or tcp://[::1]:PORT.
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

const ServeArgs = struct { secrets_file: []const u8, listen: []const u8 };

fn parseServeArgs(args: []const []const u8) error{InvalidArguments}!ServeArgs {
    var secrets_file: ?[]const u8 = null;
    var listen: ?[]const u8 = null;
    var i: usize = 0;
    while (i < args.len) : (i += 2) {
        if (i + 1 >= args.len or !isOptionValue(args[i + 1])) return error.InvalidArguments;
        const slot = if (std.mem.eql(u8, args[i], "--secrets-file"))
            &secrets_file
        else if (std.mem.eql(u8, args[i], "--listen"))
            &listen
        else
            return error.InvalidArguments;
        if (slot.* != null) return error.InvalidArguments;
        slot.* = args[i + 1];
    }
    return .{
        .secrets_file = secrets_file orelse return error.InvalidArguments,
        .listen = listen orelse return error.InvalidArguments,
    };
}

/// `--listen` のパスを置くディレクトリが無ければ作る。ソケットの直上は他ユーザに
/// 中を見せないよう 0700 で作り、それより上は `mkdir -p` と同じく umask に任せる。
/// 既にあるディレクトリの権限は変えない。
fn makeSocketDir(sock_path: []const u8) !void {
    const dir = std.fs.path.dirname(sock_path) orelse return;
    std.posix.mkdir(dir, 0o700) catch |err| switch (err) {
        error.PathAlreadyExists => return,
        error.FileNotFound => {
            if (std.fs.path.dirname(dir)) |parent| try std.fs.cwd().makePath(parent);
            std.posix.mkdir(dir, 0o700) catch |retry| switch (retry) {
                error.PathAlreadyExists => return,
                else => return retry,
            };
        },
        else => return err,
    };
}

/// serve は一覧をこのプロセスに持ち、`--server` で接続してくる hook と run の
/// 問い合わせに答える。診断は定数の文言と利用者が渡した値だけにし、
/// 接続から届いたバイトは混ぜない (supervise.serve の「出力の不変条件」)。
fn runServe(allocator: std.mem.Allocator, args: []const []const u8) u8 {
    const parsed = parseServeArgs(args) catch return usage("serve takes --secrets-file F --listen ADDR");
    // 不正な ADDR は一覧を読む前に usage エラーにする。待ち受けられない値で
    // 一覧を読み込んでから失敗しても意味が無い。
    const listen = supervise.address.parse(parsed.listen) catch |err| return usage(switch (err) {
        error.SocketPathTooLong => "the --listen socket path must be at most 107 bytes",
        error.InvalidAddress => "--listen must be a socket path, unix:///PATH, tcp://127.0.0.1:PORT or tcp://[::1]:PORT (PORT 1-65535)",
    });
    const list = secrets.load(allocator, parsed.secrets_file) catch |err| {
        std.debug.print("sumi: {s}\n", .{secrets.describe(err)});
        return 1;
    };
    if (listen == .unix) makeSocketDir(listen.unix) catch |err| {
        std.debug.print("sumi: cannot create the directory of the --listen path: {s}\n", .{@errorName(err)});
        return 1;
    };
    // 接続ごとに確保と解放を繰り返すので、arena ではなく解放できるアロケータを渡す。
    return supervise.serve.run(std.heap.page_allocator, list, listen) catch |err| {
        if (err == error.ListenPathNotSocket) {
            std.debug.print("sumi: the --listen path exists and is not a socket\n", .{});
            return 1;
        }
        std.debug.print("sumi: serve failed: {s}\n", .{@errorName(err)});
        return 1;
    };
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
        error.SocketPathInvalid, error.RelayConnectFailed => UNREACHABLE_DIAGNOSTIC,
        error.RelayClosedEarly => "sumi: mask broker closed early; output suppressed\n",
        error.RelayDrainTimeout => "sumi: mask broker stopped responding; output suppressed\n",
        else => "sumi: supervise failed; output suppressed\n",
    };
}

fn runSupervised(allocator: std.mem.Allocator, args: []const []const u8) u8 {
    const parsed = parseRunArgs(args) catch return usage("run takes (--secrets-file F | --server ADDR) [--shell PATH] COMMAND, or [--argv0 NAME] -- PROGRAM [ARGS...]");
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
        // proxy は TCP の ADDR のときだけ使われる (srt の sandbox の中から
        // ホストのブローカーへ届く経路は proxy の CONNECT だけ)。
        .server => |server| return supervise.run(allocator, server.addr, supervise.proxyFromEnv(), target.argv0, target.program, target.args, opts) catch |err| {
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
    if (std.mem.eql(u8, sub, "serve")) return runServe(allocator, args);

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

test "codex and copilot hooks reject an invalid --server ADDR as a usage error" {
    inline for (.{ "codex", "copilot" }) |agent| {
        inline for (.{ "post-tool", "prompt" }) |event| {
            try testing.expectEqual(@as(u8, EXIT_USAGE), try dispatch(testing.allocator, &.{ "sumi", "hook", "--agent", agent, event, "--server", "tcp://localhost:1" }, unavailableSelfPath));
        }
    }
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
    const selected = try parseRunArgs(&.{ "--server", "/sock", "--shell", "/bin/zsh", "echo ok" });
    try testing.expectEqualStrings("/sock", selected.source.server.addr.unix);
    try testing.expectEqualStrings("/bin/zsh", selected.target.command.shell_path.?);
    try testing.expectError(error.InvalidArguments, parseRunArgs(&.{ "--secrets-file", "/s" }));
    try testing.expectError(error.InvalidArguments, parseRunArgs(&.{ "--secrets-file", "/s", "true", "extra" }));
    try testing.expectError(error.InvalidArguments, parseRunArgs(&.{ "--secrets-file", "/s", "--server", "/sock", "true" }));
}

test "run takes --server ADDR and rejects --socket and invalid addresses" {
    const tcp = try parseRunArgs(&.{ "--server", "tcp://127.0.0.1:47321", "true" });
    try testing.expectEqual(@as(u16, 47321), tcp.source.server.addr.tcp.getPort());
    try testing.expectError(error.InvalidArguments, parseRunArgs(&.{ "--socket", "/sock", "true" }));
    try testing.expectError(error.InvalidServerAddress, parseRunArgs(&.{ "--server", "tcp://localhost:47321", "true" }));
    try testing.expectEqual(@as(u8, EXIT_USAGE), try dispatch(testing.allocator, &.{ "sumi", "run", "--socket", "/sock", "true" }, unavailableSelfPath));
    try testing.expectEqual(@as(u8, EXIT_USAGE), try dispatch(testing.allocator, &.{ "sumi", "run", "--server", "tcp://127.0.0.1:0", "true" }, unavailableSelfPath));
}

test "run arguments in exec form pass every argument through" {
    const got = try parseRunArgs(&.{ "--server", "/sock", "--argv0", "-bash", "--", "/bin/bash.real", "-c", "echo hi", "--server" });
    try testing.expectEqualStrings("-bash", got.target.exec.argv0);
    try testing.expectEqualStrings("/bin/bash.real", got.target.exec.program);
    try testing.expectEqualSlices([]const u8, &.{ "-c", "echo hi", "--server" }, got.target.exec.args);
    const bare = try parseRunArgs(&.{ "--server", "/sock", "--", "/bin/bash" });
    try testing.expectEqualStrings("/bin/bash", bare.target.exec.argv0);
    try testing.expectEqual(@as(usize, 0), bare.target.exec.args.len);
    try testing.expectError(error.InvalidArguments, parseRunArgs(&.{ "--server", "/sock", "--" }));
    try testing.expectError(error.InvalidArguments, parseRunArgs(&.{ "--server", "/sock", "--argv0", "x", "echo" }));
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

test "serve arguments need both options once, in either order" {
    const got = try parseServeArgs(&.{ "--secrets-file", "/s", "--listen", "/sock" });
    try testing.expectEqualStrings("/s", got.secrets_file);
    try testing.expectEqualStrings("/sock", got.listen);
    const swapped = try parseServeArgs(&.{ "--listen", "/sock", "--secrets-file", "/s" });
    try testing.expectEqualStrings("/s", swapped.secrets_file);
    try testing.expectEqualStrings("/sock", swapped.listen);
}

test "serve arguments reject missing, repeated and unknown options" {
    try testing.expectError(error.InvalidArguments, parseServeArgs(&.{}));
    try testing.expectError(error.InvalidArguments, parseServeArgs(&.{ "--secrets-file", "/s" }));
    try testing.expectError(error.InvalidArguments, parseServeArgs(&.{ "--listen", "/sock" }));
    try testing.expectError(error.InvalidArguments, parseServeArgs(&.{ "--secrets-file", "/s", "--listen" }));
    try testing.expectError(error.InvalidArguments, parseServeArgs(&.{ "--secrets-file", "--listen", "/sock" }));
    try testing.expectError(error.InvalidArguments, parseServeArgs(&.{ "--secrets-file", "/s", "--secrets-file", "/t", "--listen", "/sock" }));
    try testing.expectError(error.InvalidArguments, parseServeArgs(&.{ "--socket", "/b", "--listen", "/sock" }));
    try testing.expectError(error.InvalidArguments, parseServeArgs(&.{ "--secrets-file", "/s", "--listen", "/sock", "stray" }));
}

test "serve rejects a socket path that cannot be bound before reading the list" {
    const too_long = "/" ** (supervise.address.MAX_SOCKET_PATH + 1);
    try testing.expectEqual(@as(u8, EXIT_USAGE), try dispatch(testing.allocator, &.{ "sumi", "serve", "--secrets-file", "/nonexistent/sumi-secrets", "--listen", too_long }, unavailableSelfPath));
}

test "serve --listen accepts the three ADDR forms and rejects the rest as usage errors" {
    // 一覧が無いので、ADDR を受け付ければ一覧の読み込みで 1、拒めば読む前に 2 になる。
    // どちらも待ち受けまで進まないので、環境に ::1 が無くても結果は変わらない。
    inline for (&.{ "/tmp/sumi-listen-test.sock", "unix:///tmp/sumi-listen-test.sock", "tcp://127.0.0.1:47321", "tcp://[::1]:47321" }) |good| {
        try testing.expectEqual(@as(u8, 1), try dispatch(testing.allocator, &.{ "sumi", "serve", "--secrets-file", "/nonexistent/sumi-secrets", "--listen", good }, unavailableSelfPath));
    }
    inline for (&.{ "tcp://localhost:47321", "tcp://10.0.0.1:47321", "tcp://127.0.0.1:0", "tcp://127.0.0.1:65536", "tcp://127.0.0.1", "unix://relative.sock", "tpc://127.0.0.1:1" }) |bad| {
        try testing.expectEqual(@as(u8, EXIT_USAGE), try dispatch(testing.allocator, &.{ "sumi", "serve", "--secrets-file", "/nonexistent/sumi-secrets", "--listen", bad }, unavailableSelfPath));
    }
}
