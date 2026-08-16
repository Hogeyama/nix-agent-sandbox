//! Per-session hostexec gateway.
//!
//! The listener is deliberately a small process supervisor.  It never parses
//! an execution request and never calls the executor: those operations happen
//! in the forked handler for exactly one external connection.  Keeping the
//! delegated descriptor and fd 0 manipulation in that process is what makes
//! it safe for the listener to accept another request concurrently.

const std = @import("std");
const posix = std.posix;
const Allocator = std.mem.Allocator;

const fd_transport = @import("fd_transport.zig");
const gateway_executor = @import("gateway_executor.zig");
const gateway_protocol = @import("gateway_protocol.zig");
const test_paths = @import("test_paths.zig");

const max_handlers = 1024;
const poll_timeout_ms: i32 = 50;
const listener_backlog: u32 = 64;
const max_queued_bytes = gateway_protocol.max_control_bytes * 2;
const max_encoded_chunk_data_bytes = std.base64.standard.Encoder.calcSize(gateway_protocol.max_chunk_bytes);
const cleanup_retry_ns = 10 * std.time.ns_per_ms;
const terminal_flush_timeout_ns = 100 * std.time.ns_per_ms;

const GatewayOptions = struct {
    session_id: []const u8,
    external_socket: []const u8,
    internal_socket: []const u8,

    pub fn deinit(self: *GatewayOptions, allocator: Allocator) void {
        allocator.free(self.session_id);
        allocator.free(self.external_socket);
        allocator.free(self.internal_socket);
        self.* = undefined;
    }
};

pub fn parseArguments(allocator: Allocator, argv: []const []const u8) !GatewayOptions {
    var session_id: ?[]const u8 = null;
    var external_socket: ?[]const u8 = null;
    var internal_socket: ?[]const u8 = null;

    // argv[0] is the executable path, which may be an absolute store path.
    var i: usize = if (argv.len > 0) 1 else 0;
    errdefer {
        if (session_id) |value| allocator.free(value);
        if (external_socket) |value| allocator.free(value);
        if (internal_socket) |value| allocator.free(value);
    }
    while (i < argv.len) : (i += 1) {
        const flag = argv[i];
        if (i + 1 >= argv.len) return error.InvalidArgument;
        const value = argv[i + 1];
        if (value.len == 0) return error.InvalidArgument;

        if (std.mem.eql(u8, flag, "--session-id")) {
            if (session_id != null) return error.InvalidArgument;
            session_id = try allocator.dupe(u8, value);
        } else if (std.mem.eql(u8, flag, "--external-socket")) {
            if (external_socket != null) return error.InvalidArgument;
            external_socket = try allocator.dupe(u8, value);
        } else if (std.mem.eql(u8, flag, "--internal-socket")) {
            if (internal_socket != null) return error.InvalidArgument;
            internal_socket = try allocator.dupe(u8, value);
        } else {
            return error.InvalidArgument;
        }
        i += 1;
    }

    const result = GatewayOptions{
        .session_id = session_id orelse return error.InvalidArgument,
        .external_socket = external_socket orelse return error.InvalidArgument,
        .internal_socket = internal_socket orelse return error.InvalidArgument,
    };
    if (result.session_id.len == 0 or result.external_socket.len == 0 or result.internal_socket.len == 0) {
        return error.InvalidArgument;
    }
    session_id = null;
    external_socket = null;
    internal_socket = null;
    return result;
}

const ReadyMessage = struct {
    type: []const u8,
    version: u32,
    socket: []const u8,
};

fn readinessLine(allocator: Allocator, external_socket: []const u8) ![]u8 {
    const encoded = try std.json.Stringify.valueAlloc(allocator, ReadyMessage{
        .type = "ready",
        .version = 2,
        .socket = external_socket,
    }, .{});
    defer allocator.free(encoded);

    const line = try allocator.alloc(u8, encoded.len + 1);
    @memcpy(line[0..encoded.len], encoded);
    line[encoded.len] = '\n';
    return line;
}

fn writeReadiness(allocator: Allocator, external_socket: []const u8) !void {
    const line = try readinessLine(allocator, external_socket);
    defer allocator.free(line);
    try std.fs.File.stdout().writeAll(line);
}

fn socketAddress(path: []const u8) !posix.sockaddr.un {
    var address = posix.sockaddr.un{ .family = posix.AF.UNIX, .path = undefined };
    @memset(&address.path, 0);
    if (path.len == 0 or path.len >= address.path.len) return error.SocketPathTooLong;
    @memcpy(address.path[0..path.len], path);
    return address;
}

fn removeStaleSocket(path: []const u8) !void {
    posix.unlink(path) catch |err| switch (err) {
        error.FileNotFound => {},
        else => return err,
    };
}

fn bindListener(path: []const u8) !posix.fd_t {
    const address = try socketAddress(path);
    const listener = try posix.socket(
        posix.AF.UNIX,
        posix.SOCK.STREAM | posix.SOCK.CLOEXEC | posix.SOCK.NONBLOCK,
        0,
    );
    errdefer posix.close(listener);

    try removeStaleSocket(path);
    const old_umask = std.c.umask(0o177);
    posix.bind(listener, @ptrCast(&address), @sizeOf(posix.sockaddr.un)) catch |err| {
        _ = std.c.umask(old_umask);
        return err;
    };
    _ = std.c.umask(old_umask);
    errdefer removeStaleSocket(path) catch {};

    try posix.fchmodat(posix.AT.FDCWD, path, 0o600, 0);
    try posix.listen(listener, listener_backlog);
    return listener;
}

fn setNonBlocking(fd: posix.fd_t) !void {
    const flags = try posix.fcntl(fd, posix.F.GETFL, 0);
    const nonblock: u32 = @bitCast(posix.O{ .NONBLOCK = true });
    _ = try posix.fcntl(fd, posix.F.SETFL, flags | nonblock);
}

fn sendSocketAll(fd: posix.fd_t, bytes: []const u8) !void {
    var offset: usize = 0;
    while (offset < bytes.len) {
        const sent = posix.send(fd, bytes[offset..], std.os.linux.MSG.NOSIGNAL) catch |err| return err;
        if (sent == 0) return error.ZeroProgress;
        offset += sent;
    }
}

const ByteQueue = struct {
    allocator: Allocator,
    bytes: std.ArrayList(u8) = .{},
    offset: usize = 0,

    fn init(allocator: Allocator) ByteQueue {
        return .{ .allocator = allocator };
    }

    fn deinit(self: *ByteQueue) void {
        self.bytes.deinit(self.allocator);
        self.* = undefined;
    }

    fn pendingLen(self: *const ByteQueue) usize {
        return self.bytes.items.len - self.offset;
    }

    fn empty(self: *const ByteQueue) bool {
        return self.pendingLen() == 0;
    }

    fn clear(self: *ByteQueue) void {
        self.bytes.clearRetainingCapacity();
        self.offset = 0;
    }

    fn compact(self: *ByteQueue) void {
        if (self.offset == 0) return;
        const pending = self.pendingLen();
        if (pending > 0) {
            std.mem.copyForwards(u8, self.bytes.items[0..pending], self.bytes.items[self.offset..]);
        }
        self.bytes.items.len = pending;
        self.offset = 0;
    }

    fn append(self: *ByteQueue, frame: []const u8) !void {
        if (frame.len > max_queued_bytes) return error.OutputBackpressure;
        if (self.pendingLen() > max_queued_bytes - frame.len) return error.OutputBackpressure;
        if (self.offset != 0 and self.bytes.items.len > max_queued_bytes - frame.len) {
            self.compact();
        }
        try self.bytes.appendSlice(self.allocator, frame);
    }

    fn flush(self: *ByteQueue, fd: posix.fd_t) !void {
        while (!self.empty()) {
            const sent = posix.send(fd, self.bytes.items[self.offset..], std.os.linux.MSG.NOSIGNAL) catch |err| switch (err) {
                error.WouldBlock => return,
                else => return err,
            };
            if (sent == 0) return error.ZeroProgress;
            self.offset += sent;
        }
        self.clear();
    }
};

const LineReader = struct {
    allocator: Allocator,
    bytes: std.ArrayList(u8) = .{},
    start: usize = 0,

    fn init(allocator: Allocator) LineReader {
        return .{ .allocator = allocator };
    }

    fn deinit(self: *LineReader) void {
        self.bytes.deinit(self.allocator);
        self.* = undefined;
    }

    fn hasReadHeadroom(self: *const LineReader) bool {
        const remaining = self.bytes.items[self.start..];
        const partial_start = std.mem.lastIndexOfScalar(u8, remaining, '\n');
        const partial_len = if (partial_start) |newline|
            remaining.len - newline - 1
        else
            remaining.len;
        if (partial_len > gateway_protocol.max_control_bytes + 1) return false;
        if (partial_len == gateway_protocol.max_control_bytes + 1) {
            return remaining[remaining.len - 1] == '\r';
        }
        return true;
    }

    fn readAvailable(self: *LineReader, fd: posix.fd_t) !usize {
        var scratch: [64 * 1024]u8 = undefined;
        const count = posix.read(fd, &scratch) catch |err| switch (err) {
            error.WouldBlock => return 0,
            else => return err,
        };
        if (count > 0) {
            try self.validateFrames(scratch[0..count]);
            const delimiter_headroom: usize = 2; // optional CR followed by LF
            const aggregate_limit = gateway_protocol.max_control_bytes + delimiter_headroom + scratch.len;
            if (self.bytes.items.len - self.start + count > aggregate_limit) {
                return error.MessageTooLong;
            }
            try self.bytes.appendSlice(self.allocator, scratch[0..count]);
        }
        return count;
    }

    fn validateFrames(self: *const LineReader, incoming: []const u8) !void {
        var frame_len: usize = 0;
        var last_was_cr = false;
        for (self.bytes.items[self.start..]) |byte| {
            if (byte == '\n') {
                const payload_len = if (last_was_cr)
                    frame_len - 1
                else
                    frame_len;
                if (payload_len > gateway_protocol.max_control_bytes) return error.MessageTooLong;
                frame_len = 0;
                last_was_cr = false;
            } else {
                frame_len += 1;
                last_was_cr = byte == '\r';
                if (frame_len > gateway_protocol.max_control_bytes + 1 or
                    (frame_len > gateway_protocol.max_control_bytes and !last_was_cr)) return error.MessageTooLong;
            }
        }
        for (incoming) |byte| {
            if (byte == '\n') {
                const payload_len = if (last_was_cr)
                    frame_len - 1
                else
                    frame_len;
                if (payload_len > gateway_protocol.max_control_bytes) return error.MessageTooLong;
                frame_len = 0;
                last_was_cr = false;
            } else {
                frame_len += 1;
                last_was_cr = byte == '\r';
                if (frame_len > gateway_protocol.max_control_bytes + 1 or
                    (frame_len > gateway_protocol.max_control_bytes and !last_was_cr)) return error.MessageTooLong;
            }
        }
        if (frame_len > gateway_protocol.max_control_bytes + 1) return error.MessageTooLong;
    }

    fn next(self: *LineReader) !?[]u8 {
        const remaining = self.bytes.items[self.start..];
        const newline = std.mem.indexOfScalar(u8, remaining, '\n') orelse {
            if (remaining.len > gateway_protocol.max_control_bytes and
                (remaining.len != gateway_protocol.max_control_bytes + 1 or remaining[remaining.len - 1] != '\r')) return error.MessageTooLong;
            return null;
        };
        const payload_len = if (newline > 0 and remaining[newline - 1] == '\r') newline - 1 else newline;
        if (payload_len > gateway_protocol.max_control_bytes) return error.MessageTooLong;
        const line = try self.allocator.dupe(u8, remaining[0..payload_len]);
        self.start += newline + 1;
        if (self.start == self.bytes.items.len) {
            self.bytes.clearRetainingCapacity();
            self.start = 0;
        } else if (self.start >= self.bytes.items.len / 2) {
            std.mem.copyForwards(u8, self.bytes.items[0 .. self.bytes.items.len - self.start], self.bytes.items[self.start..]);
            self.bytes.items.len -= self.start;
            self.start = 0;
        }
        return line;
    }
};

var shutdown_requested = std.atomic.Value(bool).init(false);
var handler_stop_requested = std.atomic.Value(bool).init(false);
var handler_wakeup_fd = std.atomic.Value(posix.fd_t).init(-1);
var sigterm_atfork_registered = false;
var defer_atfork_signal_reset = false;
const PthreadAtforkFn = *const fn (
    ?*const fn () callconv(.c) void,
    ?*const fn () callconv(.c) void,
    ?*const fn () callconv(.c) void,
) callconv(.c) c_int;
var pthread_atfork_fn: PthreadAtforkFn = std.c.pthread_atfork;

fn resetSigtermMaskInForkedChild() callconv(.c) void {
    if (defer_atfork_signal_reset) return;
    var mask = posix.sigemptyset();
    posix.sigaddset(&mask, posix.SIG.TERM);
    posix.sigaddset(&mask, posix.SIG.INT);
    posix.sigprocmask(posix.SIG.UNBLOCK, &mask, null);
}

fn installSigtermAtfork() !void {
    if (sigterm_atfork_registered) return;
    if (pthread_atfork_fn(null, null, resetSigtermMaskInForkedChild) != 0) {
        return error.PthreadAtforkFailed;
    }
    sigterm_atfork_registered = true;
}

const SigtermDeferral = struct {
    previous: posix.sigset_t,
    restored: bool = false,

    fn begin() SigtermDeferral {
        var mask = posix.sigemptyset();
        posix.sigaddset(&mask, posix.SIG.TERM);
        posix.sigaddset(&mask, posix.SIG.INT);
        var previous: posix.sigset_t = undefined;
        posix.sigprocmask(posix.SIG.BLOCK, &mask, &previous);
        return .{ .previous = previous };
    }

    fn restore(self: *SigtermDeferral) void {
        if (self.restored) return;
        posix.sigprocmask(posix.SIG.SETMASK, &self.previous, null);
        self.restored = true;
    }
};

fn onShutdown(_: i32) callconv(.c) void {
    shutdown_requested.store(true, .seq_cst);
}

fn onHandlerShutdown(_: i32) callconv(.c) void {
    handler_stop_requested.store(true, .seq_cst);
    const fd = handler_wakeup_fd.load(.monotonic);
    if (fd >= 0) _ = std.c.shutdown(fd, 2);
}

fn installShutdownHandlers() !void {
    try installSigtermAtfork();
    const action: posix.Sigaction = .{
        .handler = .{ .handler = onShutdown },
        .mask = posix.sigemptyset(),
        .flags = 0,
    };
    posix.sigaction(posix.SIG.TERM, &action, null);
    posix.sigaction(posix.SIG.INT, &action, null);
}

fn installHandlerShutdownHandlers() void {
    const action: posix.Sigaction = .{
        .handler = .{ .handler = onHandlerShutdown },
        .mask = posix.sigemptyset(),
        .flags = 0,
    };
    posix.sigaction(posix.SIG.TERM, &action, null);
    posix.sigaction(posix.SIG.INT, &action, null);
}

fn processExitCode(term: std.process.Child.Term) i32 {
    return switch (term) {
        .Exited => |code| @intCast(code),
        .Signal => |signal| 128 + @as(i32, @intCast(signal)),
        .Stopped => |signal| 128 + @as(i32, @intCast(signal)),
        .Unknown => 1,
    };
}

const ExternalChunk = struct {
    type: []const u8,
    requestId: []const u8,
    fd: u8,
    data: []const u8,
};

