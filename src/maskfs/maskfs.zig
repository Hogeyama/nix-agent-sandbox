//! nas-maskfs — ワークスペースのマスク済みビューを提供する FUSE パススルー FS。
//!
//! 使い方: nas-maskfs <sourceDir> <mountpoint> --write-policy=readonly|passthrough [--allow-other]
//! 秘密値は stdin から読む: u32le count, その後 count 個の [u32le len + bytes]。
//! foreground (-f) / single-thread (-s) で fuse_main を実行する。

const std = @import("std");
const mask = @import("mask.zig");

const c = @cImport({
    @cDefine("FUSE_USE_VERSION", "31");
    @cDefine("_FILE_OFFSET_BITS", "64");
    @cInclude("fuse3/fuse.h");
    @cInclude("fcntl.h");
    @cInclude("unistd.h");
    @cInclude("sys/stat.h");
    @cInclude("sys/statvfs.h");
    @cInclude("dirent.h");
    @cInclude("errno.h");
    @cInclude("stdio.h"); // for renameat
});

const WritePolicy = enum { readonly, passthrough };

// ---------------------------------------------------------------------------
// fuse_file_info: Zig translate-c renders this as opaque because it contains
// bitfields, so we define an ABI-compatible extern struct manually.
// ---------------------------------------------------------------------------

const FuseFileInfo = extern struct {
    flags: i32,
    _bitfield1: u32,
    _padding2: u32,
    _padding3: u32,
    fh: u64,
    lock_owner: u64,
    poll_events: u32,
    backing_id: i32,
    compat_flags: u64,
    _reserved: [2]u64,
};

/// Cast opaque fuse_file_info pointer to our typed struct.
inline fn castFi(fi: ?*c.struct_fuse_file_info) ?*FuseFileInfo {
    return @ptrCast(@alignCast(fi));
}

// ---------------------------------------------------------------------------
// グローバル状態 (シングルスレッド前提: -s で mount する)
// ---------------------------------------------------------------------------

var gpa = std.heap.GeneralPurposeAllocator(.{}){};
const allocator = gpa.allocator();

var src_fd: c_int = -1;
var secrets: [][]u8 = &.{};
var max_len: usize = 0;
var write_policy: WritePolicy = .readonly;

// 秘密値含有判定キャッシュ (direct-mapped)
const CacheEntry = struct {
    ino: u64 = 0,
    mtime_sec: i64 = 0,
    mtime_nsec: i64 = 0,
    size: i64 = 0,
    valid: bool = false,
    contains: bool = false,
};
var scan_cache: [128]CacheEntry = [_]CacheEntry{.{}} ** 128;

fn errnoNeg() c_int {
    return -std.c._errno().*;
}

/// FUSE のパスは "/" 始まり。openat 用に相対化する。
fn relPath(path: [*c]const u8) [*c]const u8 {
    if (path[0] == '/' and path[1] != 0) return path + 1;
    if (path[0] == '/' and path[1] == 0) return ".";
    return path;
}

// ---------------------------------------------------------------------------
// 秘密値含有スキャン (write-policy=readonly 用)
// ---------------------------------------------------------------------------

fn fdContainsSecret(fd: c_int) bool {
    if (max_len == 0) return false;
    const carry = max_len - 1;
    const chunk = 64 * 1024;
    const buf = allocator.alloc(u8, carry + chunk) catch return true; // fail-closed
    defer allocator.free(buf);

    var filled: usize = 0; // buf 先頭に保持している carry バイト数
    var pos: i64 = 0;
    while (true) {
        const n = c.pread(fd, buf.ptr + filled, chunk, pos);
        if (n < 0) return true; // fail-closed
        if (n == 0) break;
        const got: usize = @intCast(n);
        if (mask.containsAny(buf[0 .. filled + got], secrets)) return true;
        pos += n;
        // 末尾 carry バイトを次のチャンクの先頭に引き継ぐ
        const total = filled + got;
        const keep = @min(carry, total);
        std.mem.copyForwards(u8, buf[0..keep], buf[total - keep .. total]);
        filled = keep;
    }
    return false;
}

