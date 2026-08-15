const std = @import("std");

pub const StdinSelection = union(enum) {
    none,
    pass_fd: std.posix.fd_t,
    reject_read_write,
};

pub fn selectStdin(fd: std.posix.fd_t, capable: bool) StdinSelection {
    if (!capable) return .none;
    if (std.posix.isatty(fd)) return .none;
    // The std.posix fcntl wrapper treats EBADF as an unreachable race. This
    // classification intentionally accepts a closed descriptor as input, so
    // use libc directly and make every failure a non-forwardable result.
    const raw_flags = std.c.fcntl(fd, std.c.F.GETFL, @as(c_int, 0));
    if (raw_flags < 0) return .none;
    return switch (@as(usize, @intCast(raw_flags)) & 0o3) {
        0o0 => .{ .pass_fd = fd },
        0o2 => .reject_read_write,
        else => .none,
    };
}

pub const ReceivedLine = struct {
    allocator: std.mem.Allocator,
    line: []u8,
    stdin_fd: ?std.posix.fd_t,
    deinitialized: bool = false,

    pub fn deinit(self: *ReceivedLine) void {
        if (self.deinitialized) return;
        self.deinitialized = true;
        if (self.stdin_fd) |fd| {
            std.posix.close(fd);
            self.stdin_fd = null;
        }
        self.allocator.free(self.line);
        self.line = self.line[0..0];
    }
};

pub fn sendLine(socket_fd: std.posix.fd_t, line: []const u8, stdin_fd: ?std.posix.fd_t) !void {
    return sendLineWith(std.posix.sendmsg, std.posix.write, socket_fd, line, stdin_fd);
}

fn sendLineWith(
    comptime sendFn: anytype,
    comptime writeFn: anytype,
    socket_fd: std.posix.fd_t,
    line: []const u8,
    stdin_fd: ?std.posix.fd_t,
) !void {
    var iov = [_]std.posix.iovec_const{.{
        .base = line.ptr,
        .len = line.len,
    }};

    var control: [cmsgSpace(@sizeOf(std.posix.fd_t))]u8 align(@alignOf(LinuxCmsghdr)) = undefined;
    var message = std.os.linux.msghdr_const{
        .name = null,
        .namelen = 0,
        .iov = &iov,
        .iovlen = 1,
        .control = null,
        .controllen = 0,
        .flags = 0,
    };

    if (stdin_fd) |fd| {
        const header: *LinuxCmsghdr = @ptrCast(@alignCast(&control));
        header.* = .{
            .len = cmsgLen(@sizeOf(std.posix.fd_t)),
            .level = std.posix.SOL.SOCKET,
            .type = scm_rights,
        };
        const fd_ptr: *std.posix.fd_t = @ptrCast(@alignCast(control[0..].ptr + cmsgAlign(@sizeOf(LinuxCmsghdr))));
        fd_ptr.* = fd;
        message.control = &control;
        message.controllen = control.len;
    }

    const sent = try sendFn(socket_fd, &message, std.os.linux.MSG.NOSIGNAL);
    var offset = sent;
    if (sent == 0 and line.len != 0) return error.ZeroProgress;
    if (offset > line.len) return error.InvalidSendCount;

    // Once the first successful sendmsg has attached SCM_RIGHTS, all
    // remaining bytes must be ordinary writes: sending the ancillary data a
    // second time would hand the gateway duplicate stdin descriptors.
    while (offset < line.len) {
        const written = try writeFn(socket_fd, line[offset..]);
        if (written == 0) return error.ZeroProgress;
        offset += written;
    }
}