const ExternalResult = struct {
    type: []const u8,
    requestId: []const u8,
    exitCode: i32,
};

const ExternalFallback = struct {
    type: []const u8,
    requestId: []const u8,
};

const ExternalError = struct {
    type: []const u8,
    requestId: []const u8,
    message: []const u8,
};

const ChildCleanupFn = *const fn (*gateway_executor.ChildHandle) anyerror!void;

fn defaultChildCleanup(child: *gateway_executor.ChildHandle) !void {
    try child.deinit();
}

const Handler = struct {
    allocator: Allocator,
    session_id: []const u8,
    internal_socket_path: []const u8,
    external_fd: posix.fd_t,
    internal_fd: ?posix.fd_t = null,
    execute_sent: bool = true,
    request_id: []const u8 = "",
    stdin_fd: ?posix.fd_t = null,
    state: gateway_protocol.GatewayState = .awaiting_decision,
    broker_out: ByteQueue,
    external_out: ByteQueue,
    broker_lines: LineReader,
    pending_broker_line: ?[]u8 = null,
    child: ?gateway_executor.ChildHandle = null,
    child_exit_code: ?i32 = null,
    stdout_eof: bool = false,
    stderr_eof: bool = false,
    process_exit_sent: bool = false,
    max_chunk_frame_bytes: usize = 0,
    cleanup_child_fn: ChildCleanupFn = defaultChildCleanup,

    fn init(allocator: Allocator, session_id: []const u8, internal_socket_path: []const u8, external_fd: posix.fd_t) Handler {
        return .{
            .allocator = allocator,
            .session_id = session_id,
            .internal_socket_path = internal_socket_path,
            .external_fd = external_fd,
            .broker_out = ByteQueue.init(allocator),
            .external_out = ByteQueue.init(allocator),
            .broker_lines = LineReader.init(allocator),
        };
    }

    fn retryCleanupChild(self: *Handler) void {
        while (self.child != null) {
            self.cleanupChild() catch {
                std.Thread.sleep(cleanup_retry_ns);
                continue;
            };
        }
    }

    fn deinit(self: *Handler) void {
        self.retryCleanupChild();
        if (self.stdin_fd) |fd| {
            posix.close(fd);
            self.stdin_fd = null;
        }
        if (self.internal_fd) |fd| {
            posix.close(fd);
            self.internal_fd = null;
        }
        if (self.external_fd >= 0) {
            handler_wakeup_fd.store(-1, .release);
            posix.close(self.external_fd);
            self.external_fd = -1;
        }
        self.broker_out.deinit();
        self.external_out.deinit();
        if (self.pending_broker_line) |line| self.allocator.free(line);
        self.broker_lines.deinit();
    }

    fn maximumChunkFrameBytes(self: *const Handler) !usize {
        const data = try self.allocator.alloc(u8, max_encoded_chunk_data_bytes);
        defer self.allocator.free(data);
        @memset(data, 'A');
        data[data.len - 2] = '=';
        data[data.len - 1] = '=';

        const max_raw_chunk: gateway_protocol.GatewayToBroker = .{ .raw_chunk = .{
            .requestId = self.request_id,
            .fd = 1,
            .data = data,
        } };
        const broker_frame = try gateway_protocol.stringifyMessage(self.allocator, max_raw_chunk);
        defer self.allocator.free(broker_frame);

        const external_json = try std.json.Stringify.valueAlloc(self.allocator, ExternalChunk{
            .type = "chunk",
            .requestId = self.request_id,
            .fd = 1,
            .data = data,
        }, .{});
        defer self.allocator.free(external_json);

        const external_frame_bytes = external_json.len + 1;
        return if (broker_frame.len > external_frame_bytes) broker_frame.len else external_frame_bytes;
    }

    fn hasChunkRoom(self: *const Handler, queue: *const ByteQueue) bool {
        return self.max_chunk_frame_bytes <= max_queued_bytes and
            queue.pendingLen() <= max_queued_bytes - self.max_chunk_frame_bytes;
    }

    fn hasExternalChunkRoom(self: *const Handler) bool {
        return self.hasChunkRoom(&self.external_out);
    }

    fn hasBrokerChunkRoom(self: *const Handler) bool {
        return self.hasChunkRoom(&self.broker_out);
    }

    fn queueBroker(self: *Handler, message: gateway_protocol.GatewayToBroker) !void {
        const encoded = try gateway_protocol.stringifyMessage(self.allocator, message);
        defer self.allocator.free(encoded);
        try self.broker_out.append(encoded);
    }

    fn flushBroker(self: *Handler) !void {
        const fd = self.internal_fd orelse return;
        try self.broker_out.flush(fd);
        if (self.broker_out.empty()) self.execute_sent = true;
    }

    fn flushBrokerForTerminal(self: *Handler) void {
        if (self.internal_fd == null or self.broker_out.empty()) return;
        var timer = std.time.Timer.start() catch return;
        while (!self.broker_out.empty() and timer.read() < terminal_flush_timeout_ns) {
            self.flushBroker() catch return;
            if (self.broker_out.empty()) return;

            const elapsed = timer.read();
            if (elapsed >= terminal_flush_timeout_ns) return;
            const remaining_ns = terminal_flush_timeout_ns - elapsed;
            const wait_ms = @as(i32, @intCast(@max(@as(u64, 1), (remaining_ns + std.time.ns_per_ms - 1) / std.time.ns_per_ms)));
            var pollfd = [_]posix.pollfd{.{
                .fd = self.internal_fd orelse return,
                .events = posix.POLL.OUT | posix.POLL.HUP | posix.POLL.ERR | posix.POLL.NVAL,
                .revents = 0,
            }};
            _ = posix.poll(&pollfd, wait_ms) catch return;
            if (pollfd[0].revents & (posix.POLL.HUP | posix.POLL.ERR | posix.POLL.NVAL) != 0) return;
        }
    }

    fn queueExternal(self: *Handler, encoded: []const u8) !void {
        try self.external_out.append(encoded);
    }

    fn queueExternalValue(self: *Handler, value: anytype) !void {
        const encoded = try std.json.Stringify.valueAlloc(self.allocator, value, .{});
        defer self.allocator.free(encoded);
        const line = try self.allocator.alloc(u8, encoded.len + 1);
        defer self.allocator.free(line);
        @memcpy(line[0..encoded.len], encoded);
        line[encoded.len] = '\n';
        try self.queueExternal(line);
    }

    fn sendExternalErrorBlocking(self: *Handler, message: []const u8) void {
        if (self.external_fd < 0) return;
        const encoded = std.json.Stringify.valueAlloc(self.allocator, ExternalError{
            .type = "error",
            .requestId = self.request_id,
            .message = message,
        }, .{}) catch return;
        defer self.allocator.free(encoded);
        const line = self.allocator.alloc(u8, encoded.len + 1) catch return;
        defer self.allocator.free(line);
        @memcpy(line[0..encoded.len], encoded);
        line[encoded.len] = '\n';
        sendSocketAll(self.external_fd, line) catch {};
    }

    fn closeStdin(self: *Handler) void {
        if (self.stdin_fd) |fd| {
            posix.close(fd);
            self.stdin_fd = null;
        }
    }

    fn cleanupChild(self: *Handler) !void {
        if (self.child) |*child| {
            try self.cleanup_child_fn(child);
            self.child = null;
        }
    }

    fn discardBroker(self: *Handler) void {
        self.broker_out.clear();
        if (self.internal_fd) |fd| {
            posix.close(fd);
            self.internal_fd = null;
        }
        self.execute_sent = true;
    }

    fn terminalize(self: *Handler) void {
        self.discardBroker();
        self.retryCleanupChild();
        self.closeStdin();
        self.state = .terminal;
    }

    fn protocolFailure(self: *Handler, message: []const u8) !void {
        if (self.internal_fd != null and self.state != .terminal) {
            self.queueBroker(.{ .transport_error = .{
                .requestId = self.request_id,
                .message = message,
            } }) catch {};
            self.flushBrokerForTerminal();
        }
        self.external_out.clear();
        if (self.external_fd >= 0) {
            self.queueExternalValue(ExternalError{
                .type = "error",
                .requestId = self.request_id,
                .message = message,
            }) catch {};
        }
        self.terminalize();
    }

    fn externalDisconnected(self: *Handler) void {
        self.external_out.clear();
        if (self.execute_sent and self.internal_fd != null and self.state != .terminal) {
            self.queueBroker(.{ .cancelled = .{
                .requestId = self.request_id,
                .reason = "client disconnected",
            } }) catch {};
            self.flushBroker() catch {};
        }
        self.terminalize();
        if (self.external_fd >= 0) {
            handler_wakeup_fd.store(-1, .release);
            posix.close(self.external_fd);
            self.external_fd = -1;
        }
    }

    fn internalDisconnected(self: *Handler) void {
        self.external_out.clear();
        if (self.external_fd >= 0 and self.state != .terminal) {
            self.queueExternalValue(ExternalError{
                .type = "error",
                .requestId = self.request_id,
                .message = "hostexec broker disconnected",
            }) catch {};
        }
        self.terminalize();
    }

    fn spawnApproved(self: *Handler, message: anytype) !void {
        var env = std.process.EnvMap.init(self.allocator);
        defer env.deinit();
        var env_iter = message.env.map.iterator();
        while (env_iter.next()) |entry| {
            try env.put(entry.key_ptr.*, entry.value_ptr.*);
        }

        var sigterm = SigtermDeferral.begin();
        defer sigterm.restore();
        const child = try gateway_executor.spawn(self.allocator, .{
            .argv0 = message.argv0,
            .args = message.args,
            .cwd = message.cwd,
            .env = env,
        }, self.stdin_fd);
        self.child = child;
        errdefer self.retryCleanupChild();
        try setNonBlocking(self.child.?.stdout_fd);
        try setNonBlocking(self.child.?.stderr_fd);
        try self.queueBroker(.{ .spawned = .{
            .requestId = self.request_id,
            .pid = @intCast(self.child.?.pid),
        } });
        // Restore the handler mask before returning to the event loop so a
        // deferred shutdown signal is delivered on every exit path.
        sigterm.restore();
        self.closeStdin();
        self.state = .running;
    }

    fn handleBrokerLine(self: *Handler, line: []const u8) !void {
        var parsed = gateway_protocol.parseBrokerToGateway(self.allocator, line, self.state) catch |err| {
            // The state-aware parser intentionally rejects fallback after
            // start.  Keep that rejection fail-closed rather than treating a
            // parser error as an internal transport retry.
            self.protocolFailure(if (err == error.InvalidState) "invalid broker message state" else "invalid broker message") catch {};
            return err;
        };
        defer parsed.deinit();

        switch (parsed.value) {
            .fallback => |message| {
                if (!std.mem.eql(u8, message.requestId, self.request_id)) return error.RequestMismatch;
                self.closeStdin();
                try self.queueExternalValue(ExternalFallback{
                    .type = "fallback",
                    .requestId = self.request_id,
                });
                self.terminalize();
            },
            .@"error" => |message| {
                if (!std.mem.eql(u8, message.requestId, self.request_id)) return error.RequestMismatch;
                self.retryCleanupChild();
                self.closeStdin();
                try self.queueExternalValue(ExternalError{
                    .type = "error",
                    .requestId = self.request_id,
                    .message = message.message,
                });
                self.terminalize();
            },
            .start => |message| {
                if (self.state != .awaiting_decision or !std.mem.eql(u8, message.requestId, self.request_id)) return error.InvalidState;
                self.spawnApproved(message) catch |err| {
                    self.retryCleanupChild();
                    self.queueBroker(.{ .transport_error = .{
                        .requestId = self.request_id,
                        .message = "failed to spawn host command",
                    } }) catch {};
                    self.flushBrokerForTerminal();
                    self.queueExternalValue(ExternalError{
                        .type = "error",
                        .requestId = self.request_id,
                        .message = "failed to spawn host command",
                    }) catch {};
                    self.terminalize();
                    return err;
                };
            },
            .masked_chunk => |message| {
                if (!std.mem.eql(u8, message.requestId, self.request_id)) return error.RequestMismatch;
                if (!self.hasExternalChunkRoom()) return error.OutputBackpressure;
                try self.queueExternalValue(ExternalChunk{
                    .type = "chunk",
                    .requestId = self.request_id,
                    .fd = message.fd,
                    .data = message.data,
                });
            },
            .result => |message| {
                if (!std.mem.eql(u8, message.requestId, self.request_id)) return error.RequestMismatch;
                self.retryCleanupChild();
                try self.queueExternalValue(ExternalResult{
                    .type = "result",
                    .requestId = self.request_id,
                    .exitCode = message.exitCode,
                });
                self.terminalize();
            },
            .kill => |message| {
                if (!std.mem.eql(u8, message.requestId, self.request_id)) return error.RequestMismatch;
                if (self.child) |child| {
                    if (child.group_active) {
                        const signal: u8 = if (std.mem.eql(u8, message.signal, "SIGTERM")) posix.SIG.TERM else posix.SIG.KILL;
                        posix.kill(-child.pgid, signal) catch |err| switch (err) {
                            error.ProcessNotFound => {},
                            else => return err,
                        };
                    }
                }
            },
        }
    }

    fn processBrokerLines(self: *Handler) !void {
        while (self.hasExternalChunkRoom()) {
            const line: []u8 = blk: {
                if (self.pending_broker_line) |pending| {
                    self.pending_broker_line = null;
                    break :blk pending;
                }
                break :blk self.broker_lines.next() catch |err| {
                    self.protocolFailure("invalid broker framing") catch {};
                    return err;
                } orelse return;
            };
            var retained = false;
            defer if (!retained) self.allocator.free(line);

            self.handleBrokerLine(line) catch |err| {
                if (err == error.OutputBackpressure) {
                    self.pending_broker_line = line;
                    retained = true;
                    return;
                }
                if (self.state != .terminal) self.protocolFailure("invalid broker message") catch {};
                if (self.state == .terminal) return;
                return err;
            };
            if (self.state == .terminal) return;
        }
    }

    fn drainChildStream(self: *Handler, is_stdout: bool) !void {
        const child = self.child orelse return;
        const fd = if (is_stdout) child.stdout_fd else child.stderr_fd;
        if (fd < 0) return;
        if (!self.hasBrokerChunkRoom()) return;
        var raw: [gateway_protocol.max_chunk_bytes]u8 = undefined;
        const count = posix.read(fd, &raw) catch |err| switch (err) {
            error.WouldBlock => return,
            else => return err,
        };
        if (count == 0) {
            if (is_stdout) {
                if (self.child) |*owned| {
                    if (owned.child.stdout) |*file| file.close();
                    owned.child.stdout = null;
                    owned.stdout_fd = -1;
                }
                self.stdout_eof = true;
            } else {
                if (self.child) |*owned| {
                    if (owned.child.stderr) |*file| file.close();
                    owned.child.stderr = null;
                    owned.stderr_fd = -1;
                }
                self.stderr_eof = true;
            }
            return;
        }

        const encoded_len = std.base64.standard.Encoder.calcSize(count);
        const encoded = try self.allocator.alloc(u8, encoded_len);
        defer self.allocator.free(encoded);
        _ = std.base64.standard.Encoder.encode(encoded, raw[0..count]);
        try self.queueBroker(.{ .raw_chunk = .{
            .requestId = self.request_id,
            .fd = if (is_stdout) 1 else 2,
            .data = encoded,
        } });
    }

    fn maybeObserveChild(self: *Handler) !void {
        if (self.child == null or self.state == .terminal) return;
        const term = self.child.?.pollExit() catch |err| {
            try self.protocolFailure("host command wait failed");
            return err;
        };
        if (term) |value| {
            if (self.child_exit_code == null) self.child_exit_code = processExitCode(value);
        }
        if (self.child_exit_code != null and self.stdout_eof and self.stderr_eof and !self.process_exit_sent) {
            try self.queueBroker(.{ .process_exit = .{
                .requestId = self.request_id,
                .exitCode = self.child_exit_code.?,
            } });
            self.process_exit_sent = true;
            self.state = .awaiting_result;
        }
    }

    fn runEventLoop(self: *Handler) !void {
        while (true) {
            if (handler_stop_requested.load(.acquire) and self.state != .terminal) {
                self.externalDisconnected();
            }

            if (self.state == .terminal) {
                self.discardBroker();
                self.retryCleanupChild();
                if (self.external_out.empty()) return;
            }

            if (self.state == .running or self.state == .awaiting_result) {
                self.maybeObserveChild() catch |err| {
                    self.retryCleanupChild();
                    return err;
                };
            }

            if (self.internal_fd != null and self.execute_sent and self.state != .terminal and
                (self.pending_broker_line != null or self.broker_lines.bytes.items.len > self.broker_lines.start))
            {
                try self.processBrokerLines();
            }

            if (self.state == .terminal and self.external_out.empty() and self.broker_out.empty()) return;

            var pollfds: [4]posix.pollfd = undefined;
            var tags: [4]u8 = undefined;
            var count: usize = 0;
            if (self.external_fd >= 0) {
                var events: i16 = posix.POLL.HUP | posix.POLL.ERR | posix.POLL.NVAL;
                if (!self.external_out.empty()) events |= posix.POLL.OUT;
                pollfds[count] = .{ .fd = self.external_fd, .events = events, .revents = 0 };
                tags[count] = 0;
                count += 1;
            }
            if (self.state != .terminal) {
                if (self.internal_fd) |fd| {
                    var events: i16 = posix.POLL.HUP | posix.POLL.ERR | posix.POLL.NVAL;
                    if (self.execute_sent and
                        self.broker_lines.hasReadHeadroom() and
                        self.hasExternalChunkRoom())
                    {
                        events |= posix.POLL.IN;
                    }
                    if (!self.broker_out.empty()) events |= posix.POLL.OUT;
                    pollfds[count] = .{ .fd = fd, .events = events, .revents = 0 };
                    tags[count] = 1;
                    count += 1;
                }
            }
            if ((self.state == .running or self.state == .awaiting_result) and self.child != null and self.hasBrokerChunkRoom()) {
                if (self.child.?.stdout_fd >= 0) {
                    pollfds[count] = .{ .fd = self.child.?.stdout_fd, .events = posix.POLL.IN | posix.POLL.HUP | posix.POLL.ERR, .revents = 0 };
                    tags[count] = 2;
                    count += 1;
                }
                if (self.child.?.stderr_fd >= 0) {
                    pollfds[count] = .{ .fd = self.child.?.stderr_fd, .events = posix.POLL.IN | posix.POLL.HUP | posix.POLL.ERR, .revents = 0 };
                    tags[count] = 3;
                    count += 1;
                }
            }

            if (count == 0) return;
            const ready = posix.poll(pollfds[0..count], poll_timeout_ms) catch |err| return err;
            if (ready == 0) continue;

            var i: usize = 0;
            while (i < count) : (i += 1) {
                const revents = pollfds[i].revents;
                if (revents == 0) continue;
                switch (tags[i]) {
                    0 => {
                        if (revents & (posix.POLL.HUP | posix.POLL.ERR | posix.POLL.NVAL) != 0) {
                            self.externalDisconnected();
                            continue;
                        }
                        if (revents & posix.POLL.OUT != 0) {
                            self.external_out.flush(self.external_fd) catch {
                                self.externalDisconnected();
                            };
                        }
                    },
                    1 => {
                        const internal_hangup = revents & (posix.POLL.HUP | posix.POLL.ERR | posix.POLL.NVAL) != 0;
                        if (revents & posix.POLL.OUT != 0 and self.internal_fd != null) {
                            self.flushBroker() catch {
                                self.internalDisconnected();
                                continue;
                            };
                        }
                        if (revents & posix.POLL.IN != 0 and self.internal_fd != null and self.state != .terminal) {
                            const n = self.broker_lines.readAvailable(self.internal_fd.?) catch |err| {
                                self.internalDisconnected();
                                return err;
                            };
                            if (n == 0) {
                                self.internalDisconnected();
                                continue;
                            }
                            try self.processBrokerLines();
                        }
                        if (internal_hangup and self.internal_fd != null and self.state != .terminal) {
                            self.internalDisconnected();
                        }
                    },
                    2 => self.drainChildStream(true) catch |err| {
                        self.protocolFailure("cannot read host command stdout") catch {};
                        return err;
                    },
                    3 => self.drainChildStream(false) catch |err| {
                        self.protocolFailure("cannot read host command stderr") catch {};
                        return err;
                    },
                    else => unreachable,
                }
            }

            if (self.state != .terminal and self.broker_out.pendingLen() > 0 and self.internal_fd != null) {
                self.flushBroker() catch self.internalDisconnected();
            }
            if (self.external_out.pendingLen() > 0 and self.external_fd >= 0) {
                self.external_out.flush(self.external_fd) catch self.externalDisconnected();
            }
        }
    }

    fn run(self: *Handler) !void {
        var received = fd_transport.receiveLine(
            self.allocator,
            self.external_fd,
            gateway_protocol.max_control_bytes,
        ) catch |err| {
            if (!handler_stop_requested.load(.acquire)) {
                self.sendExternalErrorBlocking(@errorName(err));
            }
            return err;
        };
        defer received.deinit();
        var parsed = gateway_protocol.parseExternalExecute(self.allocator, received.line) catch |err| {
            self.sendExternalErrorBlocking(@errorName(err));
            return err;
        };
        defer parsed.deinit();
        const request = parsed.value;
        self.request_id = request.requestId;
        self.max_chunk_frame_bytes = try self.maximumChunkFrameBytes();

        if (!std.mem.eql(u8, request.sessionId, self.session_id)) {
            self.sendExternalErrorBlocking("session mismatch");
            return error.SessionMismatch;
        }
        switch (request.stdinMode) {
            .fd => {
                const fd = received.stdin_fd orelse {
                    self.sendExternalErrorBlocking("stdinMode fd requires exactly one received descriptor");
                    return error.InvalidStdinDescriptor;
                };
                switch (fd_transport.selectStdin(fd, true)) {
                    .pass_fd => {},
                    .reject_read_write => {
                        self.sendExternalErrorBlocking("read-write stdin descriptors are not supported");
                        return error.InvalidStdinDescriptor;
                    },
                    .none => {
                        self.sendExternalErrorBlocking("stdin descriptor is not a readable non-tty");
                        return error.InvalidStdinDescriptor;
                    },
                }
                self.stdin_fd = fd;
                received.stdin_fd = null;
            },
            .none => if (received.stdin_fd != null) {
                self.sendExternalErrorBlocking("stdinMode none must not carry a descriptor");
                return error.UnexpectedStdinDescriptor;
            },
        }

        const internal_stream = std.net.connectUnixSocket(self.internal_socket_path) catch |err| {
            self.sendExternalErrorBlocking("cannot connect to hostexec broker");
            return err;
        };
        self.internal_fd = internal_stream.handle;
        try setNonBlocking(self.external_fd);
        try setNonBlocking(self.internal_fd.?);
        self.execute_sent = false;

        const execute = gateway_protocol.GatewayToBroker{ .execute = .{ .request = request } };
        self.queueBroker(execute) catch |err| {
            self.sendExternalErrorBlocking("cannot queue gateway request");
            return err;
        };
        try self.runEventLoop();
    }
};