/// path (source 相対) のファイルが秘密値を含むか。stat 失敗時 ENOENT は false、
/// それ以外・open 失敗は fail-closed で true。
fn pathContainsSecret(rel: [*c]const u8) bool {
    var st: c.struct_stat = undefined;
    if (c.fstatat(src_fd, rel, &st, c.AT_SYMLINK_NOFOLLOW) == -1) {
        return std.c._errno().* != c.ENOENT;
    }
    // 通常ファイル以外 (dir/symlink/fifo...) はスキャン対象外
    if ((st.st_mode & c.S_IFMT) != c.S_IFREG) return false;

    const slot = &scan_cache[@intCast(st.st_ino % scan_cache.len)];
    if (slot.valid and slot.ino == st.st_ino and
        slot.mtime_sec == st.st_mtim.tv_sec and
        slot.mtime_nsec == st.st_mtim.tv_nsec and
        slot.size == st.st_size)
    {
        return slot.contains;
    }

    const fd = c.openat(src_fd, rel, c.O_RDONLY);
    if (fd == -1) return true; // fail-closed
    defer _ = c.close(fd);
    const contains = fdContainsSecret(fd);

    slot.* = .{
        .ino = st.st_ino,
        .mtime_sec = st.st_mtim.tv_sec,
        .mtime_nsec = st.st_mtim.tv_nsec,
        .size = st.st_size,
        .valid = true,
        .contains = contains,
    };
    return contains;
}

/// readonly ポリシーで書き込み系操作を拒否すべきなら EROFS (負値) を返す。
fn denyIfProtected(rel: [*c]const u8) c_int {
    if (write_policy == .passthrough) return 0;
    if (pathContainsSecret(rel)) return -c.EROFS;
    return 0;
}

// ---------------------------------------------------------------------------
// FUSE operations
// ---------------------------------------------------------------------------

fn xGetattr(path: [*c]const u8, st: ?*c.struct_stat, fi: ?*c.fuse_file_info) callconv(.c) c_int {
    _ = fi;
    if (c.fstatat(src_fd, relPath(path), st, c.AT_SYMLINK_NOFOLLOW) == -1) return errnoNeg();
    return 0;
}

fn xReadlink(path: [*c]const u8, buf: [*c]u8, size: usize) callconv(.c) c_int {
    const n = c.readlinkat(src_fd, relPath(path), buf, size - 1);
    if (n == -1) return errnoNeg();
    buf[@intCast(n)] = 0;
    return 0;
}

fn xReaddir(
    path: [*c]const u8,
    buf: ?*anyopaque,
    filler: c.fuse_fill_dir_t,
    offset: c.off_t,
    fi: ?*c.fuse_file_info,
    flags: c.fuse_readdir_flags,
) callconv(.c) c_int {
    _ = offset;
    _ = fi;
    _ = flags;
    const dfd = c.openat(src_fd, relPath(path), c.O_RDONLY | c.O_DIRECTORY);
    if (dfd == -1) return errnoNeg();
    const dir = c.fdopendir(dfd) orelse {
        _ = c.close(dfd);
        return errnoNeg();
    };
    defer _ = c.closedir(dir);
    while (true) {
        std.c._errno().* = 0;
        const ent = c.readdir(dir) orelse {
            // readdir NULL can mean end-of-directory or error; check errno.
            const e = std.c._errno().*;
            return if (e != 0) -e else 0;
        };
        if (filler.?(buf, &ent.*.d_name, null, 0, 0) != 0) break;
    }
    return 0;
}

fn xOpen(path: [*c]const u8, fi_raw: ?*c.fuse_file_info) callconv(.c) c_int {
    const fi = castFi(fi_raw).?;
    const rel = relPath(path);
    const accmode = fi.flags & c.O_ACCMODE;
    const wants_write = accmode != c.O_RDONLY or (fi.flags & c.O_TRUNC) != 0;
    if (wants_write) {
        const deny = denyIfProtected(rel);
        if (deny != 0) return deny;
    }
    const fd = c.openat(src_fd, rel, fi.flags);
    if (fd == -1) return errnoNeg();
    fi.fh = @intCast(fd);
    return 0;
}

fn xCreate(path: [*c]const u8, mode: c.mode_t, fi_raw: ?*c.fuse_file_info) callconv(.c) c_int {
    const fi = castFi(fi_raw).?;
    const rel = relPath(path);
    // xCreate can be called for existing files when the FUSE dentry cache is
    // cold (O_CREAT on a file that already exists). Check write protection so
    // that secret-containing files are not truncated in readonly mode.
    // For genuinely new files, denyIfProtected returns 0 (ENOENT -> false).
    const deny = denyIfProtected(rel);
    if (deny != 0) return deny;
    const fd = c.openat(src_fd, rel, fi.flags, mode);
    if (fd == -1) return errnoNeg();
    fi.fh = @intCast(fd);
    return 0;
}