pub fn receiveLine(allocator: std.mem.Allocator, socket_fd: std.posix.fd_t, max_bytes: usize) !ReceivedLine {
    var line: std.ArrayList(u8) = .{};
    defer line.deinit(allocator);

    var received_fd: ?std.posix.fd_t = null;
    errdefer if (received_fd) |fd| std.posix.close(fd);

    var data: [initial_data_bytes]u8 = undefined;
    var iov = [_]std.posix.iovec{.{
        .base = data[0..].ptr,
        .len = data.len,
    }};
    var control: [receive_control_bytes]u8 align(@alignOf(LinuxCmsghdr)) = undefined;
    var message = std.os.linux.msghdr{
        .name = null,
        .namelen = 0,
        .iov = &iov,
        .iovlen = 1,
        .control = &control,
        .controllen = control.len,
        .flags = 0,
    };

    const first_count = try recvmsg(socket_fd, &message);
    parseControlMessages(
        control[0..@min(message.controllen, control.len)],
        &received_fd,
    ) catch |err| {
        if ((message.flags & std.os.linux.MSG.CTRUNC) != 0 or message.controllen > control.len) {
            return error.ControlMessageTruncated;
        }
        return err;
    };
    if ((message.flags & std.os.linux.MSG.CTRUNC) != 0 or message.controllen > control.len) {
        return error.ControlMessageTruncated;
    }
    if (first_count == 0) return error.EndOfStream;

    var chunk = data[0..first_count];
    while (true) {
        if (std.mem.indexOfScalar(u8, chunk, '\n')) |newline| {
            if (line.items.len + newline > max_bytes) return error.MessageTooLong;
            try line.appendSlice(allocator, chunk[0..newline]);
            if (newline + 1 != chunk.len) return error.TrailingData;
            const owned = try line.toOwnedSlice(allocator);
            return .{
                .allocator = allocator,
                .line = owned,
                .stdin_fd = received_fd,
            };
        }

        if (line.items.len + chunk.len > max_bytes) return error.MessageTooLong;
        try line.appendSlice(allocator, chunk);

        // When exactly max_bytes have arrived, read one byte at a time so a
        // newline immediately after the limit is accepted while any other
        // byte is rejected without growing the buffer past its bound.
        const read_len: usize = if (line.items.len >= max_bytes) 1 else data.len;
        const count = try std.posix.read(socket_fd, data[0..read_len]);
        if (count == 0) return error.EndOfStream;
        chunk = data[0..count];
    }
}

const scm_rights: i32 = 1;
const initial_data_bytes = 4096;
const max_receive_fds = 64;

const LinuxCmsghdr = extern struct {
    len: usize,
    level: i32,
    type: i32,
};

fn cmsgAlign(n: usize) usize {
    const a = @alignOf(usize);
    return (n + a - 1) & ~@as(usize, a - 1);
}

fn cmsgLen(payload_len: usize) usize {
    return cmsgAlign(@sizeOf(LinuxCmsghdr)) + payload_len;
}

fn cmsgSpace(payload_len: usize) usize {
    return cmsgAlign(@sizeOf(LinuxCmsghdr)) + cmsgAlign(payload_len);
}

const receive_control_bytes = cmsgSpace(@sizeOf(std.posix.fd_t) * max_receive_fds);

fn recvmsg(socket_fd: std.posix.fd_t, message: *std.os.linux.msghdr) !usize {
    while (true) {
        const result = std.c.recvmsg(socket_fd, message, std.os.linux.MSG.CMSG_CLOEXEC);
        if (result >= 0) return @intCast(result);
        switch (std.posix.errno(result)) {
            .INTR => continue,
            .AGAIN => return error.WouldBlock,
            .BADF => return error.BadFileDescriptor,
            .CONNRESET => return error.ConnectionResetByPeer,
            else => return error.TransportReceiveFailed,
        }
    }
}

fn parseControlMessages(control: []const u8, received_fd: *?std.posix.fd_t) !void {
    var offset: usize = 0;
    var first_error: ?anyerror = null;
    var received_count: usize = 0;
    while (offset < control.len) {
        const remaining = control.len - offset;
        if (remaining < @sizeOf(LinuxCmsghdr)) {
            if (first_error == null) first_error = error.MalformedControlMessage;
            break;
        }

        const header: *const LinuxCmsghdr = @ptrCast(@alignCast(control.ptr + offset));
        const length = header.len;
        if (length < @sizeOf(LinuxCmsghdr) or length > remaining) {
            if (first_error == null) first_error = error.MalformedControlMessage;
            break;
        }
        const payload_offset = cmsgAlign(@sizeOf(LinuxCmsghdr));
        if (payload_offset > length) {
            if (first_error == null) first_error = error.MalformedControlMessage;
        } else if (header.level != std.posix.SOL.SOCKET or header.type != scm_rights) {
            if (first_error == null) first_error = error.UnknownControlMessage;
        } else {
            const payload_len = length - payload_offset;
            if (payload_len == 0 or payload_len % @sizeOf(std.posix.fd_t) != 0) {
                if (first_error == null) first_error = error.MalformedControlMessage;
            } else {
                const count = payload_len / @sizeOf(std.posix.fd_t);
                const payload = control[offset + payload_offset .. offset + length];
                received_count += count;
                for (0..count) |index| {
                    const fd_ptr: *const std.posix.fd_t = @ptrCast(@alignCast(payload.ptr + index * @sizeOf(std.posix.fd_t)));
                    if (received_fd.* == null) {
                        received_fd.* = fd_ptr.*;
                    } else {
                        std.posix.close(fd_ptr.*);
                    }
                }
            }
        }

        const next = cmsgAlign(length);
        if (next == 0 or next > remaining) {
            if (first_error == null) first_error = error.MalformedControlMessage;
            break;
        }
        offset += next;
    }
    if (received_count > 1 and first_error == null) first_error = error.MultipleFileDescriptors;
    if (first_error) |err| return err;
}

