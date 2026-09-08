//! serve モード: ホスト側で Unix domain socket を待ち受け、接続ごとに
//! ストリームをマスクして返す常駐サーバ。
//!
//! なぜホスト側なのか
//! ------------------
//! 従来はシークレットフレームをコンテナに bind mount し、コンテナ内の
//! nas-mask-filter がローカルにマスクしていた。これはエージェントに
//! 「そのセッションの全シークレットの一覧」を可読ファイルとして渡すのと同じで、
//! security-constraints の C1 / S1 に反する。フレームをホストに留めたまま
//! マスクを効かせるには、生バイトをホストへ送ってマスク済みバイトを返す
//! ブローカーが要る。
//!
//! プロトコル
//! ----------
//! 1 接続 = 1 ストリーム。クライアントは生バイトを書き、マスク済みバイトを読む。
//! フレーミングはない。マスクは長さを保存するが、チャンク境界を跨ぐシークレットを
//! 取りこぼさないためサーバは末尾 `maxSecretLen - 1` バイトを保持する。したがって
//! **応答はバイト同期ではない**: クライアントは「N 書いたら N 読める」と
//! 仮定してはならない。
//! クライアントが `shutdown(SHUT_WR)` すると、サーバは保持中の overlap を
//! フラッシュしてから close する。クライアントはサーバが close するまで読む。
//!
//! 単一 poll ループでの多重化
//! --------------------------
//! 全接続を 1 つの poll ループで多重化する。エージェントはシェルを同時に複数
//! 起動し (1 シェルにつき stdout/stderr の 2 接続)、シェルは分単位で生存しうる。
//! 1 接続を完了まで処理してから次を accept する実装だと、長時間走るシェル 1 本が
//! 他の全シェルをブロックしてしまう。
//!
//! 資源上限
//! --------
//! このサーバはホストで動くので、消費する資源はコンテナの cgroup の外にある。
//! socket はエージェントの UID から到達可能なので、上限はすべてエージェントに
//! 到達可能な攻撃面として扱う。接続ごとの未送信バイト数上限・接続数上限・
//! EMFILE 時の listener バックオフを設ける。
//!
//! アイドル接続のタイムアウト刈り取りは **意図的に持たない**。ピアが死ねば fd が
//! 閉じて read が 0 を返し、通常の EOF 経路で接続は回収される。したがって刈り取りが
//! 発火しうるのは「生きているが黙っているだけ」の接続 (`sleep 900` の supervise、
//! stderr に何も書かない長時間ビルド、watch モードのサーバ) だけで、これを閉じると
//! スーパーバイザが fail-closed の 121 を返し、成功するはずのコマンドが失敗する。
//! 防御としても意味がない: 「1 バイトも届けていない接続だけ」という条件が必須である
//! 以上、接続ごとに 1 バイト書くだけで全スロットを恒久的に免除できてしまう。
//!
//! 出力の不変条件
//! --------------
//! serve モードは **ストリーム由来のバイトを自身の stdout/stderr に書いてはならない**。
//! ProcessService.spawn はこの 2 つをホスト上のログファイルに向けるため、
//! 「failed to mask chunk: <bytes>」のような診断は平文シークレットを永続ファイルに
//! 書き込むことになる。よってこのファイル内に診断出力は一切置かず、エラーは
//! 呼び出し元へ返すか接続を落とすだけにする。

const std = @import("std");
const posix = std.posix;
const mask_stream = @import("mask_stream.zig");

const BUF_SIZE = mask_stream.BUF_SIZE;

/// sun_path は 108 バイトで、終端 NUL の分 1 バイト使う。
pub const MAX_SOCKET_PATH: usize = 107;

