# sumi serve の secrets ファイル読み直し 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `sumi serve` が secrets ファイルの変更を accept の直前の `stat` で検出し、以後の接続で新しい一覧を使うようにする。

**Architecture:** 共有ライブラリの `serve.zig` に、参照カウント付きの一覧の世代 (`Generation`) と提供元 (`Source`) を受け取る `runWithSource` を足す。既存の `run` は `runWithSource` の薄い wrapper として残し、nas-mask-filter からの呼び出しは変えない。ファイルの監視と診断は sumi 側の新しいファイル `contrib/sumi/serve_source.zig` が受け持つ。

**Tech Stack:** Zig 0.15.2、bash の black-box テスト (`contrib/sumi/tests/run-tests.sh`)。

設計書: `docs/superpowers/specs/2026-10-02-sumi-serve-reload-design.md`

## Global Constraints

- `lib/` は nas (`src/mask-filter/`) と sumi が共有する。`src/mask-filter/` のファイルは一切変えない。`serve.run(gpa, secrets, listen)` の引数と挙動を変えない。
- `serve.zig` の中に診断出力 (`std.debug.print` など) を置かない。stdout/stderr に書くのは `contrib/sumi/` 側だけで、書くのは定数の文言と `secrets.describe` の文言だけにする。一覧の値は書かない。
- `lib/` は製品のソースを import しない。`serve.zig` は `contrib/sumi/` の型を知らない。
- 対象は Linux だけ。
- テストの書き方は `.claude/skills/test-policy/SKILL.md` に従う。unit は `bun run test:process-supervisor-unit` と `bun run test:sumi-unit`、black-box は `bun run test:sumi-integration`。
- コメントはファイル全体を読む人に向けて書く。変更の経緯 (「以前は」「今回」) は書かない。既存のコメントの密度と文体 (である調) に合わせる。
- コミットはユーザーの指示があったときだけ行う。各タスクの最後は差分の確認までにする。

## ファイル構成

| ファイル | 責務 |
|---|---|
| `lib/process-supervisor/serve.zig` | `Generation` と `Source` の型、参照の増減、`runWithSource`。`run` は `runWithSource` を呼ぶ |
| `lib/README.md` | 製品が `serve.run` か `serve.runWithSource` を呼ぶことの記述 |
| `contrib/sumi/serve_source.zig` (新規) | secrets ファイルの `stat` の比較、`secrets.load` で世代を作る、世代の解放、診断 |
| `contrib/sumi/main.zig` | `runServe` を `serve_source` と `runWithSource` に替える。テストルートへの追加 |
| `contrib/sumi/tests/run-tests.sh` | 読み直しの black-box テスト |
| `contrib/sumi/README.md` | 再起動の注意を読み直しの説明に替える |
| `contrib/sumi/CHANGELOG.md` | Unreleased の `sumi serve` の項目に追記 |

---

### Task 1: serve.zig に世代と runWithSource を足す

**Files:**
- Modify: `lib/process-supervisor/serve.zig` (型の追加は `ServeError` の直後、`Conn` に 1 フィールド、`run` を `runWithSource` に分割、テストを末尾近くの run のテスト群に追加)
- Modify: `lib/README.md:15-19`

**Interfaces:**
- Produces (Task 2, 3 が使う):
  - `pub const Generation = struct { values: []const []const u8, refs: usize = 0, destroyFn: ?*const fn (gen: *Generation) void = null }`
  - `pub const Source = struct { ctx: *anyopaque, refreshFn: *const fn (ctx: *anyopaque) ?*Generation }`
  - `pub fn runWithSource(gpa: std.mem.Allocator, initial: *Generation, source: ?Source, listen: address.Address) !u8`
  - sumi からは `supervise.serve.Generation` などとして見える (`supervise.zig:66` の `pub const serve = @import("serve.zig")`)。

- [ ] **Step 1: 型と参照の増減を書き、その unit テストを書く**

`ServeError` の定義の直後に追加する。

```zig
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
```

テストはファイル末尾の `// --- フレームの読み取り (Conn 単体)` の前 (run のテスト群の後) に追加する。

```zig
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
```

- [ ] **Step 2: テストを走らせ、通ることを確かめる**

`retain` / `release` は Step 1 で実装まで書いているので、ここでは型と参照の増減が正しいことを確かめる。