test "selectStdin passes a read-only pipe" {
    const fds = try std.posix.pipe2(.{ .CLOEXEC = true });
    defer std.posix.close(fds[0]);
    defer std.posix.close(fds[1]);
    try std.testing.expectEqual(
        StdinSelection{ .pass_fd = fds[0] },
        selectStdin(fds[0], true),
    );
}

test "selectStdin rejects a non-tty read-write socket" {
    var fds: [2]std.posix.fd_t = undefined;
    try std.testing.expectEqual(
        @as(c_int, 0),
        std.c.socketpair(
            @intCast(std.posix.AF.UNIX),
            @intCast(std.posix.SOCK.STREAM | std.posix.SOCK.CLOEXEC),
            0,
            &fds,
        ),
    );
    defer std.posix.close(fds[0]);
    defer std.posix.close(fds[1]);
    try std.testing.expectEqual(StdinSelection.reject_read_write, selectStdin(fds[0], true));
}

test "selectStdin rejects an incapable caller" {
    const fds = try std.posix.pipe2(.{ .CLOEXEC = true });
    defer std.posix.close(fds[0]);
    defer std.posix.close(fds[1]);
    try std.testing.expectEqual(StdinSelection.none, selectStdin(fds[0], false));
}

test "selectStdin rejects a closed fd" {
    const fds = try std.posix.pipe2(.{ .CLOEXEC = true });
    std.posix.close(fds[0]);
    defer std.posix.close(fds[1]);
    try std.testing.expectEqual(StdinSelection.none, selectStdin(fds[0], true));
}

test "selectStdin ignores a write-only fd" {
    const fds = try std.posix.pipe2(.{ .CLOEXEC = true });
    defer std.posix.close(fds[0]);
    defer std.posix.close(fds[1]);
    try std.testing.expectEqual(StdinSelection.none, selectStdin(fds[1], true));
}

test "selectStdin ignores a tty when /dev/ptmx is available" {
    const fd = std.posix.open("/dev/ptmx", .{ .ACCMODE = .RDWR, .CLOEXEC = true }, 0) catch |err| switch (err) {
        error.FileNotFound,
        error.AccessDenied,
        error.PermissionDenied,
        error.NoDevice,
        error.NotDir,
        => return,
        else => return err,
    };
    defer std.posix.close(fd);
    try std.testing.expectEqual(StdinSelection.none, selectStdin(fd, true));
}

const TestCmsghdr = extern struct {
    len: usize,
    level: i32,
    type: i32,
};

fn testCmsgAlign(n: usize) usize {
    const a = @alignOf(usize);
    return (n + a - 1) & ~@as(usize, a - 1);
}

fn writeTestRightsHeader(control: []u8, offset: usize, fd: std.posix.fd_t) void {
    const header: *TestCmsghdr = @ptrCast(@alignCast(control.ptr + offset));
    header.* = .{
        .len = testCmsgAlign(@sizeOf(TestCmsghdr)) + @sizeOf(std.posix.fd_t),
        .level = std.posix.SOL.SOCKET,
        .type = 1,
    };
    const fd_ptr: *std.posix.fd_t = @ptrCast(@alignCast(
        control.ptr + offset + testCmsgAlign(@sizeOf(TestCmsghdr)),
    ));
    fd_ptr.* = fd;
}

