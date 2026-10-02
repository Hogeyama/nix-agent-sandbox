//! serve モード: ホスト側で Unix domain socket か、ループバックの TCP を待ち受け、
//! 接続ごとにストリームをマスクして返す常駐サーバ。
//!
//! TCP は他のユーザーがログインしない、一人で使うホスト専用である。
//! `127.0.0.1:PORT` には所有者がなく、Unix ソケットの 0700 ディレクトリ + 0600 の
//! ような接続元の制限が効かないため、同じホストの他のユーザーが接続したり、
//! 停止中に同じポートで偽のサーバを立てたりできる。
//!
//! なぜホスト側なのか
//! ------------------
//! マスク対象のシークレット一覧をエージェントから到達できる場所 (コンテナ内の
//! ファイルなど) に置くと、一覧そのものをエージェントに渡すのと同じになる。
//! 一覧はホストのプロセスだけが持ち、エージェントは生バイトを送ってマスク済み
//! バイトを受け取る。この関係を成り立たせるのがこのブローカーである。
//!
//! プロトコル
//! ----------
//! 1 接続 = 1 ストリーム。Unix ソケットと TCP で同じものを使う。
//!
//! - クライアント → サーバ: `[u32 ビッグエンディアンの長さ][本文]` のフレーム
//!   (frame.zig) の繰り返し。長さは 1..`frame.MAX_BODY`。**長さ 0 のフレームが
//!   入力の終わり**。
//! - サーバ → クライアント: マスク済みバイトを区切りなしで流す。終わりのフレームを
//!   受け取ったら保持中の overlap をフラッシュし、送り切ったら close する。
//!   **サーバの close が出力の終わり**。
//!
//! 入力の終わりを half-close (`shutdown(SHUT_WR)`) で伝えないのは、srt の proxy が
//! half-close を通さず、クライアントが半分閉じた時点で逆向きも閉じてしまい、
//! フラッシュした末尾が届かなくなるため。
//!
//! フレームの境界とマスクの境界は関係づけない。本文をつなげたバイト列を 1 本の
//! ストリームとして MaskStream に渡すので、シークレットがフレームを跨いでも
//! マスクされる。マスクは長さを保存するが、チャンク境界を跨ぐシークレットを
//! 取りこぼさないためサーバは末尾 `maxSecretLen - 1` バイトを保持する。したがって
//! **応答はバイト同期ではない**: クライアントは「N 書いたら N 読める」と
//! 仮定してはならない。
//!
//! 次の場合は保持中の末尾を送らずに close する: 長さが上限を越えている (相手は
//! クライアントではない)、終わりのフレームの前に EOF になった (クライアントが
//! 落ちた)。終わりのフレーム以降のバイトは MaskStream に渡さず、末尾をマスクして
//! 送り切ったら close する。close の直前に、既に届いているバイトを非ブロッキングで
//! 最大 `MAX_DISCARD_BYTES` 読み捨てる (`discardUnread`)。未読のデータを残して
//! 閉じると reset が送られ、クライアントが末尾を受け取る前に接続が切られうるため。
//! 追加の到着は待たず、上限に達しても閉じるので、読み捨てた後に届いたバイトで
//! reset が起きることはありうる。プロトコルに違反するクライアントへの正常な終了は
//! 保証しない。送るのはマスク済みの末尾だけなので、余分なバイトがあっても漏れは
//! 起きない。
//!
//! 単一 poll ループでの多重化
//! --------------------------
//! 全接続を 1 つの poll ループで多重化する。エージェントはシェルを同時に複数
//! 起動し (1 シェルにつき stdout/stderr の 2 接続)、シェルは分単位で生存しうる。
//! 1 接続を完了まで処理してから次を accept する実装だと、長時間走るシェル 1 本が
//! 他の全シェルをブロックしてしまう。
//!
//! 一覧の世代
//! ----------
//! 一覧は世代 (Generation) ごとに参照を数える。serve は現在の世代を 1 つ参照し、
//! 接続は accept した時点の世代を閉じるまで参照する。MaskStream は一覧のスライスを
//! 参照し続け、保持する overlap の長さも一覧の最長値で決まるので、接続の途中で
//! 一覧を替えることはできない。
//!
//! runWithSource に Source を渡すと、listener が readable になった周回で accept の
//! 前に新しい世代を問い合わせ、それ以降に accept した接続に新しい世代を渡す。
//! 古い世代は、それを参照する接続がすべて閉じたときに呼び出し元の destroyFn で
//! 解放される。世代の確保と解放は呼び出し元が受け持ち、ここではファイル形式も
//! 確保の仕方も扱わない。
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
//! 呼び出し元はこの 2 つを永続ログや、エージェントが読める端末に向けうる
//! (例: nas の ProcessService.spawn はホスト上のログファイルに向ける)。
//! 「failed to mask chunk: <bytes>」のような診断は平文シークレットをそこへ
//! 書き出すことになる。よってこのファイル内に診断出力は一切置かず、エラーは
//! 呼び出し元へ返すか接続を落とすだけにする。

