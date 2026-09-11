//! PreToolUse(Bash): コマンドを `sumi run` の下に書き換える。
//!
//! 失敗したツール呼び出しの出力は後から差し替えられない (PostToolUseFailure の
//! `error` は updatedToolOutput を受け付けない)。Bash だけは生成源で潰せるので、
//! Claude Code が 1 バイトも読む前のパイプでマスクする。
//!
//! `permissionDecision` は返さない。返すと通常の権限判定を上書きしてしまう
//! (`allow` なら全 Bash が承認プロンプトを迂回する)。返さなければ書き換え後の
//! command に対して通常どおり判定される。
//!
//! 代償: Claude Code からは本来のコマンドが見えなくなる。パスベースの Read deny が
//! Bash の cat に効かなくなり、Bash(...) の allow ルールはラッパーに対して照合される。

const std = @import("std");
const jsonio = @import("../jsonio.zig");
const shell = @import("../shell.zig");
const secrets = @import("../secrets.zig");
const cli = @import("../main.zig");

const FALLBACK_DENY = "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"sumi: the pre-bash hook failed, so the command was not run.\"}}";

const Output = struct {
    context: *anyopaque,
    writeFn: *const fn (context: *anyopaque, bytes: []const u8) anyerror!void,

    fn write(self: Output, bytes: []const u8) !void {
        return self.writeFn(self.context, bytes);
    }
};

const HookArgs = struct {
    secrets_file: []const u8,
    shell_path: []const u8,
};

fn parseArgs(args: []const []const u8) !HookArgs {
    var secrets_file: ?[]const u8 = null;
    var shell_path: ?[]const u8 = null;
    var i: usize = 0;
    while (i < args.len) : (i += 2) {
        const name = args[i];
        if (!std.mem.eql(u8, name, "--secrets-file") and !std.mem.eql(u8, name, "--shell")) return error.UnknownOption;
        if (i + 1 == args.len or std.mem.startsWith(u8, args[i + 1], "--")) return error.MissingOptionValue;
        const value = args[i + 1];
        if (std.mem.eql(u8, name, "--secrets-file")) {
            if (secrets_file != null) return error.DuplicateOption;
            secrets_file = value;
        } else {
            if (shell_path != null) return error.DuplicateOption;
            shell_path = value;
        }
    }
    return .{
        .secrets_file = secrets_file orelse return error.MissingSecretsFile,
        .shell_path = shell_path orelse return error.MissingShell,
    };
}

pub fn rewrite(
    allocator: std.mem.Allocator,
    self_path: []const u8,
    secrets_file: []const u8,
    shell_path: []const u8,
    command: []const u8,
) ![]u8 {
    return shell.join(allocator, &.{
        self_path, "run", "--secrets-file", secrets_file, "--", shell_path, "-c", command,
    });
}

fn rewriteForHook(
    allocator: std.mem.Allocator,
    self_path: []const u8,
    secrets_file: []const u8,
    shell_path: []const u8,
    command: []const u8,
) ?[]u8 {
    return rewrite(allocator, self_path, secrets_file, shell_path, command) catch null;
}

/// 既にこの設定で生成した完全な wrapper なら二重に包まない。固定引数と最後の
/// command 引数を含め、入力全体が shell.join の正規形でなければ一致させない。
pub fn isWrapped(
    allocator: std.mem.Allocator,
    self_path: []const u8,
    secrets_file: []const u8,
    shell_path: []const u8,
    command: []const u8,
) !bool {
    const prefix = try shell.join(allocator, &.{ self_path, "run", "--secrets-file", secrets_file, "--", shell_path, "-c" });
    defer allocator.free(prefix);
    if (command.len <= prefix.len or !std.mem.eql(u8, command[0..prefix.len], prefix)) return false;
    if (command[prefix.len] != ' ') return false;
    return shell.isCanonicalWord(command[prefix.len + 1 ..]);
}

pub fn buildDecision(allocator: std.mem.Allocator, payload: *std.json.Value, wrapped: []const u8) ![]u8 {
    const tool_input = jsonio.getObject(payload.*, "tool_input") orelse return error.NoToolInput;
    try tool_input.put("command", .{ .string = wrapped });
    const input_json = try jsonio.stringify(allocator, .{ .object = tool_input.* });
    defer allocator.free(input_json);
    return std.fmt.allocPrint(
        allocator,
        "{{\"hookSpecificOutput\":{{\"hookEventName\":\"PreToolUse\",\"updatedInput\":{s}}}}}",
        .{input_json},
    );
}

pub fn denyJson(allocator: std.mem.Allocator, reason: []const u8) ![]u8 {
    const text = try std.fmt.allocPrint(allocator, "sumi: {s}, so the command was not run.", .{reason});
    defer allocator.free(text);
    const quoted = try jsonio.quoteString(allocator, text);
    defer allocator.free(quoted);
    return std.fmt.allocPrint(
        allocator,
        "{{\"hookSpecificOutput\":{{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":{s}}}}}",
        .{quoted},
    );
}