Run: `cd lib/process-supervisor && zig build test --summary all`
Expected: すべて PASS。テスト数が Step 1 の前より 2 件増える。

- [ ] **Step 3: 冒頭コメントに一覧の世代の節を足す**

`serve.zig` 冒頭の `//! 単一 poll ループでの多重化` の節の後 (`//! 資源上限` の前) に足す。

```zig
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
```

- [ ] **Step 4: 差し替えの失敗するテストを書く**

`runDetached` の直後に、TCP で接続する共通の補助と、テストを追加する。既存の `"run: a loopback TCP listener masks a connection"` の接続待ちのループと同じ形にする。

```zig
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
    var waited: usize = 0;
    while (!S.old.isDestroyed() and waited < 100) : (waited += 1) std.Thread.sleep(20 * std.time.ns_per_ms);
    try testing.expect(S.old.isDestroyed());
    try testing.expect(!S.new.isDestroyed());
}
```

- [ ] **Step 5: テストを走らせ、失敗することを確かめる**

Run: `cd lib/process-supervisor && zig build test --summary all`
Expected: コンパイルエラー。`runWithSource` が定義されていない。

- [ ] **Step 6: Conn に世代を持たせ、run を runWithSource に分ける**

`Conn` の `fd` の直後にフィールドを足す。`Conn.readable` などの引数は変えない (Conn 単体のテスト `ConnPair` は `.{ .fd = ... }` で作るので、既定値 null のままで動く)。

```zig
const Conn = struct {
    fd: posix.fd_t,
    /// accept 時の一覧の世代。run のループが参照を持ち、接続を閉じたら外す。
    /// Conn 自身は触らない。
    gen: ?*Generation = null,
```

`run` の doc コメントと本体を次に置き換える。`runWithSource` の本体は既存の `run` の本体に、印を付けた 4 か所の変更を加えたものである。

```zig
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
    // (1) bind の失敗で返るときも initial の参照を外すよう、最初に参照する。
    var current = initial;
    current.retain();
    defer current.release();

    raiseFileLimit();

    const listener = try bindListener(listen);
    defer posix.close(listener);

    const scratch = try gpa.alloc(u8, BUF_SIZE);
    defer gpa.free(scratch);

    var conns: std.ArrayList(Conn) = .empty;
    defer {
        // (2) 閉じるときに世代の参照も外す。
        for (conns.items) |*c| closeConn(gpa, c);
        conns.deinit(gpa);
    }

    // ... pollfds と listener_backoff_until は既存のまま ...

    while (true) {
        // ... poll までは既存のまま ...

        var i = n_conns;
        while (i > 0) {
            i -= 1;
            const conn = &conns.items[i];
            const revents = pollfds[i].revents;

            var failed = false;
            if (revents & posix.POLL.IN != 0) {
                // (3) 接続ごとに、accept 時の世代の一覧で伏せる。
                conn.readable(gpa, conn.gen.?.values, scratch) catch {
                    failed = true;
                };
            } else if (revents & (posix.POLL.HUP | posix.POLL.ERR | posix.POLL.NVAL) != 0) {
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
            // (4) この周回で accept する接続には、変更があれば新しい世代を渡す。
            if (source) |s| if (s.refreshFn(s.ctx)) |next| {
                next.retain();
                current.release();
                current = next;
            };

            while (true) {
                // ... accept と上限超過の close は既存のまま ...
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
```

注意:
- `(1)` で `current.retain()` の後に `defer current.release()` を置く。`defer` の式は scope を出るときに評価されるので、差し替え後の世代が外れる。
- 既存のコメント (「accept は conns に append するので…」など) は消さずに残す。ここで `// ...` と書いた部分は既存のコードをそのまま使う。
- `(4)` の `next.retain()` を `current.release()` より先に書く。`next == current` が返されても世代を解放しないためである。

- [ ] **Step 7: テストを走らせ、通ることを確かめる**

Run: `cd lib/process-supervisor && zig build test --summary all`
Expected: すべて PASS。

- [ ] **Step 8: nas 側に影響が無いことを確かめる**

Run: `git diff --stat -- src/mask-filter && bun run test:mask-filter-unit`
Expected: `git diff --stat` は何も出さない。テストはすべて PASS で、テスト数は変更前と同じ。

- [ ] **Step 9: lib/README.md を直す**

