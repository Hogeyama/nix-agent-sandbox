//! supervise モード: 子プロセスを fork/exec し、その stdout/stderr を
//! ホスト側ブローカー (`--serve`) へ中継してマスク済みバイトを書き戻す。
//!
//! なぜフィルタを「親」にするのか
//! -----------------------------
//! 以前は bash ラッパーが
//!
//!     exec > >("$NAS_MASK_FILTER") 2> >("$NAS_MASK_FILTER" >&2)
//!     exec -a "$0" bash.real "$@"
//!
//! のようにプロセス置換でフィルタを噛ませていた。この形にはデータ欠落のバグがある:
//! bash はプロセス置換の子を wait しないうえ、2 行目の exec で自分自身を置き換えて
//! しまうため、フィルタの終了を待てるプロセスが 1 つも残らない。フィルタは出力先の
//! パイプを握ったまま bash より長く生き残るので、「bash の終了」を完了シグナルに
//! している呼び出し元 (Claude Code の Bash ツール等) からは、まだフィルタ内に
//! 滞留しているデータが丸ごと失われて見える。実測では bash 終了時点で 1 バイトも
//! 届いていないことがあり、同じコマンドが成功したり無出力になったりした。
//!
//! supervise モードではフィルタ自身が親になり、パイプを drain し切ってから
//! 子の終了ステータスで exit する。出力を保持しているプロセスがそのまま
//! 呼び出し元の子プロセスなので、この競合が原理的に起きない。
//!
//! なぜローカルでマスクせず中継するのか
//! ------------------------------------
//! 以前はシークレットフレームをコンテナに bind mount し、ここでローカルに
//! マスクしていた。これはエージェントに「そのセッションの全シークレットの一覧」を
//! 可読ファイルとして渡すのと同じで、security-constraints の C1 / S1 に反する。
//! いまはフレームをホストに残したまま、生バイトを Unix socket 経由でホスト側の
//! ブローカーへ送り、マスク済みバイトを受け取って出力先へ書く。したがって
//! **このモードは NAS_MASK_SECRETS_FILE を必要としない**。
//!
//! fail-closed
//! -----------
//! マスクされたか確信できないバイトは 1 バイトも出さない。接続できない、
//! 途中でブローカーが死んだ、socket への書き込みが失敗した — いずれの場合も
//! 出力を捨てて 121 (= 出力抑止) で終了する。「エラー時は素通し」は無い。
//!
//! 終了判定の 3 段階
//! -----------------
//! 子のパイプが EOF になっただけでは終われない (サーバが保持中の末尾をまだ
//! 返していない) が、EOF を無条件に待つこともできない (fd を引き継いだ
//! バックグラウンドプロセスがパイプを掴んだままだと EOF が来ない)。
//!
//!   phase 1 (子が生存中): パイプ・self-pipe・生きているリレーを無期限に poll。
//!   phase 2 (子が終了済み): 同じ poll 集合を DRAIN_IDLE_MS で回し、
//!            アイドルになったパイプを done とみなす。
//!   phase 3 (両パイプ done): パイプの poll をやめ、送信キューを吐き切って
//!            half-close し、SOCKET_DRAIN_MS の**別の**期限で両リレーの EOF を待つ。
//!
//! phase 2 と phase 3 で期限を共有してはならない。少し混んだサーバの応答待ちが
//! 「もう出力は無い」と誤判定されて末尾が切れる。

const std = @import("std");
const posix = std.posix;
const relay_mod = @import("relay.zig");

const Relay = relay_mod.Relay;
const CHUNK_SIZE = relay_mod.CHUNK_SIZE;

/// 子プロセスの終了を検知した後、パイプに追加データを待つアイドル時間 (ms)。
///
/// 子が exit するまでに書いたデータはカーネルのパイプバッファに入っているので、
/// 終了後でも即座に読み出せる。この猶予を超えて無音になったら、まだパイプの
/// 書き込み端を握っているのは fd を引き継いで生き残ったバックグラウンドプロセス
/// (`cmd &` など) だけとみなして終了する。EOF を無条件に待つとそうしたケースで
/// スーパーバイザが居座り、呼び出し元がハングしてしまう。
const DRAIN_IDLE_MS: i32 = 100;