fn emitDeny(allocator: std.mem.Allocator, reason: []const u8, output: Output) !void {
    const out = denyJson(allocator, reason) catch return output.write(FALLBACK_DENY);
    defer allocator.free(out);
    return output.write(out);
}

fn writeStdout(_: *anyopaque, bytes: []const u8) !void {
    return jsonio.writeStdout(bytes);
}

fn reportWriteFailure() void {
    std.debug.print("sumi: pre-bash could not write its decision\n", .{});
}

fn deny(allocator: std.mem.Allocator, reason: []const u8) u8 {
    var output_context: u8 = 0;
    emitDeny(allocator, reason, .{ .context = &output_context, .writeFn = writeStdout }) catch reportWriteFailure();
    return 0;
}

/// 引数解釈が終わった後の失敗はすべて exit 0 の deny。非ゼロで終わると Claude Code は
/// 元のコマンドをそのまま実行する。
pub fn main(allocator: std.mem.Allocator, args: []const []const u8, maybe_self_path: ?[]const u8) !u8 {
    const parsed_args = parseArgs(args) catch return cli.usage("invalid pre-bash arguments");
    const secrets_file = parsed_args.secrets_file;
    const shell_path = parsed_args.shell_path;
    const self_path = maybe_self_path orelse return deny(allocator, "the executable path could not be resolved");

    const text = jsonio.readStdin(allocator) catch return deny(allocator, "the hook payload could not be read");
    if (text.len == 0) return deny(allocator, "the hook payload is not valid JSON");
    var parsed = jsonio.parse(allocator, text) catch return deny(allocator, "the hook payload is not valid JSON");
    defer parsed.deinit();

    const tool_input = jsonio.getObject(parsed.value, "tool_input") orelse return 0;
    const command_value = tool_input.get("command") orelse return 0;
    const command = if (command_value == .string) command_value.string else return 0;
    if (command.len == 0) return 0;
    if (isWrapped(allocator, self_path, secrets_file, shell_path, command) catch return deny(allocator, "the command wrapper could not be verified")) return 0;

    // 一覧が使えないコマンドを走らせると、run 側で 121 になるだけでなく、そもそも
    // 書き換えの意味が無い。ここで止めて理由を見せる。
    _ = secrets.load(allocator, secrets_file) catch |err| return deny(allocator, secrets.describe(err));
    std.fs.cwd().access(shell_path, .{}) catch return deny(allocator, "the shell given by --shell does not exist");

    const wrapped = rewriteForHook(allocator, self_path, secrets_file, shell_path, command) orelse
        return deny(allocator, "the rewritten command could not be allocated");
    defer allocator.free(wrapped);
    const out = buildDecision(allocator, &parsed.value, wrapped) catch return deny(allocator, "the rewritten command could not be encoded");
    defer allocator.free(out);
    jsonio.writeStdout(out) catch {
        reportWriteFailure();
        return 0;
    };
    return 0;
}

const testing = std.testing;

test "parseArgs: pre-bash requires each singular option exactly once" {
    const got = try parseArgs(&.{ "--secrets-file", "/s", "--shell", "/bin/bash" });
    try testing.expectEqualStrings("/s", got.secrets_file);
    try testing.expectEqualStrings("/bin/bash", got.shell_path);
    try testing.expectError(error.DuplicateOption, parseArgs(&.{ "--shell", "/bin/bash", "--shell", "/bin/sh", "--secrets-file", "/s" }));
    try testing.expectError(error.UnknownOption, parseArgs(&.{ "--secrets-file", "/s", "--shell", "/bin/bash", "--wat", "x" }));
    try testing.expectError(error.MissingOptionValue, parseArgs(&.{ "--secrets-file", "/s", "--shell" }));
    try testing.expectError(error.UnknownOption, parseArgs(&.{ "--secrets-file", "/s", "--shell", "/bin/bash", "stray" }));
}

test "rewrite: wraps the command under sumi run with every argument quoted" {
    const got = try rewrite(testing.allocator, "/opt/sumi/sumi", "/opt/sumi/secrets.txt", "/bin/bash", "cat 'a b' && false");
    defer testing.allocator.free(got);
    try testing.expectEqualStrings(
        "/opt/sumi/sumi run --secrets-file /opt/sumi/secrets.txt -- /bin/bash -c 'cat '\\''a b'\\'' && false'",
        got,
    );
}

test "rewrite: a self path with spaces is quoted" {
    const got = try rewrite(testing.allocator, "/home/u/my tools/sumi", "/s", "/bin/bash", "ls");
    defer testing.allocator.free(got);
    try testing.expect(std.mem.startsWith(u8, got, "'/home/u/my tools/sumi' run "));
}