`lib/README.md:15-19` の文の末尾を次に替える。

```
`process-supervisor/`; each product reads its own secrets format and passes
the values to `supervise.serve.run`, or passes a `Source` to
`supervise.serve.runWithSource` to replace them while serving.
```

- [ ] **Step 10: 差分を確かめる**

Run: `git diff -- lib/`
Expected: `serve.zig` と `README.md` だけが変わっている。`serve.zig` に `std.debug.print` が増えていない (`git diff -- lib/ | grep '^+.*debug.print'` が何も出さない)。

---

### Task 2: sumi に secrets ファイルの Source を足す

**Files:**
- Create: `contrib/sumi/serve_source.zig`
- Modify: `contrib/sumi/main.zig:361-371` (テストルートの `test {}` に 1 行)

**Interfaces:**
- Consumes: Task 1 の `supervise.serve.Generation`、`supervise.serve.Source`
- Produces (Task 3 が使う):
  - `pub const FileSource = struct { gpa: std.mem.Allocator, path: []const u8, report: *const fn (event: Event) void = reportToStderr, ... }`
  - `pub fn loadInitial(self: *FileSource) secrets.LoadError!*serve.Generation`
  - `pub fn source(self: *FileSource) serve.Source`
  - `pub const Event = union(enum) { reloaded, kept: secrets.LoadError }`

- [ ] **Step 1: 失敗するテストを書く**

`contrib/sumi/serve_source.zig` を作り、テストだけを書く。実装は Step 3 で書く。テスト部分は次のとおり。

```zig
const testing = std.testing;

/// テスト用の、報告を記録する FileSource。
const Fixture = struct {
    tmp: std.testing.TmpDir,
    path: []u8,
    file_source: FileSource,

    var events: std.ArrayList(Event) = .empty;

    fn record(event: Event) void {
        events.append(testing.allocator, event) catch @panic("OOM");
    }

    fn init(content: []const u8) !Fixture {
        events.clearRetainingCapacity();
        var tmp = testing.tmpDir(.{});
        errdefer tmp.cleanup();
        try tmp.dir.writeFile(.{ .sub_path = "secrets.txt", .data = content });
        const path = try tmp.dir.realpathAlloc(testing.allocator, "secrets.txt");
        return .{
            .tmp = tmp,
            .path = path,
            .file_source = .{ .gpa = testing.allocator, .path = path, .report = record },
        };
    }

    fn deinit(self: *Fixture) void {
        testing.allocator.free(self.path);
        self.tmp.cleanup();
        events.clearAndFree(testing.allocator);
    }

    fn refresh(self: *Fixture) ?*serve.Generation {
        const s = self.file_source.source();
        return s.refreshFn(s.ctx);
    }

    fn write(self: *Fixture, content: []const u8) !void {
        try self.tmp.dir.writeFile(.{ .sub_path = "secrets.txt", .data = content });
    }
};

/// 一覧に value があるかを確かめる。secrets.load は値を patterns.expand で
/// 展開するので、index では値の位置を決められない。
fn expectListed(gen: *const serve.Generation, value: []const u8) !void {
    for (gen.values) |v| if (std.mem.eql(u8, v, value)) return;
    return error.NotListed;
}

/// serve が最後の参照を外したときと同じように、世代を解放する。
fn drop(gen: *serve.Generation) void {
    gen.destroyFn.?(gen);
}

test "loadInitial: reads the list into a generation that its destroyFn frees" {
    var f = try Fixture.init("Tr0ub4dor\n");
    defer f.deinit();
    const gen = try f.file_source.loadInitial();
    defer drop(gen);
    try expectListed(gen, "Tr0ub4dor");
}

test "loadInitial: a missing file is an error and leaks nothing" {
    var f = try Fixture.init("Tr0ub4dor\n");
    defer f.deinit();
    try f.tmp.dir.deleteFile("secrets.txt");
    try testing.expectError(error.Unreadable, f.file_source.loadInitial());
}

test "refresh: an unchanged file is not read again" {
    var f = try Fixture.init("Tr0ub4dor\n");
    defer f.deinit();
    drop(try f.file_source.loadInitial());
    try testing.expect(f.refresh() == null);
    try testing.expectEqual(@as(usize, 0), Fixture.events.items.len);
}

test "refresh: an appended value is in the next generation" {
    var f = try Fixture.init("Tr0ub4dor\n");
    defer f.deinit();
    drop(try f.file_source.loadInitial());
    try f.write("Tr0ub4dor\nhunter2xyz\n");
    const gen = f.refresh() orelse return error.NotReloaded;
    defer drop(gen);
    try expectListed(gen, "hunter2xyz");
    try testing.expectEqual(@as(usize, 1), Fixture.events.items.len);
    try testing.expect(Fixture.events.items[0] == .reloaded);
}

test "refresh: a failed reload is reported once and keeps the previous list" {
    var f = try Fixture.init("Tr0ub4dor\n");
    defer f.deinit();
    drop(try f.file_source.loadInitial());
    try f.write("");
    try testing.expect(f.refresh() == null);
    try testing.expect(f.refresh() == null);
    try testing.expectEqual(@as(usize, 1), Fixture.events.items.len);
    try testing.expectEqual(Event{ .kept = error.Empty }, Fixture.events.items[0]);
    // 直したら読み直す。
    try f.write("hunter2xyz\n");
    const gen = f.refresh() orelse return error.NotReloaded;
    defer drop(gen);
    try expectListed(gen, "hunter2xyz");
}

test "refresh: a file that disappears and comes back is read again" {
    var f = try Fixture.init("Tr0ub4dor\n");
    defer f.deinit();
    drop(try f.file_source.loadInitial());
    try f.tmp.dir.deleteFile("secrets.txt");
    try testing.expect(f.refresh() == null);
    try testing.expect(f.refresh() == null);
    try testing.expectEqual(@as(usize, 1), Fixture.events.items.len);
    try testing.expectEqual(Event{ .kept = error.Unreadable }, Fixture.events.items[0]);
    try f.write("hunter2xyz\n");
    const gen = f.refresh() orelse return error.NotReloaded;
    defer drop(gen);
    try expectListed(gen, "hunter2xyz");
}

test "refresh: a rename over the file is read again even at the same size" {
    var f = try Fixture.init("Tr0ub4dor\n");
    defer f.deinit();
    drop(try f.file_source.loadInitial());
    // 同じサイズ、同じ時刻の刻みに収まりうる書き換えでも、inode が変わる。
    try f.tmp.dir.writeFile(.{ .sub_path = "next.txt", .data = "hunter2xy\n" });
    try f.tmp.dir.rename("next.txt", "secrets.txt");
    const gen = f.refresh() orelse return error.NotReloaded;
    defer drop(gen);
    try expectListed(gen, "hunter2xy");
}
```