fn xRead(
    path: [*c]const u8,
    buf: [*c]u8,
    size: usize,
    offset: c.off_t,
    fi_raw: ?*c.fuse_file_info,
) callconv(.c) c_int {
    _ = path;
    const fi = castFi(fi_raw).?;
    const fd: c_int = @intCast(fi.fh);
    if (max_len == 0) {
        const n = c.pread(fd, buf, size, offset);
        if (n == -1) return errnoNeg();
        return @intCast(n);
    }
    const win = mask.computeWindow(@intCast(offset), size, max_len);
    const wbuf = allocator.alloc(u8, win.len) catch return -c.ENOMEM;
    defer allocator.free(wbuf);
    const n = c.pread(fd, wbuf.ptr, win.len, @intCast(win.start));
    if (n == -1) return errnoNeg();
    const got: usize = @intCast(n);
    mask.maskAll(wbuf[0..got], secrets);
    if (got <= win.lead) return 0;
    const out_len = @min(got - win.lead, size);
    @memcpy(buf[0..out_len], wbuf[win.lead .. win.lead + out_len]);
    return @intCast(out_len);
}

fn xWrite(
    path: [*c]const u8,
    buf: [*c]const u8,
    size: usize,
    offset: c.off_t,
    fi_raw: ?*c.fuse_file_info,
) callconv(.c) c_int {
    _ = path; // open/create 時点でポリシー適用済み
    const fi = castFi(fi_raw).?;
    const fd: c_int = @intCast(fi.fh);
    const n = c.pwrite(fd, buf, size, offset);
    if (n == -1) return errnoNeg();
    return @intCast(n);
}

fn xTruncate(path: [*c]const u8, size: c.off_t, fi_raw: ?*c.fuse_file_info) callconv(.c) c_int {
    const rel = relPath(path);
    const deny = denyIfProtected(rel);
    if (deny != 0) return deny;
    if (castFi(fi_raw)) |fi| {
        if (c.ftruncate(@intCast(fi.fh), size) == -1) return errnoNeg();
        return 0;
    }
    const fd = c.openat(src_fd, rel, c.O_WRONLY);
    if (fd == -1) return errnoNeg();
    defer _ = c.close(fd);
    if (c.ftruncate(fd, size) == -1) return errnoNeg();
    return 0;
}

fn xUnlink(path: [*c]const u8) callconv(.c) c_int {
    const rel = relPath(path);
    const deny = denyIfProtected(rel);
    if (deny != 0) return deny;
    if (c.unlinkat(src_fd, rel, 0) == -1) return errnoNeg();
    return 0;
}

fn xRename(from: [*c]const u8, to: [*c]const u8, flags: c_uint) callconv(.c) c_int {
    if (flags != 0) return -c.EINVAL;
    const rel_from = relPath(from);
    const rel_to = relPath(to);
    var deny = denyIfProtected(rel_from);
    if (deny != 0) return deny;
    deny = denyIfProtected(rel_to); // 上書きされる側も保護
    if (deny != 0) return deny;
    if (c.renameat(src_fd, rel_from, src_fd, rel_to) == -1) return errnoNeg();
    return 0;
}

fn xMkdir(path: [*c]const u8, mode: c.mode_t) callconv(.c) c_int {
    if (c.mkdirat(src_fd, relPath(path), mode) == -1) return errnoNeg();
    return 0;
}

fn xRmdir(path: [*c]const u8) callconv(.c) c_int {
    if (c.unlinkat(src_fd, relPath(path), c.AT_REMOVEDIR) == -1) return errnoNeg();
    return 0;
}

fn xSymlink(target: [*c]const u8, linkpath: [*c]const u8) callconv(.c) c_int {
    if (c.symlinkat(target, src_fd, relPath(linkpath)) == -1) return errnoNeg();
    return 0;
}

fn xLink(from: [*c]const u8, to: [*c]const u8) callconv(.c) c_int {
    if (c.linkat(src_fd, relPath(from), src_fd, relPath(to), 0) == -1) return errnoNeg();
    return 0;
}

fn xChmod(path: [*c]const u8, mode: c.mode_t, fi: ?*c.fuse_file_info) callconv(.c) c_int {
    _ = fi;
    if (c.fchmodat(src_fd, relPath(path), mode, 0) == -1) return errnoNeg();
    return 0;
}

fn xChown(path: [*c]const u8, uid: c.uid_t, gid: c.gid_t, fi: ?*c.fuse_file_info) callconv(.c) c_int {
    _ = fi;
    if (c.fchownat(src_fd, relPath(path), uid, gid, c.AT_SYMLINK_NOFOLLOW) == -1) return errnoNeg();
    return 0;
}

fn xUtimens(path: [*c]const u8, tv: [*c]const c.struct_timespec, fi: ?*c.fuse_file_info) callconv(.c) c_int {
    _ = fi;
    if (c.utimensat(src_fd, relPath(path), tv, c.AT_SYMLINK_NOFOLLOW) == -1) return errnoNeg();
    return 0;
}