const std = @import("std");
const posix = std.posix;
const mask_stream = @import("masking").stream;
const address = @import("address.zig");
const frame = @import("frame.zig");

const BUF_SIZE = mask_stream.BUF_SIZE;

const MAX_SOCKET_PATH = address.MAX_SOCKET_PATH;

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
/// MaskStream の消費量は呼び出し元が渡す最長パターンの長さに比例する。
/// 上限は呼び出し元ごとに異なる:
///   - nas-mask-filter: 1 値あたり 16MiB (mask_filter.zig の readSecretsFromFile)
///   - sumi: `patterns.expand` 後のパターン。全体は `patterns.MAX_BYTES` で
///     抑えられ、1 パターンは展開によりその範囲内で長くなりうる
/// たとえば 16MiB のパターンが 1 つあれば 1 接続あたり約 64MiB、512 接続で約
/// 32GiB になる。ここに強制はかけていない: シークレットは運用者が設定するもので、
/// エージェントから長さを操作できないため、攻撃面ではなく設定の問題だからである。
/// 長いシークレットを扱うなら MAX_CONNECTIONS を見直すこと。
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

/// close の前に読み捨てる、終わりのフレームより後ろのバイトの上限 (discardUnread)。
/// 余分なバイトはクライアントの不具合なので、ふつうは数フレーム分も無い。
const MAX_DISCARD_BYTES: usize = 256 * 1024;

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
    ListenPathNotSocket,
};

/// 一覧の 1 世代。
///
/// MaskStream は一覧のスライスを参照し続けるので、接続が使っている世代は
/// その接続が閉じるまで解放できない。serve は現在の世代と、各接続が accept 時に
/// 受け取った世代の参照を数え、最後の参照が外れたときに destroyFn を呼ぶ。
/// 世代は呼び出し元が確保する。差し替えのときに serve が確保しないので、
/// 差し替えには失敗する経路が無い。
pub const Generation = struct {
    values: []const []const u8,
    /// 参照の数。serve だけが触る。poll ループは単一スレッドなので atomic にしない。
    refs: usize = 0,
    /// refs が 0 になったときに呼ぶ。null なら呼び出し元が寿命を持つ。
    destroyFn: ?*const fn (gen: *Generation) void = null,

    fn retain(self: *Generation) void {
        self.refs += 1;
    }

    fn release(self: *Generation) void {
        self.refs -= 1;
        if (self.refs == 0) if (self.destroyFn) |destroy| destroy(self);
    }
};