const TestDescriptorError = error{
    DescriptorProbeInterrupted,
    DescriptorProbeFailed,
};

fn isClosed(fd: std.posix.fd_t) TestDescriptorError!bool {
    const result = std.c.fcntl(fd, std.c.F.GETFD, @as(c_int, 0));
    if (result >= 0) return false;
    return switch (std.posix.errno(result)) {
        .BADF => true,
        .INTR => error.DescriptorProbeInterrupted,
        else => error.DescriptorProbeFailed,
    };
}

test "isClosed distinguishes open and closed descriptors" {
    const fd = try std.posix.open("/dev/null", .{ .ACCMODE = .RDONLY, .CLOEXEC = true }, 0);
    var owned = true;
    defer if (owned) std.posix.close(fd);

    try std.testing.expect(!(try isClosed(fd)));
    std.posix.close(fd);
    owned = false;
    try std.testing.expect(try isClosed(fd));
}

fn sendTestAncillary(
    socket_fd: std.posix.fd_t,
    line: []const u8,
    payload: []const u8,
    level: i32,
    kind: i32,
) !void {
    var control: [2048]u8 align(@alignOf(TestCmsghdr)) = undefined;
    const header_size = @sizeOf(TestCmsghdr);
    const payload_offset = testCmsgAlign(header_size);
    const control_len = payload_offset + testCmsgAlign(payload.len);
    if (control_len > control.len) return error.TestControlTooSmall;
    @memset(control[0..control_len], 0);

    const header: *TestCmsghdr = @ptrCast(@alignCast(&control));
    header.* = .{
        .len = payload_offset + payload.len,
        .level = level,
        .type = kind,
    };
    @memcpy(control[payload_offset..][0..payload.len], payload);

    var iov = [_]std.posix.iovec_const{.{
        .base = line.ptr,
        .len = line.len,
    }};
    const message = std.os.linux.msghdr_const{
        .name = null,
        .namelen = 0,
        .iov = &iov,
        .iovlen = 1,
        .control = &control,
        .controllen = control_len,
        .flags = 0,
    };
    const sent = std.c.sendmsg(socket_fd, &message, 0);
    if (sent < 0 or @as(usize, @intCast(sent)) != line.len) return error.TestSendFailed;
}

fn testSocketPair() ![2]std.posix.fd_t {
    var fds: [2]std.posix.fd_t = undefined;
    try std.testing.expectEqual(
        @as(c_int, 0),
        std.c.socketpair(
            @intCast(std.posix.AF.UNIX),
            @intCast(std.posix.SOCK.STREAM | std.posix.SOCK.CLOEXEC),
            0,
            &fds,
        ),
    );
    return fds;
}

fn reserveNextFd() !std.posix.fd_t {
    const fd = try std.posix.open("/dev/null", .{ .ACCMODE = .RDONLY, .CLOEXEC = true }, 0);
    std.posix.close(fd);
    return fd;
}

fn expectReusableFdSlots(first: std.posix.fd_t, count: usize) !void {
    var opened: [128]std.posix.fd_t = undefined;
    try std.testing.expect(count <= opened.len);
    var opened_count: usize = 0;
    defer for (opened[0..opened_count]) |fd| std.posix.close(fd);
    while (opened_count < count) : (opened_count += 1) {
        const fd = try std.posix.open("/dev/null", .{ .ACCMODE = .RDONLY, .CLOEXEC = true }, 0);
        opened[opened_count] = fd;
        try std.testing.expectEqual(first + @as(std.posix.fd_t, @intCast(opened_count)), fd);
    }
}

var partial_send_calls: usize = 0;
var partial_write_calls: usize = 0;
var partial_write_bytes: usize = 0;
var partial_control_seen: bool = false;

fn partialSend(
    socket_fd: std.posix.fd_t,
    message: *const std.os.linux.msghdr_const,
    flags: u32,
) !usize {
    _ = socket_fd;
    _ = flags;
    partial_send_calls += 1;
    partial_control_seen = message.control != null and message.controllen != 0;
    return 3;
}

fn partialWrite(socket_fd: std.posix.fd_t, bytes: []const u8) !usize {
    _ = socket_fd;
    partial_write_calls += 1;
    partial_write_bytes = bytes.len;
    return bytes.len;
}

