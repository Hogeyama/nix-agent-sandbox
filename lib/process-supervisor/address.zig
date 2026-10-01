//! ブローカーのアドレス (ADDR) の解釈。`serve` (待ち受け側) と relay (接続側) が
//! 同じ文字列を使い回せるよう、解釈をここに一本化する。
//!
//!   /path, relative/path    Unix ソケット (素のパス。従来どおり)
//!   unix:///path            Unix ソケット (絶対パスのみ)
//!   tcp://127.0.0.1:PORT    ループバックの TCP
//!   tcp://[::1]:PORT        ループバックの TCP (IPv6)
//!
//! TCP でループバック以外を受け付けない理由: このブローカーは認証を持たず、
//! 生のストリームを受けてマスク済みバイトを返すだけである。ホスト名や外向きの
//! アドレスを許すと、設定ミス 1 つで他のホストへ待ち受けたり、他のホストへ
//! 生バイトを送ったりできてしまう。名前解決も持ち込まない (`localhost` は拒否)。

const std = @import("std");

/// sun_path は 108 バイトで、終端 NUL の分 1 バイト使う。
pub const MAX_SOCKET_PATH: usize = 107;

pub const Address = union(enum) {
    /// Unix ソケットのパス (相対パスも可)。
    unix: []const u8,
    /// ループバックの TCP。
    tcp: std.net.Address,
};

pub const ParseError = error{ InvalidAddress, SocketPathTooLong };

const UNIX_PREFIX = "unix://";
const TCP_PREFIX = "tcp://";

pub fn parse(text: []const u8) ParseError!Address {
    if (std.mem.startsWith(u8, text, UNIX_PREFIX)) {
        const path = text[UNIX_PREFIX.len..];
        // unix://relative は host 部に見えて曖昧なので絶対パスだけ受け付ける。
        if (path.len == 0 or path[0] != '/') return error.InvalidAddress;
        return unixPath(path);
    }
    if (std.mem.startsWith(u8, text, TCP_PREFIX)) {
        return parseTcp(text[TCP_PREFIX.len..]);
    }
    // 未知のスキームを素のパスとして通すと、typo (`tpc://…`) が
    // 「その名前のディレクトリ配下のソケット」への接続失敗になり原因が見えない。
    if (std.mem.indexOf(u8, text, "://") != null) return error.InvalidAddress;
    if (text.len == 0) return error.InvalidAddress;
    return unixPath(text);
}

fn unixPath(path: []const u8) ParseError!Address {
    if (path.len > MAX_SOCKET_PATH) return error.SocketPathTooLong;
    return .{ .unix = path };
}

fn parseTcp(hostport: []const u8) ParseError!Address {
    if (std.mem.startsWith(u8, hostport, "127.0.0.1:")) {
        const port = try parsePort(hostport["127.0.0.1:".len..]);
        return .{ .tcp = std.net.Address.parseIp4("127.0.0.1", port) catch return error.InvalidAddress };
    }
    if (std.mem.startsWith(u8, hostport, "[::1]:")) {
        const port = try parsePort(hostport["[::1]:".len..]);
        return .{ .tcp = std.net.Address.parseIp6("::1", port) catch return error.InvalidAddress };
    }
    return error.InvalidAddress;
}

/// 10 進の数字だけを受け付ける。`parseInt` は `+1` や `1_0` を通すので使わない。
fn parsePort(s: []const u8) ParseError!u16 {
    if (s.len == 0) return error.InvalidAddress;
    var v: u32 = 0;
    for (s) |c| {
        if (c < '0' or c > '9') return error.InvalidAddress;
        v = v * 10 + (c - '0');
        if (v > 65535) return error.InvalidAddress;
    }
    if (v == 0) return error.InvalidAddress;
    return @intCast(v);
}

