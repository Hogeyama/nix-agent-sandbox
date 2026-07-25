//! supervise モード: 子プロセスを fork/exec し、その stdout/stderr を
//! マスクしながら中継する。
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

const std = @import("std");
const posix = std.posix;
const mask_stream = @import("mask_stream.zig");

/// 子プロセスの終了を検知した後、追加データを待つアイドル時間 (ms)。
///
/// 子が exit するまでに書いたデータはカーネルのパイプバッファに入っているので、
/// 終了後でも即座に読み出せる。この猶予を超えて無音になったら、まだパイプの
/// 書き込み端を握っているのは fd を引き継いで生き残ったバックグラウンドプロセス
/// (`cmd &` など) だけとみなして終了する。EOF を無条件に待つとそうしたケースで
/// スーパーバイザが居座り、呼び出し元がハングしてしまう。
const DRAIN_IDLE_MS: i32 = 100;

/// exec に失敗したときの終了コード (POSIX シェル互換)。
const EXIT_EXEC_FAILED: u8 = 127;

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

fn resetHandler(sig: u6) void {
    const act: posix.Sigaction = .{
        .handler = .{ .handler = posix.SIG.DFL },
        .mask = posix.sigemptyset(),
        .flags = 0,
    };
    posix.sigaction(sig, &act, null);
}

/// 出力先 fd への無バッファ writer。
///
/// バッファリングすると対話シェルのプロンプトが出るまで遅延するため、
/// MaskStream が出せると判断したバイトはその場で write(2) する。
/// 出力先が既に閉じられている場合に中断しても報告先がないので、
/// 書き込みエラーは黙って捨てる (子をブロックさせないことを優先する)。
const FdWriter = struct {
    fd: posix.fd_t,

    pub fn writeAll(self: FdWriter, bytes: []const u8) error{}!void {
        var i: usize = 0;
        while (i < bytes.len) {
            const n = posix.write(self.fd, bytes[i..]) catch return;
            if (n == 0) return;
            i += n;
        }
    }
};

/// 1 本のパイプ (子の stdout または stderr) を読み、マスクして出力先へ流す。
const Pump = struct {
    src: posix.fd_t,
    dst: FdWriter,
    stream: mask_stream.MaskStream,
    eof: bool = false,

    fn init(
        allocator: std.mem.Allocator,
        src: posix.fd_t,
        dst_fd: posix.fd_t,
        secrets: []const []const u8,
    ) !Pump {
        return .{
            .src = src,
            .dst = .{ .fd = dst_fd },
            .stream = try mask_stream.MaskStream.init(allocator, secrets),
        };
    }

    fn deinit(self: *Pump, allocator: std.mem.Allocator) void {
        self.stream.deinit(allocator);
    }

    /// poll(2) が readable を報告した後に 1 回だけ read して処理する。
    fn drainOnce(self: *Pump) !void {
        const n = posix.read(self.src, self.stream.readBuf()) catch |err| switch (err) {
            error.WouldBlock => return,
            // 子が pty を持たない等で読めなくなった場合は EOF 扱いにする。
            else => {
                self.eof = true;
                try self.stream.finish(self.dst);
                return;
            },
        };
        if (n == 0) {
            self.eof = true;
            try self.stream.finish(self.dst);
            return;
        }
        try self.stream.push(n, self.dst);
    }
};

/// waitpid(2) のステータスをシェル互換の終了コードへ変換する。
pub fn exitCodeFromStatus(status: u32) u8 {
    if (posix.W.IFEXITED(status)) return @truncate(posix.W.EXITSTATUS(status));
    if (posix.W.IFSIGNALED(status)) return @truncate(128 +% @as(u32, posix.W.TERMSIG(status)));
    return 1;
}