/// 一覧の新しい世代の提供元。
pub const Source = struct {
    ctx: *anyopaque,
    /// listener が readable になった周回で、accept の前に 1 回呼ぶ。新しい世代が
    /// あれば refs = 0 のまま返し、無ければ null を返す。返した世代はそれ以降の
    /// accept で使われる。poll ループの中で同期的に呼ぶので、時間のかかる処理を
    /// してはならない。
    refreshFn: *const fn (ctx: *anyopaque) ?*Generation,
};

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
    /// accept 時の一覧の世代。run のループが参照を持ち、接続を閉じたら外す。
    /// Conn 自身は触らない。
    gen: ?*Generation = null,
    /// MaskStream は ~192KiB を確保するため、accept 時ではなく
    /// **本文の最初の 1 バイトを受け取った時点** で初期化する。accept 時や
    /// ヘッダの時点で確保すると、connect(2) 1 回 (とヘッダ 4 バイト) が
    /// ホストの 192KiB になる。
    stream: ?mask_stream.MaskStream = null,
    out: std.ArrayList(u8) = .empty,
    /// 読みかけのフレームのヘッダ。
    header: [frame.HEADER_LEN]u8 = undefined,
    /// header に読めたバイト数。
    header_len: usize = 0,
    /// 今のフレームの本文の残りバイト数。0 ならヘッダを読んでいる。
    body_left: usize = 0,
    /// 終わりのフレーム (長さ 0) を受け取った。これ以降は POLLIN を待たず、
    /// MaskStream にも渡さない (close の直前の読み捨てだけが残る。`discardUnread`)。
    end_received: bool = false,

    fn deinit(self: *Conn, gpa: std.mem.Allocator) void {
        if (self.stream) |*s| s.deinit(gpa);
        self.out.deinit(gpa);
        if (self.end_received) discardUnread(self.fd);
        posix.shutdown(self.fd, .send) catch {};
        posix.close(self.fd);
        self.* = undefined;
    }

    fn wantsRead(self: *const Conn) bool {
        return !self.end_received and self.out.items.len < MAX_QUEUED_BYTES;
    }

    fn wantsWrite(self: *const Conn) bool {
        return self.out.items.len > 0;
    }

    /// 終わりのフレームの後にフラッシュし切った = この接続はもう閉じてよい。
    fn finished(self: *const Conn) bool {
        return self.end_received and self.out.items.len == 0;
    }

    /// POLLIN が立ったときに呼ぶ。ヘッダか本文を 1 回読む。
    ///
    /// ヘッダは残りのバイト数だけ、本文はそのフレームの残りだけを読む。1 回の
    /// read が次のフレームにかからないので、終わりのフレームの後ろに余分な
    /// バイトが続いていても、それを読み込んで MaskStream に渡すことはない。
    fn readable(
        self: *Conn,
        gpa: std.mem.Allocator,
        secrets: []const []const u8,
        scratch: []u8,
    ) ConnError!void {
        if (self.body_left == 0) return self.readHeader(gpa);
        return self.readBody(gpa, secrets, scratch);
    }

    fn readHeader(self: *Conn, gpa: std.mem.Allocator) ConnError!void {
        const n = posix.read(self.fd, self.header[self.header_len..]) catch |err| switch (err) {
            error.WouldBlock => return,
            else => return error.Failed,
        };
        // 終わりのフレームの前の EOF はクライアントが落ちたということ。
        // 保持中の末尾は返さずに閉じる。
        if (n == 0) return error.Failed;
        self.header_len += n;
        if (self.header_len < frame.HEADER_LEN) return;
        self.header_len = 0;

        const len = frame.bodyLen(&self.header);
        if (len == 0) {
            self.end_received = true;
            // 保持していた overlap をここでフラッシュする。本文が 1 バイトも
            // 来ていなければ MaskStream は無く、フラッシュするものもない。
            if (self.stream) |*stream| {
                stream.finish(QueueWriter{ .gpa = gpa, .out = &self.out }) catch return error.Failed;
            }
            return;
        }
        // 上限を越える長さを送ってくるのはこのプロトコルのクライアントではない。
        if (len > frame.MAX_BODY) return error.Failed;
        self.body_left = len;
    }

    fn readBody(
        self: *Conn,
        gpa: std.mem.Allocator,
        secrets: []const []const u8,
        scratch: []u8,
    ) ConnError!void {
        const writer = QueueWriter{ .gpa = gpa, .out = &self.out };
        const want = @min(self.body_left, BUF_SIZE);

        if (self.stream == null) {
            // まだ MaskStream がないので、共有バッファへ読んでから初期化する。
            const n = posix.read(self.fd, scratch[0..want]) catch |err| switch (err) {
                error.WouldBlock => return,
                else => return error.Failed,
            };
            if (n == 0) return error.Failed;
            self.stream = mask_stream.MaskStream.init(gpa, secrets) catch return error.Failed;
            @memcpy(self.stream.?.readBuf()[0..n], scratch[0..n]);
            self.stream.?.push(n, writer) catch return error.Failed;
            self.body_left -= n;
            return;
        }

        const stream = &self.stream.?;
        const n = posix.read(self.fd, stream.readBuf()[0..want]) catch |err| switch (err) {
            error.WouldBlock => return,
            else => return error.Failed,
        };
        if (n == 0) return error.Failed;
        stream.push(n, writer) catch return error.Failed;
        self.body_left -= n;
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

/// 終わりのフレームの後に既に届いているバイトを、close の前に読み捨てる。
///
/// 受信キューにバイトを残したまま close すると、Linux は相手へ reset を送る
/// (AF_UNIX では相手の次の read が ECONNRESET、TCP では RST で、送り切っていない
/// 末尾も捨てられうる)。末尾を送り切ってから閉じても、クライアントには失敗として
/// 届いてしまう。ここで読んだバイトは MaskStream には渡さない。
///
/// fd は非ブロッキングなので、受信キューが空になった時点 (WouldBlock) で戻り、
/// 追加の到着は待たない。読み捨てる量にも上限を置き、達したら残りがあっても
/// 閉じる。終わりのフレームの後も送り続けるクライアントを相手に、この接続だけで
/// poll ループを止めないため。したがってこれは reset の機会を狭めるだけで、
/// プロトコルに違反するクライアントへの正常な終了は保証しない。
fn discardUnread(fd: posix.fd_t) void {
    var sink: [4096]u8 = undefined;
    var budget: usize = MAX_DISCARD_BYTES;
    while (budget > 0) {
        const n = posix.read(fd, sink[0..@min(sink.len, budget)]) catch return;
        if (n == 0) return;
        budget -= n;
    }
}

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

fn bindUnixListener(sock_path: []const u8) !posix.socket_t {
    // address.parse を通らない呼び出し元 (nas-mask-filter の --serve) もあるので、
    // 越えていると bind が難解な失敗をするだけの AF_UNIX のパス長制限はここで弾く。
    if (sock_path.len == 0) return error.EmptySocketPath;
    if (sock_path.len > MAX_SOCKET_PATH) return error.SocketPathTooLong;

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
    // パスは利用者が指定するので、消すのはソケットだけにする。通常ファイル、
    // ディレクトリ、シンボリックリンクなどは、秘密ファイルを誤って渡された場合も
    // 含めて触らずに拒否する。
    if (posix.fstatat(posix.AT.FDCWD, sock_path, posix.AT.SYMLINK_NOFOLLOW)) |st| {
        if (!posix.S.ISSOCK(st.mode)) return error.ListenPathNotSocket;
        posix.unlink(sock_path) catch {};
    } else |err| switch (err) {
        error.FileNotFound => {},
        else => return err,
    }

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

fn bindTcpListener(addr: std.net.Address) !posix.socket_t {
    const fd = try posix.socket(
        addr.any.family,
        posix.SOCK.STREAM | posix.SOCK.CLOEXEC | posix.SOCK.NONBLOCK,
        0,
    );
    errdefer posix.close(fd);

    // serve を再起動した直後は、前回の接続が TIME_WAIT に残っていて同じポートへの
    // bind が EADDRINUSE になる。利用者が設定したポートを変えずに済ませるため。
    try posix.setsockopt(fd, posix.SOL.SOCKET, posix.SO.REUSEADDR, &std.mem.toBytes(@as(c_int, 1)));
    try posix.bind(fd, &addr.any, addr.getOsSockLen());
    try posix.listen(fd, LISTEN_BACKLOG);
    return fd;
}

fn bindListener(listen: address.Address) !posix.socket_t {
    return switch (listen) {
        .unix => |path| bindUnixListener(path),
        .tcp => |addr| bindTcpListener(addr),
    };
}

/// listen で待ち受け、kill されるまで接続をマスクし続ける。
/// 正常には返らない (戻り値の型は main の他モードと揃えるためのもの)。
/// accept 以降は fd の種類 (AF_UNIX / AF_INET) に依存しない。
pub fn run(gpa: std.mem.Allocator, secrets: []const []const u8, listen: address.Address) !u8 {
    var gen: Generation = .{ .values = secrets };
    return runWithSource(gpa, &gen, null, listen);
}

/// run と同じだが、一覧を source から差し替えられる。
/// initial は呼んだ時点から serve が参照し、返るときに参照を外す。
/// source が新しい世代を返すと、それ以降に accept した接続はその世代を使い、
/// それより前の接続は自分の世代を閉じるまで使い続ける。
pub fn runWithSource(gpa: std.mem.Allocator, initial: *Generation, source: ?Source, listen: address.Address) !u8 {
    // bind の失敗で返るときも initial の参照を外すよう、最初に参照する。
    // defer は scope を出る時点の current を外すので、差し替え後の世代が外れる。
    var current = initial;
    current.retain();
    defer current.release();

    raiseFileLimit();

    const listener = try bindListener(listen);
    defer posix.close(listener);

    // MaskStream 未初期化の接続の最初の read 先。全接続で使い回す
    // (poll ループは単一スレッドなので同時に使われることはない)。
    const scratch = try gpa.alloc(u8, BUF_SIZE);
    defer gpa.free(scratch);

    var conns: std.ArrayList(Conn) = .empty;
    defer {
        for (conns.items) |*c| closeConn(gpa, c);
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
                conn.readable(gpa, conn.gen.?.values, scratch) catch {
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
                closeConn(gpa, &dead);
            }
        }

        if (listener_armed and pollfds[listener_idx].revents != 0) {
            // この周回で accept する接続には、変更があれば新しい世代を渡す。
            // 同じ世代が返っても解放しないよう、外す前に参照する。
            if (source) |s| if (s.refreshFn(s.ctx)) |next| {
                next.retain();
                current.release();
                current = next;
            };

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
                conns.append(gpa, .{ .fd = fd, .gen = current }) catch {
                    posix.close(fd);
                    listener_backoff_until = std.time.milliTimestamp() + LISTENER_BACKOFF_MS;
                    break;
                };
                current.retain();
            }
        }
    }
}