test "sendLine finishes a positive partial send with write without resending rights" {
    partial_send_calls = 0;
    partial_write_calls = 0;
    partial_write_bytes = 0;
    partial_control_seen = false;

    const line = "abcdef\n";
    try sendLineWith(partialSend, partialWrite, 42, line, 123);

    try std.testing.expectEqual(@as(usize, 1), partial_send_calls);
    try std.testing.expectEqual(@as(usize, 1), partial_write_calls);
    try std.testing.expectEqual(@as(usize, line.len - 3), partial_write_bytes);
    try std.testing.expect(partial_control_seen);
}

test "parseControlMessages rejects a short cmsg header" {
    var control: [@sizeOf(TestCmsghdr) - 1]u8 align(@alignOf(TestCmsghdr)) = undefined;
    @memset(control[0..], 0);
    var received_fd: ?std.posix.fd_t = null;
    try std.testing.expectError(
        error.MalformedControlMessage,
        parseControlMessages(control[0..], &received_fd),
    );
}

test "parseControlMessages rejects an out-of-bounds cmsg length" {
    var control: [cmsgSpace(@sizeOf(std.posix.fd_t))]u8 align(@alignOf(TestCmsghdr)) = undefined;
    @memset(control[0..], 0);
    const header: *TestCmsghdr = @ptrCast(@alignCast(control[0..].ptr));
    header.* = .{
        .len = control.len + 1,
        .level = std.posix.SOL.SOCKET,
        .type = 1,
    };
    var received_fd: ?std.posix.fd_t = null;
    try std.testing.expectError(
        error.MalformedControlMessage,
        parseControlMessages(control[0..], &received_fd),
    );
}

test "parseControlMessages rejects empty and misaligned rights payloads" {
    var empty_control: [cmsgSpace(0)]u8 align(@alignOf(TestCmsghdr)) = undefined;
    @memset(empty_control[0..], 0);
    const empty_header: *TestCmsghdr = @ptrCast(@alignCast(empty_control[0..].ptr));
    empty_header.* = .{
        .len = cmsgAlign(@sizeOf(TestCmsghdr)),
        .level = std.posix.SOL.SOCKET,
        .type = 1,
    };
    var empty_received_fd: ?std.posix.fd_t = null;
    try std.testing.expectError(
        error.MalformedControlMessage,
        parseControlMessages(empty_control[0..], &empty_received_fd),
    );

    var misaligned_control: [cmsgSpace(1)]u8 align(@alignOf(TestCmsghdr)) = undefined;
    @memset(misaligned_control[0..], 0);
    const misaligned_header: *TestCmsghdr = @ptrCast(@alignCast(misaligned_control[0..].ptr));
    misaligned_header.* = .{
        .len = cmsgAlign(@sizeOf(TestCmsghdr)) + 1,
        .level = std.posix.SOL.SOCKET,
        .type = 1,
    };
    var misaligned_received_fd: ?std.posix.fd_t = null;
    try std.testing.expectError(
        error.MalformedControlMessage,
        parseControlMessages(misaligned_control[0..], &misaligned_received_fd),
    );
}

test "parseControlMessages rejects multiple one-fd rights headers" {
    const pipe_fds = try std.posix.pipe2(.{ .CLOEXEC = true });
    defer std.posix.close(pipe_fds[0]);
    defer std.posix.close(pipe_fds[1]);
    const first = try std.posix.dup(pipe_fds[0]);
    var first_owned = true;
    defer if (first_owned) std.posix.close(first);
    const second = try std.posix.dup(pipe_fds[0]);
    var second_owned = true;
    defer if (second_owned) {
        // The parser may already have closed this descriptor. Use libc here
        // because std.posix.close treats EBADF as an unreachable race.
        _ = std.c.close(second);
    };

    var control: [2 * cmsgSpace(@sizeOf(std.posix.fd_t))]u8 align(@alignOf(TestCmsghdr)) = undefined;
    @memset(control[0..], 0);
    writeTestRightsHeader(control[0..], 0, first);
    writeTestRightsHeader(control[0..], cmsgSpace(@sizeOf(std.posix.fd_t)), second);

    var received_fd: ?std.posix.fd_t = null;
    defer if (received_fd) |fd| std.posix.close(fd);
    var parse_error: ?anyerror = null;
    parseControlMessages(control[0..], &received_fd) catch |err| {
        parse_error = err;
    };

    // Reconcile parser ownership before handling its result. This prevents an
    // unexpected parser error from returning through guards that still point
    // at descriptors already retained or closed by the parser.
    if (received_fd) |fd| {
        std.posix.close(fd);
        received_fd = null;
        first_owned = false;
    } else if (first_owned) {
        std.posix.close(first);
        first_owned = false;
    }
    const second_closed = isClosed(second) catch |err| return err;
    if (second_closed) {
        second_owned = false;
    } else {
        std.posix.close(second);
        second_owned = false;
    }

    var saw_multiple = false;
    if (parse_error) |err| {
        if (err != error.MultipleFileDescriptors) return err;
        saw_multiple = true;
    }
    try std.testing.expect(saw_multiple);
    try std.testing.expect(second_closed);
}

