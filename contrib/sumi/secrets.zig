//! 平文の secrets ファイル: 1 行 1 値。
//!
//! 空行は無視し、行末の LF だけを取り除く。CR や前後の空白は値の一部として扱う
//! (値に空白が含まれる可能性を排除しないため)。各値は UTF-8 として有効で
//! 4 バイト以上。1024 件を上限にする。
//!
//! 行が正準な base64(標準またはURL-safe のアルファベット、パディング込みで
//! 長さが 4 の倍数、再エンコードで元に戻る)なら、復号した値も伏せる対象に
//! 加える。復号値の末尾の LF / CRLF は取り除き、UTF-8 として有効・4 バイト以上・
//! 制御文字を含まないものだけを採る。条件を満たさない行は通常の値として扱うだけで
//! エラーにはしない。復号値は 1024 件の上限に数えない。

const std = @import("std");
const patterns = @import("patterns.zig");

pub const MIN_LEN: usize = 4;
pub const MAX_COUNT: usize = 1024;
pub const MAX_FILE_BYTES: usize = 16 * 1024 * 1024;

pub const LoadError = error{
    Unreadable,
    Empty,
    TooShort,
    InvalidUtf8,
    TooMany,
    OutOfMemory,
    ExpansionTooLarge,
};

/// 利用者へ見せる理由文。hook の decision と init の診断で共用する。
pub fn describe(err: LoadError) []const u8 {
    return switch (err) {
        error.Unreadable => "the secrets file is missing or unreadable",
        error.Empty => "the secrets file is empty",
        error.TooShort => "the secrets file holds a value shorter than 4 bytes",
        error.InvalidUtf8 => "the secrets file holds a value that is not valid UTF-8",
        error.TooMany => "the secrets file holds more than 1024 values",
        error.ExpansionTooLarge => "encoded mask patterns exceed the 64 MiB or 262144-pattern limit",
        error.OutOfMemory => "out of memory while reading the secrets file",
    };
}

pub fn parse(allocator: std.mem.Allocator, text: []const u8) LoadError![]const []const u8 {
    var list: std.ArrayList([]const u8) = .empty;
    var it = std.mem.splitScalar(u8, text, '\n');
    while (it.next()) |line| {
        if (line.len == 0) continue;
        if (line.len < MIN_LEN) {
            list.deinit(allocator);
            return error.TooShort;
        }
        if (!std.unicode.utf8ValidateSlice(line)) {
            list.deinit(allocator);
            return error.InvalidUtf8;
        }
        if (list.items.len >= MAX_COUNT) {
            list.deinit(allocator);
            return error.TooMany;
        }
        list.append(allocator, line) catch {
            list.deinit(allocator);
            return error.OutOfMemory;
        };
    }
    if (list.items.len == 0) {
        list.deinit(allocator);
        return error.Empty;
    }
    return list.toOwnedSlice(allocator) catch return error.OutOfMemory;
}

pub fn load(allocator: std.mem.Allocator, path: []const u8) LoadError![]const []const u8 {
    const text = std.fs.cwd().readFileAlloc(allocator, path, MAX_FILE_BYTES) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return error.Unreadable,
    };
    defer allocator.free(text);
    const values = try parse(allocator, text);
    defer allocator.free(values);
    return expandWithDecoded(allocator, values);
}

/// 行が正準な base64 で、復号値が秘密として妥当なら、その値を新たに確保して返す。
fn decodeBase64(allocator: std.mem.Allocator, line: []const u8) error{OutOfMemory}!?[]u8 {
    // CR は base64 のアルファベットにないので、CRLF のファイルでも判定できるようにする。
    const source = std.mem.trimEnd(u8, line, "\r");
    if (source.len == 0 or source.len % 4 != 0) return null;
    for ([_]std.base64.Codecs{ std.base64.standard, std.base64.url_safe }) |codec| {
        const size = codec.Decoder.calcSizeForSlice(source) catch continue;
        const decoded = try allocator.alloc(u8, size);
        var keep = false;
        defer if (!keep) allocator.free(decoded);
        codec.Decoder.decode(decoded, source) catch continue;
        // 余りビットが 0 でない等の非正準な入力は、偶然 base64 に見えた値として除く。
        const reencoded = try allocator.alloc(u8, codec.Encoder.calcSize(size));
        defer allocator.free(reencoded);
        if (!std.mem.eql(u8, codec.Encoder.encode(reencoded, decoded), source)) continue;
        var value: []const u8 = decoded;
        if (std.mem.endsWith(u8, value, "\r\n")) {
            value = value[0 .. value.len - 2];
        } else if (std.mem.endsWith(u8, value, "\n")) {
            value = value[0 .. value.len - 1];
        }
        if (value.len < MIN_LEN or !std.unicode.utf8ValidateSlice(value)) return null;
        for (value) |c| if (c < 0x20 or c == 0x7f) return null;
        keep = true;
        return allocator.realloc(decoded, value.len) catch |err| {
            allocator.free(decoded);
            return err;
        };
    }
    return null;
}

