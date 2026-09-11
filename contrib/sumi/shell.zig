//! POSIX シェル向けの quote。
//!
//! Claude Code の shell prefix はシェルコマンドとして保存される。英数字と
//! `_ / . - = : @ ,` だけの文字列はそのまま返し、
//! それ以外は単引用符で包み、内側の単引用符は `'\''` にする。

const std = @import("std");

fn isBare(c: u8) bool {
    return std.ascii.isAlphanumeric(c) or switch (c) {
        '_', '/', '.', '-', '=', ':', '@', ',' => true,
        else => false,
    };
}

pub fn needsQuote(s: []const u8) bool {
    if (s.len == 0) return true;
    for (s) |c| if (!isBare(c)) return true;
    return false;
}

pub fn isExecutableFile(path: []const u8) bool {
    const file = std.fs.cwd().openFile(path, .{}) catch return false;
    defer file.close();
    if ((file.stat() catch return false).kind != .file) return false;
    std.posix.access(path, std.posix.X_OK) catch return false;
    return true;
}

pub fn resolveBash(allocator: std.mem.Allocator) !?[]u8 {
    const path = std.posix.getenv("PATH") orelse return null;
    var it = std.mem.splitScalar(u8, path, ':');
    while (it.next()) |dir| {
        if (dir.len == 0) continue;
        const candidate = try std.fs.path.join(allocator, &.{ dir, "bash" });
        defer allocator.free(candidate);
        const absolute = std.fs.cwd().realpathAlloc(allocator, candidate) catch continue;
        if (isExecutableFile(absolute)) return absolute;
        allocator.free(absolute);
    }
    return null;
}

pub fn quote(allocator: std.mem.Allocator, s: []const u8) ![]u8 {
    if (!needsQuote(s)) return allocator.dupe(u8, s);
    var out: std.ArrayList(u8) = .empty;
    try out.append(allocator, '\'');
    for (s) |c| {
        if (c == '\'') {
            try out.appendSlice(allocator, "'\\''");
        } else {
            try out.append(allocator, c);
        }
    }
    try out.append(allocator, '\'');
    return out.toOwnedSlice(allocator);
}

/// 引数列を空白で繋いだ 1 本のコマンド行にする。
pub fn join(allocator: std.mem.Allocator, argv: []const []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    for (argv, 0..) |arg, i| {
        if (i > 0) try out.append(allocator, ' ');
        const q = try quote(allocator, arg);
        defer allocator.free(q);
        try out.appendSlice(allocator, q);
    }
    return out.toOwnedSlice(allocator);
}

const testing = std.testing;

test "quote: bare strings pass through" {
    const q = try quote(testing.allocator, "/usr/local/bin/sumi");
    defer testing.allocator.free(q);
    try testing.expectEqualStrings("/usr/local/bin/sumi", q);
}

test "quote: spaces and shell metacharacters are single-quoted" {
    const q = try quote(testing.allocator, "cat 'a b' && false");
    defer testing.allocator.free(q);
    try testing.expectEqualStrings("'cat '\\''a b'\\'' && false'", q);
}

test "quote: empty string becomes ''" {
    const q = try quote(testing.allocator, "");
    defer testing.allocator.free(q);
    try testing.expectEqualStrings("''", q);
}

test "join: arguments are quoted individually" {
    const j = try join(testing.allocator, &.{ "/bin/bash", "-c", "echo hi; exit 3" });
    defer testing.allocator.free(j);
    try testing.expectEqualStrings("/bin/bash -c 'echo hi; exit 3'", j);
}