fn xStatfs(path: [*c]const u8, st: ?*c.struct_statvfs) callconv(.c) c_int {
    _ = path;
    if (c.fstatvfs(src_fd, st) == -1) return errnoNeg();
    return 0;
}

fn xRelease(path: [*c]const u8, fi_raw: ?*c.fuse_file_info) callconv(.c) c_int {
    _ = path;
    const fi = castFi(fi_raw).?;
    _ = c.close(@intCast(fi.fh));
    return 0;
}

fn xFsync(path: [*c]const u8, datasync: c_int, fi_raw: ?*c.fuse_file_info) callconv(.c) c_int {
    _ = path;
    const fi = castFi(fi_raw).?;
    const fd: c_int = @intCast(fi.fh);
    const res = if (datasync != 0) c.fdatasync(fd) else c.fsync(fd);
    if (res == -1) return errnoNeg();
    return 0;
}

// ---------------------------------------------------------------------------
// stdin フレーミング: u32le count, then count x [u32le len + bytes]
// ---------------------------------------------------------------------------

fn readSecretsFromStdin() ![][]u8 {
    const stdin = std.fs.File.stdin();
    const reader = stdin.deprecatedReader();
    const count = try reader.readInt(u32, .little);
    if (count > 1024) return error.TooManySecrets;
    const list = try allocator.alloc([]u8, count);
    var i: usize = 0;
    while (i < count) : (i += 1) {
        const len = try reader.readInt(u32, .little);
        if (len == 0 or len > 16 * 1024 * 1024) return error.InvalidSecretLength;
        const s = try allocator.alloc(u8, len);
        try reader.readNoEof(s);
        list[i] = s;
    }
    return list;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

pub fn main() !u8 {
    const argv = std.os.argv;
    if (argv.len < 4) {
        std.debug.print("usage: nas-maskfs <sourceDir> <mountpoint> --write-policy=readonly|passthrough [--allow-other]\n", .{});
        return 2;
    }
    const source = argv[1];
    const mountpoint = argv[2];
    var allow_other = false;
    for (argv[3..]) |arg| {
        const a = std.mem.span(arg);
        if (std.mem.eql(u8, a, "--write-policy=readonly")) {
            write_policy = .readonly;
        } else if (std.mem.eql(u8, a, "--write-policy=passthrough")) {
            write_policy = .passthrough;
        } else if (std.mem.eql(u8, a, "--allow-other")) {
            allow_other = true;
        } else {
            std.debug.print("unknown argument: {s}\n", .{a});
            return 2;
        }
    }

    secrets = try readSecretsFromStdin();
    max_len = mask.maxSecretLen(secrets);
    if (secrets.len == 0) {
        std.debug.print("nas-maskfs: refusing to start with zero secrets\n", .{});
        return 2;
    }

    src_fd = c.open(source, c.O_RDONLY | c.O_DIRECTORY);
    if (src_fd == -1) {
        std.debug.print("nas-maskfs: cannot open source dir\n", .{});
        return 1;
    }

    var ops = std.mem.zeroes(c.struct_fuse_operations);
    ops.getattr = xGetattr;
    ops.readlink = xReadlink;
    ops.mkdir = xMkdir;
    ops.unlink = xUnlink;
    ops.rmdir = xRmdir;
    ops.symlink = xSymlink;
    ops.rename = xRename;
    ops.link = xLink;
    ops.chmod = xChmod;
    ops.chown = xChown;
    ops.truncate = xTruncate;
    ops.open = xOpen;
    ops.read = xRead;
    ops.write = xWrite;
    ops.statfs = xStatfs;
    ops.release = xRelease;
    ops.fsync = xFsync;
    ops.readdir = xReaddir;
    ops.create = xCreate;
    ops.utimens = xUtimens;

    // fuse_main 引数: foreground + single-thread + permissions
    var fuse_args: std.ArrayList([*c]const u8) = .{};
    defer fuse_args.deinit(allocator);
    try fuse_args.append(allocator, "nas-maskfs");
    try fuse_args.append(allocator, mountpoint);
    try fuse_args.append(allocator, "-f");
    try fuse_args.append(allocator, "-s");
    try fuse_args.append(allocator, "-o");
    try fuse_args.append(allocator, if (allow_other) "default_permissions,allow_other" else "default_permissions");

    const rc = c.fuse_main_fn(
        @intCast(fuse_args.items.len),
        @constCast(@ptrCast(fuse_args.items.ptr)),
        &ops,
        null,
    );
    if (rc < 0) return 1;
    return @intCast(rc);
}