fn expectTcp4(a: Address, port: u16) !void {
    try std.testing.expect(a == .tcp);
    try std.testing.expectEqual(std.posix.AF.INET, a.tcp.any.family);
    try std.testing.expectEqual(port, a.tcp.getPort());
    try std.testing.expectEqual(std.mem.nativeToBig(u32, 0x7f000001), a.tcp.in.sa.addr);
}

test "parse: bare absolute and relative paths are unix" {
    const a = try parse("/run/sumi.sock");
    try std.testing.expectEqualStrings("/run/sumi.sock", a.unix);
    const r = try parse("rel/sumi.sock");
    try std.testing.expectEqualStrings("rel/sumi.sock", r.unix);
}

test "parse: unix:// with an absolute path" {
    const a = try parse("unix:///run/sumi.sock");
    try std.testing.expectEqualStrings("/run/sumi.sock", a.unix);
}

test "parse: unix:// rejects relative or empty paths" {
    try std.testing.expectError(error.InvalidAddress, parse("unix://rel/x"));
    try std.testing.expectError(error.InvalidAddress, parse("unix://"));
}

test "parse: tcp IPv4 loopback" {
    try expectTcp4(try parse("tcp://127.0.0.1:8080"), 8080);
    try expectTcp4(try parse("tcp://127.0.0.1:1"), 1);
    try expectTcp4(try parse("tcp://127.0.0.1:65535"), 65535);
}

test "parse: tcp IPv6 loopback" {
    const a = try parse("tcp://[::1]:9000");
    try std.testing.expect(a == .tcp);
    try std.testing.expectEqual(std.posix.AF.INET6, a.tcp.any.family);
    try std.testing.expectEqual(@as(u16, 9000), a.tcp.getPort());
    var want = [_]u8{0} ** 16;
    want[15] = 1;
    try std.testing.expectEqualSlices(u8, &want, &a.tcp.in6.sa.addr);
}

test "parse: tcp rejects non-loopback hosts" {
    const bad = [_][]const u8{
        "tcp://localhost:80",
        "tcp://0.0.0.0:80",
        "tcp://127.0.0.2:80",
        "tcp://192.168.0.1:80",
        "tcp://example.com:80",
        "tcp://[::]:80",
        "tcp://[::2]:80",
        "tcp://:80",
        "tcp://",
    };
    for (bad) |s| try std.testing.expectError(error.InvalidAddress, parse(s));
}

test "parse: tcp rejects bad ports" {
    const bad = [_][]const u8{
        "tcp://127.0.0.1",
        "tcp://127.0.0.1:",
        "tcp://127.0.0.1:0",
        "tcp://127.0.0.1:65536",
        "tcp://127.0.0.1:99999999999",
        "tcp://127.0.0.1:80a",
        "tcp://127.0.0.1:+80",
        "tcp://127.0.0.1:-1",
        "tcp://[::1]",
        "tcp://[::1]:0",
        "tcp://[::1]:65536",
        "tcp://[::1]:x",
    };
    for (bad) |s| try std.testing.expectError(error.InvalidAddress, parse(s));
}

test "parse: unknown schemes and empty text are invalid" {
    try std.testing.expectError(error.InvalidAddress, parse("http://127.0.0.1:80"));
    try std.testing.expectError(error.InvalidAddress, parse("tpc://127.0.0.1:80"));
    try std.testing.expectError(error.InvalidAddress, parse("/tmp/a://b"));
    try std.testing.expectError(error.InvalidAddress, parse(""));
}

test "parse: unix path length limit" {
    const ok = "/" ** MAX_SOCKET_PATH;
    const too_long = "/" ** (MAX_SOCKET_PATH + 1);
    try std.testing.expectEqual(MAX_SOCKET_PATH, (try parse(ok)).unix.len);
    try std.testing.expectError(error.SocketPathTooLong, parse(too_long));
    try std.testing.expectEqual(MAX_SOCKET_PATH, (try parse("unix://" ++ ok)).unix.len);
    try std.testing.expectError(error.SocketPathTooLong, parse("unix://" ++ too_long));
}