/// half-close 後、リレーが EOF に達するのを待つ**無進捗**許容時間 (ms)。
///
/// DRAIN_IDLE_MS と共有してはならない。パイプ側の 100ms は「バックグラウンド
/// プロセスがパイプを握っている」を検出するための短い猶予だが、socket 側は
/// 「サーバが保持中の末尾を返してくる」のを待つ経路で、少し混んだだけの
/// サーバを「もう出力は無い」と誤判定すると末尾が黙って切れる。
///
/// 期限は進捗 (1 バイトでも読めた / 書けた) のたびに引き直す。絶対期限にすると
/// ホストが混んでいるだけで大きな末尾の転送が途中で 121 になる。
const SOCKET_DRAIN_MS: i64 = 5000;

/// 1 リレーあたりの送信キュー上限。これを超えたらそのストリームのパイプを
/// poll 集合から外し、パイプバッファ経由で子へ背圧をかける。
/// 外さないとパイプを永久に読み続け、背圧の連鎖が存在しないことになる。
const RELAY_MAX_PENDING: usize = 256 * 1024;

/// exec に失敗したときの終了コード (POSIX シェル互換)。
const EXIT_EXEC_FAILED: u8 = 127;

/// 入れ子の supervise を抑止するためのマーカー。子に渡し、bash ラッパーは
/// これが設定済みなら supervisor を挟まず素の bash を exec する。
///
/// コンテナ内の bash はすべてラッパーなので、抑止しないと ./configure や
/// make の各レシピ行、再帰 make、npm/cargo のビルドスクリプトのたびに層が
/// 積み上がる。接続数は「数シェル」ではなく生存 bash プロセス数に比例し、
/// 深さのぶんだけ全バイトがコンテナとホストの間を往復して保持遅延も積み上がる。
///
/// 抑止してもカバレッジは減らない。子孫はすべて最外周 supervisor のパイプを
/// 継承するので出力は既にマスクされており、最外周から逃げる出力 (ファイルへの
/// リダイレクト、/dev/tty への書き込み) は内側の層からも同様に逃げる。
const SUPERVISED_ENTRY: [*:0]const u8 = "NAS_MASK_SUPERVISED=1";
const SUPERVISED_PREFIX = "NAS_MASK_SUPERVISED=";

/// 子へ渡す環境を組み立てる。**fork の前に**呼ぶこと (子ではアロケートしない)。
///
/// 既存の `NAS_MASK_SUPERVISED=` は追加ではなく**置換**する。append すると
/// 同名の重複エントリが残り、どちらが効くかは getenv の実装依存になる。
fn buildChildEnvp(
    allocator: std.mem.Allocator,
    environ: [*:null]?[*:0]u8,
) ![:null]?[*:0]const u8 {
    var n: usize = 0;
    while (environ[n] != null) : (n += 1) {}

    var replace_at: ?usize = null;
    var i: usize = 0;
    while (i < n) : (i += 1) {
        if (std.mem.startsWith(u8, std.mem.span(environ[i].?), SUPERVISED_PREFIX)) {
            replace_at = i;
            break;
        }
    }

    const envp = try allocator.allocSentinel(?[*:0]const u8, if (replace_at == null) n + 1 else n, null);
    i = 0;
    while (i < n) : (i += 1) envp[i] = environ[i].?;
    envp[replace_at orelse n] = SUPERVISED_ENTRY;
    return envp;
}

var g_child_pid: std.atomic.Value(i32) = .init(0);
var g_sig_write_fd: std.atomic.Value(i32) = .init(-1);

/// SIGCHLD ハンドラ。self-pipe に 1 バイト書いて poll(2) を起こすだけ。
fn onSigChld(_: i32) callconv(.c) void {
    const fd = g_sig_write_fd.load(.monotonic);
    if (fd < 0) return;
    const byte: [1]u8 = .{0};
    _ = std.c.write(fd, &byte, 1);
}