/// 各値と、base64 として復号できた値をまとめて展開する。
fn expandWithDecoded(allocator: std.mem.Allocator, values: []const []const u8) LoadError![]const []const u8 {
    var all: std.ArrayList([]const u8) = .empty;
    defer {
        for (all.items[@min(values.len, all.items.len)..]) |value| allocator.free(value);
        all.deinit(allocator);
    }
    try all.appendSlice(allocator, values);
    for (values) |value| {
        const decoded = try decodeBase64(allocator, value) orelse continue;
        all.append(allocator, decoded) catch |err| {
            allocator.free(decoded);
            return err;
        };
    }
    return patterns.expand(allocator, all.items);
}

const testing = std.testing;

test "parse: one value per line, blank lines ignored, LF only stripped" {
    const got = try parse(testing.allocator, "Tr0ub4dor\n\nhunter2xyz\r\n  padded  \n");
    defer testing.allocator.free(got);
    try testing.expectEqual(@as(usize, 3), got.len);
    try testing.expectEqualStrings("Tr0ub4dor", got[0]);
    try testing.expectEqualStrings("hunter2xyz\r", got[1]);
    try testing.expectEqualStrings("  padded  ", got[2]);
}

test "parse: last line without trailing newline is kept" {
    const got = try parse(testing.allocator, "Tr0ub4dor");
    defer testing.allocator.free(got);
    try testing.expectEqual(@as(usize, 1), got.len);
}

test "parse: empty file is an error" {
    try testing.expectError(error.Empty, parse(testing.allocator, ""));
    try testing.expectError(error.Empty, parse(testing.allocator, "\n\n"));
}

test "parse: a value shorter than 4 bytes is an error" {
    try testing.expectError(error.TooShort, parse(testing.allocator, "Tr0ub4dor\nabc\n"));
}

test "parse: invalid UTF-8 is an error" {
    try testing.expectError(error.InvalidUtf8, parse(testing.allocator, "ab\xff\xfecd\n"));
}

test "parse: more than 1024 values is an error" {
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(testing.allocator);
    var i: usize = 0;
    while (i < 1025) : (i += 1) try buf.writer(testing.allocator).print("value{d:0>5}\n", .{i});
    try testing.expectError(error.TooMany, parse(testing.allocator, buf.items));
}

fn expectDecoded(line: []const u8, expected: ?[]const u8) !void {
    const got = try decodeBase64(testing.allocator, line);
    defer if (got) |g| testing.allocator.free(g);
    if (expected) |e| {
        try testing.expectEqualStrings(e, got orelse return error.TestExpectedDecoded);
    } else {
        try testing.expect(got == null);
    }
}

test "decodeBase64: canonical padded base64 in both alphabets is decoded" {
    try expectDecoded("VHIwdWI0ZG9y", "Tr0ub4dor");
    try expectDecoded("aHVudGVyMnh5eg==", "hunter2xyz");
    try expectDecoded("fn5-Pz8_", "~~~???");
    try expectDecoded("fn5+Pz8/", "~~~???");
}

test "decodeBase64: a trailing LF or CRLF is stripped from the value and the line" {
    try expectDecoded("VHIwdWI0ZG9yCg==", "Tr0ub4dor");
    try expectDecoded("VHIwdWI0ZG9yDQo=", "Tr0ub4dor");
    try expectDecoded("VHIwdWI0ZG9y\r", "Tr0ub4dor");
}

test "decodeBase64: lines that are not a plausible encoded secret are left alone" {
    try expectDecoded("Tr0ub4dor", null); // length not a multiple of 4
    try expectDecoded("VHIwdWI0ZG9", null); // unpadded
    try expectDecoded("dGVzdB==", null); // non-canonical padding bits
    try expectDecoded("YWJj", null); // decodes to 3 bytes
    try expectDecoded("//79/Q==", null); // not UTF-8
    try expectDecoded("YQliYw==", null); // control character
    try expectDecoded("pass word", null);
}

test "load: base64 lines also mask the decoded value and its encodings" {
    const values = try expandWithDecoded(testing.allocator, &.{ "VHIwdWI0ZG9y", "plain-value" });
    defer patterns.free(testing.allocator, values);
    const mask = @import("masking").mask;
    for ([_][]const u8{ "VHIwdWI0ZG9y", "Tr0ub4dor", "plain-value" }) |s|
        try testing.expect(mask.containsAny(s, values));
    try testing.expect(!mask.containsAny("ordinary text", values));
}

fn decodedAllocationProbe(a: std.mem.Allocator) !void {
    const values = try expandWithDecoded(a, &.{ "VHIwdWI0ZG9y", "plain-value" });
    defer patterns.free(a, values);
}

test "load: base64 decoding cleans up on every allocation failure" {
    try testing.checkAllAllocationFailures(testing.allocator, decodedAllocationProbe, .{});
}

test "load: missing file is Unreadable" {
    try testing.expectError(error.Unreadable, load(testing.allocator, "/nonexistent/sumi-secrets"));
}
