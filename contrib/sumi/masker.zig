//! 値の判定と置換を、手元の一覧で行うか、ブローカーの socket へ問い合わせるか。
//!
//! `--secrets-file F` は一覧をこのプロセスに読み込む。`--socket SOCKET` は一覧を
//! 持たず、`nas-mask-filter --serve` と同じ 1 接続 = 1 ストリームのプロトコルで
//! バイト列を送り、マスク済みのバイト列を受け取る。一覧をエージェントと同じ
//! 環境へ置けないとき (コンテナ内の hook) に後者を使う。
//!
//! socket では一覧を持たないので、「含むか」は送ったバイト列と返ってきたバイト列が
//! 異なるかで判定する。`*` だけから成る値は一覧では「含む」だが、置換しても
//! 変わらないので socket では「含まない」になる。

const std = @import("std");
const mask = @import("masking").mask;
const supervise = @import("supervise");
const secrets = @import("secrets.zig");

pub const Error = error{ OutOfMemory, MaskUnavailable };

/// ブローカーへ問い合わせられなかったときに利用者へ見せる理由文。
pub const UNAVAILABLE_REASON = "the mask broker could not be reached";

/// コマンドラインで選んだ値の出どころ。
pub const Source = union(enum) {
    secrets_file: []const u8,
    socket: []const u8,
};

/// `--secrets-file` / `--socket` を 1 つだけ受け取るための状態。
/// 引数パーサはオプションを見つけるたびに `take` を呼び、最後に `finish` を呼ぶ。
pub const SourceOption = struct {
    value: ?Source = null,

    pub fn isName(name: []const u8) bool {
        return std.mem.eql(u8, name, "--secrets-file") or std.mem.eql(u8, name, "--socket");
    }

    pub fn take(self: *SourceOption, name: []const u8, value: []const u8) !void {
        if (self.value) |existing| {
            const same = switch (existing) {
                .secrets_file => std.mem.eql(u8, name, "--secrets-file"),
                .socket => std.mem.eql(u8, name, "--socket"),
            };
            return if (same) error.DuplicateOption else error.ConflictingSources;
        }
        self.value = if (std.mem.eql(u8, name, "--socket")) .{ .socket = value } else .{ .secrets_file = value };
    }

    pub fn finish(self: SourceOption) !Source {
        return self.value orelse error.MissingSource;
    }
};

pub const Masker = union(enum) {
    values: []const []const u8,
    socket: []const u8,

    /// bytes が保護された値を含むか。
    pub fn contains(self: Masker, allocator: std.mem.Allocator, bytes: []const u8) Error!bool {
        switch (self) {
            .values => |values| return mask.containsAny(bytes, values),
            .socket => |path| {
                const masked = try roundTrip(allocator, path, bytes);
                defer allocator.free(masked);
                return !std.mem.eql(u8, masked, bytes);
            },
        }
    }

    /// 各入力をマスクした新しいバッファを返す。変化の無い入力は null。
    /// 返すスライスとバッファは allocator の所有になる。
    pub fn maskMany(self: Masker, allocator: std.mem.Allocator, inputs: []const []const u8) Error![]?[]u8 {
        const out = try allocator.alloc(?[]u8, inputs.len);
        @memset(out, null);
        switch (self) {
            .values => |values| for (inputs, out) |input, *slot| {
                if (!mask.containsAny(input, values)) continue;
                const copy = try allocator.dupe(u8, input);
                mask.maskAll(copy, values, null);
                slot.* = copy;
            },
            .socket => |path| try maskManyRemote(allocator, path, inputs, out),
        }
        return out;
    }
};

fn roundTrip(allocator: std.mem.Allocator, path: []const u8, bytes: []const u8) Error![]u8 {
    return supervise.maskOnce(allocator, path, bytes) catch |err| switch (err) {
        error.OutOfMemory => error.OutOfMemory,
        else => error.MaskUnavailable,
    };
}

