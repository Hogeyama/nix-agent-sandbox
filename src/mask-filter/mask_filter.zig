//! nas-mask-filter — 出力をシークレットマスクするフィルタ / スーパーバイザ。
//!
//! 環境変数 NAS_MASK_SECRETS_FILE に secrets_frame 形式
//! (u32le count, その後 count 個の [u32le len + bytes]) のファイルパスを指定して実行する。
//!
//! 使い方:
//!   nas-mask-filter
//!       フィルタモード。stdin から読み、マスク済みバイト列を stdout へ書く。
//!
//!   nas-mask-filter --supervise [--argv0 NAME] -- PROGRAM [ARGS...]
//!       スーパーバイザモード。PROGRAM を起動し、その stdout/stderr をマスクしながら
//!       中継する。パイプを drain し切ってから PROGRAM の終了ステータスで exit するため、
//!       「プロセスの終了」を完了シグナルにしている呼び出し元から見ても出力が欠けない。
//!       詳細は supervise.zig の冒頭コメントを参照。
//!
//! exit code: フィルタモードは 0 = 成功, 1 = 致命的エラー, 2 = 使用方法エラー(env 未設定等)。
//!            スーパーバイザモードは PROGRAM の終了コードをそのまま返す
//!            (シグナル終了なら 128+signo)。

const std = @import("std");
const mask_stream = @import("mask_stream.zig");
const supervise = @import("supervise.zig");

const BUF_SIZE = mask_stream.BUF_SIZE;

const allocator = std.heap.page_allocator;

fn readSecretsFromFile(file_path: []const u8) ![][]u8 {
    const file = try std.fs.cwd().openFile(file_path, .{});
    defer file.close();
    const reader = file.deprecatedReader();
    const count = try reader.readInt(u32, .little);
    if (count > 1024) return error.TooManySecrets;
    const list = try allocator.alloc([]u8, count);
    var i: usize = 0;
    while (i < count) : (i += 1) {
        const len = try reader.readInt(u32, .little);
        if (len == 0 or len > 16 * 1024 * 1024) return error.InvalidSecretLength;
        const s = try allocator.alloc(u8, len);
        try reader.readNoEof(s);
        list[i] = s;
    }
    return list;
}

pub const SuperviseArgs = struct {
    /// 子プロセスの argv[0]。--argv0 未指定なら program と同じ。
    argv0: []const u8,
    /// execve(2) に渡す実行ファイルのパス (PATH 探索はしない)。
    program: []const u8,
    /// argv[1..] として渡す引数。
    args: []const []const u8,
};

/// argv[1..] を supervise モードの引数として解釈する。
/// supervise モードでない (先頭が --supervise でない) 場合は null を返す。
pub fn parseSuperviseArgs(argv: []const []const u8) !?SuperviseArgs {
    if (argv.len == 0) return null;
    if (!std.mem.eql(u8, argv[0], "--supervise")) return error.UnknownOption;

    var argv0: ?[]const u8 = null;
    var i: usize = 1;
    while (i < argv.len) : (i += 1) {
        if (std.mem.eql(u8, argv[i], "--argv0")) {
            i += 1;
            if (i >= argv.len) return error.MissingOptionValue;
            argv0 = argv[i];
        } else if (std.mem.eql(u8, argv[i], "--")) {
            i += 1;
            break;
        } else {
            return error.UnknownOption;
        }
    }
    if (i >= argv.len) return error.MissingProgram;

    const program = argv[i];
    return .{
        .argv0 = argv0 orelse program,
        .program = program,
        .args = argv[i + 1 ..],
    };
}

const usage_text =
    \\usage: nas-mask-filter                                      (stdin -> stdout filter)
    \\       nas-mask-filter --supervise [--argv0 NAME] -- PROGRAM [ARGS...]
    \\
;

