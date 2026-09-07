//! Synchronous Linux descriptor operations for the preload hook and forked
//! gateway. These must remain usable without an event loop or worker threads,
//! including between fork and exec. Zig 0.16 exposes these primitives via libc.
const std = @import("std");
const p = std.posix;
const c = std.c;
pub const Stat = std.os.linux.Statx;
pub const fd_t = p.fd_t;
pub const pid_t = p.pid_t;
pub const sockaddr = p.sockaddr;
pub const socklen_t = p.socklen_t;
pub const O = p.O;
pub const errno = p.errno;
pub fn exit(status: u8) noreturn {
    std.os.linux.exit_group(status);
}

fn failure(e: p.E) anyerror {
    return switch (e) {
        .ACCES, .PERM => error.PermissionDenied,
        .NOENT => error.FileNotFound,
        .EXIST => error.PathAlreadyExists,
        .AGAIN => error.WouldBlock,
        .PIPE => error.BrokenPipe,
        .BADF => error.BadFileDescriptor,
        .CONNRESET => error.ConnectionResetByPeer,
        .CONNREFUSED => error.ConnectionRefused,
        .NOTCONN => error.SocketNotConnected,
        .NAMETOOLONG => error.NameTooLong,
        .NOTDIR => error.NotDir,
        .ISDIR => error.IsDir,
        .LOOP => error.SymLinkLoop,
        .MFILE => error.ProcessFdQuotaExceeded,
        .NFILE => error.SystemFdQuotaExceeded,
        .NOMEM, .NOBUFS => error.SystemResources,
        .CONNABORTED => error.ConnectionAborted,
        .PROTO => error.ProtocolFailure,
        .INPROGRESS => error.WouldBlock,
        .ALREADY => error.ConnectionPending,
        .TIMEDOUT => error.ConnectionTimedOut,
        .SRCH => error.ProcessNotFound,
        .ADDRINUSE => error.AddressInUse,
        else => p.unexpectedErrno(e),
    };
}
fn checked(result: anytype) !@TypeOf(result) {
    const e = p.errno(result);
    if (e != .SUCCESS) return failure(e);
    return result;
}
pub fn close(fd: fd_t) void {
    _ = c.close(fd);
}
pub fn getenv(name: [:0]const u8) ?[:0]const u8 {
    return std.mem.span(c.getenv(name.ptr) orelse return null);
}
pub fn write(fd: fd_t, bytes: []const u8) !usize {
    while (true) {
        const n = c.write(fd, bytes.ptr, bytes.len);
        if (p.errno(n) == .INTR) continue;
        return @intCast(try checked(n));
    }
}
pub fn writeAll(fd: fd_t, bytes: []const u8) !void {
    var offset: usize = 0;
    while (offset < bytes.len) {
        const n = try write(fd, bytes[offset..]);
        if (n == 0) return error.WriteZero;
        offset += n;
    }
}
pub fn open(path: []const u8, flags: O, mode: p.mode_t) !fd_t {
    return p.openat(p.AT.FDCWD, path, flags, mode);
}
pub fn fcntl(fd: fd_t, cmd: i32, arg: usize) !usize {
    while (true) {
        const n = c.fcntl(fd, cmd, arg);
        if (p.errno(n) == .INTR) continue;
        return @intCast(try checked(n));
    }
}
pub fn pipe() ![2]fd_t {
    return pipe2(.{});
}
pub fn pipe2(flags: O) ![2]fd_t {
    var fds: [2]fd_t = undefined;
    _ = try checked(c.pipe2(&fds, flags));
    return fds;
}
pub fn dup(fd: fd_t) !fd_t {
    return try checked(c.dup(fd));
}
pub fn dup2(old: fd_t, new: fd_t) !void {
    while (true) {
        const n = c.dup2(old, new);
        if (p.errno(n) == .INTR or p.errno(n) == .BUSY) continue;
        _ = try checked(n);
        return;
    }
}
pub fn fork() !pid_t {
    return try checked(c.fork());
}
pub const WaitPidResult = struct { pid: pid_t, status: u32 };
pub fn waitpid(pid: pid_t, flags: u32) WaitPidResult {
    var status: c_int = 0;
    while (true) {
        const result = c.waitpid(pid, &status, @intCast(flags));
        switch (p.errno(result)) {
            .SUCCESS => return .{ .pid = result, .status = @bitCast(status) },
            .INTR => continue,
            else => unreachable,
        }
    }
}
pub fn setpgid(pid: pid_t, pgid: pid_t) !void {
    _ = try checked(c.setpgid(pid, pgid));
}
pub fn execveZ(path: [*:0]const u8, argv: [*:null]const ?[*:0]const u8, env: [*:null]const ?[*:0]const u8) anyerror {
    return failure(p.errno(c.execve(path, argv, env)));
}
pub fn getcwd(buf: []u8) ![]u8 {
    const ptr = c.getcwd(buf.ptr, buf.len) orelse return failure(p.errno(@as(c_int, -1)));
    return std.mem.span(@as([*:0]u8, @ptrCast(ptr)));
}
pub fn realpathAlloc(allocator: std.mem.Allocator, path: []const u8) ![]u8 {
    const z = try p.toPosixPath(path);
    var buf: [std.fs.max_path_bytes:0]u8 = undefined;
    const ptr = c.realpath(&z, &buf) orelse return failure(p.errno(@as(c_int, -1)));
    return allocator.dupe(u8, std.mem.span(ptr));
}
pub fn access(path: []const u8, mode: u32) !void {
    const z = try p.toPosixPath(path);
    _ = try checked(c.access(&z, mode));
}
pub fn mkdir(path: []const u8, mode: p.mode_t) !void {
    const z = try p.toPosixPath(path);
    _ = try checked(c.mkdir(&z, mode));
}
pub fn unlink(path: []const u8) !void {
    const z = try p.toPosixPath(path);
    _ = try checked(c.unlink(&z));
}
pub fn readlink(path: []const u8, buf: []u8) ![]u8 {
    const z = try p.toPosixPath(path);
    const n = try checked(c.readlink(&z, buf.ptr, buf.len));
    return buf[0..@intCast(n)];
}
pub fn fchmodat(fd: fd_t, path: []const u8, mode: p.mode_t, flags: u32) !void {
    const z = try p.toPosixPath(path);
    _ = try checked(c.fchmodat(fd, &z, mode, flags));
}
pub fn isatty(fd: fd_t) bool {
    return c.isatty(fd) == 1;
}
pub fn socket(domain: u32, kind: u32, protocol: u32) !fd_t {
    return try checked(c.socket(domain, kind, protocol));
}
pub fn bind(fd: fd_t, address: *const sockaddr, len: socklen_t) !void {
    _ = try checked(c.bind(fd, address, len));
}
pub fn listen(fd: fd_t, backlog: u31) !void {
    _ = try checked(c.listen(fd, backlog));
}
pub fn connect(fd: fd_t, address: *const sockaddr, len: socklen_t) !void {
    while (true) {
        const n = c.connect(fd, address, len);
        if (p.errno(n) == .INTR) continue;
        _ = try checked(n);
        return;
    }
}
pub fn accept(fd: fd_t, address: ?*sockaddr, len: ?*socklen_t, flags: u32) !fd_t {
    while (true) {
        const n = c.accept4(fd, address, len, flags);
        if (p.errno(n) == .INTR) continue;
        return try checked(n);
    }
}
pub fn getsockname(fd: fd_t, address: *sockaddr, len: *socklen_t) !void {
    _ = try checked(c.getsockname(fd, address, len));
}
pub fn shutdown(fd: fd_t, how: enum { recv, send, both }) !void {
    _ = try checked(c.shutdown(fd, switch (how) {
        .recv => p.SHUT.RD,
        .send => p.SHUT.WR,
        .both => p.SHUT.RDWR,
    }));
}
pub fn send(fd: fd_t, bytes: []const u8, flags: u32) !usize {
    while (true) {
        const n = c.send(fd, bytes.ptr, bytes.len, flags);
        if (p.errno(n) == .INTR) continue;
        return @intCast(try checked(n));
    }
}
pub fn sendmsg(fd: fd_t, msg: *const std.os.linux.msghdr_const, flags: u32) !usize {
    while (true) {
        const n = std.os.linux.sendmsg(fd, msg, flags);
        const e = std.os.linux.errno(n);
        if (e == .INTR) continue;
        if (e != .SUCCESS) return failure(e);
        return n;
    }
}
pub const Stream = struct {
    handle: fd_t,
    pub fn read(self: Stream, bytes: []u8) !usize {
        return p.read(self.handle, bytes);
    }
    pub fn close(self: Stream) void {
        closeFd(self.handle);
    }
};
const closeFd = close;
pub fn connectUnixSocket(path: []const u8) !Stream {
    var address: p.sockaddr.un = .{ .family = p.AF.UNIX, .path = @splat(0) };
    if (path.len >= address.path.len) return error.NameTooLong;
    @memcpy(address.path[0..path.len], path);
    const fd = try socket(p.AF.UNIX, p.SOCK.STREAM | p.SOCK.CLOEXEC, 0);
    errdefer close(fd);
    try connect(fd, @ptrCast(&address), @intCast(@offsetOf(p.sockaddr.un, "path") + path.len + 1));
    return .{ .handle = fd };
}
pub fn sleep(ns: u64) void {
    var remaining: c.timespec = .{ .sec = @intCast(ns / std.time.ns_per_s), .nsec = @intCast(ns % std.time.ns_per_s) };
    while (c.nanosleep(&remaining, &remaining) != 0) {
        if (p.errno(@as(c_int, -1)) != .INTR) return;
    }
}
pub const Timer = struct {
    started: u64,
    fn now() !u64 {
        var ts: c.timespec = undefined;
        _ = try checked(c.clock_gettime(.MONOTONIC, &ts));
        return @as(u64, @intCast(ts.sec)) * std.time.ns_per_s + @as(u64, @intCast(ts.nsec));
    }
    pub fn start() !Timer {
        return .{ .started = try now() };
    }
    pub fn read(self: *Timer) u64 {
        return (now() catch self.started) -| self.started;
    }
    pub fn reset(self: *Timer) void {
        self.started = now() catch self.started;
    }
};
pub const AF = p.AF;
pub const AT = p.AT;
pub const F = p.F;
pub const POLL = p.POLL;
pub const SHUT = p.SHUT;
pub const SIG = p.SIG;
pub const SO = p.SO;
pub const SOCK = p.SOCK;
pub const SOL = p.SOL;
pub const STDERR_FILENO = p.STDERR_FILENO;
pub const STDIN_FILENO = p.STDIN_FILENO;
pub const STDOUT_FILENO = p.STDOUT_FILENO;
pub const Sigaction = p.Sigaction;
pub const W = p.W;
pub const X_OK = p.X_OK;
pub const iovec = p.iovec;
pub const iovec_const = p.iovec_const;
pub const kill = p.kill;
pub const poll = p.poll;
pub const pollfd = p.pollfd;
pub const setsockopt = p.setsockopt;
pub const sigaction = p.sigaction;
pub const sigaddset = p.sigaddset;
pub const sigemptyset = p.sigemptyset;
pub const sigismember = p.sigismember;
pub const sigprocmask = p.sigprocmask;
pub const sigset_t = p.sigset_t;

