//! nas-mask-filter — 出力をシークレットマスクするフィルタ / スーパーバイザ。
//!
//! 使い方:
//!   nas-mask-filter
//!       フィルタモード。stdin から読み、マスク済みバイト列を stdout へ書く。
//!       hostexec のホスト実行出力マスク (C3) が使う。
//!
//!   nas-mask-filter --supervise [--argv0 NAME] --socket SOCKET -- PROGRAM [ARGS...]
//!       スーパーバイザモード。PROGRAM を起動し、その stdout/stderr を SOCKET の
//!       ホスト側ブローカーへ中継してマスク済みバイトを書き戻す。パイプを drain し
//!       切ってから PROGRAM の終了ステータスで exit するため、「プロセスの終了」を
//!       完了シグナルにしている呼び出し元から見ても出力が欠けない。
//!       詳細は supervise.zig の冒頭コメントを参照。
//!
//!   nas-mask-filter --serve SOCKET
//!       サーブモード (ホスト側常駐)。SOCKET で待ち受け、接続ごとに 1 ストリームとして
//!       マスクする。シークレットフレームをコンテナへ渡さずにマスクを効かせるための
//!       モード。詳細は serve.zig の冒頭コメントを参照。
//!
//! シークレットフレーム (NAS_MASK_SECRETS_FILE) が要るのは **filter と serve だけ**。
//! どちらもホスト側で動く。supervise はコンテナ内で動くので、フレームを読ませると
//! エージェントにセッション全シークレットの索引を渡すことになる
//! (security-constraints C1 / S1)。したがって supervise では env を一切読まない。
//!
//! exit code: フィルタ / サーブモードは 0 = 成功, 1 = 致命的エラー,
//!            2 = 使用方法エラー(env 未設定等)。
//!            スーパーバイザモードは PROGRAM の終了コードをそのまま返す
//!            (シグナル終了なら 128+signo)。ただし 121 は「出力抑止」の予約値で、
//!            マスク経路が壊れたときだけ返る (fail-closed)。

const std = @import("std");
const mask_stream = @import("mask_stream.zig");
const serve = @import("serve.zig");
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
    /// マスクを依頼するホスト側ブローカーの Unix socket パス。
    /// パーサは未指定を許す (引数解釈の契約を変えないため) が、実行時には必須で、
    /// 無ければ fail-closed で中断する。
    socket: ?[]const u8 = null,
};

