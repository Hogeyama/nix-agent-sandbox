//! supervise モードがホスト側ブローカー (`--serve`) へ生バイトを送り、
//! マスク済みバイトを受け取るためのリレー。ブローカーへは Unix socket か
//! ループバックの TCP でつなぐ。TCP はループバックの HTTP proxy があれば
//! `CONNECT` で必ずそれを経由する (経路の規則は `routeFor`)。sandbox の中からは
//! ホストのループバックへ直接は届かず、proxy だけが届くため。
//!
//! 1 接続 = 1 ストリームなので、スーパーバイザは stdout 用と stderr 用に
//! 2 本張る。サーバはチャンク境界を跨ぐシークレットを取りこぼさないため
//! 末尾 `maxSecretLen - 1` バイトを保持するので、**応答はバイト同期ではない**。
//! 「N 書いたら N 読める」と仮定してはならず、書きながら並行して読み続ける
//! 必要がある (読まずに書き続けると双方の socket バッファが埋まって詰まる)。
//!
//! プロトコル
//! ----------
//! クライアント → サーバ: 生バイトを `[u32 ビッグエンディアンの長さ][本文]` の
//! フレーム (frame.zig) に包んで送り、長さ 0 のフレームで入力の終わりを伝える。
//! サーバ → クライアント: マスク済みバイトを区切りなしで流し、末尾を送り切ったら
//! close する。**サーバの close が出力の終わり**。
//!
//! half-close (`shutdown(SHUT_WR)`) で入力の終わりを伝えないのは、srt の proxy が
//! half-close を通さず、半分閉じた時点で逆向きも閉じてしまい、サーバが返す末尾が
//! 届かなくなるため。
//!
//! 終わりのフレームを送り切っても、サーバが末尾を返し終えたとは限らない。
//! マスクは長さを保存するので、サーバが閉じたときに「終わりのフレームを送り
//! 切った」かつ「受け取ったバイト数が送った本文の合計と等しい」ことを確かめ、
//! そうでなければ失敗にする (`Relay.checkComplete`)。
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

const frame = @import("frame.zig");

/// パイプ / socket の 1 回の read で受け取る最大バイト数。1 フレームの本文の
/// 上限と同じ値にして、パイプから読んだ塊をそのまま 1 フレームで送れるようにする。
pub const CHUNK_SIZE: usize = frame.MAX_BODY;

const address = @import("address.zig");
const MAX_SOCKET_PATH = address.MAX_SOCKET_PATH;

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
    /// サーバが応答を返し終える前に閉じた (終わりのフレームを送り切る前に
    /// 閉じた、または受け取ったバイト数が送った本文の合計と違う)。
    RelayClosedEarly,
};

/// **出力先 fd 専用**のエラー集合。socket 側で使ってはならない。
///
/// socket への write が落としたバイトはシークレットを分断し、どちらの断片も
/// サーバのパターンに一致せず素通しになるので、socket 側のエラーは常に致命
/// (`RelayError.RelayFailed` → 121) でなければならない。出力先はその逆で、
/// EPIPE は「もう誰も読んでいない」以上の意味を持たない: マスクの失敗ではないし、
/// 抑止すべき未マスク出力も残っていない (出力先へ流すのはサーバが返した
/// マスク済みバイトだけ)。
///
/// 両者を同じ関数・同じエラーで扱うとこの緩和がいつか socket 側へ広がるので、
/// 集合ごと分けてある。**フラグ引数で共用しないこと**。
pub const DestError = error{
    /// 出力先が閉じている (EPIPE)。fail-closed の 121 にしてはならない。
    DestinationClosed,
    /// 出力先への書き込みが本当に失敗した。
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
///
/// EPIPE も致命ではない。`cmd | head` のように呼び出し元が途中で読むのをやめた
/// だけで、マスクは最後まで正しく効いている。ここを致命にすると、ごく普通の
/// パイプラインが「出力抑止」の診断つきで 121 になり、pipefail 下ではパイプライン
/// 全体が失敗する。呼び出し側が扱えるよう専用のエラーで返す。
///
/// それ以外のエラーは致命: ここで落としたバイトはもう誰にも届かない。
fn writeAllToDest(fd: posix.fd_t, bytes: []const u8) DestError!void {
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
            error.BrokenPipe => return error.DestinationClosed,
            else => return error.RelayFailed,
        };
        if (n == 0) return error.RelayFailed;
        i += n;
    }
}

fn connectUnix(sock_path: []const u8) RelayError!posix.socket_t {
    if (sock_path.len == 0 or sock_path.len > MAX_SOCKET_PATH) {
        return error.SocketPathInvalid;
    }
    var un = posix.sockaddr.un{ .family = posix.AF.UNIX, .path = undefined };
    @memset(&un.path, 0);
    @memcpy(un.path[0..sock_path.len], sock_path);
    return connectRetrying(posix.AF.UNIX, @ptrCast(&un), @sizeOf(posix.sockaddr.un));
}

fn connectTcp(target: std.net.Address) RelayError!posix.socket_t {
    return connectRetrying(target.any.family, &target.any, target.getOsSockLen());
}

/// connect(2) の失敗を CONNECT_ATTEMPTS まで再試行する。
fn connectRetrying(
    family: u32,
    sa: *const posix.sockaddr,
    len: posix.socklen_t,
) RelayError!posix.socket_t {
    var attempt: usize = 0;
    while (attempt < CONNECT_ATTEMPTS) : (attempt += 1) {
        if (attempt > 0) std.Thread.sleep(CONNECT_RETRY_MS * std.time.ns_per_ms);
        if (connectOnce(family, sa, len)) |fd| return fd;
    }
    return error.RelayConnectFailed;
}

fn connectOnce(family: u32, sa: *const posix.sockaddr, len: posix.socklen_t) ?posix.socket_t {
    const fd = posix.socket(family, posix.SOCK.STREAM | posix.SOCK.CLOEXEC, 0) catch return null;
    posix.connect(fd, sa, len) catch {
        // 失敗した socket は状態が未規定なので使い回さず作り直す。
        posix.close(fd);
        return null;
    };
    return fd;
}

/// proxy へつなぎ、CONNECT が通るまで再試行する。全体を、開始時に単調時計で
/// 決めた `budget_ms` (本番は PROXY_CONNECT_TIMEOUT_MS) の期限に収める。
/// proxy への TCP 接続、CONNECT の送受信、再試行の間の待ちは、どれも残り時間の
/// 中で行う。`SO_RCVTIMEO` は 1 回の read の待ちしか区切らないので、数秒おきに
/// 少しずつ返す proxy には 1 回の試行でもいくらでも延ばされる。hook は Claude Code
/// の時間制限の中で動くので、応答しない proxy で長く止まってはならない。
///
/// 1 回の試行は connect(2) 1 回と CONNECT のやりとり 1 回で、connectRetrying を
/// 入れ子にはしない (入れ子にすると試行回数が掛け算になる)。
///
/// 再試行するのは、proxy が起動直後だったり宛先へのつなぎ込みに一瞬失敗したり
/// (すぐ返る 502 など、早すぎる close) という、待てば通りうる失敗で、期限の中で
/// 最大 CONNECT_ATTEMPTS 回まで。403 は再試行しない: `allowedDomains` に無い
/// 宛先への拒否は設定で決まり、待っても変わらない。期限切れも失敗にする。
/// どの場合も直接接続へはフォールバックしない (`routeFor`)。
fn connectViaProxy(
    proxy: std.net.Address,
    target: std.net.Address,
    userinfo: ?[]const u8,
    budget_ms: u64,
) RelayError!posix.socket_t {
    const deadline = Deadline.start(budget_ms) orelse return error.RelayConnectFailed;
    var attempt: usize = 0;
    while (attempt < CONNECT_ATTEMPTS) : (attempt += 1) {
        if (attempt > 0) {
            const left = deadline.remainingMs();
            if (left == 0) break;
            const wait_ms: u64 = @min(CONNECT_RETRY_MS, left);
            std.Thread.sleep(wait_ms * std.time.ns_per_ms);
        }
        const fd = connectOnceBefore(proxy, deadline) orelse continue;
        proxyHandshake(fd, target, userinfo, deadline) catch |err| {
            posix.close(fd);
            switch (err) {
                error.ProxyForbidden, error.ProxyTimedOut => return error.RelayConnectFailed,
                error.ProxyHandshakeFailed => continue,
            }
        };
        return fd;
    }
    return error.RelayConnectFailed;
}

/// 単調時計で決めた期限。壁時計は NTP などで戻りうるので使わない。
const Deadline = struct {
    started: std.time.Instant,
    budget_ns: u64,

    fn start(budget_ms: u64) ?Deadline {
        const now = std.time.Instant.now() catch return null;
        return .{ .started = now, .budget_ns = budget_ms * std.time.ns_per_ms };
    }

    /// 残り時間 (ミリ秒、切り上げ)。切れていれば 0。切り上げるのは、1 ms 未満の
    /// 残りで poll を 0 ms にして空回りしないため。
    fn remainingMs(self: Deadline) u64 {
        const now = std.time.Instant.now() catch return 0;
        const elapsed = now.since(self.started);
        if (elapsed >= self.budget_ns) return 0;
        return std.math.divCeil(u64, self.budget_ns - elapsed, std.time.ns_per_ms) catch 0;
    }

    /// poll に渡す待ち時間。
    fn pollMs(self: Deadline) i32 {
        return @intCast(@min(self.remainingMs(), std.math.maxInt(i32)));
    }
};

