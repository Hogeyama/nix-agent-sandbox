//! nas-mask-filter — stdin をシークレットマスクしながら stdout へストリーミングするフィルタ。
//!
//! 使い方: 環境変数 NAS_MASK_SECRETS_FILE に secrets_frame 形式
//! (u32le count, その後 count 個の [u32le len + bytes]) のファイルパスを指定して実行する。
//! stdin から読み、マスク済みバイト列を stdout へ書く。
//!
//! exit code: 0 = 成功, 1 = 致命的エラー, 2 = 使用方法エラー(env 未設定等)。

const std = @import("std");
const mask = @import("mask");

const BUF_SIZE: usize = 64 * 1024;

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

/// stdin → stdout ストリーミングマスク。
///
/// - secrets が空 (overlap_size == 0) の場合はバッファなしの素通しコピー。
/// - それ以外は overlap_size = maxSecretLen-1 バイトのオーバーラップを前チャンクの末尾から
///   持ち越し、境界を跨ぐシークレットも確実にマスクする。
/// - EOF 到達時は残った overlap をマスクしてフラッシュする。
pub fn streamMask(
    reader: anytype,
    writer: anytype,
    secrets: []const []const u8,
) !void {
    const max_len = mask.maxSecretLen(secrets);
    const overlap_size: usize = if (max_len > 0) max_len - 1 else 0;

    // シークレットなし (または全て空文字列) の場合はバッファリングせず素通し。
    if (overlap_size == 0) {
        var buf: [BUF_SIZE]u8 = undefined;
        while (true) {
            const n = try reader.read(&buf);
            if (n == 0) break;
            try writer.writeAll(buf[0..n]);
        }
        return;
    }

    // combined = [overlap (overlap_size バイトまで) | 新規読み取り (BUF_SIZE バイトまで)]
    const combined_cap = overlap_size + BUF_SIZE;
    const combined = try allocator.alloc(u8, combined_cap);
    defer allocator.free(combined);
    const mask_buf = try allocator.alloc(bool, combined_cap);
    defer allocator.free(mask_buf);

    var overlap_len: usize = 0;

    while (true) {
        const n = try reader.read(combined[overlap_len .. overlap_len + BUF_SIZE]);
        if (n == 0) break;

        const total = overlap_len + n;
        mask.maskAll(combined[0..total], secrets, mask_buf);

        // 末尾 overlap_size バイトは次チャンクとマッチが跨る可能性があるため、
        // まだ出力せずオーバーラップとして保持する。
        const safe_end = if (total > overlap_size) total - overlap_size else 0;
        if (safe_end > 0) {
            try writer.writeAll(combined[0..safe_end]);
        }

        const new_overlap = total - safe_end;
        if (new_overlap > 0 and safe_end > 0) {
            std.mem.copyForwards(u8, combined[0..new_overlap], combined[safe_end..total]);
        }
        overlap_len = new_overlap;
    }

    // EOF: 残った overlap にはこれ以上跨るチャンクが来ないので、再度マスクしてそのまま出力する。
    if (overlap_len > 0) {
        mask.maskAll(combined[0..overlap_len], secrets, mask_buf);
        try writer.writeAll(combined[0..overlap_len]);
    }
}

pub fn main() !u8 {
    const env_path = std.posix.getenv("NAS_MASK_SECRETS_FILE") orelse {
        std.debug.print("nas-mask-filter: NAS_MASK_SECRETS_FILE not set\n", .{});
        return 2;
    };
    const secrets = readSecretsFromFile(env_path) catch |err| {
        std.debug.print("nas-mask-filter: failed to read secrets: {}\n", .{err});
        return 1;
    };

    const stdin = std.fs.File.stdin();
    const stdout = std.fs.File.stdout();
    streamMask(stdin.deprecatedReader(), stdout.deprecatedWriter(), secrets) catch |err| {
        std.debug.print("nas-mask-filter: stream error: {}\n", .{err});
        return 1;
    };
    return 0;
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

const testing = std.testing;

fn testStreamMask(input: []const u8, secrets: []const []const u8) ![]u8 {
    var input_stream = std.io.fixedBufferStream(input);
    var output: std.ArrayList(u8) = .empty;
    defer output.deinit(testing.allocator);
    try streamMask(input_stream.reader(), output.writer(testing.allocator), secrets);
    return try output.toOwnedSlice(testing.allocator);
}

test "streamMask: no secrets -> passthrough" {
    const result = try testStreamMask("hello world", &.{});
    defer testing.allocator.free(result);
    try testing.expectEqualStrings("hello world", result);
}

test "streamMask: single secret masked" {
    const result = try testStreamMask("password=hunter2 done", &.{"hunter2"});
    defer testing.allocator.free(result);
    try testing.expectEqualStrings("password=******* done", result);
}

test "streamMask: secret spanning chunk boundary" {
    // "SECRET" が overlap 境界を跨いでもマスクされることを確認する。
    // 実運用では BUF_SIZE=64K だが、アルゴリズム自体は入力サイズに依存しない。
    const input = "prefix_SECRET_suffix";
    const result = try testStreamMask(input, &.{"SECRET"});
    defer testing.allocator.free(result);
    try testing.expectEqualStrings("prefix_******_suffix", result);
}

test "streamMask: empty input" {
    const result = try testStreamMask("", &.{"secret"});
    defer testing.allocator.free(result);
    try testing.expectEqualStrings("", result);
}

test "streamMask: multiple secrets" {
    const result = try testStreamMask("a=tok1 b=tok22 c=tok1", &.{ "tok1", "tok22" });
    defer testing.allocator.free(result);
    try testing.expectEqualStrings("a=**** b=***** c=****", result);
}

test "streamMask: overlapping secrets" {
    const result = try testStreamMask("xabcx", &.{ "ab", "abc" });
    defer testing.allocator.free(result);
    try testing.expectEqualStrings("x***x", result);
}

test "streamMask: secret at very start of input" {
    const result = try testStreamMask("hunter2 is the password", &.{"hunter2"});
    defer testing.allocator.free(result);
    try testing.expectEqualStrings("******* is the password", result);
}

test "streamMask: secret at very end of input" {
    const result = try testStreamMask("the password is hunter2", &.{"hunter2"});
    defer testing.allocator.free(result);
    try testing.expectEqualStrings("the password is *******", result);
}

test "streamMask: empty secret list entry is ignored" {
    const result = try testStreamMask("hello world", &.{""});
    defer testing.allocator.free(result);
    try testing.expectEqualStrings("hello world", result);
}

test "streamMask: input larger than BUF_SIZE with repeated secret" {
    // BUF_SIZE (64KB) を超える入力でも、チャンク境界を跨ぐ occurrence が漏れないことを確認する。
    var input: std.ArrayList(u8) = .empty;
    defer input.deinit(testing.allocator);
    var i: usize = 0;
    while (i < 20000) : (i += 1) {
        try input.appendSlice(testing.allocator, "xx_SECRETVALUE_yy ");
    }
    const result = try testStreamMask(input.items, &.{"SECRETVALUE"});
    defer testing.allocator.free(result);
    try testing.expect(std.mem.indexOf(u8, result, "SECRETVALUE") == null);
    try testing.expectEqual(input.items.len, result.len);
}
