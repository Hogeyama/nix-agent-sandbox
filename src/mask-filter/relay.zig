//! supervise モードがホスト側ブローカー (`--serve`) へ生バイトを送り、
//! マスク済みバイトを受け取るための Unix socket リレー。
//!
//! 1 接続 = 1 ストリームなので、スーパーバイザは stdout 用と stderr 用に
//! 2 本張る。サーバはチャンク境界を跨ぐシークレットを取りこぼさないため
//! 末尾 `maxSecretLen - 1` バイトを保持するので、**応答はバイト同期ではない**。
//! 「N 書いたら N 読める」と仮定してはならず、書きながら並行して読み続ける
//! 必要がある (読まずに書き続けると双方の socket バッファが埋まって詰まる)。
//!
//! なぜ supervise.zig の FdWriter を流用しないのか
//! ----------------------------------------------
//! FdWriter は書き込みエラーを黙って捨て、短絡書き込みを完了扱いにする。
//! 子の出力 fd (もう届け先が無いなら諦めてよい) には正しい挙動だが、socket に
//! 流用すると致命的になる: バイト列 [i, i+k) を黙って落とすとシークレットが
//! 分断され、どちらの断片もサーバのパターンに一致せず **両方が素通しで**
//! エージェントの stdout に出てしまう。したがってこのリレーは短絡書き込みを
//! 必ずキューに残し、本物のエラーは致命 (fail-closed) として扱う。

const std = @import("std");
const posix = std.posix;

/// パイプ / socket の 1 回の read で受け取る最大バイト数。
pub const CHUNK_SIZE: usize = 64 * 1024;

/// sun_path は 108 バイトで、終端 NUL の分 1 バイト使う。
pub const MAX_SOCKET_PATH: usize = 107;

/// connect の再試行回数と間隔。デーモンは起動済みのはずなので、これは
/// 「起動直後にわずかにずれた」「backlog が一瞬詰まった」を吸収するための
/// 短い猶予であって、死んだデーモンを待つためのものではない。
const CONNECT_ATTEMPTS: usize = 20;
const CONNECT_RETRY_MS: u64 = 25;

pub const RelayError = error{
    /// socket パスが空、または sun_path に収まらない。
    SocketPathInvalid,
    /// 猶予内にブローカーへ接続できなかった。
    RelayConnectFailed,
    /// 接続後の入出力に失敗した。マスクできたか分からないバイトは出さない。
    RelayFailed,
};

fn setNonBlocking(fd: posix.fd_t) !void {
    const flags = try posix.fcntl(fd, posix.F.GETFL, 0);
    const nonblock: u32 = @bitCast(posix.O{ .NONBLOCK = true });
    _ = try posix.fcntl(fd, posix.F.SETFL, flags | nonblock);
}

/// 出力先 fd (子の stdout/stderr に対応する本物の fd) へ書き切る。
///
/// WouldBlock を致命扱いにしてはならない。出力先が非ブロッキングなら読み手が
/// 遅いだけで EAGAIN が返り、それを致命にすると「ただ遅い」だけの実行で出力を
/// 丸ごと捨てて 121 を返すことになる。書けるまで poll して待つ。
/// それ以外のエラーは致命: ここで落としたバイトはもう誰にも届かない。
fn writeAllFatal(fd: posix.fd_t, bytes: []const u8) RelayError!void {
    var i: usize = 0;
    while (i < bytes.len) {
        const n = posix.write(fd, bytes[i..]) catch |err| switch (err) {
            error.WouldBlock => {
                var pfd = [_]posix.pollfd{
                    .{ .fd = fd, .events = posix.POLL.OUT, .revents = 0 },
                };
                _ = posix.poll(&pfd, -1) catch return error.RelayFailed;
                continue;
            },
            else => return error.RelayFailed,
        };
        if (n == 0) return error.RelayFailed;
        i += n;
    }
}