/// 接続を閉じ、accept 時に受け取った世代の参照を外す。
fn closeConn(gpa: std.mem.Allocator, conn: *Conn) void {
    const gen = conn.gen;
    conn.deinit(gpa);
    if (gen) |g| g.release();
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

const testing = std.testing;

test "run: an empty unix path is rejected" {
    try testing.expectError(error.EmptySocketPath, run(testing.allocator, &.{"secret-value"}, .{ .unix = "" }));
}

test "run: a unix path over the sun_path limit is rejected" {
    const too_long = "/" ** (MAX_SOCKET_PATH + 1);
    try testing.expectError(error.SocketPathTooLong, run(testing.allocator, &.{"secret-value"}, .{ .unix = too_long }));
}

/// port 0 で bind して割り当て番号を読み、閉じてから返す。run に渡す番号の確保用。
fn freeLoopbackPort() !u16 {
    var addr = try std.net.Address.parseIp4("127.0.0.1", 0);
    const fd = try posix.socket(posix.AF.INET, posix.SOCK.STREAM | posix.SOCK.CLOEXEC, 0);
    defer posix.close(fd);
    try posix.bind(fd, &addr.any, addr.getOsSockLen());
    var len: posix.socklen_t = addr.getOsSockLen();
    try posix.getsockname(fd, &addr.any, &len);
    return addr.getPort();
}

/// run は返らないので、テストはスレッドを detach したまま終わる。
/// 終了時はプロセスごと落ちる。確保は leak 検査のない page_allocator で行う。
fn runDetached(addr: address.Address) void {
    _ = run(std.heap.page_allocator, &.{"secret-value"}, addr) catch {};
}

test "run: a loopback TCP listener masks a connection" {
    const port = try freeLoopbackPort();
    const addr = try std.net.Address.parseIp4("127.0.0.1", port);
    const thread = try std.Thread.spawn(.{}, runDetached, .{address.Address{ .tcp = addr }});
    thread.detach();

    // listener が立つまで待つ。
    var stream: ?std.net.Stream = null;
    var attempt: usize = 0;
    while (attempt < 100) : (attempt += 1) {
        stream = std.net.tcpConnectToAddress(addr) catch {
            std.Thread.sleep(20 * std.time.ns_per_ms);
            continue;
        };
        break;
    }
    const conn = stream orelse return error.ConnectFailed;
    defer conn.close();

    // 入力はフレームで送り、長さ 0 のフレームで終える。half-close はしない。
    try conn.writeAll(&frame.header(16));
    try conn.writeAll("a secret-value b");
    try conn.writeAll(&frame.header(0));

    var got: [64]u8 = undefined;
    var total: usize = 0;
    while (true) {
        const n = try conn.read(got[total..]);
        if (n == 0) break;
        total += n;
    }
    try testing.expectEqualStrings("a ************ b", got[0..total]);
}

test "run: a non-socket at the listen path is left alone" {
    // テストの作業ディレクトリ (build.zig の setCwd) は書き込み可能で、相対パスなら
    // AF_UNIX の上限にも収まる。/tmp は Nix のサンドボックスで書けるとは限らない。
    var name_buf: [64]u8 = undefined;
    const path = try std.fmt.bufPrint(&name_buf, "serve-nonsock-{x}", .{std.crypto.random.int(u64)});
    try std.fs.cwd().writeFile(.{ .sub_path = path, .data = "original" });
    defer std.fs.cwd().deleteFile(path) catch {};

    try testing.expectError(error.ListenPathNotSocket, run(testing.allocator, &.{"secret-value"}, .{ .unix = path }));

    var content: [16]u8 = undefined;
    const got = try std.fs.cwd().readFile(path, &content);
    try testing.expectEqualStrings("original", got);
}

// --- 一覧の世代 ----------------------------------------------------------------

/// destroyFn が呼ばれたかを記録する世代。別スレッドの run から呼ばれるので atomic にする。
const TestGeneration = struct {
    gen: Generation,
    destroyed: std.atomic.Value(bool) = .init(false),

    fn init(values: []const []const u8) TestGeneration {
        return .{ .gen = .{ .values = values, .destroyFn = markDestroyed } };
    }

    fn markDestroyed(gen: *Generation) void {
        const self: *TestGeneration = @fieldParentPtr("gen", gen);
        self.destroyed.store(true, .release);
    }

    fn isDestroyed(self: *TestGeneration) bool {
        return self.destroyed.load(.acquire);
    }
};

test "Generation: only the last release destroys it" {
    var t = TestGeneration.init(&.{"secret-value"});
    t.gen.retain();
    t.gen.retain();
    t.gen.release();
    try testing.expect(!t.isDestroyed());
    t.gen.release();
    try testing.expect(t.isDestroyed());
}

test "Generation: a generation without destroyFn is left to its owner" {
    var gen: Generation = .{ .values = &.{"secret-value"} };
    gen.retain();
    gen.release();
    try testing.expectEqual(@as(usize, 0), gen.refs);
}

/// listener が立つまで待って接続する。
fn connectLoopback(addr: std.net.Address) !std.net.Stream {
    var attempt: usize = 0;
    while (attempt < 100) : (attempt += 1) {
        return std.net.tcpConnectToAddress(addr) catch {
            std.Thread.sleep(20 * std.time.ns_per_ms);
            continue;
        };
    }
    return error.ConnectFailed;
}

/// サーバが閉じるまで読み、読んだバイト列を返す。
fn readToEnd(conn: std.net.Stream, buf: []u8) ![]const u8 {
    var total: usize = 0;
    while (true) {
        const n = try conn.read(buf[total..]);
        if (n == 0) return buf[0..total];
        total += n;
    }
}

/// テストのスレッドから差し替える世代を渡す Source。
const SwapSource = struct {
    mutex: std.Thread.Mutex = .{},
    next: ?*Generation = null,

    fn set(self: *SwapSource, gen: *Generation) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.next = gen;
    }

    fn refresh(ctx: *anyopaque) ?*Generation {
        const self: *SwapSource = @ptrCast(@alignCast(ctx));
        self.mutex.lock();
        defer self.mutex.unlock();
        const gen = self.next;
        self.next = null;
        return gen;
    }

    fn source(self: *SwapSource) Source {
        return .{ .ctx = self, .refreshFn = refresh };
    }
};