/// 同時接続数の上限。1 シェルにつき 2 接続で、`make -j` は数百のシェルを走らせる。
/// 上限を超えた接続は accept して即 close する (下の accept ループのコメント参照)。
///
/// 1 接続あたりのホスト側メモリは MaskStream と送信キューの和だが、**MaskStream
/// の側は定数ではなく最長シークレット長に比例する**。MaskStream.init が確保するのは
/// 3 * (maxSecretLen - 1 + BUF_SIZE) バイトと (maxSecretLen - 1) バイトで、
/// おおよそ 192KiB + 4 * maxSecretLen である。
///
/// 実運用のシークレット (トークンや API キーで数十〜数百バイト) では
/// maxSecretLen の項が無視でき、次の数字になる:
///
///   1 接続   MaskStream 約 192KiB + 送信キュー約 480KiB ≒ 672KiB
///   ピーク   512 * 672KiB ≒ 336MiB
///   定常     512 * (192KiB + 128KiB) = 160MiB
///
/// キュー側の内訳は、上限判定が push の前なので実データが最大
/// MAX_QUEUED_BYTES + 1 チャンク ≒ 320KiB に達し、ArrayList の伸長が最大でその
/// 1.5 倍の容量を取りうる、というもの。この 480KiB は一時的なピークであって
/// 定常的な占有ではない。キューを吐き切った時点で容量は QUEUE_RETAIN_BYTES
/// (128KiB) まで縮むので、定常状態は上の 160MiB になる (Conn.writable 参照)。
///
/// **これらは不変条件ではなく、短いシークレットという前提での実効値である。**
/// readSecretsFromFile (mask_filter.zig) が受け付けるシークレット長の上限は
/// 16MiB なので、その長さのものを 1 つ設定するだけで 1 接続あたり約 64MiB、
/// 512 接続で約 32GiB になる。ここに強制はかけていない: シークレットは運用者が
/// 設定するもので、エージェントから長さを操作できないため、攻撃面ではなく設定の
/// 問題だからである。長いシークレットを扱うなら MAX_CONNECTIONS を見直すこと。
const MAX_CONNECTIONS: usize = 512;

/// 1 接続あたりの未送信 (マスク済み) バイト数の上限。超えたらその接続の
/// read を止め、socket バッファ経由でクライアントへ背圧をかける。
/// 上限判定は push の前に行うので、実際のキュー長は一時的に 1 チャンク分
/// (overlap + BUF_SIZE) だけ超えうるが、有界であることは変わらない。
const MAX_QUEUED_BYTES: usize = 256 * 1024;

/// キューを吐き切ったときに保持する容量。**閾値であると同時に下限でもある**:
/// これを超える容量は解放し、解放後はこの容量をちょうど確保し直す。
///
/// 通常運転でキューに載る最大バイト数がちょうどこの値になるように選んである。
/// MaskStream.push が 1 回に writer へ渡すのは高々 BUF_SIZE バイト
/// (safe_end = overlap_len + n - overlap_size <= BUF_SIZE) で、POLLOUT は
/// 「arm 時点で out が空でない」ときにしか立たないため、吐き切れているストリームの
/// out は「前周回の 1 チャンク + 今周回の 1 チャンク」= 2 * BUF_SIZE までしか
/// 育たない。
///
/// 閾値だけを置いて解放しっ放しにすると、この 2 * BUF_SIZE を格納するために
/// ArrayList が確保する容量 (伸長は 1.5 倍刻みなので 2 * BUF_SIZE を上回る) が
/// 毎回閾値を超え、通常のストリーミングのたびに clearAndFree が走る。
/// page_allocator では 128KiB ごとに munmap/mmap とページフォルトが発生し、
/// この定数が避けようとしている per-chunk の alloc/free churn そのものになる。
/// 解放後に precise でこの容量へ戻すことで、通常運転では 2 チャンクが容量ぴったりに
/// 収まり、伸長も解放も起きなくなる (接続あたり高々 1 回の解放で定常状態に入る)。
///
/// したがって定常的に抱え込む容量は接続あたり 128KiB、MAX_CONNECTIONS 全体で
/// 512 * 128KiB = 64MiB が最悪値。背圧で MAX_QUEUED_BYTES まで膨らんだときの
/// ピーク容量 (約 480KiB) は、吐き切った時点でここまで縮む。
const QUEUE_RETAIN_BYTES: usize = 2 * BUF_SIZE;

const LISTEN_BACKLOG: u31 = 128;

/// poll のタイムアウト。listener のバックオフは poll から抜けた時にしか
/// 解除できないので、無限待ちにすると EMFILE 後に listener が二度と
/// 復帰しなくなる。
const POLL_TIMEOUT_MS: i32 = 1000;

/// EMFILE / ENFILE で accept に失敗したときに listener を休ませる時間。
/// readable な listener を EMFILE のまま poll し直すと 100% CPU の
/// 恒久スピンになる。
const LISTENER_BACKOFF_MS: i64 = 1000;

