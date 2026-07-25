//! シークレットマスクのストリーミング状態機械。
//!
//! `streamMask` (reader → writer の一括処理) と、supervise モードのように
//! stdout/stderr の 2 本を 1 スレッドで多重化しながら少しずつ食わせたい
//! ケースの両方から使えるよう、状態を `MaskStream` に切り出してある。

const std = @import("std");
const mask = @import("mask");

pub const BUF_SIZE: usize = 64 * 1024;

/// チャンク境界を跨ぐシークレットも取りこぼさないマスク処理の状態。
///
/// combined = [overlap (overlap_size バイトまで) | 新規読み取り (BUF_SIZE バイトまで)]
/// combined は常に「元の平文」を保持する。mask.maskAll は buf を in-place で
/// 書き換えてしまうため、combined を直接渡さず scratch (使い捨てコピー) に渡し、
/// mask_buf (マッチ位置の bool マーク) だけを受け取る。
///
/// combined を原文のまま保つ理由: overlap 部分がマスク済み ('*') になってしまうと、
/// 次チャンクのバイトと連結しても元の平文と一致せず、境界を跨ぐシークレットの
/// マッチに失敗する (例: secret="aa", 入力="aa"+"a" → overlap が '*' だと
/// 2 回目に "*a" を見ても "aa" にマッチしない)。
///
/// 一方で、原文のまま持ち越すだけだと「このチャンク内で完全に確定した (跨がない)
/// マッチ」の情報を次周回で失ってしまう (例: secret="hunter2" が safe_end 側と
/// overlap 側にまたがって完全一致した場合、overlap 側の末尾バイトは原文に戻すが、
/// それが同じ secret の一部としてマスク確定していたことを覚えておく必要がある)。
/// そのため carried_mask で「持ち越した overlap のうち、既に確定マスクされた
/// 位置」を bool で追跡し、次周回の mask_buf と OR して最終的なマスク要否を求める。
pub const MaskStream = struct {
    secrets: []const []const u8,
    /// 次チャンクとマッチが跨りうる保持バイト数 = maxSecretLen - 1。
    /// secrets が空、または 1 バイト secret のみなら 0 (持ち越し不要)。
    overlap_size: usize,
    combined: []u8,
    scratch: []u8,
    mask_buf: []bool,
    carried_mask: []bool,
    overlap_len: usize = 0,

    pub fn init(allocator: std.mem.Allocator, secrets: []const []const u8) !MaskStream {
        const max_len = mask.maxSecretLen(secrets);
        const overlap_size: usize = if (max_len == 0) 0 else max_len - 1;
        const cap = overlap_size + BUF_SIZE;

        const combined = try allocator.alloc(u8, cap);
        errdefer allocator.free(combined);
        const scratch = try allocator.alloc(u8, cap);
        errdefer allocator.free(scratch);
        const mask_buf = try allocator.alloc(bool, cap);
        errdefer allocator.free(mask_buf);
        const carried_mask = try allocator.alloc(bool, overlap_size);
        @memset(carried_mask, false);

        return .{
            .secrets = secrets,
            .overlap_size = overlap_size,
            .combined = combined,
            .scratch = scratch,
            .mask_buf = mask_buf,
            .carried_mask = carried_mask,
        };
    }

    pub fn deinit(self: *MaskStream, allocator: std.mem.Allocator) void {
        allocator.free(self.combined);
        allocator.free(self.scratch);
        allocator.free(self.mask_buf);
        allocator.free(self.carried_mask);
        self.* = undefined;
    }

    /// 次の read(2) / reader.read() の宛先スライス。
    /// 読み取れたバイト数をそのまま `push` に渡すこと。
    pub fn readBuf(self: *MaskStream) []u8 {
        return self.combined[self.overlap_len .. self.overlap_len + BUF_SIZE];
    }

    /// `readBuf()` に n バイト読み込んだ後に呼ぶ。出力可能な部分だけ writer へ流し、
    /// 末尾 overlap_size バイトは次回へ持ち越す。
    pub fn push(self: *MaskStream, n: usize, writer: anytype) !void {
        if (n == 0) return;
        const total = self.overlap_len + n;

        // combined (原文) を破壊せず、scratch 上でマスク処理を行う。
        // mask_buf[i] には「位置 i が今回の総当たりでマッチしたか」が書き戻される。
        std.mem.copyForwards(u8, self.scratch[0..total], self.combined[0..total]);
        mask.maskAll(self.scratch[0..total], self.secrets, self.mask_buf[0..total]);

        // combined[0..overlap_len] は前回持ち越した overlap。carried_mask に
        // 前回までの確定マッチが記録されているので、それを scratch に反映してから
        // 出力する (今回未マッチでも、以前確定済みならマスクする)。
        var k: usize = 0;
        while (k < self.overlap_len) : (k += 1) {
            if (self.carried_mask[k]) self.scratch[k] = '*';
        }

        // 末尾 overlap_size バイトは次チャンクとマッチが跨る可能性があるため、
        // まだ出力せずオーバーラップとして保持する。
        const safe_end = if (total > self.overlap_size) total - self.overlap_size else 0;
        if (safe_end > 0) {
            try writer.writeAll(self.scratch[0..safe_end]);
        }

        const new_overlap = total - safe_end;
        if (new_overlap > 0) {
            // 次周回へ持ち越す carried_mask を更新する: 今回の mask_buf の結果と、
            // (該当位置がさらに前回の overlap 由来でもあれば) 前回の carried_mask との OR。
            var j: usize = 0;
            while (j < new_overlap) : (j += 1) {
                const src = safe_end + j;
                self.carried_mask[j] = self.mask_buf[src] or (src < self.overlap_len and self.carried_mask[src]);
            }
            // combined は原文のまま前に詰める (scratch ではなく combined から)。
            std.mem.copyForwards(u8, self.combined[0..new_overlap], self.combined[safe_end..total]);
        }
        self.overlap_len = new_overlap;
    }

    /// EOF 到達時に呼ぶ。残った overlap にはこれ以上跨るチャンクが来ないので、
    /// 原文に対して最後にもう一度マッチングし、carried_mask (それまでに確定して
    /// いたマッチ) と OR して出力する。
    pub fn finish(self: *MaskStream, writer: anytype) !void {
        if (self.overlap_len == 0) return;
        const len = self.overlap_len;
        std.mem.copyForwards(u8, self.scratch[0..len], self.combined[0..len]);
        mask.maskAll(self.scratch[0..len], self.secrets, self.mask_buf[0..len]);
        var i: usize = 0;
        while (i < len) : (i += 1) {
            if (self.carried_mask[i]) self.scratch[i] = '*';
        }
        try writer.writeAll(self.scratch[0..len]);
        self.overlap_len = 0;
    }
};