/// program を argv0/args で起動し、その出力をマスクしながら中継する。
/// 戻り値は子の終了ステータスに対応する終了コード。
pub fn run(
    allocator: std.mem.Allocator,
    secrets: []const []const u8,
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
        // シグナルハンドラは execve でリセットされるが、exec 自体に失敗した場合に
        // 備えて明示的に既定へ戻す (SIG_IGN と違い継承事故は起きないが、念のため)。
        for ([_]u6{ posix.SIG.CHLD, posix.SIG.INT, posix.SIG.TERM, posix.SIG.HUP, posix.SIG.QUIT }) |sig| {
            resetHandler(sig);
        }
        posix.dup2(out_pipe[1], posix.STDOUT_FILENO) catch posix.exit(EXIT_EXEC_FAILED);
        posix.dup2(err_pipe[1], posix.STDERR_FILENO) catch posix.exit(EXIT_EXEC_FAILED);
        for ([_]posix.fd_t{ out_pipe[0], out_pipe[1], err_pipe[0], err_pipe[1], sig_pipe[0], sig_pipe[1] }) |fd| {
            if (fd > posix.STDERR_FILENO) posix.close(fd);
        }
        const err = posix.execveZ(program_z, argv_z.ptr, @ptrCast(std.c.environ));
        std.debug.print("nas-mask-filter: exec {s} failed: {}\n", .{ program, err });
        posix.exit(EXIT_EXEC_FAILED);
    }

    // --- 親プロセス (スーパーバイザ) ---
    g_child_pid.store(pid, .monotonic);
    // 書き込み端は子だけが持つ。親が握ったままだと EOF が来ない。
    posix.close(out_pipe[1]);
    posix.close(err_pipe[1]);

    var out_pump = try Pump.init(allocator, out_pipe[0], posix.STDOUT_FILENO, secrets);
    defer out_pump.deinit(allocator);
    var err_pump = try Pump.init(allocator, err_pipe[0], posix.STDERR_FILENO, secrets);
    defer err_pump.deinit(allocator);

    var child_status: ?u32 = null;

    while (!out_pump.eof or !err_pump.eof) {
        var fds: [3]posix.pollfd = undefined;
        var n_fds: usize = 0;
        var out_idx: ?usize = null;
        var err_idx: ?usize = null;

        if (!out_pump.eof) {
            fds[n_fds] = .{ .fd = out_pump.src, .events = posix.POLL.IN, .revents = 0 };
            out_idx = n_fds;
            n_fds += 1;
        }
        if (!err_pump.eof) {
            fds[n_fds] = .{ .fd = err_pump.src, .events = posix.POLL.IN, .revents = 0 };
            err_idx = n_fds;
            n_fds += 1;
        }
        fds[n_fds] = .{ .fd = sig_pipe[0], .events = posix.POLL.IN, .revents = 0 };
        const sig_idx = n_fds;
        n_fds += 1;

        // 子が生きている間は無期限に待つ。終了後だけ、居残りプロセス対策の
        // アイドルタイムアウトに切り替える。
        const timeout: i32 = if (child_status == null) -1 else DRAIN_IDLE_MS;
        const ready = posix.poll(fds[0..n_fds], timeout) catch |err| switch (err) {
            error.SystemResources => return err,
            else => return err,
        };
        if (ready == 0) break; // 子は終了済みで、猶予内に追加データが来なかった

        if (out_idx) |i| {
            if (fds[i].revents != 0) try out_pump.drainOnce();
        }
        if (err_idx) |i| {
            if (fds[i].revents != 0) try err_pump.drainOnce();
        }
        if (fds[sig_idx].revents != 0) {
            var sink: [64]u8 = undefined;
            _ = posix.read(sig_pipe[0], &sink) catch {};
            if (child_status == null) {
                const res = posix.waitpid(pid, posix.W.NOHANG);
                if (res.pid == pid) child_status = res.status;
            }
        }
    }

    // EOF まで読み切った (または猶予切れ) 後に、取りこぼした overlap を出す。
    if (!out_pump.eof) try out_pump.stream.finish(out_pump.dst);
    if (!err_pump.eof) try err_pump.stream.finish(err_pump.dst);

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

test "exitCodeFromStatus: killed by signal maps to 128+signo" {
    // WIFSIGNALED: 下位 7 bit が終了シグナル (0 でも 0x7f でもない)。
    try testing.expectEqual(@as(u8, 128 + 2), exitCodeFromStatus(2)); // SIGINT
    try testing.expectEqual(@as(u8, 128 + 15), exitCodeFromStatus(15)); // SIGTERM
    try testing.expectEqual(@as(u8, 128 + 9), exitCodeFromStatus(9)); // SIGKILL
}