/// 期限までに fd が `events` のどれかになるのを待つ。期限切れなら false。
fn waitFor(fd: posix.socket_t, events: i16, deadline: Deadline) error{Failed}!bool {
    while (true) {
        const ms = deadline.pollMs();
        if (ms == 0) return false;
        var pfd = [_]posix.pollfd{.{ .fd = fd, .events = events, .revents = 0 }};
        const n = posix.poll(&pfd, ms) catch return error.Failed;
        if (n > 0) return true;
    }
}

/// proxy への connect(2) を 1 回、期限までに済ませる。非ブロッキングで始めて
/// 完了を poll で待つ。ブロッキングの connect(2) は、proxy の accept キューが
/// 詰まって SYN が落とされると、カーネルの再送が尽きるまで (数十秒から 2 分) 戻らない。
///
/// TCP の非ブロッキング connect は完了を POLLOUT で知らせるので、AF_UNIX のような
/// 「EAGAIN のまま繋がらない」問題 (Relay.connect の説明) は起きない。
/// fd は非ブロッキングのまま返し、CONNECT のやりとりも poll で期限を守る。
fn connectOnceBefore(proxy: std.net.Address, deadline: Deadline) ?posix.socket_t {
    const fd = posix.socket(
        proxy.any.family,
        posix.SOCK.STREAM | posix.SOCK.CLOEXEC | posix.SOCK.NONBLOCK,
        0,
    ) catch return null;
    posix.connect(fd, &proxy.any, proxy.getOsSockLen()) catch |err| switch (err) {
        error.WouldBlock => {
            const ready = waitFor(fd, posix.POLL.OUT, deadline) catch false;
            const ok = ready and if (posix.getsockoptError(fd)) |_| true else |_| false;
            if (!ok) {
                posix.close(fd);
                return null;
            }
        },
        else => {
            // 失敗した socket は状態が未規定なので使い回さず作り直す。
            posix.close(fd);
            return null;
        },
    };
    return fd;
}

// ---------------------------------------------------------------------------
// proxy
// ---------------------------------------------------------------------------

/// 参照する環境変数。この順に最初の空でない値を使う。`NO_PROXY` は見ない:
/// srt は `NO_PROXY` に localhost などを入れるので、従うと proxy を通らずに
/// 直接つなぎに行き、sandbox の中からは届かなくなる。
const PROXY_ENV = [_][]const u8{ "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy" };

/// 環境変数から proxy の URL を選ぶ。使うかどうか (ループバックか) は
/// `Relay.connect` が決めるので、ここでは選ぶだけ。
pub fn proxyFromEnv() ?[]const u8 {
    return selectProxy(getenv);
}

fn getenv(name: []const u8) ?[]const u8 {
    return posix.getenv(name);
}

/// テストで環境変数を書き換えずに済むよう、参照先を引数で受ける。
fn selectProxy(lookup: *const fn ([]const u8) ?[]const u8) ?[]const u8 {
    for (PROXY_ENV) |name| {
        const v = lookup(name) orelse continue;
        if (v.len > 0) return v;
    }
    return null;
}

/// proxy の URL のユーザー情報の上限。srt のトークン程度を想定し、要求を
/// スタック上の固定長バッファで組み立てるために上限を置く。
const MAX_PROXY_USERINFO: usize = 512;
/// デコードした資格情報の上限。`:` の無いユーザー情報には `:` を足すので 1 多い。
const MAX_PROXY_CREDENTIAL: usize = MAX_PROXY_USERINFO + 1;
/// proxy の応答ヘッダの上限。CONNECT の応答はふつう 1 行と空行だけなので、
/// これを越えるのは proxy ではない何かとみなす。
const MAX_PROXY_RESPONSE: usize = 8 * 1024;
/// proxy 経由の接続処理全体 (TCP 接続、CONNECT の送受信、再試行の間の待ち) の
/// 期限 (ミリ秒)。proxy が黙ったり少しずつ返したりしても、hook や run をこれ以上
/// 止めないため。
const PROXY_CONNECT_TIMEOUT_MS: u64 = 5000;

const ProxyRoute = union(enum) {
    direct,
    connect: struct {
        addr: std.net.Address,
        /// URL のユーザー情報 (パーセントエンコードのまま)。無ければ null。
        userinfo: ?[]const u8,
    },
};

/// TCP の ADDR へどう接続するかを決める。
///
/// `http://` でホストがループバック (`127.0.0.1`、`[::1]`、`localhost`) の proxy
/// だけを使い、それ以外 (proxy 無し、他のホスト、`https://` など) は直接つなぐ。
///
/// ループバックに限る理由: 社内 proxy に `CONNECT 127.0.0.1:PORT` を送ると、
/// proxy は proxy 自身のホストのループバックへつなぎに行き、そこで待ち受けている
/// 何かへツールの出力が流れうる。srt の proxy はループバックで見えるので困らない。
///
/// 「直接 → 失敗したら proxy」としない理由: sandbox の network namespace では
/// 127.0.0.1:PORT が空いていて、エージェントが自前の待ち受けを立てられる。直接を
/// 先に試すと、出力をその待ち受けへ送り、返ってきた未マスクのバイトを流してしまう。
///
/// 同じ理由で、ループバックの `http://` proxy なのに URL が壊れている (ポートや
/// ユーザー情報が不正) ときは直接へ回さず `RelayConnectFailed` にする。
fn routeFor(proxy: ?[]const u8) RelayError!ProxyRoute {
    const url = proxy orelse return .direct;
    const scheme = "http://";
    // スキームは大文字小文字を区別しない (RFC 3986)。`HTTP://` を直接扱いにすると
    // 上の差し替えの穴になる。
    if (url.len < scheme.len or !std.ascii.eqlIgnoreCase(url[0..scheme.len], scheme)) return .direct;
    const rest = url[scheme.len..];
    const authority = rest[0 .. std.mem.indexOfAny(u8, rest, "/?#") orelse rest.len];

    // パスワードに `@` が素で入っていても host を取り違えないよう、最後の `@` で切る。
    const at = std.mem.lastIndexOfScalar(u8, authority, '@');
    const userinfo: ?[]const u8 = if (at) |i| authority[0..i] else null;
    const hostport = if (at) |i| authority[i + 1 ..] else authority;

    var host: []const u8 = undefined;
    var port_text: ?[]const u8 = null;
    if (hostport.len > 0 and hostport[0] == '[') {
        const close = std.mem.indexOfScalar(u8, hostport, ']') orelse return .direct;
        host = hostport[0 .. close + 1];
        const after = hostport[close + 1 ..];
        if (!std.mem.eql(u8, host, "[::1]")) return .direct;
        if (after.len > 0) {
            if (after[0] != ':') return error.RelayConnectFailed;
            port_text = after[1..];
        }
    } else {
        const colon = std.mem.indexOfScalar(u8, hostport, ':');
        host = hostport[0 .. colon orelse hostport.len];
        if (colon) |c| port_text = hostport[c + 1 ..];
    }

    const ip: []const u8 = if (std.mem.eql(u8, host, "127.0.0.1"))
        "127.0.0.1"
    else if (std.mem.eql(u8, host, "[::1]"))
        "::1"
    else if (std.ascii.eqlIgnoreCase(host, "localhost"))
        // 名前解決は持ち込まない。srt の proxy は 127.0.0.1 で待ち受ける。
        "127.0.0.1"
    else
        return .direct;

    // ここから先はループバックの proxy と決まっている。壊れていても直接へは回さない。
    const port: u16 = if (port_text) |t| parseProxyPort(t) orelse return error.RelayConnectFailed else 80;
    if (userinfo) |u| {
        if (u.len > MAX_PROXY_USERINFO) return error.RelayConnectFailed;
        if (!validPercentEncoding(u)) return error.RelayConnectFailed;
    }
    const addr = std.net.Address.parseIp(ip, port) catch return error.RelayConnectFailed;
    return .{ .connect = .{ .addr = addr, .userinfo = userinfo } };
}

/// 10 進の数字だけを受け付ける (address.zig の parsePort と同じ方針)。
fn parseProxyPort(s: []const u8) ?u16 {
    if (s.len == 0) return null;
    var v: u32 = 0;
    for (s) |c| {
        if (c < '0' or c > '9') return null;
        v = v * 10 + (c - '0');
        if (v > 65535) return null;
    }
    if (v == 0) return null;
    return @intCast(v);
}

/// `%` の後に 16 進 2 桁が続くこと。`percentDecodeInPlace` は不正な並びを
/// そのまま残すので、黙って違う資格情報を送らないよう先に弾く。
fn validPercentEncoding(s: []const u8) bool {
    var i: usize = 0;
    while (i < s.len) : (i += 1) {
        if (s[i] != '%') continue;
        if (i + 2 >= s.len) return false;
        if (!std.ascii.isHex(s[i + 1]) or !std.ascii.isHex(s[i + 2])) return false;
        i += 2;
    }
    return true;
}