/// reader → writer のストリーミングマスク (フィルタモードの本体)。
pub fn streamMask(
    reader: anytype,
    writer: anytype,
    secrets: []const []const u8,
) !void {
    var stream = try MaskStream.init(std.heap.page_allocator, secrets);
    defer stream.deinit(std.heap.page_allocator);
    while (true) {
        const n = try reader.read(stream.readBuf());
        if (n == 0) break;
        try stream.push(n, writer);
    }
    try stream.finish(writer);
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

test "MaskStream: incremental push mirrors streamMask" {
    // supervise モードは push/finish を直接叩くため、分割供給でも
    // 一括処理と同じ結果になることを確認する。
    var stream = try MaskStream.init(testing.allocator, &.{"hunter2"});
    defer stream.deinit(testing.allocator);

    var output: std.ArrayList(u8) = .empty;
    defer output.deinit(testing.allocator);
    var writer = output.writer(testing.allocator);

    const input = "pw=hunter2 and hunter2 again";
    var pos: usize = 0;
    while (pos < input.len) {
        const n = @min(@as(usize, 3), input.len - pos);
        const buf = stream.readBuf();
        @memcpy(buf[0..n], input[pos .. pos + n]);
        try stream.push(n, &writer);
        pos += n;
    }
    try stream.finish(&writer);

    try testing.expectEqualStrings("pw=******* and ******* again", output.items);
}
