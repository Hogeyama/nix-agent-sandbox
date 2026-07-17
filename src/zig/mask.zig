//! maskfs の純粋ロジック: バイト列置換とウィンドウ計算。
//! FUSE に依存しないため zig build test で単体テストできる。

const std = @import("std");

/// buf 内の各 secret の全出現をバイトごとに '*' へ置換する (in-place)。
///
/// 2-pass 方式:
///   1. mark: 元の buf に対して各 secret の全出現 (重複含む) を検出し、
///      該当するバイト位置を bool 配列に記録する。
///   2. replace: マークされたバイトをすべて '*' に置換する。
///
/// これにより、自己重複マッチ (secrets=["aaa"], buf="aaaaa") や
/// secret 間の順序依存 (secrets=["ab","abc"], buf="xabcx") でも
/// 関与する全バイトが漏れなくマスクされる。
/// アロケーション失敗時は fail-closed でバッファ全体を '*' にする。
pub fn maskAll(buf: []u8, secrets: []const []const u8, static_mask: ?[]bool) void {
    const mask_arr = if (static_mask) |m| blk: {
        if (m.len >= buf.len) break :blk m[0..buf.len];
        break :blk null;
    } else null;

    const owned_mask = mask_arr orelse blk: {
        break :blk std.heap.page_allocator.alloc(bool, buf.len) catch {
            @memset(buf, '*');
            return;
        };
    };
    defer if (mask_arr == null) std.heap.page_allocator.free(owned_mask);
    @memset(owned_mask, false);

    for (secrets) |secret| {
        if (secret.len == 0) continue;
        var i: usize = 0;
        while (i + secret.len <= buf.len) {
            if (std.mem.eql(u8, buf[i .. i + secret.len], secret)) {
                @memset(owned_mask[i .. i + secret.len], true);
            }
            i += 1;
        }
    }

    for (owned_mask, 0..) |marked, idx| {
        if (marked) buf[idx] = '*';
    }
}

pub fn maxSecretLen(secrets: []const []const u8) usize {
    var max: usize = 0;
    for (secrets) |s| {
        if (s.len > max) max = s.len;
    }
    return max;
}

/// pread(offset, size) 要求に対し、境界を跨ぐマッチも捕捉できるよう
/// 前後 max_len-1 バイト拡張した読み取りウィンドウを返す。
/// lead = 拡張ウィンドウ先頭から要求 offset までのバイト数。
pub const Window = struct { start: u64, lead: usize, len: usize };

pub fn computeWindow(offset: u64, size: usize, max_len: usize) Window {
    const pad: u64 = if (max_len == 0) 0 else max_len - 1;
    const start = if (offset >= pad) offset - pad else 0;
    const lead: usize = @intCast(offset - start);
    return .{ .start = start, .lead = lead, .len = lead + size + @as(usize, @intCast(pad)) };
}

pub fn containsAny(haystack: []const u8, secrets: []const []const u8) bool {
    for (secrets) |secret| {
        if (secret.len == 0) continue;
        if (std.mem.indexOf(u8, haystack, secret) != null) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

test "maskAll replaces single occurrence with same length" {
    var buf = "DB_PASSWORD=hunter2secret\n".*;
    maskAll(&buf, &.{"hunter2secret"}, null);
    try std.testing.expectEqualStrings("DB_PASSWORD=*************\n", &buf);
}

test "maskAll replaces multiple secrets and occurrences" {
    var buf = "a=tok1 b=tok22 c=tok1".*;
    maskAll(&buf, &.{ "tok1", "tok22" }, null);
    try std.testing.expectEqualStrings("a=**** b=***** c=****", &buf);
}

test "maskAll handles overlapping candidates without panic" {
    var buf = "aaaa".*;
    maskAll(&buf, &.{"aaa"}, null);
    // "aaa" は位置 0..3 と 1..4 の両方でマッチするため、全4バイトがマスクされる
    try std.testing.expectEqualStrings("****", &buf);
}

test "maskAll masks cross-secret overlap regardless of order" {
    var buf = "xabcx".*;
    maskAll(&buf, &.{ "ab", "abc" }, null);
    // "ab" だけを先にマスクすると "abc" のマッチが壊れて "c" が漏れる旧実装の不具合を防ぐ
    try std.testing.expectEqualStrings("x***x", &buf);
}

test "maskAll masks self-overlapping longer match fully" {
    var buf = "aaaaa".*;
    maskAll(&buf, &.{"aaa"}, null);
    try std.testing.expectEqualStrings("*****", &buf);
}

test "maskAll on binary bytes" {
    var buf = [_]u8{ 0x00, 's', 'e', 'c', 0xff };
    maskAll(&buf, &.{"sec"}, null);
    try std.testing.expectEqualSlices(u8, &[_]u8{ 0x00, '*', '*', '*', 0xff }, &buf);
}

test "computeWindow at file head" {
    const w = computeWindow(0, 10, 5);
    try std.testing.expectEqual(@as(u64, 0), w.start);
    try std.testing.expectEqual(@as(usize, 0), w.lead);
    try std.testing.expectEqual(@as(usize, 14), w.len);
}

test "computeWindow mid-file" {
    const w = computeWindow(100, 10, 5);
    try std.testing.expectEqual(@as(u64, 96), w.start);
    try std.testing.expectEqual(@as(usize, 4), w.lead);
    try std.testing.expectEqual(@as(usize, 18), w.len);
}

test "chunk-boundary straddling match is masked" {
    // secret "SECRET" が offset 4..10 に跨る。要求は offset=6, size=4。
    const data = "abcdSECRETwxyz";
    const secrets = [_][]const u8{"SECRET"};
    const w = computeWindow(6, 4, maxSecretLen(&secrets));
    var window_buf: [64]u8 = undefined;
    const end = @min(data.len, @as(usize, @intCast(w.start)) + w.len);
    const got = data[@intCast(w.start)..end];
    @memcpy(window_buf[0..got.len], got);
    maskAll(window_buf[0..got.len], &secrets, null);
    // 中央スライス = 要求範囲 (offset 6..10 = "CRET" → "****")
    try std.testing.expectEqualStrings("****", window_buf[w.lead .. w.lead + 4]);
}

test "containsAny" {
    try std.testing.expect(containsAny("xx hunter2 yy", &.{"hunter2"}));
    try std.testing.expect(!containsAny("nothing here", &.{"hunter2"}));
}
