//! 値の判定と置換を、手元の一覧で行うか、ブローカーへ問い合わせるか。
//!
//! `--secrets-file F` は一覧をこのプロセスに読み込む。`--server ADDR` は一覧を
//! 持たず、`sumi serve` / `nas-mask-filter --serve` と同じ 1 接続 = 1 ストリームの
//! プロトコルでバイト列を送り、マスク済みのバイト列を受け取る。一覧をエージェントと
//! 同じ環境へ置けないとき (コンテナ内の hook、srt の sandbox の中の run) に後者を使う。
//! ADDR は Unix ソケットのパス、`unix:///path`、ループバックの `tcp://` のどれか
//! (supervise.address)。
//!
//! ブローカーでは一覧を持たないので、「含むか」は送ったバイト列と返ってきたバイト列が
//! 異なるかで判定する。`*` だけから成る値は一覧では「含む」だが、置換しても
//! 変わらないのでブローカーでは「含まない」になる。

const std = @import("std");
const mask = @import("masking").mask;
const supervise = @import("supervise");
const secrets = @import("secrets.zig");
const address = supervise.address;

pub const Error = error{ OutOfMemory, MaskUnavailable };

/// ブローカーへ問い合わせられなかったときに利用者へ見せる理由文。
pub const UNAVAILABLE_REASON = "the mask broker could not be reached";

/// `--server` で選んだブローカー。
pub const Server = struct {
    /// 利用者が書いた ADDR そのもの。init はこれを hook と prefix へ書き戻す。
    /// `addr` から組み立て直すと `unix://` の有無などの書き方が変わり、利用者が
    /// 書いた値と settings の値が食い違って見えるので、文字列のまま持つ。
    text: []const u8,
    addr: address.Address,
};

/// コマンドラインで選んだ値の出どころ。
pub const Source = union(enum) {
    secrets_file: []const u8,
    server: Server,
};

/// `--secrets-file` / `--server` を 1 つだけ受け取るための状態。
/// 引数パーサはオプションを見つけるたびに `take` を呼び、最後に `finish` を呼ぶ。
pub const SourceOption = struct {
    value: ?Source = null,

    pub fn isName(name: []const u8) bool {
        return std.mem.eql(u8, name, "--secrets-file") or std.mem.eql(u8, name, "--server");
    }

    /// `--server` の値はここで解釈する。不正な ADDR を接続の失敗 (hook は伏せる、
    /// run は 121) まで持ち越すと、書き間違いが「ブローカーが落ちている」と
    /// 区別できなくなるので、引数の誤り (usage エラー) として返す。
    pub fn take(self: *SourceOption, name: []const u8, value: []const u8) !void {
        if (self.value) |existing| {
            const same = switch (existing) {
                .secrets_file => std.mem.eql(u8, name, "--secrets-file"),
                .server => std.mem.eql(u8, name, "--server"),
            };
            return if (same) error.DuplicateOption else error.ConflictingSources;
        }
        if (std.mem.eql(u8, name, "--server")) {
            const addr = address.parse(value) catch return error.InvalidServerAddress;
            self.value = .{ .server = .{ .text = value, .addr = addr } };
        } else self.value = .{ .secrets_file = value };
    }

    pub fn finish(self: SourceOption) !Source {
        return self.value orelse error.MissingSource;
    }
};

pub const Masker = union(enum) {
    values: []const []const u8,
    server: address.Address,

    /// bytes が保護された値を含むか。
    pub fn contains(self: Masker, allocator: std.mem.Allocator, bytes: []const u8) Error!bool {
        return self.containsVia(allocator, supervise.proxyFromEnv(), bytes);
    }

    /// contains の proxy を呼び出し側が決める版。環境変数に左右されない経路を
    /// テストで取るために分けてある。
    fn containsVia(self: Masker, allocator: std.mem.Allocator, proxy: ?[]const u8, bytes: []const u8) Error!bool {
        switch (self) {
            .values => |values| return mask.containsAny(bytes, values),
            .server => |addr| {
                const masked = try roundTrip(allocator, addr, proxy, bytes);
                defer allocator.free(masked);
                return !std.mem.eql(u8, masked, bytes);
            },
        }
    }

    /// 各入力をマスクした新しいバッファを返す。変化の無い入力は null。
    /// 返すスライスとバッファは allocator の所有になる。
    pub fn maskMany(self: Masker, allocator: std.mem.Allocator, inputs: []const []const u8) Error![]?[]u8 {
        return self.maskManyVia(allocator, supervise.proxyFromEnv(), inputs);
    }

    fn maskManyVia(self: Masker, allocator: std.mem.Allocator, proxy: ?[]const u8, inputs: []const []const u8) Error![]?[]u8 {
        const out = try allocator.alloc(?[]u8, inputs.len);
        @memset(out, null);
        switch (self) {
            .values => |values| for (inputs, out) |input, *slot| {
                if (!mask.containsAny(input, values)) continue;
                const copy = try allocator.dupe(u8, input);
                mask.maskAll(copy, values, null);
                slot.* = copy;
            },
            .server => |addr| try maskManyRemote(allocator, addr, proxy, inputs, out),
        }
        return out;
    }
};