fn runWithSourceDetached(initial: *Generation, source: Source, addr: address.Address) void {
    _ = runWithSource(std.heap.page_allocator, initial, source, addr) catch {};
}

test "runWithSource: a refreshed list applies to later connections only" {
    // run は返らないので、スレッドが参照する値はテストの終了後も残るよう static に置く。
    const S = struct {
        var old = TestGeneration.init(&.{"secret-one"});
        var new = TestGeneration.init(&.{"secret-two"});
        var swap: SwapSource = .{};
    };
    const port = try freeLoopbackPort();
    const addr = try std.net.Address.parseIp4("127.0.0.1", port);
    const thread = try std.Thread.spawn(.{}, runWithSourceDetached, .{ &S.old.gen, S.swap.source(), address.Address{ .tcp = addr } });
    thread.detach();

    // 先に始めた接続。overlap (最長値 - 1 バイト) より長く送り、最初の出力が
    // 届いたことで、差し替えの前に accept されて MaskStream ができたことを確かめる。
    const early = try connectLoopback(addr);
    defer early.close();
    const first = "secret-one" ++ "x" ** 64;
    try early.writeAll(&frame.header(first.len));
    try early.writeAll(first);
    var early_buf: [256]u8 = undefined;
    var early_len: usize = 0;
    while (early_len < "secret-one".len) {
        const n = try early.read(early_buf[early_len..]);
        if (n == 0) return error.UnexpectedEof;
        early_len += n;
    }

    S.swap.set(&S.new.gen);

    // 差し替えの後に始めた接続は新しい一覧で伏せる。
    const late = try connectLoopback(addr);
    defer late.close();
    const late_body = "secret-one secret-two";
    try late.writeAll(&frame.header(late_body.len));
    try late.writeAll(late_body);
    try late.writeAll(&frame.header(0));
    var late_buf: [64]u8 = undefined;
    try testing.expectEqualStrings("secret-one **********", try readToEnd(late, &late_buf));

    // 古い世代は、先に始めた接続が使っている間は解放されない。
    try testing.expect(!S.old.isDestroyed());

    // 先に始めた接続は、差し替えの後も古い一覧で伏せる。
    const rest = " secret-two secret-one";
    try early.writeAll(&frame.header(rest.len));
    try early.writeAll(rest);
    try early.writeAll(&frame.header(0));
    const tail = try readToEnd(early, early_buf[early_len..]);
    try testing.expectEqualStrings(
        "**********" ++ "x" ** 64 ++ " secret-two **********",
        early_buf[0 .. early_len + tail.len],
    );

    // 先に始めた接続が閉じると、古い世代を参照するものが無くなる。
    // サーバは fd を閉じてから参照を外すので、EOF の直後はまだ外れていないことがある。
    var waited: usize = 0;
    while (!S.old.isDestroyed() and waited < 100) : (waited += 1) std.Thread.sleep(20 * std.time.ns_per_ms);
    try testing.expect(S.old.isDestroyed());
    try testing.expect(!S.new.isDestroyed());
}