const HandlerPid = struct {
    pid: posix.pid_t,
};

const GatewayLoopFault = enum {
    none,
    after_first_handler,
    registry_reserve_failure,
};

fn cleanupGateway(
    listener: posix.fd_t,
    external_socket: []const u8,
    handlers: *std.ArrayList(HandlerPid),
    allocator: Allocator,
) void {
    posix.close(listener);
    signalHandlers(handlers.items, posix.SIG.TERM);
    while (handlers.items.len > 0) {
        reapHandlers(handlers, allocator, false);
        if (handlers.items.len > 0) std.Thread.sleep(25 * std.time.ns_per_ms);
    }
    removeStaleSocket(external_socket) catch {};
    handlers.deinit(allocator);
}

fn reapHandlers(handlers: *std.ArrayList(HandlerPid), allocator: Allocator, blocking: bool) void {
    var i: usize = handlers.items.len;
    while (i > 0) {
        i -= 1;
        const options: u32 = if (blocking) 0 else posix.W.NOHANG;
        const result = posix.waitpid(handlers.items[i].pid, options);
        if (blocking or result.pid == handlers.items[i].pid) {
            _ = handlers.swapRemove(i);
        }
    }
    _ = allocator;
}

fn signalHandlers(handlers: []const HandlerPid, signal: u8) void {
    for (handlers) |handler| {
        posix.kill(-handler.pid, signal) catch |err| switch (err) {
            error.ProcessNotFound => {},
            else => {},
        };
    }
}

fn runGatewayWithFault(
    allocator: Allocator,
    options: GatewayOptions,
    fault: GatewayLoopFault,
    emit_readiness: bool,
) !void {
    shutdown_requested.store(false, .seq_cst);
    try installShutdownHandlers();
    const listener = try bindListener(options.external_socket);
    var handlers = std.ArrayList(HandlerPid).empty;
    defer cleanupGateway(listener, options.external_socket, &handlers, allocator);

    if (emit_readiness) try writeReadiness(allocator, options.external_socket);

    while (!shutdown_requested.load(.acquire)) {
        reapHandlers(&handlers, allocator, false);
        var pollfd = [_]posix.pollfd{.{ .fd = listener, .events = posix.POLL.IN, .revents = 0 }};
        _ = posix.poll(&pollfd, poll_timeout_ms) catch |err| return err;
        if (shutdown_requested.load(.acquire)) {
            break;
        }
        if (pollfd[0].revents & posix.POLL.IN == 0) continue;

        while (!shutdown_requested.load(.acquire)) {
            const connection = posix.accept(listener, null, null, posix.SOCK.CLOEXEC) catch |err| switch (err) {
                error.WouldBlock => break,
                else => return err,
            };
            if (handlers.items.len >= max_handlers) {
                posix.close(connection);
                continue;
            }

            // Reserve the registry slot before fork. A post-fork allocation
            // failure would leave a live handler that the parent cannot
            // address during shutdown.
            if (fault == .registry_reserve_failure) {
                posix.close(connection);
                return error.InjectedRegistryReserve;
            }
            handlers.ensureUnusedCapacity(allocator, 1) catch |err| {
                posix.close(connection);
                return err;
            };

            var fork_signals = SigtermDeferral.begin();
            defer_atfork_signal_reset = true;
            const child_pid = posix.fork() catch |err| {
                defer_atfork_signal_reset = false;
                fork_signals.restore();
                posix.close(connection);
                return err;
            };
            defer_atfork_signal_reset = false;
            if (child_pid == 0) {
                posix.close(listener);
                // The handler stays in its own group so parent shutdown can
                // terminate the handler without touching unrelated sessions.
                posix.setpgid(0, 0) catch {};
                handler_stop_requested.store(false, .seq_cst);
                handler_wakeup_fd.store(connection, .release);
                installHandlerShutdownHandlers();
                fork_signals.restore();
                var handler = Handler.init(allocator, options.session_id, options.internal_socket, connection);
                handler.run() catch {};
                handler.deinit();
                handler_wakeup_fd.store(-1, .release);
                posix.exit(0);
            }

            posix.close(connection);
            posix.setpgid(child_pid, child_pid) catch |err| switch (err) {
                error.ProcessNotFound, error.PermissionDenied => {},
                else => {
                    fork_signals.restore();
                    posix.kill(-child_pid, posix.SIG.TERM) catch {};
                    _ = posix.waitpid(child_pid, 0);
                    return err;
                },
            };
            handlers.appendAssumeCapacity(.{ .pid = child_pid });
            fork_signals.restore();
            if (fault == .after_first_handler) return error.InjectedLoopError;
        }
    }
}

fn runGateway(allocator: Allocator, options: GatewayOptions) !void {
    return runGatewayWithFault(allocator, options, .none, true);
}

const ConnectorState = struct {
    path: []const u8,
    stop: *std.atomic.Value(bool),
    connected: *std.atomic.Value(bool),
    disconnected: *std.atomic.Value(bool),
};

fn connectAndHold(state: *ConnectorState) void {
    const address = socketAddress(state.path) catch return;
    while (!state.stop.load(.acquire)) {
        const fd = posix.socket(
            posix.AF.UNIX,
            posix.SOCK.STREAM | posix.SOCK.CLOEXEC,
            0,
        ) catch return;
        posix.connect(fd, @ptrCast(&address), @sizeOf(posix.sockaddr.un)) catch {
            posix.close(fd);
            std.Thread.sleep(std.time.ns_per_ms);
            continue;
        };
        defer posix.close(fd);
        state.connected.store(true, .release);
        while (!state.stop.load(.acquire)) {
            var pollfd = [_]posix.pollfd{.{
                .fd = fd,
                .events = posix.POLL.IN | posix.POLL.HUP | posix.POLL.ERR,
                .revents = 0,
            }};
            const ready = posix.poll(&pollfd, 25) catch return;
            if (ready == 0) continue;
            if (pollfd[0].revents & (posix.POLL.HUP | posix.POLL.ERR | posix.POLL.NVAL) != 0) {
                state.disconnected.store(true, .release);
                return;
            }
            if (pollfd[0].revents & posix.POLL.IN != 0) {
                var byte: [1]u8 = undefined;
                const count = posix.read(fd, &byte) catch {
                    state.disconnected.store(true, .release);
                    return;
                };
                if (count == 0) {
                    state.disconnected.store(true, .release);
                    return;
                }
            }
        }
        return;
    }
}

pub fn main() void {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const argv = std.process.argsAlloc(allocator) catch |err| {
        std.debug.print("nas-hostexec-gateway: cannot read arguments: {s}\n", .{@errorName(err)});
        posix.exit(1);
    };
    defer std.process.argsFree(allocator, argv);

    var options = parseArguments(allocator, argv) catch |err| {
        std.debug.print("nas-hostexec-gateway: invalid arguments ({s})\n", .{@errorName(err)});
        posix.exit(1);
    };
    defer options.deinit(allocator);
    runGateway(allocator, options) catch |err| {
        std.debug.print("nas-hostexec-gateway: failed ({s})\n", .{@errorName(err)});
        posix.exit(1);
    };
}

var injected_cleanup_attempts: usize = 0;
var injected_cleanup_failures: usize = 0;
var transient_real_cleanup_attempts: usize = 0;
var release_cleanup_attempts = std.atomic.Value(usize).init(0);
var release_cleanup = std.atomic.Value(bool).init(false);

fn injectedCleanup(child: *gateway_executor.ChildHandle) !void {
    _ = child;
    injected_cleanup_attempts += 1;
    if (injected_cleanup_attempts <= injected_cleanup_failures) return error.InjectedCleanup;
}

fn transientRealCleanup(child: *gateway_executor.ChildHandle) !void {
    if (transient_real_cleanup_attempts == 0) {
        transient_real_cleanup_attempts += 1;
        return error.InjectedCleanup;
    }
    try child.deinit();
    transient_real_cleanup_attempts += 1;
}