const HandshakeError = error{
    /// proxy が 403 で拒否した。再試行しない。
    ProxyForbidden,
    /// 接続処理全体の期限が切れた。再試行しない。
    ProxyTimedOut,
    /// それ以外の失敗 (200 以外の応答、早すぎる close など)。
    ProxyHandshakeFailed,
};

/// proxy に CONNECT を送り、200 が返ることを確かめる。どの失敗も、呼び出し元
/// では最終的に `RelayConnectFailed` (ブローカーに接続できないのと同じ扱い) になる。
/// fd は非ブロッキングで、送るのも受けるのも `deadline` までに済ませる。
///
/// 資格情報を含むので、要求も応答もどこにも出力しない。
fn proxyHandshake(
    fd: posix.socket_t,
    target: std.net.Address,
    userinfo: ?[]const u8,
    deadline: Deadline,
) HandshakeError!void {
    var req_buf: [256 + std.base64.standard.Encoder.calcSize(MAX_PROXY_CREDENTIAL)]u8 = undefined;
    defer std.crypto.secureZero(u8, &req_buf);
    const req = buildConnectRequest(&req_buf, target, userinfo) catch return error.ProxyHandshakeFailed;
    var off: usize = 0;
    while (off < req.len) {
        if (!(waitFor(fd, posix.POLL.OUT, deadline) catch return error.ProxyHandshakeFailed))
            return error.ProxyTimedOut;
        // proxy が先に閉じても SIGPIPE で死なず失敗を返すため NOSIGNAL で送る。
        const n = posix.send(fd, req[off..], posix.MSG.NOSIGNAL) catch |err| switch (err) {
            error.WouldBlock => continue,
            else => return error.ProxyHandshakeFailed,
        };
        if (n == 0) return error.ProxyHandshakeFailed;
        off += n;
    }

    var resp: [MAX_PROXY_RESPONSE]u8 = undefined;
    var len: usize = 0;
    const end = while (true) {
        if (len == resp.len) return error.ProxyHandshakeFailed;
        if (!(waitFor(fd, posix.POLL.IN, deadline) catch return error.ProxyHandshakeFailed))
            return error.ProxyTimedOut;
        const n = posix.read(fd, resp[len..]) catch |err| switch (err) {
            error.WouldBlock => continue,
            else => return error.ProxyHandshakeFailed,
        };
        if (n == 0) return error.ProxyHandshakeFailed;
        const from = len -| 3;
        len += n;
        if (std.mem.indexOfPos(u8, resp[0..len], from, "\r\n\r\n")) |i| break i + 4;
    };
    if (statusIs(resp[0..len], "403")) return error.ProxyForbidden;
    // ブローカーは自分からは何も送らないので、ヘッダの後ろにバイトがあるのは
    // 相手が CONNECT を素通しする proxy ではないということ。ストリームの頭に
    // 混ざったまま出力へ流さないため失敗にする。
    if (end != len) return error.ProxyHandshakeFailed;
    if (!statusIs(resp[0..len], "200")) return error.ProxyHandshakeFailed;
}

/// 状態行が `HTTP/1.0 <code>` か `HTTP/1.1 <code>` か。
fn statusIs(header: []const u8, comptime code: []const u8) bool {
    for ([_][]const u8{ "HTTP/1.0 " ++ code, "HTTP/1.1 " ++ code }) |prefix| {
        if (!std.mem.startsWith(u8, header, prefix)) continue;
        // `HTTP/1.1 2000` のような別の状態コードを取り違えない。
        const next = header[prefix.len];
        return next == ' ' or next == '\r';
    }
    return false;
}

fn buildConnectRequest(buf: []u8, target: std.net.Address, userinfo: ?[]const u8) ![]const u8 {
    var w: std.Io.Writer = .fixed(buf);
    // std.net.Address の書式は IPv6 を `[::1]:PORT` と角括弧付きで書く。
    try w.print("CONNECT {f} HTTP/1.1\r\nHost: {f}\r\n", .{ target, target });
    if (userinfo) |u| {
        var cred_buf: [MAX_PROXY_CREDENTIAL]u8 = undefined;
        defer std.crypto.secureZero(u8, &cred_buf);
        const cred = decodeUserinfo(&cred_buf, u);
        var b64_buf: [std.base64.standard.Encoder.calcSize(MAX_PROXY_CREDENTIAL)]u8 = undefined;
        defer std.crypto.secureZero(u8, &b64_buf);
        const b64 = std.base64.standard.Encoder.encode(&b64_buf, cred);
        try w.print("Proxy-Authorization: Basic {s}\r\n", .{b64});
    }
    try w.writeAll("\r\n");
    return w.buffered();
}

/// `user[:pass]` をそれぞれパーセントデコードし、`user:pass` にして返す。
/// デコード前に `:` で区切るのは、パスワード中の `%3A` を区切りと取り違えないため。
/// `:` が無いときも `user:` にする。Basic 認証の資格情報は `user-id ":" password`
/// の形で、`:` は省けない (RFC 7617)。
fn decodeUserinfo(buf: []u8, userinfo: []const u8) []const u8 {
    const colon = std.mem.indexOfScalar(u8, userinfo, ':');
    var len = percentDecodeInto(buf, userinfo[0 .. colon orelse userinfo.len]);
    buf[len] = ':';
    len += 1;
    if (colon) |c| len += percentDecodeInto(buf[len..], userinfo[c + 1 ..]);
    return buf[0..len];
}

/// raw をデコードして dst の先頭に置き、長さを返す。`percentDecodeInPlace` は
/// 結果を渡した領域の**末尾**に寄せて返すので、先頭へ詰め直す。
fn percentDecodeInto(dst: []u8, raw: []const u8) usize {
    @memcpy(dst[0..raw.len], raw);
    const decoded = std.Uri.percentDecodeInPlace(dst[0..raw.len]);
    std.mem.copyForwards(u8, dst[0..decoded.len], decoded);
    return decoded.len;
}