test "sendLine and receiveLine pass one stdin fd with the line" {
    const sockets = try testSocketPair();
    defer std.posix.close(sockets[0]);
    defer std.posix.close(sockets[1]);
    const pipe_fds = try std.posix.pipe2(.{ .CLOEXEC = true });
    defer std.posix.close(pipe_fds[0]);
    defer std.posix.close(pipe_fds[1]);

    try sendLine(sockets[0], "{\"type\":\"execute\"}\n", pipe_fds[0]);
    var received = try receiveLine(std.testing.allocator, sockets[1], 4096);
    defer received.deinit();
    try std.testing.expectEqualStrings("{\"type\":\"execute\"}", received.line);
    try std.testing.expect(received.stdin_fd != null);

    _ = try std.posix.write(pipe_fds[1], "payload");
    var buf: [7]u8 = undefined;
    try std.testing.expectEqual(@as(usize, 7), try std.posix.read(received.stdin_fd.?, &buf));
    try std.testing.expectEqualStrings("payload", &buf);

    const received_flags = std.c.fcntl(received.stdin_fd.?, std.c.F.GETFD, @as(c_int, 0));
    try std.testing.expect(received_flags >= 0);
    try std.testing.expect((received_flags & std.c.FD_CLOEXEC) != 0);
}

test "sendLine and receiveLine support a request without an fd" {
    const sockets = try testSocketPair();
    defer std.posix.close(sockets[0]);
    defer std.posix.close(sockets[1]);

    try sendLine(sockets[0], "{\"stdinMode\":\"none\"}\n", null);
    var received = try receiveLine(std.testing.allocator, sockets[1], 4096);
    defer received.deinit();
    try std.testing.expectEqualStrings("{\"stdinMode\":\"none\"}", received.line);
    try std.testing.expect(received.stdin_fd == null);
}

test "receiveLine completes a line split across the initial recvmsg and a read" {
    const sockets = try testSocketPair();
    defer std.posix.close(sockets[0]);
    defer std.posix.close(sockets[1]);

    _ = try std.posix.write(sockets[0], "{\"split\":");
    var suffix_writer_state = SuffixWriterState{
        .fd = sockets[0],
        .failed = std.atomic.Value(bool).init(false),
    };
    const suffix_writer = try std.Thread.spawn(.{}, writeSuffix, .{&suffix_writer_state});

    var received = receiveLine(std.testing.allocator, sockets[1], 4096) catch |err| {
        suffix_writer.join();
        return err;
    };
    suffix_writer.join();
    try std.testing.expect(!suffix_writer_state.failed.load(.acquire));
    defer received.deinit();
    try std.testing.expectEqualStrings("{\"split\":true}", received.line);
}

const SuffixWriterState = struct {
    fd: std.posix.fd_t,
    failed: std.atomic.Value(bool),
};

fn writeSuffix(state: *SuffixWriterState) void {
    std.Thread.sleep(20 * std.time.ns_per_ms);
    _ = std.posix.write(state.fd, "true}\n") catch {
        state.failed.store(true, .release);
    };
}

test "suffix writer reports a failed write after join" {
    var state = SuffixWriterState{
        .fd = -1,
        .failed = std.atomic.Value(bool).init(false),
    };
    const writer = try std.Thread.spawn(.{}, writeSuffix, .{&state});
    writer.join();
    try std.testing.expect(state.failed.load(.acquire));
}