/// 入力ごとに接続すると、ファイル名の配列のような多数の短い文字列で接続が
/// 数千になる。NUL で区切って 1 接続にまとめ、区切りがそのまま返ってきたときだけ
/// 切り分けて使う。区切りが変わったのは値が区切りを跨いで一致したということで、
/// 入力ごとのマスクとは結果が異なりうるので、そのときは入力ごとに問い合わせ直す。
fn maskManyRemote(allocator: std.mem.Allocator, path: []const u8, inputs: []const []const u8, out: []?[]u8) Error!void {
    if (inputs.len == 0) return;
    var total: usize = inputs.len - 1;
    for (inputs) |input| total += input.len;
    const joined = try allocator.alloc(u8, total);
    defer allocator.free(joined);
    var at: usize = 0;
    for (inputs, 0..) |input, i| {
        if (i > 0) {
            joined[at] = 0;
            at += 1;
        }
        @memcpy(joined[at .. at + input.len], input);
        at += input.len;
    }

    const masked = try roundTrip(allocator, path, joined);
    defer allocator.free(masked);

    var separators_intact = true;
    at = 0;
    for (inputs, 0..) |input, i| {
        if (i > 0) {
            if (masked[at] != 0) separators_intact = false;
            at += 1;
        }
        at += input.len;
    }

    if (separators_intact) {
        at = 0;
        for (inputs, out, 0..) |input, *slot, i| {
            if (i > 0) at += 1;
            const piece = masked[at .. at + input.len];
            at += input.len;
            if (!std.mem.eql(u8, piece, input)) slot.* = try allocator.dupe(u8, piece);
        }
        return;
    }

    for (inputs, out) |input, *slot| {
        const piece = try roundTrip(allocator, path, input);
        if (std.mem.eql(u8, piece, input)) allocator.free(piece) else slot.* = piece;
    }
}

pub const Resolved = union(enum) {
    ok: Masker,
    /// 利用者へ見せる理由文。
    err: []const u8,
};

/// Source を Masker にする。secrets ファイルはここで読み、socket はまだ接続しない
/// (接続の失敗は問い合わせのたびに MaskUnavailable として現れる)。
pub fn resolve(allocator: std.mem.Allocator, source: Source) Resolved {
    return switch (source) {
        .secrets_file => |path| if (secrets.load(allocator, path)) |values| .{ .ok = .{ .values = values } } else |err| .{ .err = secrets.describe(err) },
        .socket => |path| .{ .ok = .{ .socket = path } },
    };
}