/// ブローカーへの 1 接続。生バイトをフレームに包んで送り、マスク済みバイトを
/// 出力先 fd へ流す。
pub const Relay = struct {
    fd: posix.socket_t,
    /// まだ socket へ書けていないフレーム (ヘッダと本文)。短絡書き込みの残りは
    /// ここに留まり、次の POLLOUT で続きを書く。**1 バイトも落としてはならない**。
    pending: std.ArrayList(u8) = .empty,
    /// 終わりのフレームをキューに積んだか。これ以降 queueWrite してはならない。
    end_queued: bool = false,
    /// キューに積んだフレームの本文の合計バイト数 (ヘッダは含めない)。
    body_queued: usize = 0,
    /// サーバから受け取ったバイト数。
    received: usize = 0,
    /// サーバが close した (read が 0 を返した)。完了かどうかは
    /// `checkComplete` で確かめること。
    read_eof: bool = false,

    /// addr のブローカーへ接続する。
    ///
    /// **ブロッキングの connect(2) を使い、成功してから非ブロッキングに切り替える**。
    /// AF_UNIX の非ブロッキング connect は「backlog が一杯でまだ繋がっていない」を
    /// EAGAIN で返すが、TCP と違って完了を知らせる POLLOUT が来ない。EAGAIN を
    /// 成功扱いにすると、1 バイトも届かないリレーが黙って出来上がる。直接の TCP も
    /// 同じ手順に揃える。proxy 経由だけは、接続と CONNECT のやりとりを期限の中で
    /// 終えるため非ブロッキングで行う (`connectViaProxy`)。TCP の非ブロッキング
    /// connect は完了を POLLOUT で知らせるので、上の問題は起きない。
    ///
    /// fd は SOCK_CLOEXEC で作る (proxy への socket も同じ)。子へ漏れると単なる
    /// 情報漏れではなく**注入オラクル**になる: ストリーム途中に 1 バイト差し込むと
    /// サーバ側のマッチが崩れて原文がそのまま返るため、差し込んだ値を知っていれば
    /// 原文を復元できる。
    ///
    /// `proxy` は TCP のときだけ見る (Unix では無視)。経路は `routeFor` の規則
    /// 1 つで決め、直接と proxy の間でフォールバックしない。
    pub fn connect(addr: address.Address, proxy: ?[]const u8) RelayError!Relay {
        const fd = switch (addr) {
            .unix => |path| try connectUnix(path),
            .tcp => |target| switch (try routeFor(proxy)) {
                .direct => try connectTcp(target),
                .connect => |p| try connectViaProxy(p.addr, target, p.userinfo, PROXY_CONNECT_TIMEOUT_MS),
            },
        };
        setNonBlocking(fd) catch {
            posix.close(fd);
            return error.RelayConnectFailed;
        };
        return .{ .fd = fd };
    }

    pub fn deinit(self: *Relay, gpa: std.mem.Allocator) void {
        self.pending.deinit(gpa);
        posix.close(self.fd);
        self.* = undefined;
    }

    pub fn pendingLen(self: *const Relay) usize {
        return self.pending.items.len;
    }

    /// 生バイトをフレームに包んで送信キューへ積む。CHUNK_SIZE を越える分は
    /// 複数のフレームに分ける。空のバイト列は何も積まない (長さ 0 のフレームは
    /// 入力の終わりを意味するので、空の書き込みで終わらせてはならない)。
    /// 実際の write は pumpWritable が行う。
    pub fn queueWrite(self: *Relay, gpa: std.mem.Allocator, bytes: []const u8) RelayError!void {
        std.debug.assert(!self.end_queued);
        var rest = bytes;
        while (rest.len > 0) {
            const n = @min(rest.len, frame.MAX_BODY);
            const h = frame.header(n);
            self.pending.ensureUnusedCapacity(gpa, h.len + n) catch return error.RelayFailed;
            self.pending.appendSliceAssumeCapacity(&h);
            self.pending.appendSliceAssumeCapacity(rest[0..n]);
            self.body_queued += n;
            rest = rest[n..];
        }
    }

    /// 入力の終わり (長さ 0 のフレーム) を送信キューへ積む。サーバは受け取ると
    /// 保持中の overlap をフラッシュしてから close する。
    ///
    /// キューに残っているフレームの後ろに積むので、キューが空になるのを待たずに
    /// 呼んでよい。half-close と違い、積んだ後もそれより前のバイトは送れる。
    pub fn queueEnd(self: *Relay, gpa: std.mem.Allocator) RelayError!void {
        if (self.end_queued) return;
        self.pending.appendSlice(gpa, &frame.header(0)) catch return error.RelayFailed;
        self.end_queued = true;
    }

    /// POLLOUT が立ったときに呼ぶ。書けた分だけキューから取り除く。
    pub fn pumpWritable(self: *Relay) RelayError!void {
        if (self.pending.items.len == 0) return;
        // 呼び出し元は SIGPIPE を無視しているとは限らない (hook は普通の
        // プロセス)。サーバが先に閉じたときに死なず失敗を返すため NOSIGNAL で送る。
        const n = posix.send(self.fd, self.pending.items, posix.MSG.NOSIGNAL) catch |err| switch (err) {
            error.WouldBlock => return,
            else => return error.RelayFailed,
        };
        if (n == 0) return error.RelayFailed;
        const remaining = self.pending.items.len - n;
        std.mem.copyForwards(u8, self.pending.items[0..remaining], self.pending.items[n..]);
        self.pending.items.len = remaining;
    }

    /// マスク済みバイトを buf へ 1 回読み、受け取ったバイト数に数える。
    /// 戻り値は読めたバイト数 (0 は EAGAIN か EOF)。EOF は `read_eof` で区別する。
    pub fn readSome(self: *Relay, buf: []u8) RelayError!usize {
        const n = posix.read(self.fd, buf) catch |err| switch (err) {
            error.WouldBlock => return 0,
            else => return error.RelayFailed,
        };
        if (n == 0) {
            self.read_eof = true;
            return 0;
        }
        self.received += n;
        return n;
    }

    /// POLLIN / POLLHUP が立ったときに呼ぶ。マスク済みバイトを 1 回読んで
    /// dst_fd へ書き切る。戻り値は読めたバイト数 (0 は EAGAIN か EOF)。
    /// EOF は `read_eof` で区別する。
    ///
    /// socket 側の失敗は `RelayError.RelayFailed` (致命)、出力先が閉じている
    /// 場合だけ `DestError.DestinationClosed` を返す。呼び出し側は後者を
    /// 121 にしてはならない。
    pub fn pumpReadable(
        self: *Relay,
        dst_fd: posix.fd_t,
        buf: []u8,
    ) (RelayError || DestError)!usize {
        const n = try self.readSome(buf);
        if (n == 0) return 0;
        try writeAllToDest(dst_fd, buf[0..n]);
        return n;
    }

    /// サーバが close した後に呼び、応答を最後まで受け取ったかを確かめる。
    ///
    /// 終わりのフレームを送り切る前に閉じたのは切り捨て (接続数上限を超えた
    /// 接続はサーバが accept して即 close する)。送り切っていても、それは
    /// サーバが処理を終えたことを意味しない: 末尾を返さずに閉じられると、送信の
    /// 完了だけを見ていては欠けた出力が成功になる。マスクは長さを保存するので、
    /// 受け取ったバイト数と送った本文の合計を比べてそれを検出する。
    pub fn checkComplete(self: *const Relay) RelayError!void {
        std.debug.assert(self.read_eof);
        if (!self.end_queued or self.pending.items.len != 0) return error.RelayClosedEarly;
        if (self.received != self.body_queued) return error.RelayClosedEarly;
    }
};

/// maskOnce が無進捗のまま待つ上限 (ms)。進捗のたびに引き直す。
const ROUND_TRIP_IDLE_MS: i64 = 5000;