/// ブローカーへの 1 接続。生バイトを送り、マスク済みバイトを出力先 fd へ流す。
pub const Relay = struct {
    fd: posix.socket_t,
    /// まだ socket へ書けていない生バイト。短絡書き込みの残りはここに留まり、
    /// 次の POLLOUT で続きを書く。**1 バイトも落としてはならない**。
    pending: std.ArrayList(u8) = .empty,
    /// shutdown(SHUT_WR) 済みか。これ以降 queueWrite してはならない
    /// (half-close 後の write は EPIPE になる)。
    write_closed: bool = false,
    /// サーバが close した (read が 0 を返した)。half-close 前にこうなったのは
    /// 切り捨てであって完了ではない — 呼び出し側で致命扱いにすること。
    read_eof: bool = false,

    /// sock_path のブローカーへ接続する。
    ///
    /// **ブロッキングの connect(2) を使い、成功してから非ブロッキングに切り替える**。
    /// AF_UNIX の非ブロッキング connect は「backlog が一杯でまだ繋がっていない」を
    /// EAGAIN で返すが、TCP と違って完了を知らせる POLLOUT が来ない。EAGAIN を
    /// 成功扱いにすると、1 バイトも届かないリレーが黙って出来上がる。
    ///
    /// fd は SOCK_CLOEXEC で作る。子へ漏れると単なる情報漏れではなく**注入
    /// オラクル**になる: ストリーム途中に 1 バイト差し込むとサーバ側のマッチが
    /// 崩れて原文がそのまま返るため、差し込んだ値を知っていれば原文を復元できる。
    pub fn connect(sock_path: []const u8) RelayError!Relay {
        if (sock_path.len == 0 or sock_path.len > MAX_SOCKET_PATH) {
            return error.SocketPathInvalid;
        }

        var addr = posix.sockaddr.un{ .family = posix.AF.UNIX, .path = undefined };
        @memset(&addr.path, 0);
        @memcpy(addr.path[0..sock_path.len], sock_path);

        var attempt: usize = 0;
        while (attempt < CONNECT_ATTEMPTS) : (attempt += 1) {
            if (attempt > 0) std.Thread.sleep(CONNECT_RETRY_MS * std.time.ns_per_ms);

            const fd = posix.socket(
                posix.AF.UNIX,
                posix.SOCK.STREAM | posix.SOCK.CLOEXEC,
                0,
            ) catch continue;
            posix.connect(fd, @ptrCast(&addr), @sizeOf(posix.sockaddr.un)) catch {
                // 失敗した socket は状態が未規定なので使い回さず作り直す。
                posix.close(fd);
                continue;
            };
            setNonBlocking(fd) catch {
                posix.close(fd);
                return error.RelayConnectFailed;
            };
            return .{ .fd = fd };
        }
        return error.RelayConnectFailed;
    }

    pub fn deinit(self: *Relay, gpa: std.mem.Allocator) void {
        self.pending.deinit(gpa);
        posix.close(self.fd);
        self.* = undefined;
    }

    pub fn pendingLen(self: *const Relay) usize {
        return self.pending.items.len;
    }

    /// 生バイトを送信キューへ積む。実際の write は pumpWritable が行う。
    pub fn queueWrite(self: *Relay, gpa: std.mem.Allocator, bytes: []const u8) RelayError!void {
        std.debug.assert(!self.write_closed);
        self.pending.appendSlice(gpa, bytes) catch return error.RelayFailed;
    }

    /// POLLOUT が立ったときに呼ぶ。書けた分だけキューから取り除く。
    pub fn pumpWritable(self: *Relay) RelayError!void {
        if (self.pending.items.len == 0) return;
        const n = posix.write(self.fd, self.pending.items) catch |err| switch (err) {
            error.WouldBlock => return,
            else => return error.RelayFailed,
        };
        if (n == 0) return error.RelayFailed;
        const remaining = self.pending.items.len - n;
        std.mem.copyForwards(u8, self.pending.items[0..remaining], self.pending.items[n..]);
        self.pending.items.len = remaining;
    }

    /// POLLIN / POLLHUP が立ったときに呼ぶ。マスク済みバイトを 1 回読んで
    /// dst_fd へ書き切る。戻り値は読めたバイト数 (0 は EAGAIN か EOF)。
    /// EOF は `read_eof` で区別する。
    pub fn pumpReadable(self: *Relay, dst_fd: posix.fd_t, buf: []u8) RelayError!usize {
        const n = posix.read(self.fd, buf) catch |err| switch (err) {
            error.WouldBlock => return 0,
            else => return error.RelayFailed,
        };
        if (n == 0) {
            self.read_eof = true;
            return 0;
        }
        try writeAllFatal(dst_fd, buf[0..n]);
        return n;
    }

    /// このストリームの終わりをサーバへ伝える。サーバは保持中の overlap を
    /// フラッシュしてから close する。
    ///
    /// **キューが空でないうちに呼んではならない**: shutdown(SHUT_WR) 後の write は
    /// EPIPE になり、子が 0 で終わっていても全出力を捨てて 121 になる。
    pub fn halfClose(self: *Relay) RelayError!void {
        if (self.write_closed) return;
        std.debug.assert(self.pending.items.len == 0);
        posix.shutdown(self.fd, .send) catch return error.RelayFailed;
        self.write_closed = true;
    }
};

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

const testing = std.testing;

test "Relay.connect: empty path is rejected" {
    try testing.expectError(error.SocketPathInvalid, Relay.connect(""));
}

test "Relay.connect: path longer than sun_path is rejected" {
    const too_long = "/" ** (MAX_SOCKET_PATH + 1);
    try testing.expectError(error.SocketPathInvalid, Relay.connect(too_long));
}

test "Relay.connect: a missing broker fails closed" {
    var buf: [MAX_SOCKET_PATH]u8 = undefined;
    const path = try std.fmt.bufPrint(
        &buf,
        "/tmp/nas-mf-absent-{d}.sock",
        .{std.c.getpid()},
    );
    std.fs.cwd().deleteFile(path) catch {};
    try testing.expectError(error.RelayConnectFailed, Relay.connect(path));
}