/// argv[1..] を supervise モードの引数として解釈する。
/// supervise モードでない (先頭が --supervise でない) 場合は null を返す。
pub fn parseSuperviseArgs(argv: []const []const u8) !?SuperviseArgs {
    if (argv.len == 0) return null;
    if (!std.mem.eql(u8, argv[0], "--supervise")) return error.UnknownOption;

    var argv0: ?[]const u8 = null;
    var socket: ?[]const u8 = null;
    var i: usize = 1;
    while (i < argv.len) : (i += 1) {
        if (std.mem.eql(u8, argv[i], "--argv0")) {
            i += 1;
            if (i >= argv.len) return error.MissingOptionValue;
            argv0 = argv[i];
        } else if (std.mem.eql(u8, argv[i], "--socket")) {
            i += 1;
            if (i >= argv.len) return error.MissingOptionValue;
            socket = argv[i];
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
        .socket = socket,
    };
}

/// 実行モード。argv[1..] から決まる。
pub const Mode = union(enum) {
    /// stdin -> stdout フィルタ。hostexec のホスト実行出力マスク (C3) が使う。
    filter,
    /// ホスト側常駐サーバ。値は待ち受ける Unix socket のパス。
    serve: []const u8,
    supervise: SuperviseArgs,
};

/// argv[1..] を実行モードとして解釈する。
///
/// parseSuperviseArgs は「引数なし = null (フィルタモード)」という契約を持つので、
/// --serve をそちらに混ぜず手前で分岐させる。
pub fn parseMode(argv: []const []const u8) !Mode {
    if (argv.len > 0 and std.mem.eql(u8, argv[0], "--serve")) {
        if (argv.len < 2) return error.MissingSocketPath;
        if (argv.len > 2) return error.UnexpectedArgument;
        return .{ .serve = argv[1] };
    }
    if (try parseSuperviseArgs(argv)) |sa| return .{ .supervise = sa };
    return .filter;
}

const usage_text =
    \\usage: nas-mask-filter                                      (stdin -> stdout filter)
    \\       nas-mask-filter --supervise [--argv0 NAME] --socket SOCKET -- PROGRAM [ARGS...]
    \\       nas-mask-filter --serve SOCKET
    \\
;

/// 「出力を抑止した」ことを表す予約済み終了コード。子が 0 で終わっていても、
/// マスク経路が壊れたときはこれを返すので、呼び出し元が出力欠落を成功と
/// 取り違えることがない。
const EXIT_OUTPUT_SUPPRESSED: u8 = 121;

/// supervise モードの診断は **定数文字列だけ** にする。この経路はマスクを
/// 通らない本物の stderr へ直接出るので、書式指定でストリーム由来の値を
/// 混ぜてはならない。原因の区別は文字列そのものを分けることで付ける。
fn superviseDiagnostic(err: anyerror) []const u8 {
    return switch (err) {
        error.SocketPathInvalid,
        error.RelayConnectFailed,
        => "nas-mask-filter: cannot reach the mask broker; output suppressed\n",
        error.RelayClosedEarly => "nas-mask-filter: mask broker closed early; output suppressed\n",
        error.RelayDrainTimeout => "nas-mask-filter: mask broker stopped responding; output suppressed\n",
        else => "nas-mask-filter: mask relay failed; output suppressed\n",
    };
}

/// フィルタ / サーブモード用にシークレットフレームを読む。
/// supervise はホスト側ブローカーへ中継するだけなので呼ばない。
fn loadSecrets() !?[][]u8 {
    const env_path = std.posix.getenv("NAS_MASK_SECRETS_FILE") orelse {
        std.debug.print("nas-mask-filter: NAS_MASK_SECRETS_FILE not set\n", .{});
        return null;
    };
    return try readSecretsFromFile(env_path);
}

pub fn main() !u8 {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const arena_alloc = arena.allocator();

    const argv = try std.process.argsAlloc(arena_alloc);
    const mode = parseMode(argv[1..]) catch |err| {
        std.debug.print("nas-mask-filter: {}\n{s}", .{ err, usage_text });
        return 2;
    };

    // supervise はシークレットフレームを読まない。読ませてしまうと、コンテナ内に
    // 全シークレットの索引を置くことになり、このモードの存在理由が消える。
    // 残りの 2 モードはホスト側で動くのでここで読む。
    const secrets: []const []const u8 = switch (mode) {
        .supervise => &.{},
        // secrets を読めないままフィルタ / サーバを動かすとマスクなしで
        // 素通しになってしまうため、fail-closed で中断する。
        .serve, .filter => (loadSecrets() catch |err| {
            std.debug.print("nas-mask-filter: failed to read secrets: {}\n", .{err});
            return 1;
        }) orelse return 2,
    };

    switch (mode) {
        .supervise => |sa| {
            const sock_path = sa.socket orelse {
                std.debug.print(
                    "nas-mask-filter: --socket is required in supervise mode; output suppressed\n",
                    .{},
                );
                return EXIT_OUTPUT_SUPPRESSED;
            };
            return supervise.run(arena_alloc, sock_path, sa.argv0, sa.program, sa.args) catch |err| {
                std.debug.print("{s}", .{superviseDiagnostic(err)});
                return EXIT_OUTPUT_SUPPRESSED;
            };
        },
        .serve => |sock_path| {
            // 接続は出入りするので arena ではなく解放できるアロケータを渡す。
            //
            // ここで出す診断は「起動に失敗した」ことだけで、ストリーム由来の
            // バイトは含まない。serve モードの stdout/stderr はホスト上の
            // ログファイルに向くので、平文が混じってはならない
            // (serve.zig の「出力の不変条件」を参照)。
            return serve.run(allocator, secrets, sock_path) catch |err| {
                std.debug.print("nas-mask-filter: serve failed: {}\n", .{err});
                return 1;
            };
        },
        .filter => {
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
        },
    }
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

const testing = std.testing;

test {
    _ = @import("mask_stream.zig");
    _ = @import("relay.zig");
    _ = @import("serve.zig");
    _ = @import("supervise.zig");
}

// ---------------------------------------------------------------------------
// parseMode tests
// ---------------------------------------------------------------------------

test "parseMode: no args -> filter mode" {
    try testing.expectEqual(Mode.filter, try parseMode(&.{}));
}

test "parseMode: --serve takes the socket path" {
    const mode = try parseMode(&.{ "--serve", "/run/nas/mask.sock" });
    try testing.expectEqualStrings("/run/nas/mask.sock", mode.serve);
}

test "parseMode: --serve without a socket path is an error" {
    try testing.expectError(error.MissingSocketPath, parseMode(&.{"--serve"}));
}

test "parseMode: --serve with extra arguments is an error" {
    try testing.expectError(
        error.UnexpectedArgument,
        parseMode(&.{ "--serve", "/run/nas/mask.sock", "extra" }),
    );
}

test "parseMode: --supervise still reaches supervise mode" {
    const mode = try parseMode(&.{ "--supervise", "--", "/bin/bash" });
    try testing.expectEqualStrings("/bin/bash", mode.supervise.program);
}

test "parseMode: unknown option is still an error" {
    try testing.expectError(error.UnknownOption, parseMode(&.{"--bogus"}));
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

test "parseSuperviseArgs: --socket is captured" {
    const got = (try parseSuperviseArgs(&.{ "--supervise", "--socket", "/run/nas/mask.sock", "--", "/bin/bash" })).?;
    try testing.expectEqualStrings("/run/nas/mask.sock", got.socket.?);
    try testing.expectEqualStrings("/bin/bash", got.program);
}

test "parseSuperviseArgs: --socket combines with --argv0 in either order" {
    const got = (try parseSuperviseArgs(&.{ "--supervise", "--socket", "/s", "--argv0", "-bash", "--", "/bin/bash" })).?;
    try testing.expectEqualStrings("/s", got.socket.?);
    try testing.expectEqualStrings("-bash", got.argv0);
}

// パーサは --socket なしの呼び出しを受け付け続ける (引数解釈の契約は変えない)。
// 必須性は実行時に main が判定し、無ければ fail-closed で 121 にする。
test "parseSuperviseArgs: socket is null when --socket is absent" {
    const got = (try parseSuperviseArgs(&.{ "--supervise", "--", "/bin/bash" })).?;
    try testing.expectEqual(@as(?[]const u8, null), got.socket);
}

test "parseSuperviseArgs: missing --socket value is an error" {
    try testing.expectError(error.MissingOptionValue, parseSuperviseArgs(&.{ "--supervise", "--socket" }));
}

test "parseSuperviseArgs: --socket after -- is passed through to the child" {
    const got = (try parseSuperviseArgs(&.{ "--supervise", "--", "/bin/bash", "--socket", "/x" })).?;
    try testing.expectEqual(@as(?[]const u8, null), got.socket);
    try testing.expectEqual(@as(usize, 2), got.args.len);
    try testing.expectEqualStrings("--socket", got.args[0]);
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