pub const ServeError = error{
    EmptySocketPath,
    SocketPathTooLong,
};

/// bind する前に AF_UNIX のパス長制限を検査する。
/// 越えていると bind が難解な失敗をするだけなので、起動時に弾く。
pub fn validateSocketPath(path: []const u8) ServeError!void {
    if (path.len == 0) return error.EmptySocketPath;
    if (path.len > MAX_SOCKET_PATH) return error.SocketPathTooLong;
}

/// マスク済みバイトを接続の送信キューへ積む writer。
/// MaskStream.push / finish に渡す。
const QueueWriter = struct {
    gpa: std.mem.Allocator,
    out: *std.ArrayList(u8),

    pub fn writeAll(self: QueueWriter, bytes: []const u8) !void {
        try self.out.appendSlice(self.gpa, bytes);
    }
};

/// 接続を落とすべきと判断したときに使う内部エラー。
/// マスクできなかったバイトは決してクライアントへ流さない (fail-closed)。
const ConnError = error{Failed};

const Conn = struct {
    fd: posix.fd_t,
    /// MaskStream は ~192KiB を確保するため、accept 時ではなく
    /// **最初の 1 バイトを受け取った時点** で初期化する。accept 時に確保すると
    /// connect(2) 1 回がホストの 192KiB になる。
    stream: ?mask_stream.MaskStream = null,
    out: std.ArrayList(u8) = .empty,
    /// クライアントが half-close した (read が 0 を返した)。
    read_eof: bool = false,

    fn deinit(self: *Conn, gpa: std.mem.Allocator) void {
        if (self.stream) |*s| s.deinit(gpa);
        self.out.deinit(gpa);
        posix.shutdown(self.fd, .send) catch {};
        posix.close(self.fd);
        self.* = undefined;
    }

    fn wantsRead(self: *const Conn) bool {
        return !self.read_eof and self.out.items.len < MAX_QUEUED_BYTES;
    }

    fn wantsWrite(self: *const Conn) bool {
        return self.out.items.len > 0;
    }

    /// half-close 後にフラッシュし切った = この接続はもう閉じてよい。
    fn finished(self: *const Conn) bool {
        return self.read_eof and self.out.items.len == 0;
    }

    fn readable(
        self: *Conn,
        gpa: std.mem.Allocator,
        secrets: []const []const u8,
        scratch: []u8,
    ) ConnError!void {
        const writer = QueueWriter{ .gpa = gpa, .out = &self.out };

        if (self.stream == null) {
            // まだ MaskStream がないので、共有バッファへ読んでから初期化する。
            const n = posix.read(self.fd, scratch) catch |err| switch (err) {
                error.WouldBlock => return,
                else => return error.Failed,
            };
            if (n == 0) {
                // 1 バイトも来ないまま half-close。フラッシュするものはない。
                self.read_eof = true;
                return;
            }
            self.stream = mask_stream.MaskStream.init(gpa, secrets) catch return error.Failed;
            @memcpy(self.stream.?.readBuf()[0..n], scratch[0..n]);
            self.stream.?.push(n, writer) catch return error.Failed;
            return;
        }

        const stream = &self.stream.?;
        const n = posix.read(self.fd, stream.readBuf()) catch |err| switch (err) {
            error.WouldBlock => return,
            else => return error.Failed,
        };
        if (n == 0) {
            self.read_eof = true;
            // 保持していた overlap をここでフラッシュする。
            stream.finish(writer) catch return error.Failed;
            return;
        }
        stream.push(n, writer) catch return error.Failed;
    }

    fn writable(self: *Conn, gpa: std.mem.Allocator) ConnError!void {
        if (self.out.items.len == 0) return;
        const n = posix.write(self.fd, self.out.items) catch |err| switch (err) {
            error.WouldBlock => return,
            else => return error.Failed,
        };
        // 短い write は「送れた分だけ捨てて残りを次回へ」。黙って落とすと
        // シークレットが分断され、どちらの断片もマッチせず平文で出てしまう。
        const remaining = self.out.items.len - n;
        std.mem.copyForwards(u8, self.out.items[0..remaining], self.out.items[n..]);
        self.out.items.len = remaining;

        // items.len を縮めても確保済み容量は返らない。読まないクライアントの
        // せいで一度 MAX_QUEUED_BYTES まで膨らんだ接続が、その後ずっと平常運転に
        // 戻ってもピーク容量を接続の寿命いっぱい抱え続けてしまうため、吐き切った
        // 時点で通常運転に要る分を超える容量は解放する。空でないうちは実データを
        // 抱えているので触らない。
        //
        // 解放しっ放しにはせず QUEUE_RETAIN_BYTES ちょうどに確保し直す。通常運転の
        // ピークはこの値に一致するので、戻さないと次のチャンクで必ず伸長が起きて
        // 再び閾値を超え、チャンクごとの alloc/free に落ちてしまう。確保に失敗しても
        // 容量 0 の空キューが残るだけで正しさには影響しないため無視してよい。
        if (remaining == 0 and self.out.capacity > QUEUE_RETAIN_BYTES) {
            self.out.clearAndFree(gpa);
            self.out.ensureTotalCapacityPrecise(gpa, QUEUE_RETAIN_BYTES) catch {};
        }
    }
};