`contrib/sumi/main.zig` のテストルートに追加する (`_ = @import("secrets.zig");` の次の行)。

```zig
    _ = @import("serve_source.zig");
```

- [ ] **Step 2: テストを走らせ、失敗することを確かめる**

Run: `cd contrib/sumi && zig build test --summary all`
Expected: コンパイルエラー (`FileSource` などが未定義)。

- [ ] **Step 3: 実装を書く**

`contrib/sumi/serve_source.zig` のテストより上に次を書く。

```zig
//! `sumi serve` の一覧の提供元。secrets ファイルの変更を stat で検出して読み直す。
//!
//! serve は listener が readable になった周回で、accept の前に refresh を呼ぶ。
//! 一覧が使われるのは新しい接続を受け付けたときだけなので、この時点で確かめれば
//! 次の hook と `sumi run` には必ず新しい一覧が使われる。エージェントは接続を
//! 開くだけで accept を起こせるので、変更が無いときの処理は stat 1 回で済ませる。
//!
//! stat は symlink の先を見るので、リンク先の変更も検出できる。エディタが
//! rename で置き換えると inode が変わるので、サイズと時刻が同じでも検出できる。
//! 同じ時刻の刻み (数ミリ秒) の中で、同じサイズのまま in-place で 2 回書き換えると
//! 2 回目は検出できない。次に何か変更されれば、その時点の内容を読む。
//!
//! 読み直しに失敗したら古い一覧を使い続ける。保存の途中 (空や書きかけ) で hook と
//! `sumi run` を全部失敗させないためである。失敗も「試した」と記録するので、
//! ファイルが壊れたままでも警告は変更 1 回につき 1 回になる。
//!
//! 診断には定数の文言と secrets.describe の文言だけを使い、一覧の値は書かない。

const std = @import("std");
const posix = std.posix;
const serve = @import("supervise").serve;
const secrets = @import("secrets.zig");

/// refresh の結果のうち、利用者に知らせるもの。
pub const Event = union(enum) {
    reloaded,
    /// 読み直しに失敗し、前の一覧を使い続ける。
    kept: secrets.LoadError,
};

fn reportToStderr(event: Event) void {
    switch (event) {
        .reloaded => std.debug.print("sumi: reloaded the secrets file\n", .{}),
        .kept => |err| std.debug.print("sumi: kept the previous secrets: {s}\n", .{secrets.describe(err)}),
    }
}

/// stat の結果のうち、ファイルの差し替えと書き換えで変わる値。
/// stat に失敗したとき (ファイルが無い、読めない) は unavailable にする。
const Observed = union(enum) {
    unavailable,
    present: struct {
        dev: u64,
        ino: u64,
        size: i64,
        mtime: posix.timespec,
        ctime: posix.timespec,
    },
};

fn observe(path: []const u8) Observed {
    const st = posix.fstatat(posix.AT.FDCWD, path, 0) catch return .unavailable;
    return .{ .present = .{
        .dev = @intCast(st.dev),
        .ino = @intCast(st.ino),
        .size = @intCast(st.size),
        .mtime = st.mtime(),
        .ctime = st.ctime(),
    } };
}

/// 世代と、その一覧を確保した arena。destroy で @fieldParentPtr により取り出す。
const Owned = struct {
    gen: serve.Generation,
    arena: std.heap.ArenaAllocator,
    gpa: std.mem.Allocator,

    fn destroy(gen: *serve.Generation) void {
        const self: *Owned = @fieldParentPtr("gen", gen);
        const gpa = self.gpa;
        self.arena.deinit();
        gpa.destroy(self);
    }
};

fn loadGeneration(gpa: std.mem.Allocator, path: []const u8) secrets.LoadError!*serve.Generation {
    const owned = gpa.create(Owned) catch return error.OutOfMemory;
    owned.* = .{ .gen = undefined, .arena = .init(gpa), .gpa = gpa };
    errdefer {
        owned.arena.deinit();
        gpa.destroy(owned);
    }
    const values = try secrets.load(owned.arena.allocator(), path);
    owned.gen = .{ .values = values, .destroyFn = Owned.destroy };
    return &owned.gen;
}

pub const FileSource = struct {
    /// 世代の確保に使う。serve の接続と同じく、確保と解放を繰り返すので arena にしない。
    gpa: std.mem.Allocator,
    path: []const u8,
    report: *const fn (event: Event) void = reportToStderr,
    /// 最後に読み込みを試みたときのファイルの状態。
    last: Observed = .unavailable,

    /// 起動時の読み込み。失敗は呼び出し元が起動の失敗として扱うので、報告しない。
    /// stat を読み込みより先に取る。間に変更されても、次の refresh で読み直される。
    pub fn loadInitial(self: *FileSource) secrets.LoadError!*serve.Generation {
        self.last = observe(self.path);
        return loadGeneration(self.gpa, self.path);
    }

    pub fn source(self: *FileSource) serve.Source {
        return .{ .ctx = self, .refreshFn = refresh };
    }

    fn refresh(ctx: *anyopaque) ?*serve.Generation {
        const self: *FileSource = @ptrCast(@alignCast(ctx));
        const now = observe(self.path);
        if (std.meta.eql(now, self.last)) return null;
        self.last = now;
        if (now == .unavailable) {
            self.report(.{ .kept = error.Unreadable });
            return null;
        }
        const gen = loadGeneration(self.gpa, self.path) catch |err| {
            self.report(.{ .kept = err });
            return null;
        };
        self.report(.reloaded);
        return gen;
    }
};
```