fn freeMany(allocator: std.mem.Allocator, got: []?[]u8) void {
    for (got) |item| if (item) |bytes| allocator.free(bytes);
    allocator.free(got);
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

const testing = std.testing;
const posix = std.posix;

/// テスト用のブローカー。接続を `connections` 本受け、それぞれ入力を読み切ってから
/// 一覧でマスクして返す。
pub const TestBroker = struct {
    path_buf: [107]u8 = undefined,
    path: []const u8 = "",
    listener: posix.socket_t = -1,
    thread: ?std.Thread = null,
    values: []const []const u8,
    served: std.atomic.Value(usize) = .init(0),

    pub fn start(self: *TestBroker, name: []const u8, connections: usize) !void {
        self.path = try std.fmt.bufPrint(&self.path_buf, "/tmp/sumi-test-{s}-{d}.sock", .{ name, std.c.getpid() });
        var addr = posix.sockaddr.un{ .family = posix.AF.UNIX, .path = undefined };
        @memset(&addr.path, 0);
        @memcpy(addr.path[0..self.path.len], self.path);
        self.listener = try posix.socket(posix.AF.UNIX, posix.SOCK.STREAM | posix.SOCK.CLOEXEC, 0);
        posix.unlink(self.path) catch {};
        try posix.bind(self.listener, @ptrCast(&addr), @sizeOf(posix.sockaddr.un));
        try posix.listen(self.listener, 16);
        self.thread = try std.Thread.spawn(.{}, serve, .{ self, connections });
    }

    pub fn stop(self: *TestBroker) void {
        if (self.thread) |t| t.join();
        posix.close(self.listener);
        posix.unlink(self.path) catch {};
    }

    fn serve(self: *TestBroker, connections: usize) void {
        var n: usize = 0;
        while (n < connections) : (n += 1) {
            const peer = posix.accept(self.listener, null, null, posix.SOCK.CLOEXEC) catch return;
            defer posix.close(peer);
            var data: std.ArrayList(u8) = .empty;
            defer data.deinit(std.heap.page_allocator);
            var buf: [4096]u8 = undefined;
            while (true) {
                const got = posix.read(peer, &buf) catch return;
                if (got == 0) break;
                data.appendSlice(std.heap.page_allocator, buf[0..got]) catch return;
            }
            mask.maskAll(data.items, self.values, null);
            var off: usize = 0;
            while (off < data.items.len) off += posix.write(peer, data.items[off..]) catch return;
            _ = self.served.fetchAdd(1, .monotonic);
        }
    }
};

test "SourceOption: exactly one of --secrets-file and --socket" {
    var opt = SourceOption{};
    try opt.take("--socket", "/s");
    try testing.expectEqualStrings("/s", (try opt.finish()).socket);
    try testing.expectError(error.ConflictingSources, opt.take("--secrets-file", "/f"));
    try testing.expectError(error.DuplicateOption, opt.take("--socket", "/t"));
    try testing.expectError(error.MissingSource, (SourceOption{}).finish());
}

test "socket masker: contains compares the returned bytes" {
    var broker = TestBroker{ .values = &.{"Tr0ub4dor"} };
    try broker.start("contains", 2);
    defer broker.stop();
    const m: Masker = .{ .socket = broker.path };
    try testing.expect(try m.contains(testing.allocator, "pw=Tr0ub4dor"));
    try testing.expect(!(try m.contains(testing.allocator, "nothing here")));
}

test "socket masker: many inputs share one connection" {
    var broker = TestBroker{ .values = &.{"Tr0ub4dor"} };
    try broker.start("many", 1);
    defer broker.stop();
    const m: Masker = .{ .socket = broker.path };
    const got = try m.maskMany(testing.allocator, &.{ "a", "x Tr0ub4dor y", "", "b" });
    defer freeMany(testing.allocator, got);
    try testing.expectEqual(@as(?[]u8, null), got[0]);
    try testing.expectEqualStrings("x ********* y", got[1].?);
    try testing.expectEqual(@as(?[]u8, null), got[2]);
    try testing.expectEqual(@as(?[]u8, null), got[3]);
    try testing.expectEqual(@as(usize, 1), broker.served.load(.monotonic));
}

test "socket masker: a match across a separator falls back to one input per connection" {
    // "ab\x00cd" は区切りを跨ぐ値。入力ごとに見ればどちらも含まない。
    var broker = TestBroker{ .values = &.{ "ab\x00cd", "Tr0ub4dor" } };
    try broker.start("fallback", 4);
    defer broker.stop();
    const m: Masker = .{ .socket = broker.path };
    const got = try m.maskMany(testing.allocator, &.{ "ab", "cd", "Tr0ub4dor" });
    defer freeMany(testing.allocator, got);
    try testing.expectEqual(@as(?[]u8, null), got[0]);
    try testing.expectEqual(@as(?[]u8, null), got[1]);
    try testing.expectEqualStrings("*********", got[2].?);
}

test "socket masker: an unreachable broker is MaskUnavailable" {
    const m: Masker = .{ .socket = "/nonexistent/sumi-test.sock" };
    try testing.expectError(error.MaskUnavailable, m.contains(testing.allocator, "x"));
}

test "values masker: keeps the in-process behaviour" {
    const m: Masker = .{ .values = &.{"Tr0ub4dor"} };
    try testing.expect(try m.contains(testing.allocator, "pw=Tr0ub4dor"));
    const got = try m.maskMany(testing.allocator, &.{ "pw=Tr0ub4dor", "clean" });
    defer freeMany(testing.allocator, got);
    try testing.expectEqualStrings("pw=*********", got[0].?);
    try testing.expectEqual(@as(?[]u8, null), got[1]);
}