// --- フレームの読み取り (Conn 単体) -----------------------------------------

const TEST_SECRETS: []const []const u8 = &.{"secret-value"};

/// テスト用の接続。server 側を Conn に渡し、client 側からフレームを書く。
const ConnPair = struct {
    conn: Conn,
    client: posix.socket_t,
    scratch: []u8,

    fn init() !ConnPair {
        var fds: [2]posix.socket_t = undefined;
        if (std.c.socketpair(posix.AF.UNIX, posix.SOCK.STREAM | posix.SOCK.CLOEXEC, 0, &fds) != 0) return error.SocketPair;
        errdefer {
            posix.close(fds[0]);
            posix.close(fds[1]);
        }
        const flags = try posix.fcntl(fds[0], posix.F.GETFL, 0);
        _ = try posix.fcntl(fds[0], posix.F.SETFL, flags | @as(u32, @bitCast(posix.O{ .NONBLOCK = true })));
        return .{
            .conn = .{ .fd = fds[0] },
            .client = fds[1],
            .scratch = try testing.allocator.alloc(u8, BUF_SIZE),
        };
    }

    fn deinit(self: *ConnPair) void {
        posix.close(self.client);
        testing.allocator.free(self.scratch);
    }

    fn send(self: *ConnPair, bytes: []const u8) !void {
        var off: usize = 0;
        while (off < bytes.len) off += try posix.send(self.client, bytes[off..], posix.MSG.NOSIGNAL);
    }

    fn sendFrame(self: *ConnPair, body: []const u8) !void {
        try self.send(&frame.header(body.len));
        try self.send(body);
    }

    /// 1 回だけ readable を呼ぶ (読めるまで待つ)。
    fn readOnce(self: *ConnPair) ConnError!void {
        var pfd = [_]posix.pollfd{.{ .fd = self.conn.fd, .events = posix.POLL.IN, .revents = 0 }};
        // 待ちが時間切れなら失敗にする。呼び出し側のループが無限に回らないように。
        const ready = posix.poll(&pfd, 5000) catch return error.Failed;
        if (ready == 0) return error.Failed;
        return self.conn.readable(testing.allocator, TEST_SECRETS, self.scratch);
    }

    /// run のループと同じ判定で、この接続だけを回す。最後まで送り切って閉じる
    /// ところまで進んだら true、途中で落とされたら false。どちらの場合も接続は
    /// 閉じる (Conn.deinit)。
    fn drive(self: *ConnPair) !bool {
        defer self.conn.deinit(testing.allocator);
        while (!self.conn.finished()) {
            var events: i16 = 0;
            if (self.conn.wantsRead()) events |= posix.POLL.IN;
            if (self.conn.wantsWrite()) events |= posix.POLL.OUT;
            var pfd = [_]posix.pollfd{.{ .fd = self.conn.fd, .events = events, .revents = 0 }};
            if (try posix.poll(&pfd, 5000) == 0) return error.Timeout;
            const revents = pfd[0].revents;
            if (revents & posix.POLL.IN != 0) {
                self.conn.readable(testing.allocator, TEST_SECRETS, self.scratch) catch return false;
            } else if (revents & (posix.POLL.HUP | posix.POLL.ERR | posix.POLL.NVAL) != 0) {
                return false;
            }
            if (revents & posix.POLL.OUT != 0) self.conn.writable(testing.allocator) catch return false;
        }
        return true;
    }

    /// サーバが閉じるまでに返したバイト列。
    fn received(self: *ConnPair, buf: []u8) ![]const u8 {
        var total: usize = 0;
        while (true) {
            const n = try posix.read(self.client, buf[total..]);
            if (n == 0) return buf[0..total];
            total += n;
        }
    }
};