/// 1 回分のバイト列をブローカーでマスクして返す。1 接続 = 1 ストリームの
/// プロトコルをそのまま使い、全体をフレームで送って終わりのフレームを送り、
/// サーバが close するまで読む。
///
/// 書き込みと読み出しは poll で並行させる。サーバは接続ごとの未送信バイト数に
/// 上限を持ち、それを超えると read を止めるので、書き終えてから読む実装は
/// 大きな入力で双方が止まる。送信キューには 1 フレームずつ積む。入力全体を
/// 一度に積むと、入力の複製を抱えたうえ、短い write のたびに残り全体を前詰め
/// することになる。
///
/// 応答が最後まで届いたかは `Relay.checkComplete` で確かめる。途中で切れた
/// 応答を「マスク済み」として返さないため。
pub fn maskOnce(
    gpa: std.mem.Allocator,
    addr: address.Address,
    proxy: ?[]const u8,
    input: []const u8,
) (RelayError || error{OutOfMemory})![]u8 {
    var relay = try Relay.connect(addr, proxy);
    defer relay.deinit(gpa);

    const out = try gpa.alloc(u8, input.len);
    errdefer gpa.free(out);
    var queued: usize = 0;
    var deadline = std.time.milliTimestamp() + ROUND_TRIP_IDLE_MS;

    while (!relay.read_eof) {
        if (relay.pendingLen() == 0) {
            if (queued < input.len) {
                const n = @min(input.len - queued, CHUNK_SIZE);
                try relay.queueWrite(gpa, input[queued..][0..n]);
                queued += n;
            } else try relay.queueEnd(gpa);
        }

        var pfd = [_]posix.pollfd{.{ .fd = relay.fd, .events = posix.POLL.IN, .revents = 0 }};
        if (relay.pendingLen() > 0) pfd[0].events |= posix.POLL.OUT;
        const now = std.time.milliTimestamp();
        if (now >= deadline) return error.RelayFailed;
        const ready = posix.poll(&pfd, @intCast(deadline - now)) catch return error.RelayFailed;
        if (ready == 0) continue;
        const revents = pfd[0].revents;
        if (revents & (posix.POLL.ERR | posix.POLL.NVAL) != 0) return error.RelayFailed;

        if (revents & (posix.POLL.IN | posix.POLL.HUP) != 0) {
            // 入力より長い応答は受け取らない。末尾 1 バイトぶんの余地を残して
            // 読み、超過したら失敗にする。
            var spill: [1]u8 = undefined;
            const buf = if (relay.received < out.len) out[relay.received..] else spill[0..];
            if (try relay.readSome(buf) > 0) {
                if (relay.received > out.len) return error.RelayFailed;
                deadline = std.time.milliTimestamp() + ROUND_TRIP_IDLE_MS;
            }
        }
        if (relay.read_eof) break;

        if (revents & posix.POLL.OUT != 0) {
            const before = relay.pendingLen();
            try relay.pumpWritable();
            if (relay.pendingLen() != before) deadline = std.time.milliTimestamp() + ROUND_TRIP_IDLE_MS;
        }
    }
    try relay.checkComplete();
    return out;
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

const testing = std.testing;

test "Relay.connect: empty path is rejected" {
    try testing.expectError(error.SocketPathInvalid, Relay.connect(.{ .unix = "" }, null));
}

test "Relay.connect: path longer than sun_path is rejected" {
    const too_long = "/" ** (MAX_SOCKET_PATH + 1);
    try testing.expectError(error.SocketPathInvalid, Relay.connect(.{ .unix = too_long }, null));
}

test "Relay.connect: a missing broker fails closed" {
    var buf: [MAX_SOCKET_PATH]u8 = undefined;
    const path = try std.fmt.bufPrint(
        &buf,
        "/tmp/nas-mf-absent-{d}.sock",
        .{std.c.getpid()},
    );
    std.fs.cwd().deleteFile(path) catch {};
    try testing.expectError(error.RelayConnectFailed, Relay.connect(.{ .unix = path }, null));
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

test "Relay: input goes out as frames, an empty frame ends it, and there is no half-close" {
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

    var relay = try Relay.connect(.{ .unix = path }, null);
    defer relay.deinit(testing.allocator);

    const peer = try posix.accept(listener, null, null, posix.SOCK.CLOEXEC);
    defer posix.close(peer);

    // 送信キューは pumpWritable まで実際には書かれない。ヘッダ 4 バイト + 本文。
    try relay.queueWrite(testing.allocator, "hello");
    try testing.expectEqual(@as(usize, 9), relay.pendingLen());
    // 空の書き込みは何も積まない (長さ 0 のフレームは入力の終わりになってしまう)。
    try relay.queueWrite(testing.allocator, "");
    try testing.expectEqual(@as(usize, 9), relay.pendingLen());
    try relay.pumpWritable();
    try testing.expectEqual(@as(usize, 0), relay.pendingLen());

    var in: [16]u8 = undefined;
    try testing.expectEqual(@as(usize, 9), try posix.read(peer, &in));
    try testing.expectEqualSlices(u8, "\x00\x00\x00\x05hello", in[0..9]);

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

    // 入力の終わりは長さ 0 のフレーム。half-close はしないので、その後の read は
    // EOF (0) ではなく「まだ何も来ていない」になる。
    try relay.queueEnd(testing.allocator);
    try relay.pumpWritable();
    try testing.expectEqual(@as(usize, 4), try posix.read(peer, &in));
    try testing.expectEqualSlices(u8, "\x00\x00\x00\x00", in[0..4]);
    try testing.expectError(error.WouldBlock, posix.recv(peer, &in, posix.MSG.DONTWAIT));

    // サーバが close したら read_eof が立ち、送った本文と同じ長さを受け取って
    // いれば完了。
    posix.shutdown(peer, .send) catch {};
    try waitReadable(relay.fd);
    try testing.expectEqual(@as(usize, 0), try relay.pumpReadable(out_pipe[1], &buf));
    try testing.expect(relay.read_eof);
    try relay.checkComplete();
}

test "Relay.queueWrite: input over CHUNK_SIZE is split into frames of at most CHUNK_SIZE" {
    var path_buf: [MAX_SOCKET_PATH]u8 = undefined;
    const path = try std.fmt.bufPrint(&path_buf, "/tmp/nas-mf-split-{d}.sock", .{std.c.getpid()});
    const listener = try listenAt(path);
    defer {
        posix.close(listener);
        posix.unlink(path) catch {};
    }
    var relay = try Relay.connect(.{ .unix = path }, null);
    defer relay.deinit(testing.allocator);

    const payload = try testing.allocator.alloc(u8, CHUNK_SIZE + 1);
    defer testing.allocator.free(payload);
    @memset(payload, 'x');
    try relay.queueWrite(testing.allocator, payload);
    const q = relay.pending.items;
    try testing.expectEqual(@as(usize, 4 + CHUNK_SIZE + 4 + 1), q.len);
    try testing.expectEqual(@as(u32, CHUNK_SIZE), std.mem.readInt(u32, q[0..4], .big));
    try testing.expectEqual(@as(u32, 1), std.mem.readInt(u32, q[4 + CHUNK_SIZE ..][0..4], .big));
    try testing.expectEqual(CHUNK_SIZE + 1, relay.body_queued);
}

test "Relay.checkComplete: a close before the end frame or with a short response fails" {
    const cases = [_]struct { end_queued: bool, pending: usize, body: usize, received: usize }{
        // 終わりのフレームを積んでいない。
        .{ .end_queued = false, .pending = 0, .body = 3, .received = 3 },
        // 積んだが送り切っていない。
        .{ .end_queued = true, .pending = 4, .body = 3, .received = 3 },
        // 送り切ったが、末尾が返ってこなかった。
        .{ .end_queued = true, .pending = 0, .body = 3, .received = 2 },
        // 送った以上のバイトが返ってきた。
        .{ .end_queued = true, .pending = 0, .body = 3, .received = 4 },
    };
    for (cases) |c| {
        var relay = Relay{ .fd = -1, .end_queued = c.end_queued, .body_queued = c.body, .received = c.received, .read_eof = true };
        defer relay.pending.deinit(testing.allocator);
        try relay.pending.appendNTimes(testing.allocator, 0, c.pending);
        try testing.expectError(error.RelayClosedEarly, relay.checkComplete());
    }
    const ok = Relay{ .fd = -1, .end_queued = true, .body_queued = 3, .received = 3, .read_eof = true };
    try ok.checkComplete();
}

// 出力先の EPIPE は「もう誰も読んでいない」だけでマスクの失敗ではないので、
// socket 側の失敗と同じ RelayFailed にしてはならない。同じにすると
// `cmd | head` が「出力抑止」の診断つきで 121 になる。
test "Relay.pumpReadable: a closed destination is reported apart from mask failure" {
    // 出力先への write が EPIPE を返す前にテストランナーが死なないようにする
    // (supervise.run も同じ理由で SIGPIPE を無視している)。
    var old: posix.Sigaction = undefined;
    const ign: posix.Sigaction = .{
        .handler = .{ .handler = posix.SIG.IGN },
        .mask = posix.sigemptyset(),
        .flags = 0,
    };
    posix.sigaction(posix.SIG.PIPE, &ign, &old);
    defer posix.sigaction(posix.SIG.PIPE, &old, null);

    var path_buf: [MAX_SOCKET_PATH]u8 = undefined;
    const path = try std.fmt.bufPrint(
        &path_buf,
        "/tmp/nas-mf-dstgone-{d}.sock",
        .{std.c.getpid()},
    );

    const listener = try listenAt(path);
    defer {
        posix.close(listener);
        posix.unlink(path) catch {};
    }

    var relay = try Relay.connect(.{ .unix = path }, null);
    defer relay.deinit(testing.allocator);
    const peer = try posix.accept(listener, null, null, posix.SOCK.CLOEXEC);
    defer posix.close(peer);

    _ = try posix.write(peer, "HELLO");

    // 読み手が去った出力先 (`cmd | head` 相当)。
    const out_pipe = try posix.pipe();
    posix.close(out_pipe[0]);
    defer posix.close(out_pipe[1]);

    var buf: [CHUNK_SIZE]u8 = undefined;
    try waitReadable(relay.fd);
    try testing.expectError(
        error.DestinationClosed,
        relay.pumpReadable(out_pipe[1], &buf),
    );
}

/// テストの相手から buf を埋めるまで読む。クライアントの不具合でテストが
/// 止まらないよう、1 回の待ちを 5 秒で区切る。EOF・タイムアウト・エラーは false。
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

/// テスト用のブローカー。1 接続を受け、フレームの本文の小文字 'x' を '*' にして返す。
/// 読み終える前に書き始めるので、背圧のかかる大きな入力でも止まらないことを確かめられる。
/// 本物のサーバと同じく末尾 (ここでは最後の 1 バイト) を保持し、終わりのフレームで返す。
const StarServer = struct {
    const Mode = enum {
        /// 終わりのフレームで保持中の末尾を返してから閉じる。
        echo,
        /// 最初の read の直後に閉じる。
        cut,
        /// 終わりのフレームを受け取った後、保持中の末尾を返さずに閉じる。
        drop_tail,
    };

    fn run(listener: posix.socket_t, mode: Mode) void {
        // クライアントが接続に失敗したときにテストが join で止まらないよう、待つ時間を区切る。
        var lp = [_]posix.pollfd{.{ .fd = listener, .events = posix.POLL.IN, .revents = 0 }};
        const ready = posix.poll(&lp, 5000) catch return;
        if (ready == 0) return;
        const peer = posix.accept(listener, null, null, posix.SOCK.CLOEXEC) catch return;
        defer posix.close(peer);
        var held: ?u8 = null;
        var buf: [4096]u8 = undefined;
        while (true) {
            var h: [4]u8 = undefined;
            if (!readExactly(peer, &h)) return;
            if (mode == .cut) return;
            var left: usize = std.mem.readInt(u32, &h, .big);
            if (left == 0) break;
            while (left > 0) {
                const n = @min(left, buf.len);
                if (!readExactly(peer, buf[0..n])) return;
                left -= n;
                for (buf[0..n]) |*b| {
                    if (b.* == 'x') b.* = '*';
                }
                if (held) |b| writeAllBlocking(peer, &.{b}) catch return;
                writeAllBlocking(peer, buf[0 .. n - 1]) catch return;
                held = buf[n - 1];
            }
        }
        if (mode == .drop_tail) return;
        if (held) |b| writeAllBlocking(peer, &.{b}) catch return;
    }
};

test "maskOnce: a large input round-trips through the broker" {
    var path_buf: [MAX_SOCKET_PATH]u8 = undefined;
    const path = try std.fmt.bufPrint(&path_buf, "/tmp/nas-mf-once-{d}.sock", .{std.c.getpid()});
    const listener = try listenAt(path);
    defer {
        posix.close(listener);
        posix.unlink(path) catch {};
    }
    const server = try std.Thread.spawn(.{}, StarServer.run, .{ listener, StarServer.Mode.echo });
    defer server.join();

    const input = try testing.allocator.alloc(u8, 2 * 1024 * 1024);
    defer testing.allocator.free(input);
    for (input, 0..) |*b, i| b.* = if (i % 3 == 0) 'x' else 'a';
    const got = try maskOnce(testing.allocator, .{ .unix = path }, null, input);
    defer testing.allocator.free(got);
    try testing.expectEqual(input.len, got.len);
    for (got, 0..) |b, i| try testing.expectEqual(@as(u8, if (i % 3 == 0) '*' else 'a'), b);
}

test "maskOnce: an empty input sends only the end frame" {
    var path_buf: [MAX_SOCKET_PATH]u8 = undefined;
    const path = try std.fmt.bufPrint(&path_buf, "/tmp/nas-mf-empty-{d}.sock", .{std.c.getpid()});
    const listener = try listenAt(path);
    defer {
        posix.close(listener);
        posix.unlink(path) catch {};
    }
    const server = try std.Thread.spawn(.{}, StarServer.run, .{ listener, StarServer.Mode.echo });
    defer server.join();

    const got = try maskOnce(testing.allocator, .{ .unix = path }, null, "");
    defer testing.allocator.free(got);
    try testing.expectEqual(@as(usize, 0), got.len);
}

test "maskOnce: a broker that closes before the end frame is a failure" {
    var path_buf: [MAX_SOCKET_PATH]u8 = undefined;
    const path = try std.fmt.bufPrint(&path_buf, "/tmp/nas-mf-cut-{d}.sock", .{std.c.getpid()});
    const listener = try listenAt(path);
    defer {
        posix.close(listener);
        posix.unlink(path) catch {};
    }
    const server = try std.Thread.spawn(.{}, StarServer.run, .{ listener, StarServer.Mode.cut });
    defer server.join();

    // サーバが閉じたのを送信の失敗で知るか、EOF で知るかはタイミングによる。
    // どちらでも失敗であること。
    if (maskOnce(testing.allocator, .{ .unix = path }, null, "xxxx")) |got| {
        testing.allocator.free(got);
        return error.TestUnexpectedResult;
    } else |err| switch (err) {
        error.RelayFailed, error.RelayClosedEarly => {},
        else => return err,
    }
}

// 終わりのフレームを送り切っただけでは、サーバが末尾を返し終えたことにならない。
test "maskOnce: a broker that closes after the end frame without the tail is a failure" {
    var path_buf: [MAX_SOCKET_PATH]u8 = undefined;
    const path = try std.fmt.bufPrint(&path_buf, "/tmp/nas-mf-notail-{d}.sock", .{std.c.getpid()});
    const listener = try listenAt(path);
    defer {
        posix.close(listener);
        posix.unlink(path) catch {};
    }
    const server = try std.Thread.spawn(.{}, StarServer.run, .{ listener, StarServer.Mode.drop_tail });
    defer server.join();

    try testing.expectError(error.RelayClosedEarly, maskOnce(testing.allocator, .{ .unix = path }, null, "axbxc"));
}

test "maskOnce: a missing broker fails" {
    var path_buf: [MAX_SOCKET_PATH]u8 = undefined;
    const path = try std.fmt.bufPrint(&path_buf, "/tmp/nas-mf-once-absent-{d}.sock", .{std.c.getpid()});
    std.fs.cwd().deleteFile(path) catch {};
    try testing.expectError(error.RelayConnectFailed, maskOnce(testing.allocator, .{ .unix = path }, null, "x"));
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

    var relay = try Relay.connect(.{ .unix = path }, null);
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
    // フレームのヘッダも含め、キューに積んだバイト列がそのままの順で届くこと。
    const expected = try testing.allocator.dupe(u8, relay.pending.items);
    defer testing.allocator.free(expected);

    try relay.pumpWritable();
    const left = relay.pendingLen();
    try testing.expect(left > 0);
    try testing.expect(left < expected.len);

    // 残りは前詰めされていて、続きが正しい位置から書けること。
    var drained: usize = 0;
    var in: [64 * 1024]u8 = undefined;
    while (drained < expected.len) {
        const n = try posix.read(peer, &in);
        if (n == 0) break;
        try testing.expectEqualSlices(u8, expected[drained..][0..n], in[0..n]);
        drained += n;
        try relay.pumpWritable();
    }
    try testing.expect(relay.pendingLen() == 0);
    try testing.expectEqual(expected.len, drained);
}

// --- TCP / proxy -----------------------------------------------------------

/// テスト用の TCP listener を 127.0.0.1 の空きポートに張る。
fn listenTcp() !struct { fd: posix.socket_t, addr: std.net.Address } {
    var addr = try std.net.Address.parseIp4("127.0.0.1", 0);
    const fd = try posix.socket(posix.AF.INET, posix.SOCK.STREAM | posix.SOCK.CLOEXEC, 0);
    errdefer posix.close(fd);
    try posix.bind(fd, &addr.any, addr.getOsSockLen());
    try posix.listen(fd, 4);
    var len: posix.socklen_t = addr.getOsSockLen();
    try posix.getsockname(fd, &addr.any, &len);
    return .{ .fd = fd, .addr = addr };
}

/// listener に未 accept の接続が積まれていないこと (= 誰もつないでこなかった) を確かめる。
fn expectNoPendingConnection(listener: posix.socket_t) !void {
    var pfd = [_]posix.pollfd{.{ .fd = listener, .events = posix.POLL.IN, .revents = 0 }};
    try testing.expectEqual(@as(usize, 0), try posix.poll(&pfd, 0));
}

/// テスト用の CONNECT proxy が 1 接続ごとにすること。
const ProxyAction = union(enum) {
    /// 要求行の宛先へ実際につなぎ、200 を返してから両方向を中継する。
    tunnel,
    /// この応答をそのまま 1 回の write で返し、相手が閉じるまで待つ。
    reply: []const u8,
    /// 要求を読んだら何も返さずに閉じる。
    close,
    /// 要求を読んだら何も返さず、相手が閉じるまで待つ。
    silent,
    /// 要求を読んだら、終わらないヘッダをこの間隔 (ミリ秒) で 1 バイトずつ返し続ける。
    /// 相手が閉じて send が失敗するか、TRICKLE_MAX_MS が過ぎたらやめる。
    trickle: u64,
};

/// trickle を続ける上限。クライアントが期限を守らなくてもテストのスレッドが
/// 終わるようにする (クライアントの不具合でスイートが止まらないため)。
const TRICKLE_MAX_MS: i64 = 10_000;

/// テスト用の CONNECT proxy。`actions` の数だけ接続を順に受け、それぞれに対応する
/// 動作をする。最初の要求ヘッダを記録する。
const TestProxy = struct {
    listener: posix.socket_t,
    addr: std.net.Address,
    actions: []const ProxyAction,
    request: [4096]u8 = undefined,
    request_len: usize = 0,
    accepted: usize = 0,

    fn init(actions: []const ProxyAction) !TestProxy {
        const l = try listenTcp();
        return .{ .listener = l.fd, .addr = l.addr, .actions = actions };
    }

    fn deinit(self: *TestProxy) void {
        posix.close(self.listener);
    }

    fn url(self: *const TestProxy, buf: []u8, userinfo: []const u8) ![]const u8 {
        return std.fmt.bufPrint(buf, "http://{s}127.0.0.1:{d}", .{ userinfo, self.addr.getPort() });
    }

    fn requestText(self: *const TestProxy) []const u8 {
        return self.request[0..self.request_len];
    }

    fn run(self: *TestProxy) void {
        self.serve() catch {};
    }

    fn serve(self: *TestProxy) !void {
        for (self.actions) |action| {
            // クライアントの不具合でテストが止まらないよう、accept は時間を区切る。
            var lp = [_]posix.pollfd{.{ .fd = self.listener, .events = posix.POLL.IN, .revents = 0 }};
            if (try posix.poll(&lp, 5000) == 0) return;
            const client = try posix.accept(self.listener, null, null, posix.SOCK.CLOEXEC);
            defer posix.close(client);
            self.accepted += 1;

            var req: [4096]u8 = undefined;
            var len: usize = 0;
            while (std.mem.indexOf(u8, req[0..len], "\r\n\r\n") == null) {
                if (len == req.len) return;
                const n = try posix.read(client, req[len..]);
                if (n == 0) return;
                len += n;
            }
            if (self.accepted == 1) {
                @memcpy(self.request[0..len], req[0..len]);
                self.request_len = len;
            }

            switch (action) {
                .close => {},
                .reply => |r| {
                    try writeAllBlocking(client, r);
                    try waitClosed(client);
                },
                .silent => try waitClosed(client),
                .trickle => |interval_ms| trickle(client, interval_ms),
                .tunnel => {
                    // "CONNECT host:port HTTP/1.1"
                    const line_end = std.mem.indexOf(u8, req[0..len], "\r\n").?;
                    var it = std.mem.splitScalar(u8, req[0..line_end], ' ');
                    _ = it.next();
                    const target = try std.net.Address.parseIpAndPort(it.next() orelse return);
                    const upstream = try posix.socket(target.any.family, posix.SOCK.STREAM | posix.SOCK.CLOEXEC, 0);
                    defer posix.close(upstream);
                    try posix.connect(upstream, &target.any, target.getOsSockLen());
                    try writeAllBlocking(client, "HTTP/1.1 200 Connection established\r\n\r\n");
                    try splice(client, upstream);
                },
            }
        }
    }

    /// ヘッダの終わり (`\r\n\r\n`) を含まないバイト列を 1 バイトずつ返す。
    /// 1 回の read の待ちは毎回短いので、読み取りごとのタイムアウトでは切れない。
    fn trickle(fd: posix.socket_t, interval_ms: u64) void {
        const text = "HTTP/1.1 200 OK\r\nX-Pad: ";
        const started = std.time.milliTimestamp();
        var i: usize = 0;
        while (std.time.milliTimestamp() - started < TRICKLE_MAX_MS) : (i += 1) {
            const b: u8 = if (i < text.len) text[i] else 'a';
            _ = posix.send(fd, &[_]u8{b}, posix.MSG.NOSIGNAL) catch return;
            std.Thread.sleep(interval_ms * std.time.ns_per_ms);
        }
    }

    /// 相手が閉じるまで読み捨てる。クライアントの接続処理の期限 (5 秒) より長く待つ。
    /// 応答を読み切らずに閉じたクライアントからは RST が届くので、read のエラーも
    /// 「閉じた」として扱う (エラーで抜けると次の接続を受けなくなる)。
    fn waitClosed(fd: posix.socket_t) !void {
        var sink: [4096]u8 = undefined;
        var cp = [_]posix.pollfd{.{ .fd = fd, .events = posix.POLL.IN, .revents = 0 }};
        while (try posix.poll(&cp, 10_000) > 0) {
            const n = posix.read(fd, &sink) catch return;
            if (n == 0) return;
        }
    }

    /// srt の proxy と同じく half-close を通さない: どちらかの向きで EOF を
    /// 受け取ったら、両方の接続を閉じる。
    fn splice(a: posix.socket_t, b: posix.socket_t) !void {
        var buf: [16 * 1024]u8 = undefined;
        while (true) {
            var pfd = [_]posix.pollfd{
                .{ .fd = a, .events = posix.POLL.IN, .revents = 0 },
                .{ .fd = b, .events = posix.POLL.IN, .revents = 0 },
            };
            if (try posix.poll(&pfd, 5000) == 0) return;
            const ends = [2][2]posix.socket_t{ .{ a, b }, .{ b, a } };
            for (0..2) |i| {
                if (pfd[i].revents == 0) continue;
                const n = try posix.read(ends[i][0], &buf);
                if (n == 0) return;
                try writeAllBlocking(ends[i][1], buf[0..n]);
            }
        }
    }
};

fn writeAllBlocking(fd: posix.socket_t, bytes: []const u8) !void {
    var off: usize = 0;
    while (off < bytes.len) off += try posix.send(fd, bytes[off..], posix.MSG.NOSIGNAL);
}

fn expectStarred(input: []const u8, got: []const u8) !void {
    try testing.expectEqual(input.len, got.len);
    for (input, got) |i, g| try testing.expectEqual(if (i == 'x') @as(u8, '*') else i, g);
}

test "maskOnce: loopback TCP round-trips directly" {
    const l = try listenTcp();
    defer posix.close(l.fd);
    const server = try std.Thread.spawn(.{}, StarServer.run, .{ l.fd, StarServer.Mode.echo });
    defer server.join();

    const got = try maskOnce(testing.allocator, .{ .tcp = l.addr }, null, "axbxc");
    defer testing.allocator.free(got);
    try testing.expectEqualStrings("a*b*c", got);
}

test "maskOnce: a large input round-trips through a loopback CONNECT proxy" {
    const l = try listenTcp();
    defer posix.close(l.fd);
    const server = try std.Thread.spawn(.{}, StarServer.run, .{ l.fd, StarServer.Mode.echo });
    defer server.join();
    var proxy = try TestProxy.init(&.{.tunnel});
    defer proxy.deinit();
    const pt = try std.Thread.spawn(.{}, TestProxy.run, .{&proxy});
    defer pt.join();

    const input = try testing.allocator.alloc(u8, 1024 * 1024);
    defer testing.allocator.free(input);
    for (input, 0..) |*b, i| b.* = if (i % 3 == 0) 'x' else 'a';

    var url_buf: [64]u8 = undefined;
    const got = try maskOnce(testing.allocator, .{ .tcp = l.addr }, try proxy.url(&url_buf, ""), input);
    defer testing.allocator.free(got);
    try expectStarred(input, got);

    var want_buf: [128]u8 = undefined;
    const want = try std.fmt.bufPrint(&want_buf, "CONNECT 127.0.0.1:{d} HTTP/1.1\r\nHost: 127.0.0.1:{d}\r\n", .{ l.addr.getPort(), l.addr.getPort() });
    try testing.expect(std.mem.startsWith(u8, proxy.requestText(), want));
    // ユーザー情報の無い URL では認証ヘッダを付けない。
    try testing.expect(std.mem.indexOf(u8, proxy.requestText(), "Proxy-Authorization") == null);
}

test "Relay.connect: an IPv6 target is written in brackets on the CONNECT line" {
    var proxy = try TestProxy.init(&.{.{ .reply = "HTTP/1.1 403 Forbidden\r\n\r\n" }});
    defer proxy.deinit();
    const pt = try std.Thread.spawn(.{}, TestProxy.run, .{&proxy});
    var url_buf: [64]u8 = undefined;
    const target = try std.net.Address.parseIp6("::1", 4242);
    const res = Relay.connect(.{ .tcp = target }, try proxy.url(&url_buf, ""));
    pt.join();
    try testing.expectError(error.RelayConnectFailed, res);
    try testing.expect(std.mem.startsWith(u8, proxy.requestText(), "CONNECT [::1]:4242 HTTP/1.1\r\nHost: [::1]:4242\r\n"));
}

test "Relay.connect: a 403 from the proxy fails without retrying or going direct" {
    const l = try listenTcp();
    defer posix.close(l.fd);
    var proxy = try TestProxy.init(&.{.{ .reply = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n" }});
    defer proxy.deinit();
    const pt = try std.Thread.spawn(.{}, TestProxy.run, .{&proxy});

    var url_buf: [64]u8 = undefined;
    const started = std.time.milliTimestamp();
    const res = Relay.connect(.{ .tcp = l.addr }, try proxy.url(&url_buf, ""));
    const elapsed = std.time.milliTimestamp() - started;
    pt.join();
    try testing.expectError(error.RelayConnectFailed, res);
    try testing.expectEqual(@as(usize, 1), proxy.accepted);
    try expectNoPendingConnection(l.fd);
    // 再試行して 2 回目の接続が期限 (5 秒) で落ちたのではなく、
    // 403 を見て即座に断ったこと。
    try testing.expect(elapsed < 2000);
}

/// 1 回目の接続で `first` の動作をし、2 回目で 200 を返す proxy に対して、
/// 再試行して接続できることを確かめる。宛先へ直接はつながない。
fn expectProxyRetried(first: ProxyAction) !void {
    const l = try listenTcp();
    defer posix.close(l.fd);
    var proxy = try TestProxy.init(&.{ first, .{ .reply = "HTTP/1.1 200 Connection established\r\n\r\n" } });
    defer proxy.deinit();
    const pt = try std.Thread.spawn(.{}, TestProxy.run, .{&proxy});
    defer pt.join();

    var url_buf: [64]u8 = undefined;
    var relay = try Relay.connect(.{ .tcp = l.addr }, try proxy.url(&url_buf, ""));
    relay.deinit(testing.allocator);
    try testing.expectEqual(@as(usize, 2), proxy.accepted);
    try expectNoPendingConnection(l.fd);
}

// proxy が起動直後だったり、宛先へのつなぎ込みに一瞬失敗したりしただけの失敗は、
// 直接接続と同じく待てば通りうる。
test "Relay.connect: a proxy failure other than 403 is retried" {
    try expectProxyRetried(.{ .reply = "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n" });
    try expectProxyRetried(.close);
    // ヘッダが上限を越える、ヘッダの後ろにバイトがある、状態行が HTTP/1.x 200 でない。
    // どれも接続には使わないが、403 ではないので再試行する。
    try expectProxyRetried(.{ .reply = "HTTP/1.1 200 OK\r\nX-Pad: " ++ ("a" ** (9 * 1024)) });
    try expectProxyRetried(.{ .reply = "HTTP/1.1 200 OK\r\n\r\nunexpected" });
    try expectProxyRetried(.{ .reply = "HTTP/1.1 2000 OK\r\n\r\n" });
    try expectProxyRetried(.{ .reply = "HTTP/2 200\r\n\r\n" });
    try expectProxyRetried(.{ .reply = "ICY 200 OK\r\n\r\n" });
}

/// 期限を短くして proxy 経由でつなぎ、`action` の proxy が期限ちょうどで
/// 失敗させられることを確かめる。期限が切れたら再試行せず、直接もつながない。
fn expectProxyDeadline(action: ProxyAction) !void {
    const budget_ms: u64 = 600;
    const l = try listenTcp();
    defer posix.close(l.fd);
    var proxy = try TestProxy.init(&.{action});
    defer proxy.deinit();
    const pt = try std.Thread.spawn(.{}, TestProxy.run, .{&proxy});
    defer pt.join();

    const started = std.time.milliTimestamp();
    const res = connectViaProxy(proxy.addr, l.addr, null, budget_ms);
    const elapsed = std.time.milliTimestamp() - started;
    if (res) |fd| posix.close(fd) else |_| {}
    try testing.expectError(error.RelayConnectFailed, res);
    try testing.expect(elapsed >= budget_ms);
    // 1 回の read ごとの待ちではなく、接続処理全体で切れたこと。
    try testing.expect(elapsed < budget_ms + 1000);
    try testing.expectEqual(@as(usize, 1), proxy.accepted);
    try expectNoPendingConnection(l.fd);
    try expectNoPendingConnection(proxy.listener);
}

test "connectViaProxy: a proxy that accepts and never replies fails at the overall deadline" {
    try expectProxyDeadline(.silent);
}

test "connectViaProxy: a proxy that trickles its header fails at the overall deadline" {
    try expectProxyDeadline(.{ .trickle = 100 });
}

test "Relay.connect: a proxy that keeps failing gives up after the direct-connect attempt count" {
    const l = try listenTcp();
    defer posix.close(l.fd);
    const bad: ProxyAction = .{ .reply = "HTTP/1.1 502 Bad Gateway\r\n\r\n" };
    var proxy = try TestProxy.init(&([_]ProxyAction{bad} ** CONNECT_ATTEMPTS));
    defer proxy.deinit();
    const pt = try std.Thread.spawn(.{}, TestProxy.run, .{&proxy});

    var url_buf: [64]u8 = undefined;
    const res = Relay.connect(.{ .tcp = l.addr }, try proxy.url(&url_buf, ""));
    pt.join();
    try testing.expectError(error.RelayConnectFailed, res);
    try testing.expectEqual(CONNECT_ATTEMPTS, proxy.accepted);
    // 再試行し尽くしても宛先へ直接はつながない。
    try expectNoPendingConnection(l.fd);
    // それ以上は proxy にもつながない。
    try expectNoPendingConnection(proxy.listener);
}

test "Relay.connect: HTTP/1.0 200 from the proxy is accepted" {
    const l = try listenTcp();
    defer posix.close(l.fd);
    var proxy = try TestProxy.init(&.{.{ .reply = "HTTP/1.0 200 Connection established\r\n\r\n" }});
    defer proxy.deinit();
    const pt = try std.Thread.spawn(.{}, TestProxy.run, .{&proxy});
    defer pt.join();
    var url_buf: [64]u8 = undefined;
    var relay = try Relay.connect(.{ .tcp = l.addr }, try proxy.url(&url_buf, ""));
    relay.deinit(testing.allocator);
}

/// URL に `userinfo` (末尾の `@` を含む) を付けて接続し、`credential` の base64 が
/// Proxy-Authorization に載ることを確かめる。
fn expectProxyAuthorization(userinfo: []const u8, credential: []const u8) !void {
    const l = try listenTcp();
    defer posix.close(l.fd);
    var proxy = try TestProxy.init(&.{.{ .reply = "HTTP/1.1 200 OK\r\n\r\n" }});
    defer proxy.deinit();
    const pt = try std.Thread.spawn(.{}, TestProxy.run, .{&proxy});
    defer pt.join();

    var url_buf: [96]u8 = undefined;
    var relay = try Relay.connect(.{ .tcp = l.addr }, try proxy.url(&url_buf, userinfo));
    relay.deinit(testing.allocator);

    var b64: [64]u8 = undefined;
    const enc = std.base64.standard.Encoder.encode(&b64, credential);
    var want_buf: [128]u8 = undefined;
    const want = try std.fmt.bufPrint(&want_buf, "\r\nProxy-Authorization: Basic {s}\r\n", .{enc});
    try testing.expect(std.mem.indexOf(u8, proxy.requestText(), want) != null);
}

test "Relay.connect: userinfo in the proxy URL becomes Proxy-Authorization" {
    // パスワード中の `@` はパーセントエンコードで渡される。デコードしてから base64 にする。
    try expectProxyAuthorization("srt:p%40ss:w@", "srt:p@ss:w");
}

// Basic 認証の資格情報は `user-id ":" password` で、`:` は省けない (RFC 7617)。
test "Relay.connect: userinfo without a colon is sent as user with an empty password" {
    try expectProxyAuthorization("srt@", "srt:");
}

test "Relay.connect: a non-loopback or non-http proxy is ignored and the target is dialed directly" {
    const l = try listenTcp();
    defer posix.close(l.fd);
    var https_buf: [64]u8 = undefined;
    const https = try std.fmt.bufPrint(&https_buf, "https://127.0.0.1:{d}", .{l.addr.getPort()});
    const proxies = [_][]const u8{ "http://10.0.0.1:3128", https, "socks5://127.0.0.1:1080", "http://localhost.evil:1", "http://127.0.0.1.nip.io:1" };
    for (proxies) |p| {
        var relay = try Relay.connect(.{ .tcp = l.addr }, p);
        defer relay.deinit(testing.allocator);
        const peer = try posix.accept(l.fd, null, null, posix.SOCK.CLOEXEC);
        posix.close(peer);
    }
}

test "Relay.connect: a malformed loopback proxy URL fails instead of going direct" {
    const bad = [_][]const u8{
        "http://127.0.0.1:x",
        "http://127.0.0.1:",
        "http://127.0.0.1:0",
        "http://127.0.0.1:99999",
        "http://127.0.0.1:3128x",
        "http://[::1]x:1",
        "http://[::1]:",
        "http://localhost:1a",
        "http://u:%zz@127.0.0.1:1",
        "http://u:%4@127.0.0.1:1",
        "http://" ++ ("u" ** (MAX_PROXY_USERINFO + 1)) ++ "@127.0.0.1:1",
    };
    // 経路の判定で弾かれること (接続を試してから失敗したのではないこと)。
    for (bad) |p| try testing.expectError(error.RelayConnectFailed, routeFor(p));

    // Relay.connect でも、宛先へ直接つなぎに行かない。
    const l = try listenTcp();
    defer posix.close(l.fd);
    for (bad) |p| {
        try testing.expectError(error.RelayConnectFailed, Relay.connect(.{ .tcp = l.addr }, p));
    }
    try expectNoPendingConnection(l.fd);
}

test "routeFor: loopback http proxies are used" {
    const cases = [_]struct { url: []const u8, port: u16, family: posix.sa_family_t }{
        .{ .url = "http://127.0.0.1:3128", .port = 3128, .family = posix.AF.INET },
        .{ .url = "http://127.0.0.1:3128/", .port = 3128, .family = posix.AF.INET },
        .{ .url = "http://localhost:8080", .port = 8080, .family = posix.AF.INET },
        .{ .url = "HTTP://LocalHost:8080", .port = 8080, .family = posix.AF.INET },
        .{ .url = "http://[::1]:9000", .port = 9000, .family = posix.AF.INET6 },
        .{ .url = "http://127.0.0.1", .port = 80, .family = posix.AF.INET },
        .{ .url = "http://[::1]", .port = 80, .family = posix.AF.INET6 },
        .{ .url = "http://u:p@[::1]:7/x?y", .port = 7, .family = posix.AF.INET6 },
        .{ .url = "http://a:b@127.0.0.1:1", .port = 1, .family = posix.AF.INET },
    };
    for (cases) |c| {
        const r = try routeFor(c.url);
        try testing.expect(r == .connect);
        try testing.expectEqual(c.port, r.connect.addr.getPort());
        try testing.expectEqual(c.family, r.connect.addr.any.family);
    }
    try testing.expect(try routeFor(null) == .direct);
    try testing.expect(try routeFor("") == .direct);
    try testing.expect(try routeFor("http://[::2]:1") == .direct);
    try testing.expect(try routeFor("http://127.0.0.1@10.0.0.1:1") == .direct);
}

fn fakeEnv(name: []const u8) ?[]const u8 {
    if (std.mem.eql(u8, name, "HTTPS_PROXY")) return "";
    if (std.mem.eql(u8, name, "https_proxy")) return null;
    if (std.mem.eql(u8, name, "HTTP_PROXY")) return "http://127.0.0.1:1";
    if (std.mem.eql(u8, name, "http_proxy")) return "http://127.0.0.1:2";
    return null;
}

fn fakeEnvHttps(name: []const u8) ?[]const u8 {
    if (std.mem.eql(u8, name, "HTTPS_PROXY")) return "http://127.0.0.1:3";
    return "http://127.0.0.1:4";
}

fn emptyEnv(_: []const u8) ?[]const u8 {
    return null;
}

test "selectProxy: the first non-empty variable wins, in HTTPS_PROXY > https_proxy > HTTP_PROXY > http_proxy order" {
    try testing.expectEqualStrings("http://127.0.0.1:1", selectProxy(fakeEnv).?);
    try testing.expectEqualStrings("http://127.0.0.1:3", selectProxy(fakeEnvHttps).?);
    try testing.expect(selectProxy(emptyEnv) == null);
}