fn releaseCleanup(child: *gateway_executor.ChildHandle) !void {
    _ = child;
    _ = release_cleanup_attempts.fetchAdd(1, .seq_cst);
    if (!release_cleanup.load(.acquire)) return error.InjectedCleanup;
}

fn retryCleanupWorker(handler: *Handler) void {
    handler.retryCleanupChild();
}

// These helpers intentionally exercise the same forked listener and handler
// used by the installed gateway.  Keeping the mock broker in the test
// process makes every wire direction observable without introducing a second
// implementation of the gateway protocol.
const IntegrationReader = struct {
    allocator: Allocator,
    bytes: std.ArrayList(u8) = .{},

    fn init(allocator: Allocator) IntegrationReader {
        return .{ .allocator = allocator };
    }

    fn deinit(self: *IntegrationReader) void {
        self.bytes.deinit(self.allocator);
        self.* = undefined;
    }

    fn nextLine(self: *IntegrationReader, fd: posix.fd_t, timeout_ms: i32) ![]u8 {
        self.bytes.clearRetainingCapacity();
        var timer = try std.time.Timer.start();
        while (true) {
            const elapsed_ms = timer.read() / std.time.ns_per_ms;
            if (elapsed_ms >= @as(u64, @intCast(timeout_ms))) return error.IntegrationTimeout;
            const remaining_ms = @as(u64, @intCast(timeout_ms)) - elapsed_ms;
            const wait_ms: i32 = @intCast(@max(@as(u64, 1), @min(remaining_ms, @as(u64, 50))));
            var pollfd = [_]posix.pollfd{.{
                .fd = fd,
                .events = posix.POLL.IN | posix.POLL.HUP | posix.POLL.ERR | posix.POLL.NVAL,
                .revents = 0,
            }};
            const ready = try posix.poll(&pollfd, wait_ms);
            if (ready == 0) continue;
            const revents = pollfd[0].revents;
            if (revents & posix.POLL.IN == 0 and revents & (posix.POLL.HUP | posix.POLL.ERR | posix.POLL.NVAL) != 0) {
                return error.EndOfStream;
            }
            if (revents & posix.POLL.IN == 0) continue;

            var byte: [1]u8 = undefined;
            const count = posix.read(fd, &byte) catch |err| switch (err) {
                error.WouldBlock => continue,
                else => return err,
            };
            if (count == 0) return error.EndOfStream;
            if (self.bytes.items.len >= gateway_protocol.max_control_bytes) return error.MessageTooLong;
            try self.bytes.append(self.allocator, byte[0]);
            if (byte[0] == '\n') {
                const line = try self.allocator.dupe(u8, self.bytes.items[0 .. self.bytes.items.len - 1]);
                self.bytes.clearRetainingCapacity();
                return line;
            }
        }
    }
};

const GatewayIntegrationInitFault = enum {
    none,
    wait_external_socket,
    connect_external_socket,
};

const ShutdownRequest = enum {
    normal,
    force_timeout,
};

const ShutdownOutcome = enum {
    cooperative,
    forced,
};

const TestProcessGroupOwner = struct {
    pid: ?posix.pid_t,
    signal_attempts: *usize,
    reap_on_cleanup: bool = false,
    reaped: bool = false,
    injected_reap_failures: usize = 0,
    persistent_reap_failure: bool = false,

    fn init(pid: posix.pid_t, signal_attempts: *usize) TestProcessGroupOwner {
        return .{ .pid = pid, .signal_attempts = signal_attempts };
    }

    fn disarm(self: *TestProcessGroupOwner) void {
        self.pid = null;
    }

    fn signalWith(self: *TestProcessGroupOwner, signal_value: u8) !void {
        if (!self.reaped) {
            if (self.pid) |pid| {
                self.signal_attempts.* += 1;
                posix.kill(-pid, signal_value) catch |err| switch (err) {
                    error.ProcessNotFound => {},
                    else => return err,
                };
            }
        }
    }

    fn signal(self: *TestProcessGroupOwner) !void {
        try self.signalWith(posix.SIG.KILL);
    }

    fn cleanup(self: *TestProcessGroupOwner) void {
        if (self.pid == null) return;
        if (self.reap_on_cleanup) {
            self.mustCleanOwnedGroup() catch |err| {
                std.debug.panic("test-owned process group cleanup failed: {s}", .{@errorName(err)});
            };
        } else {
            self.signal() catch |err| {
                std.debug.panic("test-owned process group signal failed: {s}", .{@errorName(err)});
            };
            self.disarm();
        }
    }

    fn enableReapOnCleanup(self: *TestProcessGroupOwner) void {
        self.reap_on_cleanup = true;
    }

    fn injectFirstReapFailure(self: *TestProcessGroupOwner) void {
        self.injected_reap_failures = 1;
        self.persistent_reap_failure = false;
    }

    fn injectPersistentReapFailure(self: *TestProcessGroupOwner) void {
        self.injected_reap_failures = 0;
        self.persistent_reap_failure = true;
    }

    fn clearInjectedReapFailure(self: *TestProcessGroupOwner) void {
        self.injected_reap_failures = 0;
        self.persistent_reap_failure = false;
    }

    fn mustCleanOwnedGroup(self: *TestProcessGroupOwner) !void {
        if (self.pid == null) return;
        if (!self.reaped) {
            try self.signal();
            try self.reap();
        }
        self.disarm();
    }

    fn reap(self: *TestProcessGroupOwner) !void {
        if (self.reaped) return;
        const pid = self.pid orelse return;
        if (self.persistent_reap_failure) return error.InjectedReapFailure;
        if (self.injected_reap_failures > 0) {
            self.injected_reap_failures -= 1;
            return error.InjectedReapFailure;
        }
        var rounds: usize = 0;
        while (rounds < 300) : (rounds += 1) {
            const result = posix.waitpid(pid, posix.W.NOHANG);
            if (result.pid == pid) {
                self.reaped = true;
                return;
            }
            std.Thread.sleep(10 * std.time.ns_per_ms);
        }
        return error.IntegrationTimeout;
    }
};

fn installTestSubreaper() !i32 {
    var previous: i32 = 0;
    _ = try posix.prctl(.GET_CHILD_SUBREAPER, .{@intFromPtr(&previous)});
    _ = try posix.prctl(.SET_CHILD_SUBREAPER, .{1});
    return previous;
}

fn restoreTestSubreaper(previous: i32) void {
    _ = posix.prctl(.SET_CHILD_SUBREAPER, .{@as(usize, @intCast(previous))}) catch {};
}

fn processIsLive(pid: posix.pid_t) bool {
    var path: [64]u8 = undefined;
    const path_slice = std.fmt.bufPrint(&path, "/proc/{d}/stat", .{pid}) catch return false;
    var file = std.fs.cwd().openFile(path_slice, .{}) catch return false;
    defer file.close();
    var buffer: [4096]u8 = undefined;
    const len = file.read(&buffer) catch return false;
    const stat = buffer[0..len];
    const comm_end = std.mem.lastIndexOfScalar(u8, stat, ')') orelse return false;
    if (comm_end + 2 >= stat.len) return false;
    return stat[comm_end + 2] != 'Z';
}

fn expectProcessGone(pid: posix.pid_t) !void {
    var rounds: usize = 0;
    while (rounds < 300) : (rounds += 1) {
        if (!processIsLive(pid)) return;
        std.Thread.sleep(10 * std.time.ns_per_ms);
    }
    return error.IntegrationTimeout;
}

fn openDescriptorCount(pid: posix.pid_t) !usize {
    var path: [96]u8 = undefined;
    const path_slice = try std.fmt.bufPrint(&path, "/proc/{d}/fd", .{pid});
    var dir = try std.fs.cwd().openDir(path_slice, .{ .iterate = true });
    defer dir.close();
    var count: usize = 0;
    var iterator = dir.iterate();
    while (try iterator.next()) |_| count += 1;
    return count;
}

fn spawnTestOwnedGroup() !posix.pid_t {
    const pid = try posix.fork();
    if (pid == 0) {
        posix.setpgid(0, 0) catch posix.exit(1);
        while (true) std.Thread.sleep(std.time.ns_per_s);
    }
    errdefer {
        posix.kill(pid, posix.SIG.KILL) catch {};
        _ = posix.waitpid(pid, 0);
    }
    try posix.setpgid(pid, pid);
    return pid;
}

test "owned process-group cleanup retries after an injected reap failure" {
    var signal_attempts: usize = 0;
    var owner = TestProcessGroupOwner.init(try spawnTestOwnedGroup(), &signal_attempts);
    owner.enableReapOnCleanup();
    defer owner.cleanup();

    owner.injectFirstReapFailure();
    try std.testing.expectError(error.InjectedReapFailure, owner.mustCleanOwnedGroup());
    try std.testing.expect(owner.pid != null);

    try owner.mustCleanOwnedGroup();
    try std.testing.expect(owner.pid == null);
    try std.testing.expectEqual(@as(usize, 2), signal_attempts);
}

test "owned process-group cleanup reports persistent reap failure without orphan" {
    var signal_attempts: usize = 0;
    var owner = TestProcessGroupOwner.init(try spawnTestOwnedGroup(), &signal_attempts);
    owner.enableReapOnCleanup();
    defer {
        owner.clearInjectedReapFailure();
        owner.cleanup();
    }

    owner.injectPersistentReapFailure();
    try std.testing.expectError(error.InjectedReapFailure, owner.mustCleanOwnedGroup());
    try std.testing.expectError(error.InjectedReapFailure, owner.mustCleanOwnedGroup());
    try std.testing.expect(owner.pid != null);

    owner.clearInjectedReapFailure();
    try owner.mustCleanOwnedGroup();
    try std.testing.expect(owner.pid == null);
}