/// proxy は TCP の ADDR のときだけ relay が見る (srt の sandbox の中では proxy の
/// `CONNECT` でしかホストのブローカーへ届かない)。接続・proxy の失敗はどれも
/// MaskUnavailable にまとめ、原因ごとの詳細は呼び出し側へ渡さない。hook の stderr は
/// エージェントに見えうるからである。
fn roundTrip(allocator: std.mem.Allocator, addr: address.Address, proxy: ?[]const u8, bytes: []const u8) Error![]u8 {
    return supervise.maskOnce(allocator, addr, proxy, bytes) catch |err| switch (err) {
        error.OutOfMemory => error.OutOfMemory,
        else => error.MaskUnavailable,
    };
}

/// 入力ごとに接続すると、ファイル名の配列のような多数の短い文字列で接続が
/// 数千になる。NUL で区切って 1 接続にまとめ、区切りがそのまま返ってきたときだけ
/// 切り分けて使う。区切りが変わったのは値が区切りを跨いで一致したということで、
/// 入力ごとのマスクとは結果が異なりうるので、そのときは入力ごとに問い合わせ直す。
fn maskManyRemote(allocator: std.mem.Allocator, addr: address.Address, proxy: ?[]const u8, inputs: []const []const u8, out: []?[]u8) Error!void {
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

    const masked = try roundTrip(allocator, addr, proxy, joined);
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
        const piece = try roundTrip(allocator, addr, proxy, input);
        if (std.mem.eql(u8, piece, input)) allocator.free(piece) else slot.* = piece;
    }
}

pub const Resolved = union(enum) {
    ok: Masker,
    /// 利用者へ見せる理由文。
    err: []const u8,
};

/// Source を Masker にする。secrets ファイルはここで読み、ブローカーへはまだ接続しない
/// (接続の失敗は問い合わせのたびに MaskUnavailable として現れる)。
pub fn resolve(allocator: std.mem.Allocator, source: Source) Resolved {
    return switch (source) {
        .secrets_file => |path| if (secrets.load(allocator, path)) |values| .{ .ok = .{ .values = values } } else |err| .{ .err = secrets.describe(err) },
        .server => |server| .{ .ok = .{ .server = server.addr } },
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

/// テスト用のブローカー。接続を `connections` 本受け、それぞれ入力を終わりの
/// フレームまで読み切ってから一覧でマスクして返す。
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
            // 入力は `[u32 ビッグエンディアンの長さ][本文]` のフレームで届き、長さ 0 の
            // フレームで終わる。終わりの前に切れた接続には何も返さない。
            while (true) {
                var header: [4]u8 = undefined;
                if (!readExactly(peer, &header)) return;
                var left: usize = std.mem.readInt(u32, &header, .big);
                if (left == 0) break;
                while (left > 0) {
                    const want = @min(left, buf.len);
                    if (!readExactly(peer, buf[0..want])) return;
                    data.appendSlice(std.heap.page_allocator, buf[0..want]) catch return;
                    left -= want;
                }
            }
            mask.maskAll(data.items, self.values, null);
            var off: usize = 0;
            while (off < data.items.len) off += posix.write(peer, data.items[off..]) catch return;
            _ = self.served.fetchAdd(1, .monotonic);
        }
    }
};

/// buf を埋めるまで読む。クライアントの不具合でテストが止まらないよう、1 回の待ちを
/// 5 秒で区切る。EOF・タイムアウト・エラーは false。
fn readExactly(fd: posix.socket_t, buf: []u8) bool {
    var off: usize = 0;
    while (off < buf.len) {
        var pfd = [_]posix.pollfd{.{ .fd = fd, .events = posix.POLL.IN, .revents = 0 }};
        const ready = posix.poll(&pfd, 5000) catch return false;
        if (ready == 0) return false;
        const n = posix.read(fd, buf[off..]) catch return false;
        if (n == 0) return false;
        off += n;
    }
    return true;
}

