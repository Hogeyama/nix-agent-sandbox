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
    /// 世代の確保に使う。読み直すたびに確保と解放を繰り返すので arena にしない。
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