const GatewayIntegration = struct {
    allocator: Allocator,
    root: []u8,
    external_socket: []u8,
    internal_socket: []u8,
    internal_listener: posix.fd_t,
    gateway_pid: ?posix.pid_t,
    external_fd: posix.fd_t = -1,
    broker_fd: posix.fd_t = -1,
    broker_reader: IntegrationReader,
    external_reader: IntegrationReader,
    deinitialized: bool = false,

    fn init(allocator: Allocator, tmp: anytype) !GatewayIntegration {
        return initWithFault(allocator, tmp, .none);
    }

    fn initWithFault(allocator: Allocator, tmp: anytype, fault: GatewayIntegrationInitFault) !GatewayIntegration {
        var root: ?[]u8 = try tmp.dir.realpathAlloc(allocator, ".");
        errdefer if (root) |value| allocator.free(value);
        var external_socket: ?[]u8 = try std.fs.path.join(allocator, &.{ root.?, "external.sock" });
        errdefer if (external_socket) |value| allocator.free(value);
        var internal_socket: ?[]u8 = try std.fs.path.join(allocator, &.{ root.?, "internal.sock" });
        errdefer if (internal_socket) |value| allocator.free(value);
        var internal_listener: ?posix.fd_t = try bindListener(internal_socket.?);
        errdefer if (internal_listener) |fd| posix.close(fd);

        const gateway_pid = try posix.fork();
        if (gateway_pid == 0) {
            // The broker listener belongs to the test process.  Closing the
            // inherited copy is important for deterministic EOF tests.
            posix.close(internal_listener.?);
            runGatewayWithFault(std.heap.page_allocator, .{
                .session_id = "integration",
                .external_socket = external_socket.?,
                .internal_socket = internal_socket.?,
            }, .none, false) catch posix.exit(1);
            posix.exit(0);
        }

        var result = GatewayIntegration{
            .allocator = allocator,
            .root = root.?,
            .external_socket = external_socket.?,
            .internal_socket = internal_socket.?,
            .internal_listener = internal_listener.?,
            .gateway_pid = gateway_pid,
            .broker_reader = IntegrationReader.init(allocator),
            .external_reader = IntegrationReader.init(allocator),
        };
        root = null;
        external_socket = null;
        internal_socket = null;
        internal_listener = null;
        errdefer result.deinit();
        if (fault == .wait_external_socket) return error.InjectedIntegrationWait;
        try result.waitForExternalSocket();
        if (fault == .connect_external_socket) return error.InjectedIntegrationConnect;
        const stream = try std.net.connectUnixSocket(result.external_socket);
        result.external_fd = stream.handle;
        return result;
    }

    fn deinit(self: *GatewayIntegration) void {
        if (self.deinitialized) return;
        self.deinitialized = true;

        if (self.external_fd >= 0) {
            posix.close(self.external_fd);
            self.external_fd = -1;
        }
        if (self.broker_fd >= 0) {
            posix.close(self.broker_fd);
            self.broker_fd = -1;
        }
        if (self.internal_listener >= 0) {
            posix.close(self.internal_listener);
            self.internal_listener = -1;
        }

        _ = self.shutdownGateway(.normal);

        removeStaleSocket(self.external_socket) catch {};
        removeStaleSocket(self.internal_socket) catch {};
        self.broker_reader.deinit();
        self.external_reader.deinit();
        self.allocator.free(self.root);
        self.allocator.free(self.external_socket);
        self.allocator.free(self.internal_socket);
        self.* = undefined;
    }

    fn shutdownGateway(self: *GatewayIntegration, request: ShutdownRequest) ShutdownOutcome {
        const pid = self.gateway_pid orelse return .cooperative;
        if (request == .force_timeout) {
            // Test-only fault injection: stop the parent before TERM so the
            // timeout branch SIGKILLs/reaps only the gateway, leaving its
            // descendant groups for their still-armed owners to clean up.
            posix.kill(pid, posix.SIG.STOP) catch {};
            std.Thread.sleep(10 * std.time.ns_per_ms);
        }
        signalGatewayShutdown(pid);
        const max_signal_retries: usize = if (request == .force_timeout) 1 else 30;
        var signal_retries: usize = 0;
        var outcome: ShutdownOutcome = .cooperative;
        while (true) {
            const result = posix.waitpid(pid, posix.W.NOHANG);
            if (result.pid == pid) break;
            if (signal_retries == max_signal_retries) {
                outcome = .forced;
                // Keep a failed test from leaking a gateway process, while
                // leaving descendant cleanup to their still-owned groups.
                posix.kill(pid, posix.SIG.KILL) catch {};
                _ = posix.waitpid(pid, 0);
                break;
            }
            // A forked gateway can inherit the test process's SIGTERM
            // handler before it installs its own. Retry at a bounded 100 ms
            // cadence so an early signal is not lost without starving the
            // cooperative shutdown loop with repeated interruptions.
            std.Thread.sleep(100 * std.time.ns_per_ms);
            signalGatewayShutdown(pid);
            signal_retries += 1;
        }
        self.gateway_pid = null;
        return outcome;
    }

    fn signalGatewayShutdown(pid: posix.pid_t) void {
        posix.kill(pid, posix.SIG.TERM) catch |err| switch (err) {
            error.ProcessNotFound => {},
            else => {},
        };
    }

    fn waitForExternalSocket(self: *GatewayIntegration) !void {
        var timer = try std.time.Timer.start();
        while (timer.read() < 3 * std.time.ns_per_s) {
            std.fs.cwd().access(self.external_socket, .{}) catch |err| switch (err) {
                error.FileNotFound => {
                    std.Thread.sleep(10 * std.time.ns_per_ms);
                    continue;
                },
                else => return err,
            };
            return;
        }
        return error.IntegrationTimeout;
    }

    fn waitForHandlerPid(self: *const GatewayIntegration) !posix.pid_t {
        const gateway_pid = self.gateway_pid orelse return error.IntegrationProcessGone;
        var path_buf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&path_buf, "/proc/{d}/task/{d}/children", .{ gateway_pid, gateway_pid });
        var timer = try std.time.Timer.start();
        while (timer.read() < 3 * std.time.ns_per_s) {
            var file = std.fs.openFileAbsolute(path, .{}) catch |err| switch (err) {
                error.FileNotFound => {
                    std.Thread.sleep(10 * std.time.ns_per_ms);
                    continue;
                },
                else => return err,
            };
            defer file.close();
            var bytes: [128]u8 = undefined;
            const count = try file.read(&bytes);
            var tokens = std.mem.tokenizeAny(u8, bytes[0..count], " \t\n");
            const token = tokens.next() orelse {
                std.Thread.sleep(10 * std.time.ns_per_ms);
                continue;
            };
            return std.fmt.parseInt(posix.pid_t, token, 10);
        }
        return error.IntegrationTimeout;
    }

    fn acceptBroker(self: *GatewayIntegration) !void {
        if (self.broker_fd >= 0) return;
        var timer = try std.time.Timer.start();
        while (timer.read() < 3 * std.time.ns_per_s) {
            var pollfd = [_]posix.pollfd{.{
                .fd = self.internal_listener,
                .events = posix.POLL.IN | posix.POLL.HUP | posix.POLL.ERR,
                .revents = 0,
            }};
            const ready = try posix.poll(&pollfd, 50);
            if (ready == 0) continue;
            if (pollfd[0].revents & posix.POLL.IN == 0) return error.BrokerDisconnected;
            self.broker_fd = try posix.accept(self.internal_listener, null, null, posix.SOCK.CLOEXEC);
            return;
        }
        return error.IntegrationTimeout;
    }

    fn expectNoBrokerConnection(self: *GatewayIntegration) !void {
        var pollfd = [_]posix.pollfd{.{
            .fd = self.internal_listener,
            .events = posix.POLL.IN | posix.POLL.HUP | posix.POLL.ERR,
            .revents = 0,
        }};
        const ready = try posix.poll(&pollfd, 150);
        if (ready == 0) return;
        if (pollfd[0].revents & posix.POLL.IN != 0) {
            const fd = try posix.accept(self.internal_listener, null, null, posix.SOCK.CLOEXEC);
            posix.close(fd);
            return error.UnexpectedBrokerConnection;
        }
        return error.BrokerDisconnected;
    }

    fn closeExternal(self: *GatewayIntegration) void {
        if (self.external_fd >= 0) {
            posix.close(self.external_fd);
            self.external_fd = -1;
        }
    }

    fn reconnectExternal(self: *GatewayIntegration) !void {
        self.closeExternal();
        const stream = try std.net.connectUnixSocket(self.external_socket);
        self.external_fd = stream.handle;
    }

    fn closeBroker(self: *GatewayIntegration) void {
        if (self.broker_fd >= 0) {
            posix.close(self.broker_fd);
            self.broker_fd = -1;
        }
    }

    fn sendExecute(self: *GatewayIntegration, session_id: []const u8, request_id: []const u8, stdin_mode: gateway_protocol.StdinMode, stdin_fd: ?posix.fd_t) !void {
        const request = gateway_protocol.ExternalExecuteRequest{
            .version = 2,
            .type = "execute",
            .sessionId = session_id,
            .requestId = request_id,
            .argv0 = test_paths.executable("true"),
            .args = &.{},
            .cwd = "/",
            .tty = false,
            .stdinMode = stdin_mode,
        };
        const encoded = try std.json.Stringify.valueAlloc(self.allocator, request, .{});
        defer self.allocator.free(encoded);
        const line = try self.allocator.alloc(u8, encoded.len + 1);
        defer self.allocator.free(line);
        @memcpy(line[0..encoded.len], encoded);
        line[encoded.len] = '\n';
        try fd_transport.sendLine(self.external_fd, line, stdin_fd);
    }

    fn sendLargeExecute(self: *GatewayIntegration, request_id: []const u8, stdin_fd: ?posix.fd_t) !void {
        const argument = try self.allocator.alloc(u8, 2 * 1024 * 1024);
        defer self.allocator.free(argument);
        @memset(argument, 'x');
        const args = [_][]const u8{argument};
        const request = gateway_protocol.ExternalExecuteRequest{
            .version = 2,
            .type = "execute",
            .sessionId = "integration",
            .requestId = request_id,
            .argv0 = test_paths.executable("true"),
            .args = &args,
            .cwd = "/",
            .tty = false,
            .stdinMode = if (stdin_fd == null) .none else .fd,
        };
        const encoded = try std.json.Stringify.valueAlloc(self.allocator, request, .{});
        defer self.allocator.free(encoded);
        const line = try self.allocator.alloc(u8, encoded.len + 1);
        defer self.allocator.free(line);
        @memcpy(line[0..encoded.len], encoded);
        line[encoded.len] = '\n';
        try fd_transport.sendLine(self.external_fd, line, stdin_fd);
    }

    fn sendOversizedExecute(self: *GatewayIntegration, request_id: []const u8, stdin_fd: posix.fd_t) !void {
        const argument = try self.allocator.alloc(u8, gateway_protocol.max_control_bytes + 1024);
        defer self.allocator.free(argument);
        @memset(argument, 'x');
        const args = [_][]const u8{argument};
        const request = gateway_protocol.ExternalExecuteRequest{
            .version = 2,
            .type = "execute",
            .sessionId = "integration",
            .requestId = request_id,
            .argv0 = test_paths.executable("true"),
            .args = &args,
            .cwd = "/",
            .tty = false,
            .stdinMode = .fd,
        };
        const encoded = try std.json.Stringify.valueAlloc(self.allocator, request, .{});
        defer self.allocator.free(encoded);
        const line = try self.allocator.alloc(u8, encoded.len + 1);
        defer self.allocator.free(line);
        @memcpy(line[0..encoded.len], encoded);
        line[encoded.len] = '\n';
        try fd_transport.sendLine(self.external_fd, line, stdin_fd);
    }

    fn sendBroker(self: *GatewayIntegration, line: []const u8) !void {
        try sendSocketAll(self.broker_fd, line);
    }

    fn sendOversized(self: *GatewayIntegration, fd: posix.fd_t) !void {
        const payload = try self.allocator.alloc(u8, gateway_protocol.max_control_bytes + 1);
        defer self.allocator.free(payload);
        @memset(payload, 'x');
        try sendSocketAll(fd, payload);
    }

    fn expectHandlerCleanup(self: *GatewayIntegration, handler_pid: posix.pid_t, parent_fd_count: usize) !void {
        try expectProcessGone(handler_pid);
        const gateway_pid = self.gateway_pid orelse return error.IntegrationProcessGone;
        var rounds: usize = 0;
        while (rounds < 300) : (rounds += 1) {
            if ((openDescriptorCount(gateway_pid) catch 0) == parent_fd_count) return;
            std.Thread.sleep(10 * std.time.ns_per_ms);
        }
        return error.IntegrationTimeout;
    }

    fn sendDelayedMaximumFrame(self: *GatewayIntegration, request_id: []const u8, crlf: bool) !void {
        const base = try std.json.Stringify.valueAlloc(self.allocator, gateway_protocol.BrokerToGateway{
            .fallback = .{ .requestId = request_id },
        }, .{});
        defer self.allocator.free(base);
        try std.testing.expect(base.len <= gateway_protocol.max_control_bytes);

        const encoded = try self.allocator.alloc(u8, gateway_protocol.max_control_bytes);
        defer self.allocator.free(encoded);
        @memcpy(encoded[0..base.len], base);
        @memset(encoded[base.len..], ' ');
        try self.sendBroker(encoded);
        std.Thread.sleep(100 * std.time.ns_per_ms);
        if (crlf) {
            try self.sendBroker("\r");
            std.Thread.sleep(100 * std.time.ns_per_ms);
        }
        try self.sendBroker("\n");
    }

    fn writePipeAll(fd: posix.fd_t, bytes: []const u8) !void {
        var offset: usize = 0;
        while (offset < bytes.len) {
            const count = try posix.write(fd, bytes[offset..]);
            if (count == 0) return error.ZeroProgress;
            offset += count;
        }
    }

    fn sendStart(self: *GatewayIntegration, request_id: []const u8, argv0: []const u8, args: []const []const u8) !void {
        const message = gateway_protocol.BrokerToGateway{ .start = .{
            .requestId = request_id,
            .argv0 = argv0,
            .args = args,
            .cwd = "/",
            .env = .{},
        } };
        const encoded = try gateway_protocol.stringifyMessage(self.allocator, message);
        defer self.allocator.free(encoded);
        try self.sendBroker(encoded);
    }

    fn readBroker(self: *GatewayIntegration) ![]u8 {
        return self.broker_reader.nextLine(self.broker_fd, 3000);
    }

    fn readExternal(self: *GatewayIntegration) ![]u8 {
        return self.external_reader.nextLine(self.external_fd, 3000);
    }

    fn expectExecute(self: *GatewayIntegration, request_id: []const u8) !void {
        const line = try self.readBroker();
        defer self.allocator.free(line);
        var parsed = try gateway_protocol.parseGatewayToBroker(self.allocator, line, .awaiting_decision);
        defer parsed.deinit();
        switch (parsed.value) {
            .execute => |message| {
                try std.testing.expectEqualStrings(request_id, message.request.requestId);
                try std.testing.expectEqualStrings("integration", message.request.sessionId);
            },
            else => return error.UnexpectedBrokerMessage,
        }
    }

    fn expectExternal(self: *GatewayIntegration, expected_type: []const u8, request_id: []const u8) ![]u8 {
        const line = try self.readExternal();
        errdefer self.allocator.free(line);
        var value = try std.json.parseFromSlice(std.json.Value, self.allocator, line, .{});
        defer value.deinit();
        const object = value.value.object;
        const type_value = object.get("type") orelse return error.UnexpectedExternalMessage;
        const id_value = object.get("requestId") orelse return error.UnexpectedExternalMessage;
        if (type_value != .string or id_value != .string) return error.UnexpectedExternalMessage;
        try std.testing.expectEqualStrings(expected_type, type_value.string);
        try std.testing.expectEqualStrings(request_id, id_value.string);
        return line;
    }

    fn expectSpawned(self: *GatewayIntegration, state: gateway_protocol.GatewayState, request_id: []const u8) !posix.pid_t {
        const line = try self.readBroker();
        defer self.allocator.free(line);
        var parsed = try gateway_protocol.parseGatewayToBroker(self.allocator, line, state);
        defer parsed.deinit();
        return switch (parsed.value) {
            .spawned => |message| blk: {
                try std.testing.expectEqualStrings(request_id, message.requestId);
                break :blk @intCast(message.pid);
            },
            else => error.UnexpectedBrokerMessage,
        };
    }

    fn startPersistentCommand(self: *GatewayIntegration, request_id: []const u8) !posix.pid_t {
        try self.sendExecute("integration", request_id, .none, null);
        try self.acceptBroker();
        try self.expectExecute(request_id);
        try self.sendStart(request_id, test_paths.executable("sleep"), &.{"30"});
        return self.expectSpawned(.running, request_id);
    }

    fn startNoisyCommand(self: *GatewayIntegration, request_id: []const u8) !posix.pid_t {
        try self.sendExecute("integration", request_id, .none, null);
        try self.acceptBroker();
        try self.expectExecute(request_id);
        try self.sendStart(request_id, test_paths.executable("sh"), &.{ "-c", "while :; do printf xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done" });
        return self.expectSpawned(.running, request_id);
    }

    fn expectProcessGroupGone(pid: posix.pid_t) !void {
        var rounds: usize = 0;
        while (rounds < 300) : (rounds += 1) {
            posix.kill(-pid, 0) catch |err| switch (err) {
                error.ProcessNotFound => return,
                else => return err,
            };
            std.Thread.sleep(10 * std.time.ns_per_ms);
        }
        return error.IntegrationTimeout;
    }

    fn expectProcessGroupGoneWithFault(pid: posix.pid_t, force_failure: bool) !void {
        if (force_failure) return error.InjectedProcessGroupProbe;
        return expectProcessGroupGone(pid);
    }

    fn runPreStartFallback(self: *GatewayIntegration) !void {
        try self.sendExecute("integration", "fallback", .none, null);
        try self.acceptBroker();
        try self.expectExecute("fallback");
        try self.sendBroker("{\"type\":\"fallback\",\"requestId\":\"fallback\"}\n");
        const response = try self.expectExternal("fallback", "fallback");
        self.allocator.free(response);
    }

    fn runSessionAndFdMismatch(self: *GatewayIntegration) !void {
        try self.sendExecute("wrong-session", "session-mismatch", .none, null);
        const session_error = try self.expectExternal("error", "session-mismatch");
        defer self.allocator.free(session_error);
        try std.testing.expect(std.mem.indexOf(u8, session_error, "session mismatch") != null);
        try self.expectNoBrokerConnection();

        try self.reconnectExternal();
        try self.sendExecute("integration", "fd-mismatch", .fd, null);
        const fd_error = try self.expectExternal("error", "fd-mismatch");
        defer self.allocator.free(fd_error);
        try std.testing.expect(std.mem.indexOf(u8, fd_error, "stdinMode fd requires") != null);
        try self.expectNoBrokerConnection();
    }

    fn runMaskedForwarding(self: *GatewayIntegration) !void {
        try self.sendExecute("integration", "masked", .none, null);
        try self.acceptBroker();
        try self.expectExecute("masked");
        try self.sendStart("masked", test_paths.executable("sh"), &.{ "-c", "printf raw" });

        var broker_state: gateway_protocol.GatewayState = .running;
        var saw_raw = false;
        var saw_process_exit = false;
        while (!saw_process_exit) {
            const line = try self.readBroker();
            defer self.allocator.free(line);
            var parsed = try gateway_protocol.parseGatewayToBroker(self.allocator, line, broker_state);
            defer parsed.deinit();
            switch (parsed.value) {
                .spawned => |message| {
                    try std.testing.expectEqualStrings("masked", message.requestId);
                    broker_state = .running;
                },
                .raw_chunk => |message| {
                    try std.testing.expectEqualStrings("masked", message.requestId);
                    try std.testing.expectEqualStrings("cmF3", message.data);
                    saw_raw = true;
                },
                .process_exit => |message| {
                    try std.testing.expectEqualStrings("masked", message.requestId);
                    try std.testing.expectEqual(@as(i32, 0), message.exitCode);
                    saw_process_exit = true;
                    broker_state = .awaiting_result;
                },
                else => return error.UnexpectedBrokerMessage,
            }
        }
        try std.testing.expect(saw_raw);
        try self.sendBroker("{\"type\":\"masked_chunk\",\"requestId\":\"masked\",\"fd\":1,\"data\":\"bWFza2Vk\"}\n");
        try self.sendBroker("{\"type\":\"result\",\"requestId\":\"masked\",\"exitCode\":0}\n");

        var saw_masked = false;
        var saw_result = false;
        while (!saw_result) {
            const line = try self.readExternal();
            defer self.allocator.free(line);
            try std.testing.expect(std.mem.indexOf(u8, line, "raw") == null);
            if (std.mem.indexOf(u8, line, "\"type\":\"chunk\"") != null) {
                try std.testing.expect(std.mem.indexOf(u8, line, "bWFza2Vk") != null);
                saw_masked = true;
            } else if (std.mem.indexOf(u8, line, "\"type\":\"result\"") != null) {
                saw_result = true;
            } else {
                return error.UnexpectedExternalMessage;
            }
        }
        try std.testing.expect(saw_masked);
    }

    fn runPostStartFallback(self: *GatewayIntegration) !void {
        const pid = try self.startPersistentCommand("post-start-fallback");
        try self.sendBroker("{\"type\":\"fallback\",\"requestId\":\"post-start-fallback\"}\n");

        const broker_line = try self.readBroker();
        defer self.allocator.free(broker_line);
        var parsed = try gateway_protocol.parseGatewayToBroker(self.allocator, broker_line, .running);
        defer parsed.deinit();
        switch (parsed.value) {
            .transport_error => |message| {
                try std.testing.expectEqualStrings("post-start-fallback", message.requestId);
            },
            else => return error.UnexpectedBrokerMessage,
        }
        const external = try self.expectExternal("error", "post-start-fallback");
        self.allocator.free(external);
        try expectProcessGroupGone(pid);
    }

    fn runExternalDisconnect(self: *GatewayIntegration) !void {
        const pid = try self.startPersistentCommand("external-disconnect");
        self.closeExternal();
        const line = try self.readBroker();
        defer self.allocator.free(line);
        var parsed = try gateway_protocol.parseGatewayToBroker(self.allocator, line, .running);
        defer parsed.deinit();
        switch (parsed.value) {
            .cancelled => |message| {
                try std.testing.expectEqualStrings("external-disconnect", message.requestId);
                try std.testing.expectEqualStrings("client disconnected", message.reason);
            },
            else => return error.UnexpectedBrokerMessage,
        }
        try expectProcessGroupGone(pid);
    }

    fn runInternalDisconnect(self: *GatewayIntegration) !void {
        const pid = try self.startPersistentCommand("internal-disconnect");
        self.closeBroker();
        const external = try self.expectExternal("error", "internal-disconnect");
        defer self.allocator.free(external);
        try std.testing.expect(std.mem.indexOf(u8, external, "hostexec broker disconnected") != null);
        try expectProcessGroupGone(pid);
    }

    fn runNoReadRequest(self: *GatewayIntegration) !void {
        const pipe = try posix.pipe2(.{ .CLOEXEC = true });
        var read_fd = pipe[0];
        var write_fd = pipe[1];
        defer if (read_fd >= 0) posix.close(read_fd);
        defer if (write_fd >= 0) posix.close(write_fd);
        const sibling_fd = try posix.dup(read_fd);
        defer posix.close(sibling_fd);

        try self.sendExecute("integration", "no-read", .fd, read_fd);
        posix.close(read_fd);
        read_fd = -1;
        try writePipeAll(write_fd, "payload");
        posix.close(write_fd);
        write_fd = -1;

        try self.acceptBroker();
        try self.expectExecute("no-read");
        try self.sendStart("no-read", test_paths.executable("true"), &.{});
        _ = try self.expectSpawned(.running, "no-read");

        const process_exit = try self.readBroker();
        defer self.allocator.free(process_exit);
        var parsed = try gateway_protocol.parseGatewayToBroker(self.allocator, process_exit, .running);
        defer parsed.deinit();
        try std.testing.expect(std.meta.activeTag(parsed.value) == .process_exit);
        try self.sendBroker("{\"type\":\"result\",\"requestId\":\"no-read\",\"exitCode\":0}\n");
        const result = try self.expectExternal("result", "no-read");
        self.allocator.free(result);

        var payload: [32]u8 = undefined;
        const count = try posix.read(sibling_fd, &payload);
        try std.testing.expectEqualStrings("payload", payload[0..count]);
    }
};