/// 接続は 1 シェルあたり 2 本で `make -j` は数百に達するので、
/// 起動時に soft limit を hard limit まで上げておく。
fn raiseFileLimit() void {
    if (posix.getrlimit(.NOFILE)) |lim| {
        if (lim.cur < lim.max) {
            var next = lim;
            next.cur = lim.max;
            posix.setrlimit(.NOFILE, next) catch {};
        }
    } else |_| {}
}

fn bindListener(sock_path: []const u8) !posix.socket_t {
    var addr = posix.sockaddr.un{ .family = posix.AF.UNIX, .path = undefined };
    @memset(&addr.path, 0);
    @memcpy(addr.path[0..sock_path.len], sock_path);

    const fd = try posix.socket(
        posix.AF.UNIX,
        posix.SOCK.STREAM | posix.SOCK.CLOEXEC | posix.SOCK.NONBLOCK,
        0,
    );
    errdefer posix.close(fd);

    // 前回のセッションの stale socket が残っていると bind が EADDRINUSE になる。
    posix.unlink(sock_path) catch {};

    // bind 直後の一瞬でも他ユーザから connect できないよう umask を絞り、
    // その後 chmod で 0600 を確定させる。
    const prev_umask = std.c.umask(0o177);
    posix.bind(fd, @ptrCast(&addr), @sizeOf(posix.sockaddr.un)) catch |err| {
        _ = std.c.umask(prev_umask);
        return err;
    };
    _ = std.c.umask(prev_umask);

    try posix.fchmodat(posix.AT.FDCWD, sock_path, 0o600, 0);
    try posix.listen(fd, LISTEN_BACKLOG);
    return fd;
}