/// テスト用の listener を張る (ブロッキング、backlog 1)。
fn listenAt(path: []const u8) !posix.socket_t {
    var addr = posix.sockaddr.un{ .family = posix.AF.UNIX, .path = undefined };
    @memset(&addr.path, 0);
    @memcpy(addr.path[0..path.len], path);
    const fd = try posix.socket(posix.AF.UNIX, posix.SOCK.STREAM | posix.SOCK.CLOEXEC, 0);
    errdefer posix.close(fd);
    posix.unlink(path) catch {};
    try posix.bind(fd, @ptrCast(&addr), @sizeOf(posix.sockaddr.un));
    try posix.listen(fd, 1);
    return fd;
}

fn waitReadable(fd: posix.fd_t) !void {
    var pfd = [_]posix.pollfd{.{ .fd = fd, .events = posix.POLL.IN, .revents = 0 }};
    const ready = try posix.poll(&pfd, 5000);
    try testing.expect(ready > 0);
}

test "Relay: relays bytes out and back, and half-close is the EOF signal" {
    var path_buf: [MAX_SOCKET_PATH]u8 = undefined;
    const path = try std.fmt.bufPrint(
        &path_buf,
        "/tmp/nas-mf-relay-{d}.sock",
        .{std.c.getpid()},
    );

    const listener = try listenAt(path);
    defer {
        posix.close(listener);
        posix.unlink(path) catch {};
    }

    var relay = try Relay.connect(path);
    defer relay.deinit(testing.allocator);

    const peer = try posix.accept(listener, null, null, posix.SOCK.CLOEXEC);
    defer posix.close(peer);

    // 送信キューは pumpWritable まで実際には書かれない。
    try relay.queueWrite(testing.allocator, "hello");
    try testing.expectEqual(@as(usize, 5), relay.pendingLen());
    try relay.pumpWritable();
    try testing.expectEqual(@as(usize, 0), relay.pendingLen());

    var in: [16]u8 = undefined;
    try testing.expectEqual(@as(usize, 5), try posix.read(peer, &in));
    try testing.expectEqualStrings("hello", in[0..5]);

    // サーバが返したマスク済みバイトは出力先 fd へそのまま流れる。
    _ = try posix.write(peer, "HELLO");
    const out_pipe = try posix.pipe();
    defer posix.close(out_pipe[0]);
    defer posix.close(out_pipe[1]);
    try waitReadable(relay.fd);
    var buf: [CHUNK_SIZE]u8 = undefined;
    try testing.expectEqual(@as(usize, 5), try relay.pumpReadable(out_pipe[1], &buf));
    var got: [16]u8 = undefined;
    try testing.expectEqual(@as(usize, 5), try posix.read(out_pipe[0], &got));
    try testing.expectEqualStrings("HELLO", got[0..5]);

    // half-close はサーバ側では read == 0 として観測される。
    try relay.halfClose();
    try testing.expect(relay.write_closed);
    try testing.expectEqual(@as(usize, 0), try posix.read(peer, &in));

    // サーバが close したら read_eof が立つ。
    posix.shutdown(peer, .send) catch {};
    try waitReadable(relay.fd);
    try testing.expectEqual(@as(usize, 0), try relay.pumpReadable(out_pipe[1], &buf));
    try testing.expect(relay.read_eof);
}

test "Relay.pumpWritable: a short write leaves the remainder queued" {
    var path_buf: [MAX_SOCKET_PATH]u8 = undefined;
    const path = try std.fmt.bufPrint(
        &path_buf,
        "/tmp/nas-mf-short-{d}.sock",
        .{std.c.getpid()},
    );

    const listener = try listenAt(path);
    defer {
        posix.close(listener);
        posix.unlink(path) catch {};
    }

    var relay = try Relay.connect(path);
    defer relay.deinit(testing.allocator);
    const peer = try posix.accept(listener, null, null, posix.SOCK.CLOEXEC);
    defer posix.close(peer);

    // 受信側を一切読まないまま socket バッファを超える量を積む。write は
    // 途中までしか通らないので、残りがキューに残っていなければならない
    // (捨てるとシークレットが分断されて素通しになる)。
    const payload = try testing.allocator.alloc(u8, 4 * 1024 * 1024);
    defer testing.allocator.free(payload);
    @memset(payload, 'x');
    try relay.queueWrite(testing.allocator, payload);

    try relay.pumpWritable();
    const left = relay.pendingLen();
    try testing.expect(left > 0);
    try testing.expect(left < payload.len);

    // 残りは前詰めされていて、続きが正しい位置から書けること。
    var drained: usize = payload.len - left;
    var in: [64 * 1024]u8 = undefined;
    while (relay.pendingLen() > 0) {
        const n = posix.read(peer, &in) catch |err| switch (err) {
            error.WouldBlock => break,
            else => return err,
        };
        if (n == 0) break;
        for (in[0..n]) |b| try testing.expectEqual(@as(u8, 'x'), b);
        drained += n;
        try relay.pumpWritable();
    }
    try testing.expect(relay.pendingLen() == 0);
    try testing.expect(drained > 0);
}
