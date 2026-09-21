//! Bounded, owned variants of plaintext secrets. Expansion happens once per load.
const std = @import("std");

pub const MAX_BYTES = 64 * 1024 * 1024;
pub const MAX_PATTERNS = 262144;
const B64_MIN_INTERIOR = 8;
pub const Error = error{ OutOfMemory, ExpansionTooLarge };

const Builder = struct {
    allocator: std.mem.Allocator,
    seen: std.StringHashMap(void),
    list: std.ArrayList([]const u8) = .empty,
    bytes: usize = 0,
    limit: usize = MAX_BYTES,

    fn init(a: std.mem.Allocator) Builder {
        return .{ .allocator = a, .seen = std.StringHashMap(void).init(a) };
    }

    fn deinit(self: *Builder) void {
        for (self.list.items) |p| self.allocator.free(p);
        self.list.deinit(self.allocator);
        self.seen.deinit();
    }

    fn add(self: *Builder, value: []const u8) Error!void {
        if (self.seen.contains(value)) return;
        if (value.len > self.limit - self.bytes or self.list.items.len >= MAX_PATTERNS)
            return error.ExpansionTooLarge;
        try self.list.ensureUnusedCapacity(self.allocator, 1);
        const owned = try self.allocator.dupe(u8, value);
        errdefer self.allocator.free(owned);
        try self.seen.put(owned, {});
        self.list.appendAssumeCapacity(owned);
        self.bytes += value.len;
    }

    fn percent(self: *Builder, value: []const u8, plus: bool, slash: bool, lower: bool) Error!void {
        const hex = if (lower) "0123456789abcdef" else "0123456789ABCDEF";
        // At most three bytes per UTF-8 input byte, already bounded by file size.
        const buf = try self.allocator.alloc(u8, value.len * 3);
        defer self.allocator.free(buf);
        var n: usize = 0;
        for (value) |c| {
            if (std.ascii.isAlphanumeric(c) or std.mem.indexOfScalar(u8, "_.~-", c) != null or (slash and c == '/')) {
                buf[n] = c;
                n += 1;
            } else if (plus and c == ' ') {
                buf[n] = '+';
                n += 1;
            } else {
                buf[n..][0..3].* = .{ '%', hex[c >> 4], hex[c & 15] };
                n += 3;
            }
        }
        try self.add(buf[0..n]);
    }

    fn wrapped(self: *Builder, value: []const u8, first: usize, newline: []const u8) Error!void {
        if (first >= value.len) return;
        const breaks = 1 + (value.len - first - 1) / 76;
        const buf = try self.allocator.alloc(u8, value.len + breaks * newline.len);
        defer self.allocator.free(buf);
        var src: usize = 0;
        var dst: usize = 0;
        var width = first;
        while (src < value.len) {
            const n = @min(width, value.len - src);
            @memcpy(buf[dst..][0..n], value[src..][0..n]);
            src += n;
            dst += n;
            if (src < value.len) {
                @memcpy(buf[dst..][0..newline.len], newline);
                dst += newline.len;
            }
            width = 76;
        }
        try self.add(buf);
    }

    fn base64Variant(self: *Builder, value: []const u8, start_mod4: ?usize) Error!void {
        try self.add(value);
        // Standalone encoding starts at column zero. An embedded confident
        // substring starts at ceil(8*k/6) mod 4; each phase repeats every 76.
        for ([_][]const u8{ "\n", "\r\n" }) |newline| {
            if (start_mod4) |start| {
                var first: usize = 4 - start;
                while (first <= 76 and first < value.len) : (first += 4)
                    try self.wrapped(value, first, newline);
            } else {
                try self.wrapped(value, 76, newline);
            }
        }
    }

    fn base64(self: *Builder, value: []const u8) Error!void {
        const raw = try self.allocator.alloc(u8, value.len + 2);
        defer self.allocator.free(raw);
        const encoded = try self.allocator.alloc(u8, std.base64.standard.Encoder.calcSize(raw.len));
        defer self.allocator.free(encoded);
        for (0..3) |k| {
            @memset(raw[0..k], 0);
            @memcpy(raw[k..][0..value.len], value);
            const n = std.base64.standard.Encoder.calcSize(k + value.len);
            _ = std.base64.standard.Encoder.encode(encoded[0..n], raw[0 .. k + value.len]);
            for (0..2) |alphabet| {
                if (alphabet == 1) for (encoded[0..n]) |*c| {
                    if (c.* == '+') c.* = '-';
                    if (c.* == '/') c.* = '_';
                };
                if (k == 0) {
                    try self.base64Variant(encoded[0..n], null);
                    try self.base64Variant(std.mem.trimEnd(u8, encoded[0..n], "="), null);
                }
                const start = (8 * k + 5) / 6;
                const end = 8 * (k + value.len) / 6;
                if (end - start >= B64_MIN_INTERIOR)
                    try self.base64Variant(encoded[start..end], start % 4);
            }
        }
    }
};