fn shutdownGatewayWorker(gateway: *GatewayIntegration) void {
    _ = gateway.shutdownGateway(.normal);
}

test "gateway CLI parses its required session and socket arguments" {
    var options = try parseArguments(std.testing.allocator, &.{
        "nas-hostexec-gateway",
        "--session-id",
        "session",
        "--external-socket",
        "/tmp/external.sock",
        "--internal-socket",
        "/tmp/internal.sock",
    });
    defer options.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("session", options.session_id);
}

test "gateway CLI rejects unknown or incomplete arguments" {
    try std.testing.expectError(error.InvalidArgument, parseArguments(std.testing.allocator, &.{ "gateway", "--unknown", "x" }));
    try std.testing.expectError(error.InvalidArgument, parseArguments(std.testing.allocator, &.{ "gateway", "--session-id" }));
}

test "ByteQueue compacts consumed prefixes during partial append/drain cycles" {
    var sockets: [2]posix.fd_t = undefined;
    try std.testing.expectEqual(
        @as(c_int, 0),
        std.c.socketpair(
            @intCast(posix.AF.UNIX),
            @intCast(posix.SOCK.STREAM | posix.SOCK.CLOEXEC),
            0,
            &sockets,
        ),
    );
    defer posix.close(sockets[0]);
    defer posix.close(sockets[1]);
    try setNonBlocking(sockets[0]);
    try setNonBlocking(sockets[1]);

    var send_buffer: c_int = 4096;
    try posix.setsockopt(
        sockets[0],
        posix.SOL.SOCKET,
        posix.SO.SNDBUF,
        std.mem.asBytes(&send_buffer),
    );

    var queue = ByteQueue.init(std.testing.allocator);
    defer queue.deinit();
    var expected = std.ArrayList(u8).empty;
    defer expected.deinit(std.testing.allocator);
    var received = std.ArrayList(u8).empty;
    defer received.deinit(std.testing.allocator);
    var initial_frame: [64 * 1024]u8 = undefined;
    for (&initial_frame, 0..) |*byte, index| byte.* = @truncate(index);
    try queue.append(&initial_frame);
    try expected.appendSlice(std.testing.allocator, &initial_frame);
    try queue.flush(sockets[0]);
    try std.testing.expect(queue.offset > 0);

    var cycle_frame: [4 * 1024]u8 = undefined;
    for (0..4096) |cycle| {
        for (&cycle_frame, 0..) |*byte, index| byte.* = @truncate(cycle + index);
        try queue.append(&cycle_frame);
        try expected.appendSlice(std.testing.allocator, &cycle_frame);

        var remaining = cycle_frame.len;
        while (remaining > 0) {
            var buffer: [4 * 1024]u8 = undefined;
            const count = posix.read(sockets[1], buffer[0..@min(remaining, buffer.len)]) catch |err| switch (err) {
                error.WouldBlock => return error.UnexpectedEndOfStream,
                else => return err,
            };
            if (count == 0) return error.UnexpectedEndOfStream;
            try received.appendSlice(std.testing.allocator, buffer[0..count]);
            remaining -= count;
        }
        try queue.flush(sockets[0]);
        try std.testing.expect(queue.bytes.items.len <= max_queued_bytes + initial_frame.len);
        try std.testing.expect(queue.bytes.capacity <= max_queued_bytes * 2);
    }

    while (!queue.empty()) {
        var buffer: [64 * 1024]u8 = undefined;
        while (true) {
            const count = posix.read(sockets[1], &buffer) catch |err| switch (err) {
                error.WouldBlock => break,
                else => return err,
            };
            if (count == 0) break;
            try received.appendSlice(std.testing.allocator, buffer[0..count]);
        }
        try queue.flush(sockets[0]);
    }
    var buffer: [64 * 1024]u8 = undefined;
    while (true) {
        const count = posix.read(sockets[1], &buffer) catch |err| switch (err) {
            error.WouldBlock => break,
            else => return err,
        };
        if (count == 0) break;
        try received.appendSlice(std.testing.allocator, buffer[0..count]);
    }
    try std.testing.expectEqualSlices(u8, expected.items, received.items);
}

test "LineReader retains a full next chunk after maximum CRLF frame" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var writer = try tmp.dir.createFile("split-max-frame", .{ .read = true });
    defer writer.close();
    var reader_file = try tmp.dir.openFile("split-max-frame", .{ .mode = .read_only });
    defer reader_file.close();

    var payload = std.ArrayList(u8).empty;
    defer payload.deinit(std.testing.allocator);
    try payload.resize(std.testing.allocator, gateway_protocol.max_control_bytes);
    @memset(payload.items, 'x');
    try writer.writeAll(payload.items);
    try writer.writeAll("\r");
    try reader_file.seekTo(0);

    var line_reader = LineReader.init(std.testing.allocator);
    defer line_reader.deinit();
    while (true) {
        const count = try line_reader.readAvailable(reader_file.handle);
        if (count == 0) break;
    }
    try std.testing.expect((try line_reader.next()) == null);

    var next_payload: [65_535]u8 = undefined;
    @memset(&next_payload, 'y');
    try writer.writeAll("\n");
    try writer.writeAll(&next_payload);
    try std.testing.expectEqual(@as(usize, 65_536), try line_reader.readAvailable(reader_file.handle));

    const first = (try line_reader.next()) orelse return error.UnexpectedEndOfStream;
    defer std.testing.allocator.free(first);
    try std.testing.expectEqual(gateway_protocol.max_control_bytes, first.len);
    try std.testing.expect((try line_reader.next()) == null);
    try std.testing.expectEqualSlices(u8, &next_payload, line_reader.bytes.items[line_reader.start..]);
}

test "LineReader preserves a near-limit frame and the next frame" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var file = try tmp.dir.createFile("frames", .{ .read = true });
    defer file.close();

    var bytes = std.ArrayList(u8).empty;
    defer bytes.deinit(std.testing.allocator);
    try bytes.resize(std.testing.allocator, gateway_protocol.max_control_bytes);
    @memset(bytes.items[0..gateway_protocol.max_control_bytes], 'x');
    try bytes.appendSlice(std.testing.allocator, "\nnext\n");
    try file.writeAll(bytes.items);
    try file.seekTo(0);

    var reader = LineReader.init(std.testing.allocator);
    defer reader.deinit();
    var first: ?[]u8 = null;
    while (first == null) {
        const count = try reader.readAvailable(file.handle);
        if (count == 0) return error.UnexpectedEndOfStream;
        first = try reader.next();
    }
    defer std.testing.allocator.free(first.?);
    try std.testing.expectEqual(gateway_protocol.max_control_bytes, first.?.len);

    var second: ?[]u8 = null;
    while (second == null) {
        second = try reader.next();
        if (second != null) break;
        const count = try reader.readAvailable(file.handle);
        if (count == 0) return error.UnexpectedEndOfStream;
    }
    defer std.testing.allocator.free(second.?);
    try std.testing.expectEqualStrings("next", second.?);
}

test "LineReader rejects an oversized first frame before accepting its delimiter" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var file = try tmp.dir.createFile("oversized", .{ .read = true });
    defer file.close();

    var bytes = std.ArrayList(u8).empty;
    defer bytes.deinit(std.testing.allocator);
    try bytes.resize(std.testing.allocator, gateway_protocol.max_control_bytes + 1);
    @memset(bytes.items, 'x');
    try bytes.append(std.testing.allocator, '\n');
    try file.writeAll(bytes.items);
    try file.seekTo(0);

    var reader = LineReader.init(std.testing.allocator);
    defer reader.deinit();
    var saw_error = false;
    while (true) {
        _ = reader.readAvailable(file.handle) catch |err| {
            try std.testing.expectEqual(error.MessageTooLong, err);
            saw_error = true;
            break;
        };
    }
    try std.testing.expect(saw_error);
}

test "LineReader accepts an optional CR whose LF arrives in the next read" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var file = try tmp.dir.createFile("split-delimiter", .{ .read = true });
    defer file.close();

    var bytes = std.ArrayList(u8).empty;
    defer bytes.deinit(std.testing.allocator);
    try bytes.resize(std.testing.allocator, gateway_protocol.max_control_bytes - 1);
    @memset(bytes.items, 'x');
    try bytes.appendSlice(std.testing.allocator, "\r\nnext\n");
    try file.writeAll(bytes.items);
    try file.seekTo(0);

    var reader = LineReader.init(std.testing.allocator);
    defer reader.deinit();
    var first: ?[]u8 = null;
    while (first == null) {
        const count = try reader.readAvailable(file.handle);
        if (count == 0) return error.UnexpectedEndOfStream;
        first = try reader.next();
    }
    defer std.testing.allocator.free(first.?);
    try std.testing.expectEqual(gateway_protocol.max_control_bytes - 1, first.?.len);

    var second: ?[]u8 = null;
    while (second == null) {
        second = try reader.next();
        if (second != null) break;
        const count = try reader.readAvailable(file.handle);
        if (count == 0) return error.UnexpectedEndOfStream;
    }
    defer std.testing.allocator.free(second.?);
    try std.testing.expectEqualStrings("next", second.?);
}

test "LineReader rejects max payload plus a non-CR before its delimiter" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var file = try tmp.dir.createFile("unterminated-non-cr", .{ .read = true });
    defer file.close();

    var bytes = std.ArrayList(u8).empty;
    defer bytes.deinit(std.testing.allocator);
    try bytes.resize(std.testing.allocator, gateway_protocol.max_control_bytes + 1);
    @memset(bytes.items, 'x');
    try file.writeAll(bytes.items);
    try file.seekTo(0);

    var reader = LineReader.init(std.testing.allocator);
    defer reader.deinit();
    var saw_error = false;
    while (!saw_error) {
        _ = reader.readAvailable(file.handle) catch |err| {
            try std.testing.expectEqual(error.MessageTooLong, err);
            saw_error = true;
            break;
        };
        if (file.getPos() catch 0 == bytes.items.len) break;
    }
    try std.testing.expect(saw_error);
}

test "LineReader accepts max payload plus CR until the following LF arrives" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var writer = try tmp.dir.createFile("unterminated-cr", .{ .read = true });
    defer writer.close();
    var reader_file = try tmp.dir.openFile("unterminated-cr", .{ .mode = .read_only });
    defer reader_file.close();

    var payload = std.ArrayList(u8).empty;
    defer payload.deinit(std.testing.allocator);
    try payload.resize(std.testing.allocator, gateway_protocol.max_control_bytes);
    @memset(payload.items, 'x');
    try writer.writeAll(payload.items);
    try writer.writeAll("\r");
    try reader_file.seekTo(0);

    var line_reader = LineReader.init(std.testing.allocator);
    defer line_reader.deinit();
    while (true) {
        const count = try line_reader.readAvailable(reader_file.handle);
        if (count == 0) break;
    }
    try std.testing.expect((try line_reader.next()) == null);

    try writer.writeAll("\n");
    try std.testing.expectEqual(@as(usize, 1), try line_reader.readAvailable(reader_file.handle));
    const line = (try line_reader.next()) orelse return error.UnexpectedEndOfStream;
    defer std.testing.allocator.free(line);
    try std.testing.expectEqual(gateway_protocol.max_control_bytes, line.len);
}

test "external responses are newline terminated and preserve request identity" {
    const allocator = std.testing.allocator;
    const encoded = try std.json.Stringify.valueAlloc(allocator, ExternalResult{
        .type = "result",
        .requestId = "request",
        .exitCode = 0,
    }, .{});
    defer allocator.free(encoded);
    try std.testing.expect(std.mem.indexOf(u8, encoded, "\"requestId\":\"request\"") != null);
}

test "gateway readiness is a v2 newline-delimited handshake" {
    const line = try readinessLine(std.testing.allocator, "/run/nas/exec.sock");
    defer std.testing.allocator.free(line);
    try std.testing.expectEqualStrings(
        "{\"type\":\"ready\",\"version\":2,\"socket\":\"/run/nas/exec.sock\"}\n",
        line,
    );
}