pub fn milliTimestamp() i64 {
    return @intCast((Timer.now() catch 0) / std.time.ns_per_ms);
}

pub fn isRegularFile(path: []const u8) bool {
    const z = p.toPosixPath(path) catch return false;
    var stat: Stat = undefined;
    if (std.os.linux.statx(p.AT.FDCWD, &z, 0, .{ .TYPE = true }, &stat) != 0) return false;
    return stat.mask.TYPE and stat.mode & p.S.IFMT == p.S.IFREG;
}

pub fn randomBytes(bytes: []u8) void {
    var offset: usize = 0;
    while (offset < bytes.len) {
        const n = std.os.linux.getrandom(bytes[offset..].ptr, bytes.len - offset, 0);
        switch (std.os.linux.errno(n)) {
            .SUCCESS => offset += n,
            .INTR => continue,
            else => @panic("getrandom failed"),
        }
    }
}

pub const read = p.read;
pub fn fstat(fd: fd_t, stat: *Stat) usize {
    return std.os.linux.statx(fd, "", std.os.linux.AT.EMPTY_PATH, .{ .INO = true, .TYPE = true }, stat);
}

pub fn lseek_SET(fd: fd_t, offset: u64) !void {
    _ = try checked(c.lseek(fd, @intCast(offset), p.SEEK.SET));
}

pub fn lseek_CUR_get(fd: fd_t) !u64 {
    return @intCast(try checked(c.lseek(fd, 0, p.SEEK.CUR)));
}