注意:
- `posix.Stat` のフィールドの型 (`dev_t`、`ino_t`、`off_t`) はアーキテクチャで違う。`@intCast` で固定の幅に揃える。`dev` が `u64` に収まらない、`size` が負になるなどでコンパイルエラーになる場合は、`Observed` のフィールドの型を `@TypeOf(st.dev)` などに合わせる。
- `std.meta.eql` は union と、`posix.timespec` を含む struct をフィールドごとに比べる。

- [ ] **Step 4: テストを走らせ、通ることを確かめる**

Run: `cd contrib/sumi && zig build test --summary all`
Expected: すべて PASS。`testing.allocator` のリーク報告が無い。

---

### Task 3: sumi serve を読み直しに対応させ、black-box テストと文書を足す

**Files:**
- Modify: `contrib/sumi/main.zig:148-175` (`runServe`)、`:309` (呼び出し)、冒頭の import
- Modify: `contrib/sumi/tests/run-tests.sh` (serve の節、既存の `check "serve writes nothing to stderr while serving"` の直後)
- Modify: `contrib/sumi/README.md:110-112`
- Modify: `contrib/sumi/CHANGELOG.md` (Unreleased の Added の 1 項目目)

**Interfaces:**
- Consumes: Task 1 の `supervise.serve.runWithSource`、Task 2 の `serve_source.FileSource`