test "receiveLine rejects a line over the maximum size" {
    const sockets = try testSocketPair();
    defer std.posix.close(sockets[0]);
    defer std.posix.close(sockets[1]);
    const pipe_fds = try std.posix.pipe2(.{ .CLOEXEC = true });
    defer std.posix.close(pipe_fds[0]);
    defer std.posix.close(pipe_fds[1]);
    const first_available = try reserveNextFd();

    try sendLine(sockets[0], "12345\n", pipe_fds[0]);
    try std.testing.expectError(
        error.MessageTooLong,
        receiveLine(std.testing.allocator, sockets[1], 4),
    );
    try expectReusableFdSlots(first_available, 1);
}

test "receiveLine rejects multiple received descriptors" {
    const sockets = try testSocketPair();
    defer std.posix.close(sockets[0]);
    defer std.posix.close(sockets[1]);
    const first = try std.posix.pipe2(.{ .CLOEXEC = true });
    defer std.posix.close(first[0]);
    defer std.posix.close(first[1]);
    const second = try std.posix.pipe2(.{ .CLOEXEC = true });
    defer std.posix.close(second[0]);
    defer std.posix.close(second[1]);
    const first_available = try reserveNextFd();
    const descriptors = [_]std.posix.fd_t{ first[0], second[0] };

    try sendTestAncillary(
        sockets[0],
        "{\"stdinMode\":\"fd\"}\n",
        std.mem.sliceAsBytes(&descriptors),
        std.posix.SOL.SOCKET,
        1,
    );
    try std.testing.expectError(
        error.MultipleFileDescriptors,
        receiveLine(std.testing.allocator, sockets[1], 4096),
    );
    try expectReusableFdSlots(first_available, 2);
}

test "receiveLine rejects MSG_CTRUNC" {
    const sockets = try testSocketPair();
    defer std.posix.close(sockets[0]);
    defer std.posix.close(sockets[1]);

    var pipes: [128][2]std.posix.fd_t = undefined;
    var descriptors: [128]std.posix.fd_t = undefined;
    var initialized: usize = 0;
    defer {
        for (pipes[0..initialized]) |pair| {
            std.posix.close(pair[0]);
            std.posix.close(pair[1]);
        }
    }
    while (initialized < pipes.len) : (initialized += 1) {
        pipes[initialized] = try std.posix.pipe2(.{ .CLOEXEC = true });
        descriptors[initialized] = pipes[initialized][0];
    }
    const first_available = try reserveNextFd();

    try sendTestAncillary(
        sockets[0],
        "{\"stdinMode\":\"fd\"}\n",
        std.mem.sliceAsBytes(&descriptors),
        std.posix.SOL.SOCKET,
        1,
    );
    try std.testing.expectError(
        error.ControlMessageTruncated,
        receiveLine(std.testing.allocator, sockets[1], 4096),
    );
    try expectReusableFdSlots(first_available, max_receive_fds);
}

test "receiveLine rejects unknown ancillary data" {
    const sockets = try testSocketPair();
    defer std.posix.close(sockets[0]);
    defer std.posix.close(sockets[1]);
    var enabled: c_int = 1;
    try std.posix.setsockopt(
        sockets[1],
        std.posix.SOL.SOCKET,
        std.posix.SO.PASSCRED,
        std.mem.asBytes(&enabled),
    );
    _ = try std.posix.write(sockets[0], "{\"type\":\"execute\"}\n");

    try std.testing.expectError(
        error.UnknownControlMessage,
        receiveLine(std.testing.allocator, sockets[1], 4096),
    );
}

test "ReceivedLine.deinit closes the fd and is idempotent" {
    const sockets = try testSocketPair();
    defer std.posix.close(sockets[0]);
    defer std.posix.close(sockets[1]);
    const pipe_fds = try std.posix.pipe2(.{ .CLOEXEC = true });
    defer std.posix.close(pipe_fds[0]);
    defer std.posix.close(pipe_fds[1]);

    try sendLine(sockets[0], "line\n", pipe_fds[0]);
    var received = try receiveLine(std.testing.allocator, sockets[1], 4096);
    const received_fd = received.stdin_fd.?;
    received.deinit();
    received.deinit();
    try std.testing.expectEqual(@as(c_int, -1), std.c.fcntl(received_fd, std.c.F.GETFD, @as(c_int, 0)));
}