test "SourceOption: exactly one of --secrets-file and --server" {
    var opt = SourceOption{};
    try opt.take("--server", "/s");
    const got = (try opt.finish()).server;
    try testing.expectEqualStrings("/s", got.text);
    try testing.expectEqualStrings("/s", got.addr.unix);
    try testing.expectError(error.ConflictingSources, opt.take("--secrets-file", "/f"));
    try testing.expectError(error.DuplicateOption, opt.take("--server", "/t"));
    try testing.expectError(error.MissingSource, (SourceOption{}).finish());
}

test "SourceOption: --server keeps the text and parses every ADDR form" {
    var unix_url = SourceOption{};
    try unix_url.take("--server", "unix:///run/mask.sock");
    const u = (try unix_url.finish()).server;
    try testing.expectEqualStrings("unix:///run/mask.sock", u.text);
    try testing.expectEqualStrings("/run/mask.sock", u.addr.unix);

    var tcp4 = SourceOption{};
    try tcp4.take("--server", "tcp://127.0.0.1:47321");
    const t4 = (try tcp4.finish()).server;
    try testing.expectEqualStrings("tcp://127.0.0.1:47321", t4.text);
    try testing.expectEqual(@as(u16, 47321), t4.addr.tcp.getPort());

    var tcp6 = SourceOption{};
    try tcp6.take("--server", "tcp://[::1]:47321");
    try testing.expectEqual(posix.AF.INET6, (try tcp6.finish()).server.addr.tcp.any.family);
}

test "SourceOption: an invalid --server value is rejected, and --socket is not an option" {
    inline for (&.{ "tcp://localhost:1", "tcp://10.0.0.1:1", "tcp://127.0.0.1:0", "unix://relative", "tpc://127.0.0.1:1", "" }) |bad| {
        var opt = SourceOption{};
        try testing.expectError(error.InvalidServerAddress, opt.take("--server", bad));
        try testing.expectError(error.MissingSource, opt.finish());
    }
    try testing.expect(!SourceOption.isName("--socket"));
}

test "socket masker: contains compares the returned bytes" {
    var broker = TestBroker{ .values = &.{"Tr0ub4dor"} };
    try broker.start("contains", 2);
    defer broker.stop();
    const m: Masker = .{ .server = .{ .unix = broker.path } };
    try testing.expect(try m.contains(testing.allocator, "pw=Tr0ub4dor"));
    try testing.expect(!(try m.contains(testing.allocator, "nothing here")));
}

test "socket masker: many inputs share one connection" {
    var broker = TestBroker{ .values = &.{"Tr0ub4dor"} };
    try broker.start("many", 1);
    defer broker.stop();
    const m: Masker = .{ .server = .{ .unix = broker.path } };
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
    const m: Masker = .{ .server = .{ .unix = broker.path } };
    const got = try m.maskMany(testing.allocator, &.{ "ab", "cd", "Tr0ub4dor" });
    defer freeMany(testing.allocator, got);
    try testing.expectEqual(@as(?[]u8, null), got[0]);
    try testing.expectEqual(@as(?[]u8, null), got[1]);
    try testing.expectEqualStrings("*********", got[2].?);
}

test "socket masker: an unreachable broker is MaskUnavailable" {
    const m: Masker = .{ .server = .{ .unix = "/nonexistent/sumi-test.sock" } };
    try testing.expectError(error.MaskUnavailable, m.contains(testing.allocator, "x"));
}

test "tcp masker: a port with no listener is MaskUnavailable" {
    // bind だけして listen しないポートは接続を拒む。閉じたポート番号を選ぶより、
    // 他のプロセスに取られる心配が無い。
    const fd = try posix.socket(posix.AF.INET, posix.SOCK.STREAM | posix.SOCK.CLOEXEC, 0);
    defer posix.close(fd);
    var addr = try std.net.Address.parseIp4("127.0.0.1", 0);
    try posix.bind(fd, &addr.any, addr.getOsSockLen());
    var len = addr.getOsSockLen();
    try posix.getsockname(fd, &addr.any, &len);
    const m: Masker = .{ .server = .{ .tcp = addr } };
    // proxy は null で固定する。環境の HTTPS_PROXY が経路を決めないようにするため。
    try testing.expectError(error.MaskUnavailable, m.containsVia(testing.allocator, null, "x"));
}

test "values masker: keeps the in-process behaviour" {
    const m: Masker = .{ .values = &.{"Tr0ub4dor"} };
    try testing.expect(try m.contains(testing.allocator, "pw=Tr0ub4dor"));
    const got = try m.maskMany(testing.allocator, &.{ "pw=Tr0ub4dor", "clean" });
    defer freeMany(testing.allocator, got);
    try testing.expectEqualStrings("pw=*********", got[0].?);
    try testing.expectEqual(@as(?[]u8, null), got[1]);
}
