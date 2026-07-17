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
    if (max_len == 0) {
        // No secrets — pure passthrough without masking.
        var buf: [BUF_SIZE]u8 = undefined;
        while (true) {
            const n = try reader.read(&buf);
            if (n == 0) break;
            try writer.writeAll(buf[0..n]);
        }
        return;
    }

    const overlap_size: usize = max_len - 1;
    if (overlap_size == 0) {
        // 1-byte secrets: no overlap needed but still mask each chunk.
        var buf: [BUF_SIZE]u8 = undefined;
        while (true) {
            const n = try reader.read(&buf);
            if (n == 0) break;
            mask.maskAll(buf[0..n], secrets, null);
            try writer.writeAll(buf[0..n]);
        }
        return;
    }

    // combined = [overlap (overlap_size バイトまで) | 新規読み取り (BUF_SIZE バイトまで)]
    // combined は常に「元の平文」を保持する。mask.maskAll は buf を in-place で
    // 書き換えてしまうため、combined を直接渡さず scratch (使い捨てコピー) に渡し、
    // mask_buf (マッチ位置の bool マーク) だけを受け取る。
    //
    // combined を原文のまま保つ理由: overlap 部分がマスク済み ('*') になってしまうと、
    // 次チャンクのバイトと連結しても元の平文と一致せず、境界を跨ぐシークレットの
    // マッチに失敗する (例: secret="aa", 入力="aa"+"a" → overlap が '*' だと
    // 2 回目に "*a" を見ても "aa" にマッチしない)。
    //
    // 一方で、原文のまま持ち越すだけだと「このチャンク内で完全に確定した (跨がない)
    // マッチ」の情報を次周回で失ってしまう (例: secret="hunter2" が safe_end 側と
    // overlap 側にまたがって完全一致した場合、overlap 側の末尾バイトは原文に戻すが、
    // それが同じ secret の一部としてマスク確定していたことを覚えておく必要がある)。
    // そのため carried_mask で「持ち越した overlap のうち、既に確定マスクされた
    // 位置」を bool で追跡し、次周回の mask_buf と OR して最終的なマスク要否を求める。
    const combined_cap = overlap_size + BUF_SIZE;
    const combined = try allocator.alloc(u8, combined_cap);
    defer allocator.free(combined);
    const scratch = try allocator.alloc(u8, combined_cap);
    defer allocator.free(scratch);
    const mask_buf = try allocator.alloc(bool, combined_cap);
    defer allocator.free(mask_buf);
    const carried_mask = try allocator.alloc(bool, overlap_size);
    defer allocator.free(carried_mask);
    @memset(carried_mask, false);

    var overlap_len: usize = 0;

    while (true) {
        const n = try reader.read(combined[overlap_len .. overlap_len + BUF_SIZE]);
        if (n == 0) break;

        const total = overlap_len + n;

        // combined (原文) を破壊せず、scratch 上でマスク処理を行う。
        // mask_buf[i] には「位置 i が今回の総当たりでマッチしたか」が書き戻される。
        std.mem.copyForwards(u8, scratch[0..total], combined[0..total]);
        mask.maskAll(scratch[0..total], secrets, mask_buf[0..total]);

        // combined[0..overlap_len] は前回持ち越した overlap。carried_mask に
        // 前回までの確定マッチが記録されているので、それを scratch に反映してから
        // 出力する (今回未マッチでも、以前確定済みならマスクする)。
        var k: usize = 0;
        while (k < overlap_len) : (k += 1) {
            if (carried_mask[k]) scratch[k] = '*';
        }

        // 末尾 overlap_size バイトは次チャンクとマッチが跨る可能性があるため、
        // まだ出力せずオーバーラップとして保持する。
        const safe_end = if (total > overlap_size) total - overlap_size else 0;
        if (safe_end > 0) {
            try writer.writeAll(scratch[0..safe_end]);
        }

        const new_overlap = total - safe_end;
        if (new_overlap > 0) {
            // 次周回へ持ち越す carried_mask を更新する: 今回の mask_buf の結果と、
            // (該当位置がさらに前回の overlap 由来でもあれば) 前回の carried_mask との OR。
            var j: usize = 0;
            while (j < new_overlap) : (j += 1) {
                const src = safe_end + j;
                carried_mask[j] = mask_buf[src] or (src < overlap_len and carried_mask[src]);
            }
            // combined は原文のまま前に詰める (scratch ではなく combined から)。
            std.mem.copyForwards(u8, combined[0..new_overlap], combined[safe_end..total]);
        }
        overlap_len = new_overlap;
    }

    // EOF: 残った overlap にはこれ以上跨るチャンクが来ないので、原文に対して
    // 最後にもう一度マッチングし、carried_mask (それまでに確定していたマッチ) と
    // OR して出力する。
    if (overlap_len > 0) {
        std.mem.copyForwards(u8, scratch[0..overlap_len], combined[0..overlap_len]);
        mask.maskAll(scratch[0..overlap_len], secrets, mask_buf[0..overlap_len]);
        var i: usize = 0;
        while (i < overlap_len) : (i += 1) {
            if (carried_mask[i]) scratch[i] = '*';
        }
        try writer.writeAll(scratch[0..overlap_len]);
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
    var out_buf: [BUF_SIZE]u8 = undefined;
    var stdout_writer = stdout.writer(&out_buf);
    streamMask(stdin.deprecatedReader(), &stdout_writer.interface, secrets) catch |err| {
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

test "streamMask: single-byte secret masked" {
    const result = try testStreamMask("abc_x_def", &.{"x"});
    defer testing.allocator.free(result);
    try testing.expectEqualStrings("abc_*_def", result);
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

// ---------------------------------------------------------------------------
// ChunkedReader: テストで read() の呼び出しごとに返すバイト数を強制的に
// 指定できるようにするための reader。streamMask のチャンク境界跨ぎ処理を
// 実際の read() 分割パターンで検証するために使う。
// ---------------------------------------------------------------------------

const ChunkedReader = struct {
    data: []const u8,
    chunks: []const usize,
    pos: usize = 0,
    chunk_idx: usize = 0,

    fn read(self: *ChunkedReader, buf: []u8) !usize {
        if (self.chunk_idx >= self.chunks.len) return 0;
        const want = self.chunks[self.chunk_idx];
        self.chunk_idx += 1;
        const remaining = self.data.len - self.pos;
        const n = @min(@min(want, remaining), buf.len);
        @memcpy(buf[0..n], self.data[self.pos .. self.pos + n]);
        self.pos += n;
        return n;
    }
};

fn testStreamMaskChunked(input: []const u8, chunks: []const usize, secrets: []const []const u8) ![]u8 {
    var reader = ChunkedReader{ .data = input, .chunks = chunks };
    var output: std.ArrayList(u8) = .empty;
    defer output.deinit(testing.allocator);
    try streamMask(&reader, output.writer(testing.allocator), secrets);
    return try output.toOwnedSlice(testing.allocator);
}

test "streamMask: self-overlapping secret at chunk boundary" {
    // secret "aa" が "aaa" (chunk "aa" + "a") の境界を跨いで自己重複マッチする。
    // バグ修正前は overlap に '*' が持ち越され "**a" になっていた。
    const result = try testStreamMaskChunked("aaa", &.{ 2, 1 }, &.{"aa"});
    defer testing.allocator.free(result);
    try testing.expectEqualStrings("***", result);
}

test "streamMask: cross-secret overlap at chunk boundary" {
    // secrets {"PQ","QRS"} が "XPQRSY" (chunk "XPQR" + "SY") の境界を跨いでマッチする。
    // "PQ" は 1 回目のチャンクで確定するが、"QRS" は 2 回目のチャンクとの
    // 組み合わせでのみ確定する。
    const result = try testStreamMaskChunked("XPQRSY", &.{ 4, 2 }, &.{ "PQ", "QRS" });
    defer testing.allocator.free(result);
    try testing.expectEqualStrings("X****Y", result);
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