- [ ] **Step 1: 失敗する black-box テストを書く**

`contrib/sumi/tests/run-tests.sh` の、`check "serve writes nothing to stderr while serving" ...` の行の直後に追加する。

```bash
reload_secrets="$work/reload-secrets.txt"
reload_sock="$serve_dir/reload.sock"
printf '%s\n' "$current" > "$reload_secrets"
"$sumi" serve --secrets-file "$reload_secrets" --listen "$reload_sock" 2>"$work/reload.err" &
serve_pid=$!
for _ in $(seq 50); do
  "$sumi" run --server "$reload_sock" true >/dev/null 2>&1 && break
  sleep 0.1
done

added="r3l0ad-added1"
out="$("$sumi" run --server "$reload_sock" --shell /bin/bash "printf 'a=%s\n' '$added'")"
check "serve does not mask a value before it is listed" "a=$added" "$out"

printf '%s\n' "$added" >> "$reload_secrets"
out="$("$sumi" run --server "$reload_sock" --shell /bin/bash "printf 'a=%s\n' '$added'")"
record_success_status "run after appending to the served list" "$?"
check "serve masks a value appended to the secrets file" 'a=*************' "$out"

replaced="r3pl4ced-v4lu"
printf '%s\n' "$replaced" > "$work/reload-next.txt"
mv -f "$work/reload-next.txt" "$reload_secrets"
out="$("$sumi" run --server "$reload_sock" --shell /bin/bash "printf 'a=%s b=%s\n' '$replaced' '$added'")"
check "serve uses a secrets file replaced by rename" "a=************* b=$added" "$out"

: > "$reload_secrets"
out="$("$sumi" run --server "$reload_sock" --shell /bin/bash "printf 'a=%s\n' '$replaced'")"
check "serve keeps the previous list when the secrets file becomes empty" 'a=*************' "$out"
out="$("$sumi" run --server "$reload_sock" --shell /bin/bash "printf 'a=%s\n' '$replaced'")"
check "serve keeps the previous list on the next connection too" 'a=*************' "$out"

kill "$serve_pid" 2>/dev/null
wait "$serve_pid" 2>/dev/null
serve_pid=""
check "serve warns once about an unusable secrets file" "1" "$(grep -c 'kept the previous secrets: the secrets file is empty' "$work/reload.err")"
check "serve reports each reload" "2" "$(grep -c 'reloaded the secrets file' "$work/reload.err")"
check "serve does not print listed values" "no" "$(grep -q -e "$added" -e "$replaced" -e "$current" "$work/reload.err" && echo yes || echo no)"
```

- [ ] **Step 2: テストを走らせ、失敗することを確かめる**

Run: `bun run test:sumi-integration`
Expected: `serve masks a value appended to the secrets file` などが FAIL (serve が読み直さないため)。`serve does not mask a value before it is listed` は PASS。

- [ ] **Step 3: runServe を替える**

`contrib/sumi/main.zig` の import に追加する (`const secrets = @import("secrets.zig");` の次の行)。

```zig
const serve_source = @import("serve_source.zig");
```

`runServe` の doc コメントの末尾に 1 文足し、本体の読み込みと `run` の呼び出しを替える。`allocator` は使わなくなるので引数から外し、`dispatch` の呼び出しも `runServe(args)` にする。