/// 終了系シグナルを子へ転送する。呼び出し元がスーパーバイザの pid だけを狙って
/// kill した場合でも子に伝わるようにするため。自分自身は死なずに drain を続ける。
///
/// 端末由来の SIGINT などはプロセスグループ全体に配送されるので子は既に
/// 受け取っており、この転送で二重配送になるが、シェルにとっては無害。
fn onForwardSig(sig: i32) callconv(.c) void {
    const pid = g_child_pid.load(.monotonic);
    if (pid > 0) _ = std.c.kill(pid, sig);
}

fn installHandler(sig: u6, comptime handler: *const fn (i32) callconv(.c) void) void {
    const act: posix.Sigaction = .{
        .handler = .{ .handler = handler },
        .mask = posix.sigemptyset(),
        .flags = posix.SA.RESTART,
    };
    posix.sigaction(sig, &act, null);
}

fn setDisposition(sig: u6, handler: ?posix.Sigaction.handler_fn) void {
    const act: posix.Sigaction = .{
        .handler = .{ .handler = handler },
        .mask = posix.sigemptyset(),
        .flags = 0,
    };
    posix.sigaction(sig, &act, null);
}

/// exec 前の子で既定へ戻すシグナル。SIGPIPE は特に重要で、親が SIG_IGN に
/// している無視状態は execve を越えて継承されるため、戻さないと `yes | head`
/// のような子側のパイプ終了が壊れる。
const CHILD_RESET_SIGNALS = [_]u6{
    posix.SIG.CHLD,
    posix.SIG.INT,
    posix.SIG.TERM,
    posix.SIG.HUP,
    posix.SIG.QUIT,
    posix.SIG.PIPE,
};

/// 子の 1 本のパイプと、それに対応するブローカーへのリレー。
const Stream = struct {
    /// 子の stdout / stderr パイプの読み出し端。
    pipe_fd: posix.fd_t,
    /// マスク済みバイトの出力先 (スーパーバイザ本来の stdout / stderr)。
    dst_fd: posix.fd_t,
    /// このストリーム専用のブローカー接続。所有者は `run` のローカル変数で、
    /// Stream は借りているだけ (値で持つとキューの更新が反映されない)。
    relay: *Relay,
    /// パイプをこれ以上読まない (EOF、またはアイドル打ち切り)。
    pipe_done: bool = false,

    /// パイプを POLLIN で張るか。送信キューが上限に達している間は張らない
    /// (張り続けるとパイプを永久に読み込み、背圧の連鎖が存在しなくなる)。
    fn wantsPipeRead(self: *const Stream) bool {
        return !self.pipe_done and self.relay.pendingLen() < RELAY_MAX_PENDING;
    }

    fn relayEvents(self: *const Stream) i16 {
        var events: i16 = posix.POLL.IN;
        // 吐き残しがある限り POLLOUT を張り続ける。phase 3 で外すと、
        // 吐き切れていないキューが二度と吐けなくなる。
        if (self.relay.pendingLen() > 0) events |= posix.POLL.OUT;
        return events;
    }

    fn done(self: *const Stream) bool {
        return self.relay.read_eof;
    }
};

/// poll が readable を報告したパイプを 1 回読み、リレーの送信キューへ積む。
fn drainPipeOnce(gpa: std.mem.Allocator, s: *Stream, buf: []u8) !void {
    const n = posix.read(s.pipe_fd, buf) catch |err| switch (err) {
        error.WouldBlock => return,
        // 子が pty を持たない等で読めなくなった場合は EOF 扱いにする。
        else => {
            s.pipe_done = true;
            return;
        },
    };
    if (n == 0) {
        s.pipe_done = true;
        return;
    }
    try s.relay.queueWrite(gpa, buf[0..n]);
}

/// waitpid(2) のステータスをシェル互換の終了コードへ変換する。
pub fn exitCodeFromStatus(status: u32) u8 {
    if (posix.W.IFEXITED(status)) return @truncate(posix.W.EXITSTATUS(status));
    if (posix.W.IFSIGNALED(status)) return @truncate(128 +% @as(u32, posix.W.TERMSIG(status)));
    return 1;
}