/// Returns individually owned strings and an owned slice. No recursive expansion.
pub fn expand(a: std.mem.Allocator, values: []const []const u8) Error![]const []const u8 {
    var b = Builder.init(a);
    defer b.deinit();
    for (values) |value| {
        try b.add(value);
        for ([_]bool{ false, true }) |lower| {
            try b.percent(value, false, false, lower);
            try b.percent(value, false, true, lower);
            try b.percent(value, true, false, lower);
        }
        try b.base64(value);
    }
    return b.list.toOwnedSlice(a);
}

pub fn free(a: std.mem.Allocator, values: []const []const u8) void {
    for (values) |value| a.free(value);
    a.free(values);
}

const testing = std.testing;
const mask = @import("masking").mask;

test "URL encoding preserves literal case and covers UTF-8, slash and spaces" {
    const values = try expand(testing.allocator, &.{"Ab/é +?"});
    defer free(testing.allocator, values);
    for ([_][]const u8{ "Ab%2F%C3%A9%20%2B%3F", "Ab/%C3%A9%20%2B%3F", "Ab%2F%C3%A9+%2B%3F", "Ab%2f%c3%a9%20%2b%3f" }) |s|
        try testing.expect(mask.containsAny(s, values));
    try testing.expect(!mask.containsAny("ordinary text", values));
}

test "short standalone base64 supports padding and both alphabets" {
    const values = try expand(testing.allocator, &.{"~~~?"});
    defer free(testing.allocator, values);
    for ([_][]const u8{ "fn5+Pw==", "fn5-Pw==", "fn5+Pw", "fn5-Pw" }) |s|
        try testing.expect(mask.containsAny(s, values));
}

test "embedded base64 is masked across every offset and 76-column wrap phase" {
    const secret = "secret/with+symbols-and-a-long-enough-tail" ** 3;
    const values = try expand(testing.allocator, &.{secret});
    defer free(testing.allocator, values);
    for (0..57) |offset| {
        const raw = try std.fmt.allocPrint(testing.allocator, "{s}{s}suffix", .{ ("x" ** 57)[0..offset], secret });
        defer testing.allocator.free(raw);
        const encoded = try testing.allocator.alloc(u8, std.base64.standard.Encoder.calcSize(raw.len));
        defer testing.allocator.free(encoded);
        _ = std.base64.standard.Encoder.encode(encoded, raw);
        for ([_][]const u8{ "", "\n", "\r\n" }) |newline| {
            var text: std.ArrayList(u8) = .empty;
            defer text.deinit(testing.allocator);
            for (encoded, 0..) |c, i| {
                if (i > 0 and i % 76 == 0) try text.appendSlice(testing.allocator, newline);
                try text.append(testing.allocator, c);
            }
            try testing.expect(mask.containsAny(text.items, values));
            mask.maskAll(text.items, values, null);
            try testing.expect(std.mem.count(u8, text.items, "*") >= 8);
        }
    }
}

test "expansion deduplicates and rejects budgets without dropping protection" {
    var b = Builder.init(testing.allocator);
    defer b.deinit();
    b.limit = 4;
    try b.add("abcd");
    try b.add("abcd");
    try testing.expectEqual(@as(usize, 1), b.list.items.len);
    try testing.expectError(error.ExpansionTooLarge, b.add("efgh"));
}

fn allocationProbe(a: std.mem.Allocator) !void {
    const values = try expand(a, &.{ "p@ss word", "p@ss word" });
    defer free(a, values);
}

test "expansion cleans up on every allocation failure" {
    try testing.checkAllAllocationFailures(testing.allocator, allocationProbe, .{});
}