test "rewriteForHook: allocation failure becomes a deny result" {
    try testing.expect((rewriteForHook(testing.failing_allocator, "/sumi", "/secrets", "/bin/bash", "true")) == null);
}

test "isWrapped: detects a command already rewritten by this binary" {
    try testing.expect(try isWrapped(testing.allocator, "/opt/sumi/sumi", "/s", "/bin/bash", "/opt/sumi/sumi run --secrets-file /s -- /bin/bash -c ls"));
    try testing.expect(!(try isWrapped(testing.allocator, "/opt/sumi/sumi", "/s", "/bin/bash", "ls")));
    try testing.expect(!(try isWrapped(testing.allocator, "/opt/sumi/sumi", "/s", "/bin/bash", "/other/sumi run -- x")));
}

test "isWrapped: rejects unsafe or differently configured wrapper lookalikes" {
    const self_path = "/opt/sumi/sumi";
    const exact = "/opt/sumi/sumi run --secrets-file /s -- /bin/bash -c 'printf \"$HOME\"; false'";
    try testing.expect(try isWrapped(testing.allocator, self_path, "/s", "/bin/bash", exact));
    try testing.expect(!(try isWrapped(testing.allocator, self_path, "/s", "/bin/bash", exact ++ "; cat /tmp/secret")));
    try testing.expect(!(try isWrapped(testing.allocator, self_path, "/s", "/bin/bash", "/opt/sumi/sumi run --secrets-file /other -- /bin/bash -c true")));
    try testing.expect(!(try isWrapped(testing.allocator, self_path, "/s", "/bin/bash", "/opt/sumi/sumi run --secrets-file /s -- /bin/sh -c true")));
    try testing.expect(!(try isWrapped(testing.allocator, self_path, "/s", "/bin/bash", "/opt/sumi/sumi run --secrets-file /s -- /bin/bash -c $(cat /tmp/secret)")));
}

test "buildDecision: rewritten input keeps the other tool_input fields" {
    var parsed = try jsonio.parse(testing.allocator, "{\"tool_input\":{\"command\":\"ls\",\"description\":\"list\"}}");
    defer parsed.deinit();
    const out = try buildDecision(testing.allocator, &parsed.value, "WRAPPED");
    defer testing.allocator.free(out);
    try testing.expectEqualStrings(
        "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"updatedInput\":{\"command\":\"WRAPPED\",\"description\":\"list\"}}}",
        out,
    );
}

test "denyJson: carries the reason with the sumi prefix" {
    const out = try denyJson(testing.allocator, "the secrets file is empty");
    defer testing.allocator.free(out);
    try testing.expectEqualStrings(
        "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"sumi: the secrets file is empty, so the command was not run.\"}}",
        out,
    );
}

test "fallback deny remains a fail-closed pre-bash decision without allocation" {
    var parsed = try jsonio.parse(testing.allocator, FALLBACK_DENY);
    defer parsed.deinit();
    const output = jsonio.getObject(parsed.value, "hookSpecificOutput").?;
    try testing.expectEqualStrings("deny", jsonio.getString(.{ .object = output.* }, "permissionDecision").?);
    try testing.expect(std.mem.startsWith(u8, jsonio.getString(.{ .object = output.* }, "permissionDecisionReason").?, "sumi: "));
    try testing.expectError(error.OutOfMemory, denyJson(testing.failing_allocator, "allocation failed"));
}

const FailingOutput = struct {
    calls: usize = 0,
    partial_bytes: usize = 0,
    received_fallback: bool = false,

    fn write(context: *anyopaque, bytes: []const u8) anyerror!void {
        const self: *FailingOutput = @ptrCast(@alignCast(context));
        self.calls += 1;
        self.partial_bytes += @min(bytes.len, 7);
        self.received_fallback = std.mem.eql(u8, bytes, FALLBACK_DENY);
        return error.BrokenPipe;
    }
};

test "deny output does not retry after a partial rendered decision" {
    var sink = FailingOutput{};
    try testing.expectError(error.BrokenPipe, emitDeny(testing.allocator, "reason", .{ .context = &sink, .writeFn = FailingOutput.write }));
    try testing.expectEqual(@as(usize, 1), sink.calls);
    try testing.expect(sink.partial_bytes > 0);
    try testing.expect(!sink.received_fallback);
}

test "deny output reports a failed static fallback without retrying" {
    var sink = FailingOutput{};
    try testing.expectError(error.BrokenPipe, emitDeny(testing.failing_allocator, "reason", .{ .context = &sink, .writeFn = FailingOutput.write }));
    try testing.expectEqual(@as(usize, 1), sink.calls);
    try testing.expect(sink.received_fallback);
}