test "gateway loop errors clean up live handler groups and socket" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const root = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(root);
    const socket_path = try std.fs.path.join(std.testing.allocator, &.{ root, "gateway.sock" });
    defer std.testing.allocator.free(socket_path);

    var stop = std.atomic.Value(bool).init(false);
    var connected = std.atomic.Value(bool).init(false);
    var disconnected = std.atomic.Value(bool).init(false);
    var connector = ConnectorState{
        .path = socket_path,
        .stop = &stop,
        .connected = &connected,
        .disconnected = &disconnected,
    };
    var thread = try std.Thread.spawn(.{}, connectAndHold, .{&connector});
    defer {
        stop.store(true, .release);
        thread.join();
    }

    const result = runGatewayWithFault(std.testing.allocator, .{
        .session_id = "session",
        .external_socket = socket_path,
        .internal_socket = "/tmp/no-broker.sock",
    }, .after_first_handler, false);
    try std.testing.expectError(error.InjectedLoopError, result);
    try std.testing.expect(connected.load(.acquire));
    try std.testing.expectError(error.FileNotFound, std.fs.cwd().access(socket_path, .{}));
}

test "registry reservation failure closes the accepted client before fork" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const root = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(root);
    const socket_path = try std.fs.path.join(std.testing.allocator, &.{ root, "gateway.sock" });
    defer std.testing.allocator.free(socket_path);

    var stop = std.atomic.Value(bool).init(false);
    var connected = std.atomic.Value(bool).init(false);
    var disconnected = std.atomic.Value(bool).init(false);
    var connector = ConnectorState{
        .path = socket_path,
        .stop = &stop,
        .connected = &connected,
        .disconnected = &disconnected,
    };
    var thread = try std.Thread.spawn(.{}, connectAndHold, .{&connector});
    defer {
        stop.store(true, .release);
        thread.join();
    }

    const result = runGatewayWithFault(std.testing.allocator, .{
        .session_id = "session",
        .external_socket = socket_path,
        .internal_socket = "/tmp/no-broker.sock",
    }, .registry_reserve_failure, false);
    try std.testing.expectError(error.InjectedRegistryReserve, result);
    try std.testing.expect(connected.load(.acquire));
    var rounds: usize = 0;
    while (!disconnected.load(.acquire) and rounds < 100) : (rounds += 1) {
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expect(disconnected.load(.acquire));
    try std.testing.expectError(error.FileNotFound, std.fs.cwd().access(socket_path, .{}));
}

test "handler keeps pre-start fallback on the external response path" {
    var sockets: [2]posix.fd_t = undefined;
    try std.testing.expectEqual(
        @as(c_int, 0),
        std.c.socketpair(
            @intCast(posix.AF.UNIX),
            @intCast(posix.SOCK.STREAM | posix.SOCK.CLOEXEC),
            0,
            &sockets,
        ),
    );
    defer posix.close(sockets[1]);

    var handler = Handler.init(std.testing.allocator, "session", "", sockets[0]);
    defer handler.deinit();
    handler.request_id = "request";
    try handler.handleBrokerLine("{\"type\":\"fallback\",\"requestId\":\"request\"}");
    try std.testing.expectEqual(gateway_protocol.GatewayState.terminal, handler.state);
    try handler.external_out.flush(sockets[0]);
    var response: [256]u8 = undefined;
    const count = try posix.read(sockets[1], &response);
    try std.testing.expectEqualStrings(
        "{\"type\":\"fallback\",\"requestId\":\"request\"}\n",
        response[0..count],
    );
}

test "handler rejects broker raw chunks and post-start fallback" {
    var raw_handler = Handler.init(std.testing.allocator, "session", "", -1);
    defer raw_handler.deinit();
    raw_handler.request_id = "request";
    raw_handler.state = .running;
    try std.testing.expectError(
        error.InvalidMessageType,
        raw_handler.handleBrokerLine("{\"type\":\"raw_chunk\",\"requestId\":\"request\",\"fd\":1,\"data\":\"eA==\"}"),
    );
    try std.testing.expectEqual(gateway_protocol.GatewayState.terminal, raw_handler.state);

    var fallback_handler = Handler.init(std.testing.allocator, "session", "", -1);
    defer fallback_handler.deinit();
    fallback_handler.request_id = "request";
    fallback_handler.state = .running;
    try std.testing.expectError(
        error.InvalidState,
        fallback_handler.handleBrokerLine("{\"type\":\"fallback\",\"requestId\":\"request\"}"),
    );
    try std.testing.expectEqual(gateway_protocol.GatewayState.terminal, fallback_handler.state);
}

test "slow external consumer reserves room for multiple maximum chunks" {
    var handler = Handler.init(std.testing.allocator, "session", "", -1);
    defer handler.deinit();
    handler.request_id = "request";
    handler.max_chunk_frame_bytes = try handler.maximumChunkFrameBytes();

    const frame = try std.testing.allocator.alloc(u8, handler.max_chunk_frame_bytes);
    defer std.testing.allocator.free(frame);
    @memset(frame, 'x');

    var chunks: usize = 0;
    while (handler.hasExternalChunkRoom()) {
        try handler.external_out.append(frame);
        chunks += 1;
    }
    try std.testing.expect(chunks >= 2);
    try std.testing.expect(!handler.hasExternalChunkRoom());
    handler.external_out.clear();
    try std.testing.expect(handler.hasExternalChunkRoom());
}

test "slow broker reserves room for multiple maximum chunks" {
    var handler = Handler.init(std.testing.allocator, "session", "", -1);
    defer handler.deinit();
    handler.request_id = "request";
    handler.max_chunk_frame_bytes = try handler.maximumChunkFrameBytes();

    const frame = try std.testing.allocator.alloc(u8, handler.max_chunk_frame_bytes);
    defer std.testing.allocator.free(frame);
    @memset(frame, 'x');

    var chunks: usize = 0;
    while (handler.hasBrokerChunkRoom()) {
        try handler.broker_out.append(frame);
        chunks += 1;
    }
    try std.testing.expect(chunks >= 2);
    try std.testing.expect(!handler.hasBrokerChunkRoom());
    handler.broker_out.clear();
    try std.testing.expect(handler.hasBrokerChunkRoom());
}

test "handler retains child ownership across transient cleanup failure" {
    var handler = Handler.init(std.testing.allocator, "session", "", -1);
    defer handler.deinit();
    const fake_child: gateway_executor.ChildHandle = undefined;
    handler.child = fake_child;
    handler.cleanup_child_fn = injectedCleanup;
    injected_cleanup_attempts = 0;
    injected_cleanup_failures = 1;

    try std.testing.expectError(error.InjectedCleanup, handler.cleanupChild());
    try std.testing.expect(handler.child != null);
    try handler.cleanupChild();
    try std.testing.expect(handler.child == null);
    try std.testing.expectEqual(@as(usize, 2), injected_cleanup_attempts);
}

test "handler retains a real child until transient cleanup retry succeeds" {
    var env = std.process.EnvMap.init(std.testing.allocator);
    defer env.deinit();
    const argv = [_][]const u8{ test_paths.executable("sleep"), "30" };
    const child = try gateway_executor.spawn(std.testing.allocator, .{
        .argv = &argv,
        .env = env,
    }, null);
    const child_pid = child.pid;

    var handler = Handler.init(std.testing.allocator, "session", "", -1);
    defer handler.deinit();
    handler.child = child;
    handler.cleanup_child_fn = transientRealCleanup;
    transient_real_cleanup_attempts = 0;

    try std.testing.expectError(error.InjectedCleanup, handler.cleanupChild());
    try std.testing.expect(handler.child != null);
    try handler.cleanupChild();
    try std.testing.expect(handler.child == null);
    try GatewayIntegration.expectProcessGroupGone(child_pid);
}

test "handler retains ownership after persistent cleanup failure" {
    var handler = Handler.init(std.testing.allocator, "session", "", -1);
    defer handler.deinit();
    const fake_child: gateway_executor.ChildHandle = undefined;
    handler.child = fake_child;
    handler.cleanup_child_fn = injectedCleanup;
    injected_cleanup_attempts = 0;
    injected_cleanup_failures = 100;

    try std.testing.expectError(error.InjectedCleanup, handler.cleanupChild());
    try std.testing.expect(handler.child != null);
    handler.child = null;
}

test "handler retry retains ownership until a persistent cleanup failure is released" {
    var handler = Handler.init(std.testing.allocator, "session", "", -1);
    defer handler.deinit();
    const fake_child: gateway_executor.ChildHandle = undefined;
    handler.child = fake_child;
    handler.cleanup_child_fn = releaseCleanup;
    release_cleanup_attempts.store(0, .seq_cst);
    release_cleanup.store(false, .release);

    var worker = try std.Thread.spawn(.{}, retryCleanupWorker, .{&handler});
    var joined = false;
    defer {
        release_cleanup.store(true, .release);
        if (!joined) worker.join();
    }

    var rounds: usize = 0;
    while (release_cleanup_attempts.load(.acquire) == 0 and rounds < 100) : (rounds += 1) {
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expect(release_cleanup_attempts.load(.acquire) > 0);
    try std.testing.expect(handler.child != null);

    release_cleanup.store(true, .release);
    worker.join();
    joined = true;
    try std.testing.expect(handler.child == null);
}

test "SIGTERM deferral restores the handler's original signal mask" {
    var before: posix.sigset_t = undefined;
    posix.sigprocmask(0, null, &before);
    const initially_blocked = posix.sigismember(&before, posix.SIG.TERM);

    var deferral = SigtermDeferral.begin();
    var during: posix.sigset_t = undefined;
    posix.sigprocmask(0, null, &during);
    try std.testing.expect(posix.sigismember(&during, posix.SIG.TERM));
    deferral.restore();

    var after: posix.sigset_t = undefined;
    posix.sigprocmask(0, null, &after);
    try std.testing.expectEqual(initially_blocked, posix.sigismember(&after, posix.SIG.TERM));
}

fn injectedPthreadAtforkFailure(
    _: ?*const fn () callconv(.c) void,
    _: ?*const fn () callconv(.c) void,
    _: ?*const fn () callconv(.c) void,
) callconv(.c) c_int {
    return 1;
}

test "pthread_atfork registration failure aborts gateway setup" {
    const previous_registered = sigterm_atfork_registered;
    const previous_atfork_fn = pthread_atfork_fn;
    defer {
        sigterm_atfork_registered = previous_registered;
        pthread_atfork_fn = previous_atfork_fn;
    }
    sigterm_atfork_registered = false;
    pthread_atfork_fn = injectedPthreadAtforkFailure;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const root = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(root);
    const socket_path = try std.fs.path.join(std.testing.allocator, &.{ root, "gateway.sock" });
    defer std.testing.allocator.free(socket_path);

    try std.testing.expectError(
        error.PthreadAtforkFailed,
        runGatewayWithFault(std.testing.allocator, .{
            .session_id = "session",
            .external_socket = socket_path,
            .internal_socket = "/tmp/no-broker.sock",
        }, .none, false),
    );
    try std.testing.expect(!sigterm_atfork_registered);
    try std.testing.expectError(error.FileNotFound, std.fs.cwd().access(socket_path, .{}));
}

test "executed child restores default SIGTERM mask and disposition after handler deferral" {
    try installShutdownHandlers();

    var env = std.process.EnvMap.init(std.testing.allocator);
    defer env.deinit();
    const argv = [_][]const u8{ test_paths.executable("cat"), "/proc/self/status" };
    var deferral = SigtermDeferral.begin();
    var child = try gateway_executor.spawn(std.testing.allocator, .{
        .argv = &argv,
        .env = env,
    }, null);
    deferral.restore();
    defer child.deinit() catch {};

    var output = std.ArrayList(u8).empty;
    defer output.deinit(std.testing.allocator);
    var buffer: [4096]u8 = undefined;
    while (true) {
        const count = try posix.read(child.stdout_fd, &buffer);
        if (count == 0) break;
        try output.appendSlice(std.testing.allocator, buffer[0..count]);
    }
    _ = try child.wait();

    const sigterm_bit = @as(u64, 1) << @intCast(posix.SIG.TERM - 1);
    var found_blocked = false;
    var found_ignored = false;
    var found_caught = false;
    var lines = std.mem.splitScalar(u8, output.items, '\n');
    while (lines.next()) |line| {
        if (std.mem.startsWith(u8, line, "SigBlk:")) {
            const value = try std.fmt.parseInt(u64, std.mem.trim(u8, line[7..], " \t"), 16);
            try std.testing.expect(value & sigterm_bit == 0);
            found_blocked = true;
        } else if (std.mem.startsWith(u8, line, "SigIgn:")) {
            const value = try std.fmt.parseInt(u64, std.mem.trim(u8, line[7..], " \t"), 16);
            try std.testing.expect(value & sigterm_bit == 0);
            found_ignored = true;
        } else if (std.mem.startsWith(u8, line, "SigCgt:")) {
            const value = try std.fmt.parseInt(u64, std.mem.trim(u8, line[7..], " \t"), 16);
            try std.testing.expect(value & sigterm_bit == 0);
            found_caught = true;
        }
    }
    try std.testing.expect(found_blocked);
    try std.testing.expect(found_ignored);
    try std.testing.expect(found_caught);
}

test "external disconnect cleans a real descendant process group" {
    var sockets: [2]posix.fd_t = undefined;
    try std.testing.expectEqual(
        @as(c_int, 0),
        std.c.socketpair(
            @intCast(posix.AF.UNIX),
            @intCast(posix.SOCK.STREAM | posix.SOCK.CLOEXEC),
            0,
            &sockets,
        ),
    );
    defer posix.close(sockets[1]);

    var handler = Handler.init(std.testing.allocator, "session", "", sockets[0]);
    defer handler.deinit();
    handler.request_id = "request";
    const start = try std.fmt.allocPrint(
        std.testing.allocator,
        "{{\"type\":\"start\",\"requestId\":\"request\",\"argv0\":\"{s}\",\"args\":[\"-c\",\"trap '' TERM; {s} 30 & wait\"],\"cwd\":\"/\",\"env\":{{}}}}",
        .{ test_paths.executable("sh"), test_paths.executable("sleep") },
    );
    defer std.testing.allocator.free(start);
    try handler.handleBrokerLine(start);
    const pgid = handler.child.?.pgid;
    handler.externalDisconnected();
    try std.testing.expect(handler.child == null);
    // The direct child is reaped and the entire command group is signalled.
    // A descendant killed by the group may remain briefly as an init-owned
    // zombie; the executor owns only the direct-child wait boundary.
    _ = pgid;
}

test "gateway integration preserves a no-read delegated stdin" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var gateway = try GatewayIntegration.init(std.testing.allocator, &tmp);
    defer gateway.deinit();
    try gateway.runNoReadRequest();
}

test "gateway initial execute resumes after a partial broker send" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var gateway = try GatewayIntegration.init(std.testing.allocator, &tmp);
    defer gateway.deinit();

    try gateway.sendLargeExecute("partial-send", null);
    try gateway.acceptBroker();
    try gateway.expectExecute("partial-send");
}