```zig
/// serve は一覧をこのプロセスに持ち、`--server` で接続してくる hook と run の
/// 問い合わせに答える。診断は定数の文言と利用者が渡した値だけにし、
/// 接続から届いたバイトは混ぜない (supervise.serve の「出力の不変条件」)。
/// secrets ファイルが変わると、以後の接続で読み直した一覧を使う (serve_source.zig)。
fn runServe(args: []const []const u8) u8 {
    const parsed = parseServeArgs(args) catch return usage("serve takes --secrets-file F --listen ADDR");
    // 不正な ADDR は一覧を読む前に usage エラーにする。待ち受けられない値で
    // 一覧を読み込んでから失敗しても意味が無い。
    const listen = supervise.address.parse(parsed.listen) catch |err| return usage(switch (err) {
        error.SocketPathTooLong => "the --listen socket path must be at most 107 bytes",
        error.InvalidAddress => "--listen must be a socket path, unix:///PATH, tcp://127.0.0.1:PORT or tcp://[::1]:PORT (PORT 1-65535)",
    });
    // 接続ごとに確保と解放を繰り返し、一覧も読み直すたびに作り直すので、
    // arena ではなく解放できるアロケータを使う。
    const gpa = std.heap.page_allocator;
    var file_source: serve_source.FileSource = .{ .gpa = gpa, .path = parsed.secrets_file };
    const initial = file_source.loadInitial() catch |err| {
        std.debug.print("sumi: {s}\n", .{secrets.describe(err)});
        return 1;
    };
    if (listen == .unix) makeSocketDir(listen.unix) catch |err| {
        std.debug.print("sumi: cannot create the directory of the --listen path: {s}\n", .{@errorName(err)});
        return 1;
    };
    return supervise.serve.runWithSource(gpa, initial, file_source.source(), listen) catch |err| {
        if (err == error.ListenPathNotSocket) {
            std.debug.print("sumi: the --listen path exists and is not a socket\n", .{});
            return 1;
        }
        std.debug.print("sumi: serve failed: {s}\n", .{@errorName(err)});
        return 1;
    };
}
```

`makeSocketDir` の失敗で返るときに `initial` は解放されないが、プロセスはすぐに終わるので構わない (既存のコードも一覧を解放せずに返している)。

- [ ] **Step 4: テストを走らせ、通ることを確かめる**

Run: `bun run test:sumi-unit && bun run test:sumi-integration`
Expected: すべて PASS。既存の `serve writes nothing to stderr while serving` も PASS (その serve の間はファイルを変えない)。

- [ ] **Step 5: README を直す**

`contrib/sumi/README.md` の手順 1 の NOTE の 1 項目目を次に替える。

```markdown
> * シークレットファイルを変更すると、`sumi serve` は次の接続から新しい内容を使います。すでに動いているコマンドには反映されません。
> * 変更後の内容を読めないとき (ファイルが空、形式が正しくないなど) は、それまでの内容を使い続け、`sumi serve` の stderr に警告を出します。
```

README の他の箇所に「再起動」「読み直」を含む serve の説明が無いことを確かめる。

Run: `grep -n -E '再起動|読み直' contrib/sumi/README.md`
Expected: ソケットの作り直しに関する行 (Dev Container の節) だけが出る。

- [ ] **Step 6: CHANGELOG に追記する**

`contrib/sumi/CHANGELOG.md` の Unreleased の Added の 1 項目目 (`sumi serve --secrets-file FILE --listen ADDR` で始まる行) の末尾に次の文を足す。`sumi serve` はまだリリースされていないので、別の項目にしない。

```
When the secrets file changes, connections that start afterward use the new values; if the new contents cannot be read, `sumi serve` keeps the previous values and prints a warning.
```

---

### Task 4: 最終確認

- [ ] **Step 1: 共有ライブラリと nas の確認**

Run: `git diff --stat -- src/ && bun run test:process-supervisor-unit && bun run test:mask-filter-unit`
Expected: `src/` に差分が無い。テストはすべて PASS。

- [ ] **Step 2: プロジェクトの完了時の確認**

`skills/post-change-checks/SKILL.md` に従い、リポジトリのルートで `bun run test` と `hostexec bun run test` を順に実行する。1 つ目が失敗しても 2 つ目を実行し、それぞれの結果と skip を分けて報告する。

- [ ] **Step 3: 差分全体を読む**

Run: `git diff`
Expected: Global Constraints に反するもの (`src/mask-filter/` の変更、`serve.zig` の診断出力、経緯を書いたコメント) が無い。`.nas/config.pkl` の既存の変更には触れていない。