test "Conn: a secret split across frames is still masked" {
    var p = try ConnPair.init();
    defer p.deinit();
    try p.sendFrame("a secr");
    try p.sendFrame("et-value b");
    try p.sendFrame("");
    try testing.expect(try p.drive());
    var buf: [64]u8 = undefined;
    try testing.expectEqualStrings("a ************ b", try p.received(&buf));
}

test "Conn: a frame of exactly the maximum length is accepted" {
    var p = try ConnPair.init();
    defer p.deinit();
    const body = try testing.allocator.alloc(u8, frame.MAX_BODY);
    defer testing.allocator.free(body);
    @memset(body, 'a');
    try p.sendFrame(body);
    try p.sendFrame("");
    try testing.expect(try p.drive());
    const buf = try testing.allocator.alloc(u8, frame.MAX_BODY + 1);
    defer testing.allocator.free(buf);
    try testing.expectEqualSlices(u8, body, try p.received(buf));
}

// 長さが上限を越えるのはクライアントではない何か。保持中の末尾も返さない。
test "Conn: a length over the maximum closes without flushing the held tail" {
    var p = try ConnPair.init();
    defer p.deinit();
    // シークレットより短い入力は丸ごと overlap として保持される。
    try p.sendFrame("abc");
    var h: [4]u8 = undefined;
    std.mem.writeInt(u32, &h, frame.MAX_BODY + 1, .big);
    try p.send(&h);
    try testing.expect(!try p.drive());
    var buf: [64]u8 = undefined;
    try testing.expectEqualStrings("", try p.received(&buf));
}