/// program を argv0/args で起動し、その出力を sock_path のブローカー経由で
/// マスクして中継する。戻り値は子の終了ステータスに対応する終了コード。
///
/// リレーは **fork の前に** 2 本とも張る。どちらか一方でも張れなければ子を
/// 起動せずにエラーを返す (起動してしまうと、マスクできない出力を持つ
/// プロセスが動き出す)。
pub fn run(
    allocator: std.mem.Allocator,
    sock_path: []const u8,
    argv0: []const u8,
    program: []const u8,
    args: []const []const u8,
) !u8 {
    // exec 用の引数は fork 前に用意する (fork 後の子でアロケートしない)。
    const program_z = try allocator.dupeZ(u8, program);
    const argv_z = try allocator.allocSentinel(?[*:0]const u8, args.len + 1, null);
    argv_z[0] = (try allocator.dupeZ(u8, argv0)).ptr;
    for (args, 0..) |arg, i| {
        argv_z[i + 1] = (try allocator.dupeZ(u8, arg)).ptr;
    }
    const envp_z = try buildChildEnvp(allocator, std.c.environ);

    // socket / 出力先 fd への write が EPIPE を返す前にプロセスが死なないよう、
    // SIGPIPE を無視する。無視しないと fail-closed の 121 に到達できず、
    // シグナル終了 (141) になってしまう。
    setDisposition(posix.SIG.PIPE, posix.SIG.IGN);

    var out_relay = try Relay.connect(sock_path);
    var err_relay = Relay.connect(sock_path) catch |err| {
        out_relay.deinit(allocator);
        return err;
    };
    defer out_relay.deinit(allocator);
    defer err_relay.deinit(allocator);

    // SIGCHLD 通知用 self-pipe。ハンドラ内から書くので NONBLOCK にしておく。
    const sig_pipe = try posix.pipe2(.{ .NONBLOCK = true });
    g_sig_write_fd.store(sig_pipe[1], .monotonic);
    installHandler(posix.SIG.CHLD, onSigChld);
    for ([_]u6{ posix.SIG.INT, posix.SIG.TERM, posix.SIG.HUP, posix.SIG.QUIT }) |sig| {
        installHandler(sig, onForwardSig);
    }

    const out_pipe = try posix.pipe();
    const err_pipe = try posix.pipe();

    const pid = try posix.fork();
    if (pid == 0) {
        // --- 子プロセス ---
        // シグナルハンドラは execve でリセットされるが、SIG_IGN の無視状態は
        // 継承されるうえ、exec 自体に失敗した場合にも備えて明示的に既定へ戻す。
        for (CHILD_RESET_SIGNALS) |sig| setDisposition(sig, posix.SIG.DFL);
        posix.dup2(out_pipe[1], posix.STDOUT_FILENO) catch posix.exit(EXIT_EXEC_FAILED);
        posix.dup2(err_pipe[1], posix.STDERR_FILENO) catch posix.exit(EXIT_EXEC_FAILED);
        // socket fd は CLOEXEC で作ってあるが、明示的にも閉じる。子へ漏れると
        // 注入オラクルになる: ストリーム途中に 1 バイト差し込むとサーバ側の
        // マッチが崩れて原文が返るため、差し込んだ値を知っていれば原文を
        // 復元できてしまう (単なる情報漏れでは済まない)。
        const child_close = [_]posix.fd_t{
            out_pipe[0], out_pipe[1], err_pipe[0],  err_pipe[1],
            sig_pipe[0], sig_pipe[1], out_relay.fd, err_relay.fd,
        };
        for (child_close) |fd| {
            if (fd > posix.STDERR_FILENO) posix.close(fd);
        }
        const err = posix.execveZ(program_z, argv_z.ptr, envp_z.ptr);
        // 子の stderr は既にパイプ (= マスク経路) なので、この診断は
        // マスクを通ってから出る。program はエージェントが与えた文字列で
        // シークレット由来ではない。
        std.debug.print("nas-mask-filter: exec {s} failed: {}\n", .{ program, err });
        posix.exit(EXIT_EXEC_FAILED);
    }

    // --- 親プロセス (スーパーバイザ) ---
    g_child_pid.store(pid, .monotonic);
    // 出力を捨てて抜けるときに、マスクされない出力を持ったまま走り続ける
    // プロセスを残さない。
    errdefer _ = std.c.kill(pid, posix.SIG.KILL);
    // 書き込み端は子だけが持つ。親が握ったままだと EOF が来ない。
    posix.close(out_pipe[1]);
    posix.close(err_pipe[1]);

    var streams = [2]Stream{
        .{ .pipe_fd = out_pipe[0], .dst_fd = posix.STDOUT_FILENO, .relay = &out_relay },
        .{ .pipe_fd = err_pipe[0], .dst_fd = posix.STDERR_FILENO, .relay = &err_relay },
    };

    const scratch = try allocator.alloc(u8, CHUNK_SIZE);
    defer allocator.free(scratch);

    var child_status: ?u32 = null;
    var drain_deadline: ?i64 = null;

    while (!streams[0].done() or !streams[1].done()) {
        // パイプを読み切っていて送信キューも空になったストリームだけ half-close
        // する。キューが残っているうちに shutdown(SHUT_WR) すると、その後の
        // write が EPIPE になって全出力を捨てることになる (子が 0 で終わって
        // いても 121)。
        for (&streams) |*s| {
            if (s.pipe_done and s.relay.pendingLen() == 0) try s.relay.halfClose();
        }

        const pipes_all_done = streams[0].pipe_done and streams[1].pipe_done;

        var fds: [5]posix.pollfd = undefined;
        var n_fds: usize = 0;
        var pipe_idx: [2]?usize = .{ null, null };
        var relay_idx: [2]?usize = .{ null, null };

        for (&streams, 0..) |*s, i| {
            if (s.wantsPipeRead()) {
                fds[n_fds] = .{ .fd = s.pipe_fd, .events = posix.POLL.IN, .revents = 0 };
                pipe_idx[i] = n_fds;
                n_fds += 1;
            }
            // EOF を報告したリレーは poll 集合から外す。サーバが close した
            // socket は恒久的に POLLIN|POLLHUP なので、張ったままだと
            // もう一方のストリームが走っている間ずっとホスト CPU を回す。
            if (!s.relay.read_eof) {
                fds[n_fds] = .{ .fd = s.relay.fd, .events = s.relayEvents(), .revents = 0 };
                relay_idx[i] = n_fds;
                n_fds += 1;
            }
        }
        var sig_idx: ?usize = null;
        if (child_status == null) {
            fds[n_fds] = .{ .fd = sig_pipe[0], .events = posix.POLL.IN, .revents = 0 };
            sig_idx = n_fds;
            n_fds += 1;
        }

        const timeout: i32 = blk: {
            if (!pipes_all_done) {
                // phase 1 / phase 2。
                break :blk if (child_status == null) -1 else DRAIN_IDLE_MS;
            }
            // phase 3。パイプはもう読まないので、socket 側だけを別期限で待つ。
            const now = std.time.milliTimestamp();
            const deadline = drain_deadline orelse d: {
                const v = now + SOCKET_DRAIN_MS;
                drain_deadline = v;
                break :d v;
            };
            if (now >= deadline) return error.RelayDrainTimeout;
            break :blk @intCast(@min(deadline - now, SOCKET_DRAIN_MS));
        };

        const ready = try posix.poll(fds[0..n_fds], timeout);

        var progress = false;

        // 先に socket を読む。書くだけで読まないと双方の socket バッファが
        // 埋まって両側が止まる。
        for (&streams, 0..) |*s, i| {
            const idx = relay_idx[i] orelse continue;
            const revents = fds[idx].revents;
            if (revents == 0) continue;
            if (revents & (posix.POLL.ERR | posix.POLL.NVAL) != 0) return error.RelayFailed;
            if (revents & (posix.POLL.IN | posix.POLL.HUP) != 0) {
                if (try s.relay.pumpReadable(s.dst_fd, scratch) > 0) progress = true;
                if (s.relay.read_eof) {
                    // half-close 前にサーバが閉じたのは「完了」ではなく
                    // 切り捨て。接続数上限を超えた接続はサーバが accept して
                    // 即 close するので、この経路が fail-closed の要になる。
                    if (!s.relay.write_closed) return error.RelayClosedEarly;
                    progress = true;
                }
            }
            if (!s.relay.read_eof and revents & posix.POLL.OUT != 0) {
                const before = s.relay.pendingLen();
                try s.relay.pumpWritable();
                if (s.relay.pendingLen() != before) progress = true;
            }
        }

        for (&streams, 0..) |*s, i| {
            const idx = pipe_idx[i] orelse continue;
            if (fds[idx].revents != 0) try drainPipeOnce(allocator, s, scratch);
        }

        // パイプのアイドル打ち切り (phase 2)。判定は「POLLIN を張ったのに
        // 発火しなかった」であって「poll が 0 を返した」ではない。背圧で
        // poll 集合から外れているパイプは常に発火しないので、後者で判定すると
        // 未読のまま数 MB を捨てて exit 0 を返してしまう。
        if (ready == 0 and child_status != null) {
            for (&streams, 0..) |*s, i| {
                if (pipe_idx[i] != null) s.pipe_done = true;
            }
        }

        if (sig_idx) |idx| {
            if (fds[idx].revents != 0) {
                var sink: [64]u8 = undefined;
                _ = posix.read(sig_pipe[0], &sink) catch {};
                const res = posix.waitpid(pid, posix.W.NOHANG);
                if (res.pid == pid) child_status = res.status;
            }
        }

        if (pipes_all_done and progress) drain_deadline = null;
    }

    const status = child_status orelse posix.waitpid(pid, 0).status;
    return exitCodeFromStatus(status);
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

const testing = std.testing;

test "exitCodeFromStatus: normal exit" {
    // WIFEXITED: 下位 7 bit が 0、終了コードは 8..16 bit。
    try testing.expectEqual(@as(u8, 0), exitCodeFromStatus(0x0000));
    try testing.expectEqual(@as(u8, 3), exitCodeFromStatus(0x0300));
    try testing.expectEqual(@as(u8, 127), exitCodeFromStatus(0x7f00));
}

test "buildChildEnvp: appends the marker when absent" {
    var environ = [_:null]?[*:0]u8{ @constCast("A=1"), @constCast("B=2") };
    const envp = try buildChildEnvp(testing.allocator, &environ);
    defer testing.allocator.free(envp);

    try testing.expectEqual(@as(usize, 3), envp.len);
    try testing.expectEqualStrings("A=1", std.mem.span(envp[0].?));
    try testing.expectEqualStrings("B=2", std.mem.span(envp[1].?));
    try testing.expectEqualStrings("NAS_MASK_SUPERVISED=1", std.mem.span(envp[2].?));
}

// append すると同名エントリが 2 つ残り、どちらが効くかは getenv 依存になる。
test "buildChildEnvp: replaces an existing marker instead of appending" {
    var environ = [_:null]?[*:0]u8{
        @constCast("A=1"),
        @constCast("NAS_MASK_SUPERVISED=0"),
        @constCast("B=2"),
    };
    const envp = try buildChildEnvp(testing.allocator, &environ);
    defer testing.allocator.free(envp);

    try testing.expectEqual(@as(usize, 3), envp.len);
    try testing.expectEqualStrings("A=1", std.mem.span(envp[0].?));
    try testing.expectEqualStrings("NAS_MASK_SUPERVISED=1", std.mem.span(envp[1].?));
    try testing.expectEqualStrings("B=2", std.mem.span(envp[2].?));
}

test "exitCodeFromStatus: killed by signal maps to 128+signo" {
    // WIFSIGNALED: 下位 7 bit が終了シグナル (0 でも 0x7f でもない)。
    try testing.expectEqual(@as(u8, 128 + 2), exitCodeFromStatus(2)); // SIGINT
    try testing.expectEqual(@as(u8, 128 + 15), exitCodeFromStatus(15)); // SIGTERM
    try testing.expectEqual(@as(u8, 128 + 9), exitCodeFromStatus(9)); // SIGKILL
}