/// sock_path で待ち受け、kill されるまで接続をマスクし続ける。
/// 正常には返らない (戻り値の型は main の他モードと揃えるためのもの)。
pub fn run(gpa: std.mem.Allocator, secrets: []const []const u8, sock_path: []const u8) !u8 {
    try validateSocketPath(sock_path);
    raiseFileLimit();

    const listener = try bindListener(sock_path);
    defer posix.close(listener);

    // MaskStream 未初期化の接続の最初の read 先。全接続で使い回す
    // (poll ループは単一スレッドなので同時に使われることはない)。
    const scratch = try gpa.alloc(u8, BUF_SIZE);
    defer gpa.free(scratch);

    var conns: std.ArrayList(Conn) = .empty;
    defer {
        for (conns.items) |*c| c.deinit(gpa);
        conns.deinit(gpa);
    }

    const pollfds = try gpa.alloc(posix.pollfd, MAX_CONNECTIONS + 1);
    defer gpa.free(pollfds);

    var listener_backoff_until: i64 = 0;

    while (true) {
        const now = std.time.milliTimestamp();

        // accept は conns に append するので、poll 配列のインデックス対応は
        // **accept 前の** 接続数で確定させる。accept 後の長さで索引すると
        // 最初の 1 接続で範囲外アクセスになる。
        const n_conns = conns.items.len;
        for (conns.items, 0..) |*c, i| {
            var events: i16 = 0;
            if (c.wantsRead()) events |= posix.POLL.IN;
            if (c.wantsWrite()) events |= posix.POLL.OUT;
            pollfds[i] = .{ .fd = c.fd, .events = events, .revents = 0 };
        }

        const listener_idx = n_conns;
        const listener_armed = now >= listener_backoff_until;
        var n_fds = n_conns;
        if (listener_armed) {
            pollfds[n_fds] = .{ .fd = listener, .events = posix.POLL.IN, .revents = 0 };
            n_fds += 1;
        }

        _ = try posix.poll(pollfds[0..n_fds], POLL_TIMEOUT_MS);

        // 接続を降順に走査し、閉じる接続は swapRemove する。降順なら
        // 繰り上がってくる末尾要素は必ず走査済みインデックス由来なので、
        // 取りこぼしも二重処理も起きない。
        // listener の accept は接続処理が終わってから行う (走査中は
        // conns.items.len が n_conns のままであることを保証するため)。
        var i = n_conns;
        while (i > 0) {
            i -= 1;
            const conn = &conns.items[i];
            const revents = pollfds[i].revents;

            var failed = false;
            if (revents & posix.POLL.IN != 0) {
                conn.readable(gpa, secrets, scratch) catch {
                    failed = true;
                };
            } else if (revents & (posix.POLL.HUP | posix.POLL.ERR | posix.POLL.NVAL) != 0) {
                // 読むものがないまま切断/エラー。マスク済みの残りを届ける先もない。
                failed = true;
            }
            if (!failed and revents & posix.POLL.OUT != 0) {
                conn.writable(gpa) catch {
                    failed = true;
                };
            }

            if (failed or conn.finished()) {
                var dead = conns.swapRemove(i);
                dead.deinit(gpa);
            }
        }

        if (listener_armed and pollfds[listener_idx].revents != 0) {
            while (true) {
                const fd = posix.accept(
                    listener,
                    null,
                    null,
                    posix.SOCK.CLOEXEC | posix.SOCK.NONBLOCK,
                ) catch |err| switch (err) {
                    error.WouldBlock => break,
                    error.ProcessFdQuotaExceeded,
                    error.SystemFdQuotaExceeded,
                    error.SystemResources,
                    => {
                        listener_backoff_until = std.time.milliTimestamp() + LISTENER_BACKOFF_MS;
                        break;
                    },
                    // 接続が accept 前に消えた等。次の accept を試す。
                    error.ConnectionAborted, error.ProtocolFailure => continue,
                    // 想定外の errno。原因が持続するものだと、backlog に残った
                    // 接続で listener は次の周回も readable のままなので、
                    // poll が即返り accept が即失敗する 100% CPU スピンになる。
                    else => {
                        listener_backoff_until = std.time.milliTimestamp() + LISTENER_BACKOFF_MS;
                        break;
                    },
                };

                // 上限超過分は accept して即 close する。listener の poll を
                // 止めるだけだと kernel が backlog へ接続を完了させてしまい、
                // クライアントは応答も拒否も得られないまま待たされる (実測で
                // 300 本のアイドル接続が次のクライアントをタイムアウトまで
                // 詰まらせた)。即 close ならクライアントは即座に EOF を受け取り、
                // スーパーバイザがそれを fail-closed な 121 に変換できる。
                if (conns.items.len >= MAX_CONNECTIONS) {
                    posix.shutdown(fd, .send) catch {};
                    posix.close(fd);
                    continue;
                }
                // append の失敗はホストのメモリ枯渇。次の周回でも同じように失敗する
                // 上に、accept 済みでない接続が backlog に残っていれば listener は
                // readable のままなので、バックオフを張らないと EMFILE と同じ
                // 100% CPU スピンになる。
                conns.append(gpa, .{ .fd = fd }) catch {
                    posix.close(fd);
                    listener_backoff_until = std.time.milliTimestamp() + LISTENER_BACKOFF_MS;
                    break;
                };
            }
        }
    }
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

const testing = std.testing;

test "validateSocketPath: ordinary path is accepted" {
    try validateSocketPath("/run/user/1000/nas/abc-sock/mask.sock");
}

test "validateSocketPath: empty path is an error" {
    try testing.expectError(error.EmptySocketPath, validateSocketPath(""));
}

test "validateSocketPath: 107 bytes is the maximum accepted length" {
    const ok = "/" ** MAX_SOCKET_PATH;
    try testing.expectEqual(@as(usize, 107), ok.len);
    try validateSocketPath(ok);
}

test "validateSocketPath: 108 bytes is too long" {
    const too_long = "/" ** (MAX_SOCKET_PATH + 1);
    try testing.expectError(error.SocketPathTooLong, validateSocketPath(too_long));
}