pub fn main() !u8 {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const arena_alloc = arena.allocator();

    const argv = try std.process.argsAlloc(arena_alloc);
    const supervise_args = parseSuperviseArgs(argv[1..]) catch |err| {
        std.debug.print("nas-mask-filter: {}\n{s}", .{ err, usage_text });
        return 2;
    };

    const env_path = std.posix.getenv("NAS_MASK_SECRETS_FILE") orelse {
        std.debug.print("nas-mask-filter: NAS_MASK_SECRETS_FILE not set\n", .{});
        return 2;
    };
    // secrets を読めないまま子を起動するとマスクなしで動いてしまうため、
    // フィルタモード・スーパーバイザモードとも fail-closed で中断する。
    const secrets = readSecretsFromFile(env_path) catch |err| {
        std.debug.print("nas-mask-filter: failed to read secrets: {}\n", .{err});
        return 1;
    };

    if (supervise_args) |sa| {
        return supervise.run(arena_alloc, secrets, sa.argv0, sa.program, sa.args) catch |err| {
            std.debug.print("nas-mask-filter: supervise failed: {}\n", .{err});
            return 1;
        };
    }

    const stdin = std.fs.File.stdin();
    const stdout = std.fs.File.stdout();
    var out_buf: [BUF_SIZE]u8 = undefined;
    var stdout_writer = stdout.writer(&out_buf);
    mask_stream.streamMask(stdin.deprecatedReader(), &stdout_writer.interface, secrets) catch |err| {
        std.debug.print("nas-mask-filter: stream error: {}\n", .{err});
        return 1;
    };
    try stdout_writer.interface.flush();
    return 0;
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

const testing = std.testing;

test {
    _ = @import("mask_stream.zig");
    _ = @import("supervise.zig");
}

// ---------------------------------------------------------------------------
// parseSuperviseArgs tests
// ---------------------------------------------------------------------------

test "parseSuperviseArgs: no args -> filter mode" {
    try testing.expectEqual(@as(?SuperviseArgs, null), try parseSuperviseArgs(&.{}));
}

test "parseSuperviseArgs: program only" {
    const got = (try parseSuperviseArgs(&.{ "--supervise", "--", "/bin/bash" })).?;
    try testing.expectEqualStrings("/bin/bash", got.program);
    try testing.expectEqualStrings("/bin/bash", got.argv0); // 既定は program
    try testing.expectEqual(@as(usize, 0), got.args.len);
}

test "parseSuperviseArgs: argv0 override and trailing args" {
    const got = (try parseSuperviseArgs(&.{ "--supervise", "--argv0", "-bash", "--", "/bin/bash.real", "-c", "echo hi" })).?;
    try testing.expectEqualStrings("-bash", got.argv0);
    try testing.expectEqualStrings("/bin/bash.real", got.program);
    try testing.expectEqual(@as(usize, 2), got.args.len);
    try testing.expectEqualStrings("-c", got.args[0]);
    try testing.expectEqualStrings("echo hi", got.args[1]);
}

test "parseSuperviseArgs: args after -- are never parsed as options" {
    // 子に渡す引数が --argv0 や --supervise でも、そのまま透過すること。
    const got = (try parseSuperviseArgs(&.{ "--supervise", "--", "/bin/bash", "--argv0", "--supervise" })).?;
    try testing.expectEqual(@as(usize, 2), got.args.len);
    try testing.expectEqualStrings("--argv0", got.args[0]);
    try testing.expectEqualStrings("--supervise", got.args[1]);
}

test "parseSuperviseArgs: unknown option is an error" {
    try testing.expectError(error.UnknownOption, parseSuperviseArgs(&.{"--bogus"}));
    try testing.expectError(error.UnknownOption, parseSuperviseArgs(&.{ "--supervise", "--bogus", "--", "/bin/bash" }));
}

test "parseSuperviseArgs: missing program is an error" {
    try testing.expectError(error.MissingProgram, parseSuperviseArgs(&.{"--supervise"}));
    try testing.expectError(error.MissingProgram, parseSuperviseArgs(&.{ "--supervise", "--" }));
}

test "parseSuperviseArgs: missing --argv0 value is an error" {
    try testing.expectError(error.MissingOptionValue, parseSuperviseArgs(&.{ "--supervise", "--argv0" }));
}

// ---------------------------------------------------------------------------
// readSecretsFromFile tests
// ---------------------------------------------------------------------------

// std.testing.tmpDir を使って secrets_frame 形式のバイト列を書き込み、
// readSecretsFromFile が std.fs.cwd().openFile で開ける絶対パスを返す。
fn writeTempFile(tmp: *testing.TmpDir, bytes: []const u8) ![]const u8 {
    const file = try tmp.dir.createFile("secrets.bin", .{});
    defer file.close();
    try file.writeAll(bytes);
    return try tmp.dir.realpathAlloc(testing.allocator, "secrets.bin");
}

test "readSecretsFromFile: 0 secrets" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const path = try writeTempFile(&tmp, &[_]u8{ 0, 0, 0, 0 });
    defer testing.allocator.free(path);

    const secrets = try readSecretsFromFile(path);
    try testing.expectEqual(@as(usize, 0), secrets.len);
}

test "readSecretsFromFile: more than 1024 secrets is an error" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const path = try writeTempFile(&tmp, &[_]u8{ 0x01, 0x04, 0x00, 0x00 }); // count = 1025
    defer testing.allocator.free(path);

    try testing.expectError(error.TooManySecrets, readSecretsFromFile(path));
}

test "readSecretsFromFile: 0-length secret is an error" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    // count=1, then len=0
    const bytes = [_]u8{ 1, 0, 0, 0, 0, 0, 0, 0 };
    const path = try writeTempFile(&tmp, &bytes);
    defer testing.allocator.free(path);

    try testing.expectError(error.InvalidSecretLength, readSecretsFromFile(path));
}

test "readSecretsFromFile: secret length over 16MB is an error" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    // count=1, then len = 16*1024*1024 + 1 (u32le)
    const len: u32 = 16 * 1024 * 1024 + 1;
    var bytes: [8]u8 = undefined;
    std.mem.writeInt(u32, bytes[0..4], 1, .little);
    std.mem.writeInt(u32, bytes[4..8], len, .little);
    const path = try writeTempFile(&tmp, &bytes);
    defer testing.allocator.free(path);

    try testing.expectError(error.InvalidSecretLength, readSecretsFromFile(path));
}

test "readSecretsFromFile: truncated file is an error" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    // count=1, len=10, but fewer than 10 bytes of secret data follow.
    var bytes: [4 + 4 + 3]u8 = undefined;
    std.mem.writeInt(u32, bytes[0..4], 1, .little);
    std.mem.writeInt(u32, bytes[4..8], 10, .little);
    @memcpy(bytes[8..11], "abc");
    const path = try writeTempFile(&tmp, &bytes);
    defer testing.allocator.free(path);

    try testing.expectError(error.EndOfStream, readSecretsFromFile(path));
}