// 終わりのフレームの前の EOF はクライアントが落ちたということ。返す先もない。
test "Conn: EOF before the end frame closes without flushing the held tail" {
    var p = try ConnPair.init();
    defer p.deinit();
    try p.sendFrame("abc");
    try posix.shutdown(p.client, .send);
    try testing.expect(!try p.drive());
    var buf: [64]u8 = undefined;
    try testing.expectEqualStrings("", try p.received(&buf));
}

test "Conn: bytes after the end frame in the same read are not processed" {
    var p = try ConnPair.init();
    defer p.deinit();
    // 1 回の write で届けば、サーバの 1 回の read に収まりうる。
    var all: [64]u8 = undefined;
    var w: std.Io.Writer = .fixed(&all);
    try w.writeAll(&frame.header(3));
    try w.writeAll("abc");
    try w.writeAll(&frame.header(0));
    try w.writeAll(&frame.header(3));
    try w.writeAll("XYZ");
    try w.writeAll(&frame.header(0));
    try p.send(w.buffered());
    try testing.expect(try p.drive());
    var buf: [64]u8 = undefined;
    try testing.expectEqualStrings("abc", try p.received(&buf));
}

test "Conn: after the end frame the connection is not read, and late bytes are not processed" {
    var p = try ConnPair.init();
    defer p.deinit();
    try p.sendFrame("abc");
    try p.sendFrame("");
    while (!p.conn.end_received) try p.readOnce();
    // 終わりを受け取ったら、もう POLLIN を待たない。
    try testing.expect(!p.conn.wantsRead());
    try p.sendFrame("XYZ");
    try p.sendFrame("");
    try testing.expect(try p.drive());
    var buf: [64]u8 = undefined;
    try testing.expectEqualStrings("abc", try p.received(&buf));
}

// accept しただけの接続や、本文のないヘッダだけでは MaskStream を確保しない。
test "Conn: the mask stream is allocated only on the first body byte" {
    var p = try ConnPair.init();
    defer p.deinit();
    defer p.conn.deinit(testing.allocator);
    try p.send(&frame.header(5));
    try p.readOnce();
    try testing.expect(p.conn.stream == null);
    try p.send("a");
    try p.readOnce();
    try testing.expect(p.conn.stream != null);
}

test "Conn: an input of only the end frame closes with nothing to send" {
    var p = try ConnPair.init();
    defer p.deinit();
    try p.sendFrame("");
    try testing.expect(try p.drive());
    var buf: [8]u8 = undefined;
    try testing.expectEqualStrings("", try p.received(&buf));
}