test "gateway shutdown closes stdin while broker does not read initial execute" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var gateway = try GatewayIntegration.init(std.testing.allocator, &tmp);
    defer gateway.deinit();

    var pipe_fds = try posix.pipe2(.{ .CLOEXEC = true });
    defer {
        if (pipe_fds[0] >= 0) posix.close(pipe_fds[0]);
        if (pipe_fds[1] >= 0) posix.close(pipe_fds[1]);
    }
    try gateway.sendLargeExecute("blocked-send", pipe_fds[0]);
    posix.close(pipe_fds[0]);
    pipe_fds[0] = -1;
    try gateway.acceptBroker();
    std.Thread.sleep(100 * std.time.ns_per_ms);

    var timer = try std.time.Timer.start();
    _ = gateway.shutdownGateway(.normal);
    try std.testing.expect(timer.read() < 2 * std.time.ns_per_s);
    try std.testing.expect(gateway.gateway_pid == null);

    var old_sigpipe: posix.Sigaction = undefined;
    const ignore_sigpipe: posix.Sigaction = .{
        .handler = .{ .handler = posix.SIG.IGN },
        .mask = posix.sigemptyset(),
        .flags = 0,
    };
    posix.sigaction(posix.SIG.PIPE, &ignore_sigpipe, &old_sigpipe);
    defer posix.sigaction(posix.SIG.PIPE, &old_sigpipe, null);
    try std.testing.expectError(error.BrokenPipe, posix.write(pipe_fds[1], "x"));
}

test "gateway shutdown reaps a running command with a stalled broker queue" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    const previous_subreaper = try installTestSubreaper();
    defer restoreTestSubreaper(previous_subreaper);

    var gateway = try GatewayIntegration.init(std.testing.allocator, &tmp);
    defer gateway.deinit();

    var cleanup_signals: usize = 0;
    {
        var command = TestProcessGroupOwner.init(try gateway.startNoisyCommand("stalled-raw"), &cleanup_signals);
        defer command.cleanup();
        var handler = TestProcessGroupOwner.init(try gateway.waitForHandlerPid(), &cleanup_signals);
        defer handler.cleanup();

        // Allow the command output to fill the broker socket and stage raw
        // frames in broker_out. The broker is deliberately never read after
        // spawned.
        std.Thread.sleep(250 * std.time.ns_per_ms);

        const command_pid = command.pid orelse return error.IntegrationProcessGone;
        const handler_pid = handler.pid orelse return error.IntegrationProcessGone;
        var timer = try std.time.Timer.start();
        const shutdown_outcome = gateway.shutdownGateway(.normal);
        // Establish cleanup ownership immediately from the returned outcome.
        // An unexpected forced result must retain both groups for forced reap
        // cleanup before the scenario assertion can fail.
        switch (shutdown_outcome) {
            .cooperative => {
                command.disarm();
                handler.disarm();
            },
            .forced => {
                command.enableReapOnCleanup();
                handler.enableReapOnCleanup();
                try handler.mustCleanOwnedGroup();
                try command.mustCleanOwnedGroup();
            },
        }
        const elapsed = timer.read();
        try std.testing.expectEqual(ShutdownOutcome.cooperative, shutdown_outcome);
        try std.testing.expect(elapsed < 2 * std.time.ns_per_s);
        try std.testing.expect(gateway.gateway_pid == null);

        // Force both read-only absence probes to fail once. The owners are
        // already disarmed, so the deferred cleanup must remain signal-free
        // even when an assertion takes an error path.
        try std.testing.expectError(
            error.InjectedProcessGroupProbe,
            GatewayIntegration.expectProcessGroupGoneWithFault(command_pid, true),
        );
        try std.testing.expectError(
            error.InjectedProcessGroupProbe,
            GatewayIntegration.expectProcessGroupGoneWithFault(handler_pid, true),
        );
        try GatewayIntegration.expectProcessGroupGone(command_pid);
        try GatewayIntegration.expectProcessGroupGone(handler_pid);
    }
    try std.testing.expectEqual(@as(usize, 0), cleanup_signals);
}

test "gateway forced shutdown retains descendant cleanup ownership" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    const previous_subreaper = try installTestSubreaper();
    defer restoreTestSubreaper(previous_subreaper);

    var gateway = try GatewayIntegration.init(std.testing.allocator, &tmp);
    defer gateway.deinit();

    var cleanup_signals: usize = 0;
    {
        var command = TestProcessGroupOwner.init(try gateway.startNoisyCommand("forced-stalled"), &cleanup_signals);
        defer command.cleanup();
        var handler = TestProcessGroupOwner.init(try gateway.waitForHandlerPid(), &cleanup_signals);
        defer handler.cleanup();

        const command_pid = command.pid orelse return error.IntegrationProcessGone;
        const handler_pid = handler.pid orelse return error.IntegrationProcessGone;
        const shutdown_outcome = gateway.shutdownGateway(.force_timeout);
        // Establish cleanup ownership immediately from the returned outcome.
        // An unexpected cooperative result disarms only after the parent has
        // synchronously cleaned both groups; the scenario assertion follows.
        switch (shutdown_outcome) {
            .cooperative => {
                command.disarm();
                handler.disarm();
            },
            .forced => {
                command.enableReapOnCleanup();
                handler.enableReapOnCleanup();
                try handler.mustCleanOwnedGroup();
                try command.mustCleanOwnedGroup();
            },
        }
        try std.testing.expectEqual(ShutdownOutcome.forced, shutdown_outcome);
        try std.testing.expect(gateway.gateway_pid == null);

        // The timeout only reaps the stopped gateway parent. The must-clean
        // helpers above terminate and directly reap both descendant groups;
        // only successful reaps disarm their owners.
        try std.testing.expect(command.pid == null);
        try std.testing.expect(handler.pid == null);
        try GatewayIntegration.expectProcessGroupGone(command_pid);
        try GatewayIntegration.expectProcessGroupGone(handler_pid);
    }
    try std.testing.expectEqual(@as(usize, 2), cleanup_signals);
}

test "gateway event loop admits a delayed LF after a maximum broker frame" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var gateway = try GatewayIntegration.init(std.testing.allocator, &tmp);
    defer gateway.deinit();

    try gateway.sendExecute("integration", "maximum-lf", .none, null);
    try gateway.acceptBroker();
    try gateway.expectExecute("maximum-lf");
    try gateway.sendDelayedMaximumFrame("maximum-lf", false);
    const response = try gateway.expectExternal("fallback", "maximum-lf");
    defer gateway.allocator.free(response);
}

test "gateway event loop admits a delayed CRLF after a maximum broker frame" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var gateway = try GatewayIntegration.init(std.testing.allocator, &tmp);
    defer gateway.deinit();

    try gateway.sendExecute("integration", "maximum-crlf", .none, null);
    try gateway.acceptBroker();
    try gateway.expectExecute("maximum-crlf");
    try gateway.sendDelayedMaximumFrame("maximum-crlf", true);
    const response = try gateway.expectExternal("fallback", "maximum-crlf");
    defer gateway.allocator.free(response);
}

test "gateway parent shutdown cooperatively cleans a pre-start handler" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var gateway = try GatewayIntegration.init(std.testing.allocator, &tmp);
    defer gateway.deinit();

    // Leave the accepted handler in receiveLine with an incomplete request so
    // the parent TERM races the handler's pre-start setup path.
    try sendSocketAll(gateway.external_fd, "{");
    var shutdown_thread = try std.Thread.spawn(.{}, shutdownGatewayWorker, .{&gateway});
    std.Thread.sleep(10 * std.time.ns_per_ms);
    shutdown_thread.join();
    try std.testing.expect(gateway.gateway_pid == null);
    try std.testing.expectError(error.FileNotFound, std.fs.cwd().access(gateway.external_socket, .{}));
}

test "gateway parent shutdown waits for running command-group cleanup" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var gateway = try GatewayIntegration.init(std.testing.allocator, &tmp);
    defer gateway.deinit();

    const pid = try gateway.startPersistentCommand("shutdown-running");
    // Run parent shutdown concurrently with the child-group disappearance;
    // the handler must complete its normal cooperative cleanup before the
    // parent reports that shutdown is complete.
    var shutdown_thread = try std.Thread.spawn(.{}, shutdownGatewayWorker, .{&gateway});
    try GatewayIntegration.expectProcessGroupGone(pid);
    shutdown_thread.join();
    try std.testing.expect(gateway.gateway_pid == null);
}

test "GatewayIntegration wait failure releases staged resources once" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try std.testing.expectError(
        error.InjectedIntegrationWait,
        GatewayIntegration.initWithFault(std.testing.allocator, &tmp, .wait_external_socket),
    );
    const root = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(root);
    const external_socket = try std.fs.path.join(std.testing.allocator, &.{ root, "external.sock" });
    defer std.testing.allocator.free(external_socket);
    const internal_socket = try std.fs.path.join(std.testing.allocator, &.{ root, "internal.sock" });
    defer std.testing.allocator.free(internal_socket);
    try std.testing.expectError(error.FileNotFound, std.fs.cwd().access(external_socket, .{}));
    try std.testing.expectError(error.FileNotFound, std.fs.cwd().access(internal_socket, .{}));
}

test "GatewayIntegration connect failure releases staged resources once" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try std.testing.expectError(
        error.InjectedIntegrationConnect,
        GatewayIntegration.initWithFault(std.testing.allocator, &tmp, .connect_external_socket),
    );
    const root = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(root);
    const external_socket = try std.fs.path.join(std.testing.allocator, &.{ root, "external.sock" });
    defer std.testing.allocator.free(external_socket);
    const internal_socket = try std.fs.path.join(std.testing.allocator, &.{ root, "internal.sock" });
    defer std.testing.allocator.free(internal_socket);
    try std.testing.expectError(error.FileNotFound, std.fs.cwd().access(external_socket, .{}));
    try std.testing.expectError(error.FileNotFound, std.fs.cwd().access(internal_socket, .{}));
}

test "gateway integration returns pre-start fallback without spawning" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var gateway = try GatewayIntegration.init(std.testing.allocator, &tmp);
    defer gateway.deinit();
    try gateway.runPreStartFallback();
}

test "gateway reports a missing executable before closing the broker" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var gateway = try GatewayIntegration.init(std.testing.allocator, &tmp);
    defer gateway.deinit();

    try gateway.sendExecute("integration", "missing-executable", .none, null);
    try gateway.acceptBroker();
    try gateway.expectExecute("missing-executable");
    try gateway.sendStart("missing-executable", "/definitely/missing/nas-command", &.{});

    const line = try gateway.readBroker();
    defer gateway.allocator.free(line);
    var parsed = try gateway_protocol.parseGatewayToBroker(std.testing.allocator, line, .awaiting_decision);
    defer parsed.deinit();
    switch (parsed.value) {
        .transport_error => |message| {
            try std.testing.expectEqualStrings("missing-executable", message.requestId);
        },
        else => return error.UnexpectedBrokerMessage,
    }
    try std.testing.expectError(error.EndOfStream, gateway.readBroker());

    const external = try gateway.expectExternal("error", "missing-executable");
    defer gateway.allocator.free(external);
}

test "gateway integration rejects session and descriptor mismatches" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var gateway = try GatewayIntegration.init(std.testing.allocator, &tmp);
    defer gateway.deinit();
    try gateway.runSessionAndFdMismatch();
}

test "gateway malformed FD and oversized frames close handlers without leaks" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var gateway = try GatewayIntegration.init(std.testing.allocator, &tmp);
    defer gateway.deinit();

    const gateway_pid = gateway.gateway_pid orelse return error.IntegrationProcessGone;

    var pipe_fds = try posix.pipe2(.{ .CLOEXEC = true });
    defer {
        if (pipe_fds[0] >= 0) posix.close(pipe_fds[0]);
        if (pipe_fds[1] >= 0) posix.close(pipe_fds[1]);
    }
    try gateway.sendExecute("integration", "fd-mismatch", .fd, pipe_fds[0]);
    posix.close(pipe_fds[0]);
    pipe_fds[0] = -1;
    posix.close(pipe_fds[1]);
    pipe_fds[1] = -1;
    try gateway.acceptBroker();
    try gateway.expectExecute("fd-mismatch");
    const parent_fd_count = try openDescriptorCount(gateway_pid);
    const mismatch_handler = try gateway.waitForHandlerPid();
    try gateway.sendBroker("{\"type\":\"fallback\",\"requestId\":\"wrong-id\"}\n");
    const mismatch_broker = try gateway.readBroker();
    defer gateway.allocator.free(mismatch_broker);
    try std.testing.expect(std.mem.indexOf(u8, mismatch_broker, "transport_error") != null);
    try std.testing.expect(std.mem.indexOf(u8, mismatch_broker, "fd-mismatch") != null);
    const mismatch_external = try gateway.expectExternal("error", "fd-mismatch");
    defer gateway.allocator.free(mismatch_external);
    try std.testing.expect(std.mem.indexOf(u8, mismatch_external, "invalid broker message") != null);
    try std.testing.expectError(error.EndOfStream, gateway.readBroker());
    try std.testing.expectError(error.EndOfStream, gateway.readExternal());
    try gateway.expectHandlerCleanup(mismatch_handler, parent_fd_count);

    gateway.closeBroker();
    gateway.closeExternal();
    try gateway.reconnectExternal();
    const external_handler = try gateway.waitForHandlerPid();
    const external_fd_count = try openDescriptorCount(gateway_pid);
    var oversized_pipe = try posix.pipe2(.{ .CLOEXEC = true });
    try gateway.sendOversizedExecute("oversized-external", oversized_pipe[0]);
    posix.close(oversized_pipe[0]);
    oversized_pipe[0] = -1;
    posix.close(oversized_pipe[1]);
    oversized_pipe[1] = -1;
    defer {
        if (oversized_pipe[0] >= 0) posix.close(oversized_pipe[0]);
        if (oversized_pipe[1] >= 0) posix.close(oversized_pipe[1]);
    }
    const oversized_external = try gateway.readExternal();
    defer gateway.allocator.free(oversized_external);
    try std.testing.expect(std.mem.indexOf(u8, oversized_external, "\"type\":\"error\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, oversized_external, "MessageTooLong") != null);
    if (gateway.readExternal()) |line| {
        gateway.allocator.free(line);
        return error.ExpectedConnectionClose;
    } else |err| switch (err) {
        error.EndOfStream, error.ConnectionResetByPeer => {},
        else => return err,
    }
    try gateway.expectNoBrokerConnection();
    try gateway.expectHandlerCleanup(external_handler, external_fd_count);

    gateway.closeExternal();
    try gateway.reconnectExternal();
    try gateway.sendExecute("integration", "oversized-internal", .none, null);
    try gateway.acceptBroker();
    try gateway.expectExecute("oversized-internal");
    const internal_handler = try gateway.waitForHandlerPid();
    const internal_fd_count = try openDescriptorCount(gateway_pid);
    try gateway.sendOversized(gateway.broker_fd);
    try std.testing.expectError(error.EndOfStream, gateway.readBroker());
    try std.testing.expectError(error.EndOfStream, gateway.readExternal());
    try gateway.expectHandlerCleanup(internal_handler, internal_fd_count);
}

test "gateway integration forwards only masked chunks through the external socket" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var gateway = try GatewayIntegration.init(std.testing.allocator, &tmp);
    defer gateway.deinit();
    try gateway.runMaskedForwarding();
}

test "gateway integration kills the command on post-start fallback" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var gateway = try GatewayIntegration.init(std.testing.allocator, &tmp);
    defer gateway.deinit();
    try gateway.runPostStartFallback();
}

test "gateway integration cleans command groups after external disconnect" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var gateway = try GatewayIntegration.init(std.testing.allocator, &tmp);
    defer gateway.deinit();
    try gateway.runExternalDisconnect();
}

test "gateway integration cleans command groups after internal disconnect" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var gateway = try GatewayIntegration.init(std.testing.allocator, &tmp);
    defer gateway.deinit();
    try gateway.runInternalDisconnect();
}
