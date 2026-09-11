//! 平文の secrets ファイル: 1 行 1 値。
//!
//! 空行は無視し、行末の LF だけを取り除く。CR や前後の空白は値の一部として扱う
//! (値に空白が含まれる可能性を排除しないため)。各値は UTF-8 として有効で
//! 4 バイト以上。1024 件を上限にする。

const std = @import("std");

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
};

/// 利用者へ見せる理由文。hook の decision と init の診断で共用する。
pub fn describe(err: LoadError) []const u8 {
    return switch (err) {
        error.Unreadable => "the secrets file is missing or unreadable",
        error.Empty => "the secrets file is empty",
        error.TooShort => "the secrets file holds a value shorter than 4 bytes",
        error.InvalidUtf8 => "the secrets file holds a value that is not valid UTF-8",
        error.TooMany => "the secrets file holds more than 1024 values",
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
    return parse(allocator, text);
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

test "load: missing file is Unreadable" {
    try testing.expectError(error.Unreadable, load(testing.allocator, "/nonexistent/sumi-secrets"));
}
