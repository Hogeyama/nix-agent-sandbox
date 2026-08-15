//! Process lifecycle primitive for an approved hostexec gateway request.
//!
//! `spawn` is called by a single-request handler.  The handler is the only
//! process allowed to temporarily install a delegated descriptor at fd 0;
//! the listener must never call it while serving another request.

const std = @import("std");
const c = @cImport({
    @cInclude("fcntl.h");
    @cInclude("sys/wait.h");
    @cInclude("unistd.h");
});

const Allocator = std.mem.Allocator;
const EnvMap = std.process.EnvMap;
const ChildTerm = std.process.Child.Term;
const posix = std.posix;
const pid_t = posix.pid_t;

pub const ExecutionSpec = struct {
    /// Prefer an already assembled argv.  The argv0/args form mirrors the
    /// broker's `start` fields and is accepted so the gateway can construct a
    /// spec without making protocol parsing part of this module.
    argv: []const []const u8 = &.{},
    argv0: ?[]const u8 = null,
    args: []const []const u8 = &.{},
    cwd: ?[]const u8 = null,
    env: EnvMap,
};

pub const ChildHandle = struct {
    child: std.process.Child,

    stdout_fd: posix.fd_t,
    stderr_fd: posix.fd_t,
    pid: pid_t,

    pgid: pid_t,
    group_active: bool = true,
    term: ?ChildTerm = null,
    exit_observed: bool = false,
    wait_error: ?anyerror = null,
    waited: bool = false,
    deinitialized: bool = false,

    pub fn pollExit(self: *ChildHandle) !?ChildTerm {
        if (self.waited) {
            if (self.wait_error) |err| return err;
            return self.term;
        }
        if (self.exit_observed) return self.term;

        // Child.spawn() reports errors that happen before exec through an
        // internal CLOEXEC pipe.  Consume it before polling so a failed
        // chdir/exec cannot be mistaken for a normal exit.
        self.child.waitForSpawn() catch |err| {
            reapFailedSpawn(&self.child);
            self.finishClosed(null, err);
            return err;
        };

        return self.observeExitNoReap(false);
    }

    pub fn wait(self: *ChildHandle) !ChildTerm {
        if (self.waited) {
            if (self.wait_error) |err| return err;
            return self.term.?;
        }
        if (self.exit_observed) return self.term.?;

        // Keep the leader waitable after reporting its terminal state.  The
        // process-group cleanup must still signal its PGID before the direct
        // child is reaped.
        self.child.waitForSpawn() catch |err| {
            reapFailedSpawn(&self.child);
            self.finishClosed(null, err);
            return err;
        };
        return (try self.observeExitNoReap(true)).?;
    }

    pub fn terminateGroup(self: *ChildHandle, grace_ms: u64) !ChildTerm {
        return self.terminateGroupWith(grace_ms, signalGroup, startTimer);
    }

    fn terminateGroupWith(
        self: *ChildHandle,
        grace_ms: u64,
        signal_fn: SignalGroupFn,
        timer_start_fn: TimerStartFn,
    ) !ChildTerm {
        if (self.waited) {
            if (self.wait_error) |err| return err;
            return self.term.?;
        }

        var timer: ?std.time.Timer = null;
        if (grace_ms != 0) {
            timer = try timer_start_fn();
        }
        signal_fn(self, posix.SIG.TERM) catch |err| switch (err) {
            error.ProcessNotFound => {},
            else => return err,
        };

        if (timer) |*clock| {
            clock.reset();
            while (!graceExpired(clock.read(), grace_ms)) {
                if (!self.exit_observed) {
                    _ = try self.observeExitNoReap(false);
                }
                std.Thread.sleep(std.time.ns_per_ms);
            }
        }

        // Keep the leader unreaped until after this final group signal.  A
        // leader may exit on TERM while a same-group descendant ignores it;
        // reaping first would make the numeric PGID reusable and strand that
        // descendant outside the cleanup boundary.
        signal_fn(self, posix.SIG.KILL) catch |err| switch (err) {
            error.ProcessNotFound => {},
            else => return err,
        };

        return try self.reapDirectChild();
    }

    pub fn deinit(self: *ChildHandle) !void {
        return self.deinitWith(cleanupHandle);
    }

    fn deinitWith(self: *ChildHandle, cleanup_fn: CleanupFn) !void {
        if (self.deinitialized) return;
        cleanup_fn(self) catch |err| {
            self.closeStreams();
            return err;
        };
        self.closeStreams();
        self.deinitialized = true;
    }

    fn cleanupHandle(self: *ChildHandle) !void {
        if (self.wait_error) |err| return err;
        if (self.waited) return;
        _ = try self.terminateGroup(100);
    }

    fn signalGroup(self: *ChildHandle, signal: u8) !void {
        // Once waitpid reaps the direct child, never touch the reusable
        // numeric PGID again.
        if (!self.group_active) return;
        try posix.kill(-self.pgid, signal);
    }

    fn observeExitNoReap(self: *ChildHandle, blocking: bool) !?ChildTerm {
        if (self.exit_observed) return self.term;

        var info: c.siginfo_t = undefined;
        const options = c.WEXITED | c.WNOWAIT | if (blocking) 0 else c.WNOHANG;
        while (true) {
            const result = c.waitid(
                c.P_PID,
                @intCast(self.pid),
                &info,
                options,
            );
            if (result == 0) {
                if (siginfoPid(&info) == 0) return null;
                const term = termFromSiginfo(info);
                self.term = term;
                self.exit_observed = true;
                return term;
            }
            switch (posix.errno(result)) {
                .INTR => continue,
                .CHILD => return error.ChildProcessUnavailable,
                else => return error.WaitIdFailed,
            }
        }
    }

    fn reapDirectChild(self: *ChildHandle) !ChildTerm {
        if (self.waited) {
            if (self.wait_error) |err| return err;
            return self.term.?;
        }

        const result = posix.waitpid(self.pid, 0);
        const term = termFromStatus(result.status);
        self.finishReaped(term);
        return term;
    }

    fn finishReaped(self: *ChildHandle, term: ChildTerm) void {
        self.child.term = term;
        self.child.id = undefined;
        self.group_active = false;
        self.term = term;
        self.exit_observed = true;
        self.waited = true;
    }

    fn finishClosed(self: *ChildHandle, term: ?ChildTerm, wait_error: ?anyerror) void {
        self.closeStreams();
        self.group_active = false;
        if (term) |value| self.term = value;
        self.exit_observed = term != null;
        self.wait_error = wait_error;
        self.waited = true;
    }

    fn closeStreams(self: *ChildHandle) void {
        if (self.child.err_pipe) |fd| {
            posix.close(fd);
            self.child.err_pipe = null;
        }
        if (self.child.stdin) |*file| {
            file.close();
            self.child.stdin = null;
        }
        if (self.child.stdout) |*file| {
            file.close();
            self.child.stdout = null;
        }
        if (self.child.stderr) |*file| {
            file.close();
            self.child.stderr = null;
        }
        self.stdout_fd = -1;
        self.stderr_fd = -1;
    }
};

const SavedStdin = struct {
    fd: posix.fd_t,
    flags: c_int,
};

const RestoreFn = *const fn (?SavedStdin, bool) anyerror!void;
const CleanupFn = *const fn (*ChildHandle) anyerror!void;
const SignalGroupFn = *const fn (*ChildHandle, u8) anyerror!void;
const TimerStartFn = *const fn () anyerror!std.time.Timer;

pub fn spawn(allocator: Allocator, spec: ExecutionSpec, stdin_fd: ?posix.fd_t) !ChildHandle {
    return spawnWithRestore(allocator, spec, stdin_fd, restoreStdin);
}

fn spawnWithRestore(
    allocator: Allocator,
    spec: ExecutionSpec,
    stdin_fd: ?posix.fd_t,
    restore_fn: RestoreFn,
) !ChildHandle {
    var assembled_argv: ?[]const []const u8 = null;
    defer if (assembled_argv) |argv| allocator.free(argv);
    const argv = if (spec.argv.len != 0) spec.argv else blk: {
        const argv0 = spec.argv0 orelse return error.InvalidArgument;
        const result = try allocator.alloc([]const u8, spec.args.len + 1);
        result[0] = argv0;
        @memcpy(result[1..], spec.args);
        assembled_argv = result;
        break :blk result;
    };

    // A received descriptor is duplicated before touching fd 0.  The caller
    // retains ownership of the received descriptor, while the duplicate is
    // closed after Child.spawn().  The replacement itself is confined to the
    // request handler: the gateway listener must fork before entering here.
    var delegated_fd: ?posix.fd_t = null;
    var saved_stdin: ?SavedStdin = null;
    var replaced_stdin = false;
    if (stdin_fd) |fd| {
        saved_stdin = try saveStdin();
        errdefer if (saved_stdin) |saved| posix.close(saved.fd);

        delegated_fd = try duplicateCloexec(fd);
        errdefer if (delegated_fd) |duplicate| posix.close(duplicate);

        try posix.dup2(delegated_fd.?, posix.STDIN_FILENO);
        replaced_stdin = true;
        posix.close(delegated_fd.?);
        delegated_fd = null;
    }

    var child = std.process.Child.init(argv, allocator);
    child.cwd = spec.cwd;
    child.env_map = &spec.env;
    child.stdin_behavior = if (stdin_fd != null) .Inherit else .Ignore;
    child.stdout_behavior = .Pipe;
    child.stderr_behavior = .Pipe;
    child.pgid = 0;

    child.spawn() catch |err| {
        closeSpawnStreams(&child);
        restore_fn(saved_stdin, replaced_stdin) catch |restore_err| return restore_err;
        return err;
    };

    // Child.spawn() may successfully fork while exec/chdir fails.  Surface
    // that failure to the broker and reap the failed child before returning.
    child.waitForSpawn() catch |err| {
        var restore_error: ?anyerror = null;
        restore_fn(saved_stdin, replaced_stdin) catch |restore_err| {
            restore_error = restore_err;
        };
        reapFailedSpawn(&child);
        if (restore_error) |restore_err| return restore_err;
        return err;
    };

    const child_pid = child.id;
    // `pgid = 0` asks the child to create a group whose id is its own pid.
    // The parent-side call closes the small fork/exec race before a kill can
    // be requested by the broker.
    posix.setpgid(child_pid, child_pid) catch |err| switch (err) {
        error.ProcessNotFound, error.ProcessAlreadyExec => {},
        else => {
            var restore_error: ?anyerror = null;
            restore_fn(saved_stdin, replaced_stdin) catch |restore_err| {
                restore_error = restore_err;
            };
            const cleanup_error = killAndReapSpawnedChild(&child);
            if (cleanup_error) |cleanup_err| return cleanup_err;
            if (restore_error) |restore_err| return restore_err;
            return err;
        },
    };

    restore_fn(saved_stdin, replaced_stdin) catch |restore_err| {
        if (killAndReapSpawnedChild(&child)) |cleanup_err| return cleanup_err;
        return restore_err;
    };

    return .{
        .child = child,
        .stdout_fd = child.stdout.?.handle,
        .stderr_fd = child.stderr.?.handle,
        .pid = child_pid,
        .pgid = child_pid,
    };
}

fn restoreStdin(saved_stdin: ?SavedStdin, replaced_stdin: bool) !void {
    if (!replaced_stdin) return;
    if (saved_stdin) |saved| {
        defer posix.close(saved.fd);
        posix.dup2(saved.fd, posix.STDIN_FILENO) catch |err| {
            posix.close(posix.STDIN_FILENO);
            return err;
        };
        setFdFlags(posix.STDIN_FILENO, saved.flags) catch |err| {
            posix.close(posix.STDIN_FILENO);
            return err;
        };
    } else {
        // If fd 0 was already closed when the request handler entered, do not
        // leave the delegated duplicate installed in the handler.
        posix.close(posix.STDIN_FILENO);
    }
}

fn saveStdin() !?SavedStdin {
    const flags = getFdFlags(posix.STDIN_FILENO) catch |err| switch (err) {
        error.BadFileDescriptor => return null,
        else => return err,
    };
    const fd = duplicateCloexec(posix.STDIN_FILENO) catch |err| switch (err) {
        error.BadFileDescriptor => return null,
        else => return err,
    };
    return .{ .fd = fd, .flags = flags };
}

fn getFdFlags(fd: posix.fd_t) !c_int {
    while (true) {
        const result = c.fcntl(fd, c.F_GETFD);
        if (result >= 0) return result;
        switch (posix.errno(result)) {
            .INTR => continue,
            .BADF => return error.BadFileDescriptor,
            else => return error.GetFdFlagsFailed,
        }
    }
}

fn setFdFlags(fd: posix.fd_t, flags: c_int) !void {
    while (true) {
        const result = c.fcntl(fd, c.F_SETFD, flags);
        if (result == 0) return;
        switch (posix.errno(result)) {
            .INTR => continue,
            .BADF => return error.BadFileDescriptor,
            else => return error.SetFdFlagsFailed,
        }
    }
}

fn duplicateCloexec(fd: posix.fd_t) !posix.fd_t {
    while (true) {
        const result = c.fcntl(fd, c.F_DUPFD_CLOEXEC, @as(c_int, 3));
        if (result >= 0) return @intCast(result);
        switch (posix.errno(result)) {
            .INTR => continue,
            .BADF => return error.BadFileDescriptor,
            else => return error.SaveStdinFailed,
        }
    }
}

fn closeSpawnStreams(child: *std.process.Child) void {
    if (child.err_pipe) |fd| {
        posix.close(fd);
        child.err_pipe = null;
    }
    if (child.stdin) |*file| {
        file.close();
        child.stdin = null;
    }
    if (child.stdout) |*file| {
        file.close();
        child.stdout = null;
    }
    if (child.stderr) |*file| {
        file.close();
        child.stderr = null;
    }
}

fn reapFailedSpawn(child: *std.process.Child) void {
    const failed_pid = child.id;
    closeSpawnStreams(child);
    _ = posix.waitpid(failed_pid, 0);
    child.id = undefined;
}

fn killAndReapSpawnedChild(child: *std.process.Child) ?anyerror {
    return killAndReapSpawnedChildWith(child, ChildHandle.signalGroup);
}

fn killAndReapSpawnedChildWith(child: *std.process.Child, signal_fn: SignalGroupFn) ?anyerror {
    var rollback = ChildHandle{
        .child = child.*,
        .stdout_fd = if (child.stdout) |file| file.handle else -1,
        .stderr_fd = if (child.stderr) |file| file.handle else -1,
        .pid = child.id,
        .pgid = child.id,
    };
    defer rollback.closeStreams();

    _ = rollback.terminateGroupWith(0, signal_fn, startTimer) catch |err| return err;
    return null;
}

fn termFromStatus(status: u32) ChildTerm {
    return if (posix.W.IFEXITED(status))
        .{ .Exited = posix.W.EXITSTATUS(status) }
    else if (posix.W.IFSIGNALED(status))
        .{ .Signal = posix.W.TERMSIG(status) }
    else if (posix.W.IFSTOPPED(status))
        .{ .Stopped = posix.W.STOPSIG(status) }
    else
        .{ .Unknown = status };
}

fn termFromSiginfo(info: c.siginfo_t) ChildTerm {
    return switch (info.si_code) {
        c.CLD_EXITED => .{ .Exited = @intCast(siginfoStatus(&info)) },
        c.CLD_KILLED, c.CLD_DUMPED => .{ .Signal = @intCast(siginfoStatus(&info)) },
        else => .{ .Unknown = @bitCast(siginfoStatus(&info)) },
    };
}

// glibc exposes the Linux siginfo union through `_sifields`; musl exposes the
// same ABI storage as an anonymous `__si_fields` union.  SIGCHLD's pid and
// status members occupy stable offsets within that union in both layouts.
fn siginfoPid(info: *const c.siginfo_t) i32 {
    if (comptime @hasField(c.siginfo_t, "_sifields")) {
        return info._sifields._sigchld.si_pid;
    }
    const raw: [*]const u8 = @ptrCast(info);
    const fields = @offsetOf(c.siginfo_t, "__si_fields");
    const value: *const i32 = @ptrCast(@alignCast(raw + fields));
    return value.*;
}

fn siginfoStatus(info: *const c.siginfo_t) i32 {
    if (comptime @hasField(c.siginfo_t, "_sifields")) {
        return info._sifields._sigchld.si_status;
    }
    const raw: [*]const u8 = @ptrCast(info);
    const fields = @offsetOf(c.siginfo_t, "__si_fields");
    const value: *const i32 = @ptrCast(@alignCast(raw + fields + 8));
    return value.*;
}

fn graceDurationNs(duration_ms: u64) u64 {
    const max = std.math.maxInt(u64);
    const nanoseconds_per_millisecond = @as(u64, std.time.ns_per_ms);
    if (duration_ms > max / nanoseconds_per_millisecond) return max;
    return duration_ms * nanoseconds_per_millisecond;
}

fn graceExpired(elapsed_ns: u64, duration_ms: u64) bool {
    return elapsed_ns >= graceDurationNs(duration_ms);
}

fn startTimer() anyerror!std.time.Timer {
    return std.time.Timer.start();
}

test "child that does not read delegated stdin leaves the pipe untouched" {
    const allocator = std.testing.allocator;
    const fds = try posix.pipe2(.{ .CLOEXEC = true });
    defer posix.close(fds[0]);
    defer posix.close(fds[1]);
    _ = try posix.write(fds[1], "payload");
    const sibling = try posix.dup(fds[0]);
    defer posix.close(sibling);

    var env = EnvMap.init(allocator);
    defer env.deinit();
    const argv = [_][]const u8{"/bin/true"};
    var child = try spawn(allocator, .{ .argv = &argv, .cwd = null, .env = env }, fds[0]);
    defer child.deinit() catch {};
    _ = try child.wait();

    var result: [7]u8 = undefined;
    try std.testing.expectEqual(@as(usize, 7), try posix.read(sibling, &result));
    try std.testing.expectEqualStrings("payload", &result);
}

test "grace deadline uses monotonic elapsed readings at the exact boundary" {
    const grace_ms: u64 = 7;
    const one_ms = @as(u64, std.time.ns_per_ms);
    const elapsed_samples = [_]u64{ 0, one_ms, 6 * one_ms, 7 * one_ms - 1 };
    for (elapsed_samples) |elapsed_ns| {
        try std.testing.expect(!graceExpired(elapsed_ns, grace_ms));
    }
    try std.testing.expect(graceExpired(7 * one_ms, grace_ms));

    // Saturation keeps a huge millisecond request from wrapping into an
    // immediately-expired deadline. Only monotonic elapsed samples matter;
    // wall-clock readings are not part of this calculation.
    try std.testing.expectEqual(std.math.maxInt(u64), graceDurationNs(std.math.maxInt(u64)));
    try std.testing.expect(!graceExpired(std.math.maxInt(u64) - 1, std.math.maxInt(u64)));
}

test "zero-grace cleanup does not require a timer" {
    const allocator = std.testing.allocator;
    var env = EnvMap.init(allocator);
    defer env.deinit();
    const argv = [_][]const u8{ "/bin/sh", "-c", "while :; do :; done" };
    var child = try spawn(allocator, .{ .argv = &argv, .env = env }, null);
    defer child.deinit() catch {};

    test_signal_order_count = 0;
    _ = try child.terminateGroupWith(0, testRecordingSignalGroup, testTimerUnsupported);
    try std.testing.expect(child.waited);
    try std.testing.expectEqual(@as(usize, 2), test_signal_order_count);
    try std.testing.expectEqual(posix.SIG.TERM, test_signal_order[0]);
    try std.testing.expectEqual(posix.SIG.KILL, test_signal_order[1]);
}

test "nonzero cleanup surfaces timer start errors for retry" {
    const allocator = std.testing.allocator;
    var env = EnvMap.init(allocator);
    defer env.deinit();
    const argv = [_][]const u8{ "/bin/sh", "-c", "while :; do :; done" };
    var child = try spawn(allocator, .{ .argv = &argv, .env = env }, null);
    defer child.deinit() catch {};

    test_signal_order_count = 0;
    try std.testing.expectError(
        error.TimerUnsupported,
        child.terminateGroupWith(1, testRecordingSignalGroup, testTimerUnsupported),
    );
    try std.testing.expect(!child.waited);
    try std.testing.expectEqual(@as(usize, 0), test_signal_order_count);

    _ = try child.terminateGroupWith(0, testRecordingSignalGroup, testTimerStart);
    try std.testing.expect(child.waited);
}

test "delegated child does not inherit the handler's original stdin descriptor" {
    const allocator = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const dir = try tmp.dir.realpathAlloc(allocator, ".");
    defer allocator.free(dir);
    const original_path = try std.fs.path.join(allocator, &.{ dir, "handler-stdin" });
    defer allocator.free(original_path);
    const original_file = try std.fs.cwd().createFile(original_path, .{});
    defer original_file.close();

    const saved_handler_stdin = try testDupCloexec(posix.STDIN_FILENO);
    defer {
        posix.dup2(saved_handler_stdin, posix.STDIN_FILENO) catch {};
        posix.close(saved_handler_stdin);
    }
    try posix.dup2(original_file.handle, posix.STDIN_FILENO);

    const fds = try posix.pipe2(.{ .CLOEXEC = true });
    defer posix.close(fds[0]);
    defer posix.close(fds[1]);
    var env = EnvMap.init(allocator);
    defer env.deinit();
    try env.put("NAS_EXECUTOR_ORIGINAL_STDIN", original_path);
    const argv = [_][]const u8{
        "/bin/ls",
        "-l",
        "/proc/self/fd",
    };
    var child = try spawn(allocator, .{ .argv = &argv, .env = env }, fds[0]);
    defer child.deinit() catch {};

    var output = std.ArrayList(u8).empty;
    defer output.deinit(allocator);
    var buffer: [256]u8 = undefined;
    while (true) {
        const n = try posix.read(child.stdout_fd, &buffer);
        if (n == 0) break;
        try output.appendSlice(allocator, buffer[0..n]);
    }
    try std.testing.expect(std.mem.indexOf(u8, output.items, original_path) == null);
    _ = try child.wait();
}

fn testDupCloexec(fd: posix.fd_t) !posix.fd_t {
    const result = c.fcntl(fd, c.F_DUPFD_CLOEXEC, @as(c_int, 3));
    if (result < 0) return error.TestUnexpectedResult;
    return @intCast(result);
}

test "child consumes only the bytes it reads" {
    const allocator = std.testing.allocator;
    const fds = try posix.pipe2(.{ .CLOEXEC = true });
    defer posix.close(fds[0]);
    defer posix.close(fds[1]);
    _ = try posix.write(fds[1], "payload");
    const sibling = try posix.dup(fds[0]);
    defer posix.close(sibling);

    var env = EnvMap.init(allocator);
    defer env.deinit();
    const argv = [_][]const u8{
        "/bin/sh",
        "-c",
        "dd bs=1 count=3 status=none >&2",
    };
    var child = try spawn(allocator, .{ .argv = &argv, .cwd = null, .env = env }, fds[0]);
    defer child.deinit() catch {};
    _ = try child.wait();

    var result: [4]u8 = undefined;
    try std.testing.expectEqual(@as(usize, 4), try posix.read(sibling, &result));
    try std.testing.expectEqualStrings("load", &result);
}

test "delegated regular-file stdin preserves the shared open-file-description offset" {
    const allocator = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var input = try tmp.dir.createFile("delegated-stdin", .{ .read = true });
    defer input.close();
    try input.writeAll("payload");
    try input.seekTo(0);
    const sibling = try posix.dup(input.handle);
    defer posix.close(sibling);

    var env = EnvMap.init(allocator);
    defer env.deinit();
    const argv = [_][]const u8{
        "/bin/sh",
        "-c",
        "dd bs=1 count=3 status=none >&2",
    };
    var child = try spawn(allocator, .{ .argv = &argv, .env = env }, input.handle);
    defer child.deinit() catch {};
    _ = try child.wait();

    var result: [4]u8 = undefined;
    try std.testing.expectEqual(@as(usize, 4), try posix.read(sibling, &result));
    try std.testing.expectEqualStrings("load", &result);
}

test "stdin null gives the child EOF" {
    const allocator = std.testing.allocator;
    var env = EnvMap.init(allocator);
    defer env.deinit();
    const argv = [_][]const u8{"/bin/cat"};
    var child = try spawn(allocator, .{ .argv = &argv, .cwd = null, .env = env }, null);
    defer child.deinit() catch {};

    var output: [1]u8 = undefined;
    try std.testing.expectEqual(@as(usize, 0), try posix.read(child.stdout_fd, &output));
    _ = try child.wait();
}

test "execution spec can be built directly from start fields" {
    const allocator = std.testing.allocator;
    var env = EnvMap.init(allocator);
    defer env.deinit();
    const args = [_][]const u8{ "-c", "exit 7" };
    var child = try spawn(allocator, .{
        .argv0 = "/bin/sh",
        .args = &args,
        .env = env,
    }, null);
    defer child.deinit() catch {};
    const term = try child.wait();
    try std.testing.expectEqual(std.process.Child.Term{ .Exited = 7 }, term);
}

test "pollExit keeps final stdout and stderr bytes available to drain" {
    const allocator = std.testing.allocator;
    var env = EnvMap.init(allocator);
    defer env.deinit();
    const argv = [_][]const u8{
        "/bin/sh",
        "-c",
        "printf out; printf err >&2",
    };
    var child = try spawn(allocator, .{ .argv = &argv, .env = env }, null);
    defer child.deinit() catch {};

    while (try child.pollExit() == null) {
        std.Thread.sleep(std.time.ns_per_ms);
    }
    var stdout: [3]u8 = undefined;
    var stderr: [3]u8 = undefined;
    try std.testing.expectEqual(@as(usize, 3), try posix.read(child.stdout_fd, &stdout));
    try std.testing.expectEqual(@as(usize, 3), try posix.read(child.stderr_fd, &stderr));
    try std.testing.expectEqualStrings("out", &stdout);
    try std.testing.expectEqualStrings("err", &stderr);
    _ = try child.wait();
}

test "missing executable and cwd failures are reported by spawn" {
    const allocator = std.testing.allocator;
    var env = EnvMap.init(allocator);
    defer env.deinit();

    const missing = [_][]const u8{"/definitely/missing/nas-executor"};
    try std.testing.expectError(
        error.FileNotFound,
        spawn(allocator, .{ .argv = &missing, .cwd = null, .env = env }, null),
    );

    const argv = [_][]const u8{"/bin/true"};
    try std.testing.expectError(
        error.FileNotFound,
        spawn(allocator, .{ .argv = &argv, .cwd = "/definitely/missing/nas-cwd", .env = env }, null),
    );
}

test "spawn failures reap the failed child and release their pipes" {
    const allocator = std.testing.allocator;
    const before_children = try testChildrenSnapshot(allocator);
    defer allocator.free(before_children);
    const before_fds = try testOpenDescriptorCount();

    var env = EnvMap.init(allocator);
    defer env.deinit();
    const missing = [_][]const u8{"/definitely/missing/nas-executor"};
    for (0..8) |_| {
        try std.testing.expectError(
            error.FileNotFound,
            spawn(allocator, .{ .argv = &missing, .env = env }, null),
        );
    }

    const after_children = try testChildrenSnapshot(allocator);
    defer allocator.free(after_children);
    try std.testing.expectEqualStrings(before_children, after_children);
    try std.testing.expectEqual(before_fds, try testOpenDescriptorCount());
}

test "exec and cwd failures leave no child or descriptor ownership" {
    const allocator = std.testing.allocator;
    const before_children = try testChildrenSnapshot(allocator);
    defer allocator.free(before_children);
    const before_fds = try testOpenDescriptorCount();

    var env = EnvMap.init(allocator);
    defer env.deinit();
    const missing = [_][]const u8{"/definitely/missing/nas-executor"};
    const argv = [_][]const u8{"/bin/true"};
    for (0..4) |_| {
        try std.testing.expectError(
            error.FileNotFound,
            spawn(allocator, .{ .argv = &missing, .env = env }, null),
        );
        try std.testing.expectError(
            error.FileNotFound,
            spawn(allocator, .{ .argv = &argv, .cwd = "/definitely/missing/nas-cwd", .env = env }, null),
        );
    }

    const after_children = try testChildrenSnapshot(allocator);
    defer allocator.free(after_children);
    try std.testing.expectEqualStrings(before_children, after_children);
    try std.testing.expectEqual(before_fds, try testOpenDescriptorCount());
}

test "delegated stdin restores a handler whose fd 0 was already closed" {
    const allocator = std.testing.allocator;
    const saved_handler_stdin = try testDupCloexec(posix.STDIN_FILENO);
    defer {
        posix.dup2(saved_handler_stdin, posix.STDIN_FILENO) catch {};
        posix.close(saved_handler_stdin);
    }
    const fds = try posix.pipe2(.{ .CLOEXEC = true });
    defer posix.close(fds[0]);
    defer posix.close(fds[1]);
    posix.close(posix.STDIN_FILENO);

    var env = EnvMap.init(allocator);
    defer env.deinit();
    const argv = [_][]const u8{"/bin/true"};
    var child = try spawn(allocator, .{ .argv = &argv, .env = env }, fds[0]);
    defer child.deinit() catch {};

    try std.testing.expect(!testFdIsOpen(posix.STDIN_FILENO));
    _ = try child.wait();
}

test "closed delegated stdin cleanup leaves no child or descriptor leak" {
    const allocator = std.testing.allocator;
    const saved_handler_stdin = try testDupCloexec(posix.STDIN_FILENO);
    defer {
        posix.dup2(saved_handler_stdin, posix.STDIN_FILENO) catch {};
        posix.close(saved_handler_stdin);
    }
    const fds = try posix.pipe2(.{ .CLOEXEC = true });
    defer posix.close(fds[0]);
    defer posix.close(fds[1]);
    const before_children = try testChildrenSnapshot(allocator);
    defer allocator.free(before_children);
    const before_fds = try testOpenDescriptorCount();
    posix.close(posix.STDIN_FILENO);

    var env = EnvMap.init(allocator);
    defer env.deinit();
    const argv = [_][]const u8{"/bin/true"};
    var child = try spawn(allocator, .{ .argv = &argv, .env = env }, fds[0]);
    defer child.deinit() catch {};
    _ = try child.wait();
    try child.deinit();
    try child.deinit();

    try std.testing.expect(!testFdIsOpen(posix.STDIN_FILENO));
    const after_children = try testChildrenSnapshot(allocator);
    defer allocator.free(after_children);
    try std.testing.expectEqualStrings(before_children, after_children);
    try std.testing.expectEqual(before_fds - 1, try testOpenDescriptorCount());
}

test "delegated stdin restores the original open fd 0 after repeated cleanup" {
    const allocator = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const dir = try tmp.dir.realpathAlloc(allocator, ".");
    defer allocator.free(dir);
    const original_path = try std.fs.path.join(allocator, &.{ dir, "restored-stdin" });
    defer allocator.free(original_path);
    const original_file = try std.fs.cwd().createFile(original_path, .{});
    defer original_file.close();

    const saved_handler_stdin = try testDupCloexec(posix.STDIN_FILENO);
    defer {
        posix.dup2(saved_handler_stdin, posix.STDIN_FILENO) catch {};
        posix.close(saved_handler_stdin);
    }
    try posix.dup2(original_file.handle, posix.STDIN_FILENO);
    const fds = try posix.pipe2(.{ .CLOEXEC = true });
    defer posix.close(fds[0]);
    defer posix.close(fds[1]);
    const before_children = try testChildrenSnapshot(allocator);
    defer allocator.free(before_children);
    const before_fds = try testOpenDescriptorCount();

    var env = EnvMap.init(allocator);
    defer env.deinit();
    const argv = [_][]const u8{"/bin/true"};
    var child = try spawn(allocator, .{ .argv = &argv, .env = env }, fds[0]);
    defer child.deinit() catch {};
    _ = try child.wait();
    try child.deinit();
    try child.deinit();

    var target: [std.fs.max_path_bytes]u8 = undefined;
    const target_slice = try posix.readlink("/proc/self/fd/0", &target);
    try std.testing.expectEqualStrings(original_path, target_slice);
    const after_children = try testChildrenSnapshot(allocator);
    defer allocator.free(after_children);
    try std.testing.expectEqualStrings(before_children, after_children);
    try std.testing.expectEqual(before_fds, try testOpenDescriptorCount());
}

test "delegated stdin restores fd 0 close-on-exec flags exactly" {
    const allocator = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var original_file = try tmp.dir.createFile("flags-stdin", .{ .read = true });
    defer original_file.close();

    const saved_handler_stdin = try testDupCloexec(posix.STDIN_FILENO);
    defer {
        posix.dup2(saved_handler_stdin, posix.STDIN_FILENO) catch {};
        posix.close(saved_handler_stdin);
    }
    try posix.dup2(original_file.handle, posix.STDIN_FILENO);
    const expected_flags = @as(c_int, c.FD_CLOEXEC);
    try setFdFlags(posix.STDIN_FILENO, expected_flags);
    const original_flags = try getFdFlags(posix.STDIN_FILENO);

    const fds = try posix.pipe2(.{ .CLOEXEC = true });
    defer posix.close(fds[0]);
    defer posix.close(fds[1]);
    var env = EnvMap.init(allocator);
    defer env.deinit();
    const argv = [_][]const u8{"/bin/true"};
    var child = try spawn(allocator, .{ .argv = &argv, .env = env }, fds[0]);
    defer child.deinit() catch {};
    _ = try child.wait();

    try std.testing.expectEqual(original_flags, try getFdFlags(posix.STDIN_FILENO));
}

test "stdin restoration failure kills and reaps the started child" {
    const allocator = std.testing.allocator;
    const saved_handler_stdin = try testDupCloexec(posix.STDIN_FILENO);
    defer {
        posix.dup2(saved_handler_stdin, posix.STDIN_FILENO) catch {};
        posix.close(saved_handler_stdin);
    }
    const fds = try posix.pipe2(.{ .CLOEXEC = true });
    defer posix.close(fds[0]);
    defer posix.close(fds[1]);
    posix.close(posix.STDIN_FILENO);

    const before_children = try testChildrenSnapshot(allocator);
    defer allocator.free(before_children);
    const before_fds = try testOpenDescriptorCount();

    var env = EnvMap.init(allocator);
    defer env.deinit();
    const argv = [_][]const u8{ "/bin/sh", "-c", "while :; do :; done" };
    try std.testing.expectError(
        error.TestRestoreFailure,
        spawnWithRestore(
            allocator,
            .{ .argv = &argv, .env = env },
            fds[0],
            testFailingRestore,
        ),
    );

    try std.testing.expectEqualStrings(before_children, try testChildrenSnapshot(allocator));
    try std.testing.expectEqual(before_fds, try testOpenDescriptorCount());
}

fn testFdIsOpen(fd: posix.fd_t) bool {
    return c.fcntl(fd, c.F_GETFD) >= 0;
}

fn testFailingRestore(saved_stdin: ?SavedStdin, replaced_stdin: bool) anyerror!void {
    if (saved_stdin) |saved| posix.close(saved.fd);
    if (replaced_stdin) posix.close(posix.STDIN_FILENO);
    return error.TestRestoreFailure;
}

fn testChildrenSnapshot(allocator: Allocator) ![]u8 {
    const path = try std.fmt.allocPrint(allocator, "/proc/self/task/{d}/children", .{c.getpid()});
    defer allocator.free(path);
    return std.fs.cwd().readFileAlloc(allocator, path, 4096);
}

fn testOpenDescriptorCount() !usize {
    var dir = try std.fs.cwd().openDir("/proc/self/fd", .{ .iterate = true });
    defer dir.close();
    var count: usize = 0;
    var iterator = dir.iterate();
    while (try iterator.next()) |_| count += 1;
    return count;
}

fn testProcessIsLive(pid: pid_t) bool {
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

test "environment replacement is passed exactly to the child" {
    const allocator = std.testing.allocator;
    var env = EnvMap.init(allocator);
    defer env.deinit();
    try env.put("NAS_EXECUTOR_TEST_ONLY", "present");
    const argv = [_][]const u8{"/usr/bin/env"};
    var child = try spawn(allocator, .{ .argv = &argv, .cwd = null, .env = env }, null);
    defer child.deinit() catch {};

    var output = std.ArrayList(u8).empty;
    defer output.deinit(allocator);
    var buffer: [256]u8 = undefined;
    while (true) {
        const n = try posix.read(child.stdout_fd, &buffer);
        if (n == 0) break;
        try output.appendSlice(allocator, buffer[0..n]);
    }
    _ = try child.wait();
    try std.testing.expectEqualStrings("NAS_EXECUTOR_TEST_ONLY=present\n", output.items);
}

test "wait observes exit but leaves group cleanup for deinit" {
    const allocator = std.testing.allocator;
    var env = EnvMap.init(allocator);
    defer env.deinit();
    const argv = [_][]const u8{"/bin/true"};
    var child = try spawn(allocator, .{ .argv = &argv, .env = env }, null);
    defer child.deinit() catch {};

    const term = try child.wait();
    try std.testing.expect(child.group_active);
    try std.testing.expectEqual(term, try child.wait());
    try std.testing.expectEqual(term, try child.terminateGroup(0));
    try std.testing.expect(!child.group_active);
}

test "terminateGroup kills a descendant that ignores SIGTERM" {
    const allocator = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const dir = try tmp.dir.realpathAlloc(allocator, ".");
    defer allocator.free(dir);
    const pid_path = try std.fs.path.join(allocator, &.{ dir, "descendant.pid" });
    defer allocator.free(pid_path);

    var env = EnvMap.init(allocator);
    defer env.deinit();
    try env.put("NAS_EXECUTOR_PID_FILE", pid_path);
    const argv = [_][]const u8{
        "/bin/sh",
        "-c",
        "trap '' TERM; (trap '' TERM; while :; do /bin/sleep 1; done) & echo $! > \"$NAS_EXECUTOR_PID_FILE\"; while :; do /bin/sleep 1; done",
    };
    var child = try spawn(allocator, .{ .argv = &argv, .cwd = null, .env = env }, null);
    defer child.deinit() catch {};

    try std.testing.expectEqual(child.pid, c.getpgid(child.pid));

    var descendant_pid: ?posix.pid_t = null;
    var attempts: usize = 0;
    while (attempts < 100 and descendant_pid == null) : (attempts += 1) {
        if (std.fs.cwd().openFile(pid_path, .{})) |file| {
            defer file.close();
            var bytes: [32]u8 = undefined;
            const len = try file.read(&bytes);
            if (len > 0) {
                descendant_pid = try std.fmt.parseInt(posix.pid_t, std.mem.trim(u8, bytes[0..len], " \t\r\n"), 10);
            }
        } else |_| {}
        if (descendant_pid == null) std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expect(descendant_pid != null);

    _ = try child.terminateGroup(20);
    if (descendant_pid) |pid| {
        var gone = false;
        var i: usize = 0;
        while (i < 100) : (i += 1) {
            if (!testProcessIsLive(pid)) {
                gone = true;
                break;
            }
            std.Thread.sleep(std.time.ns_per_ms);
        }
        // The executor owns and reaps the direct child.  A same-group
        // descendant is killed by the group signal but may be an init-owned
        // zombie because descendant reaping is intentionally out of scope.
        try std.testing.expect(gone);
    }
}

test "terminateGroup gives a TERM-handling descendant the full grace period" {
    const allocator = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const dir = try tmp.dir.realpathAlloc(allocator, ".");
    defer allocator.free(dir);
    const pid_path = try std.fs.path.join(allocator, &.{ dir, "grace-descendant.pid" });
    defer allocator.free(pid_path);
    const done_path = try std.fs.path.join(allocator, &.{ dir, "grace-descendant.done" });
    defer allocator.free(done_path);

    var env = EnvMap.init(allocator);
    defer env.deinit();
    try env.put("NAS_EXECUTOR_PID_FILE", pid_path);
    try env.put("NAS_EXECUTOR_DONE_FILE", done_path);
    const argv = [_][]const u8{
        "/bin/sh",
        "-c",
        "trap 'exit 0' TERM; (trap 'sleep 0.02; echo done > \"$NAS_EXECUTOR_DONE_FILE\"; exit 0' TERM; while :; do :; done) & echo $! > \"$NAS_EXECUTOR_PID_FILE\"; while :; do :; done",
    };
    var child = try spawn(allocator, .{ .argv = &argv, .env = env }, null);
    defer child.deinit() catch {};

    const descendant_pid = try readFixturePid(pid_path);
    try std.testing.expectEqual(child.pgid, c.getpgid(descendant_pid));
    const term = try child.terminateGroup(100);
    try std.testing.expectEqual(std.process.Child.Term{ .Exited = 0 }, term);
    const done = try std.fs.cwd().readFileAlloc(allocator, done_path, 64);
    defer allocator.free(done);
    try std.testing.expectEqualStrings("done\n", done);
    try expectFixtureGone(descendant_pid);
}

test "terminateGroup kills a same-group descendant after the leader exits on TERM" {
    const allocator = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const dir = try tmp.dir.realpathAlloc(allocator, ".");
    defer allocator.free(dir);
    const pid_path = try std.fs.path.join(allocator, &.{ dir, "term-exit-descendant.pid" });
    defer allocator.free(pid_path);

    var env = EnvMap.init(allocator);
    defer env.deinit();
    try env.put("NAS_EXECUTOR_PID_FILE", pid_path);
    const argv = [_][]const u8{
        "/bin/sh",
        "-c",
        "trap 'exit 0' TERM; (trap '' TERM; while :; do /bin/sleep 1; done) & echo $! > \"$NAS_EXECUTOR_PID_FILE\"; while :; do :; done",
    };
    var child = try spawn(allocator, .{ .argv = &argv, .env = env }, null);
    defer child.deinit() catch {};

    const descendant_pid = try readFixturePid(pid_path);
    try std.testing.expectEqual(child.pgid, c.getpgid(descendant_pid));
    const term = try child.terminateGroup(100);
    try std.testing.expectEqual(std.process.Child.Term{ .Exited = 0 }, term);
    try expectFixtureGone(descendant_pid);
}

test "wait leaves a lingering same-group child for later cleanup" {
    const allocator = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const dir = try tmp.dir.realpathAlloc(allocator, ".");
    defer allocator.free(dir);
    const pid_path = try std.fs.path.join(allocator, &.{ dir, "post-wait-descendant.pid" });
    defer allocator.free(pid_path);

    var env = EnvMap.init(allocator);
    defer env.deinit();
    try env.put("NAS_EXECUTOR_PID_FILE", pid_path);
    const argv = [_][]const u8{
        "/bin/sh",
        "-c",
        "(trap '' TERM; while :; do /bin/sleep 1; done) & echo $! > \"$NAS_EXECUTOR_PID_FILE\"; exit 0",
    };
    var child = try spawn(allocator, .{ .argv = &argv, .env = env }, null);
    defer child.deinit() catch {};

    const term = try child.wait();
    try std.testing.expectEqual(std.process.Child.Term{ .Exited = 0 }, term);
    try std.testing.expect(child.group_active);
    const descendant_pid = try readFixturePid(pid_path);
    try std.testing.expect(testProcessIsLive(descendant_pid));
    _ = try child.terminateGroup(100);
    try expectFixtureGone(descendant_pid);
}

test "wait leaves final stdout and stderr bytes available to drain" {
    const allocator = std.testing.allocator;
    var env = EnvMap.init(allocator);
    defer env.deinit();
    const argv = [_][]const u8{
        "/bin/sh",
        "-c",
        "printf out; printf err >&2",
    };
    var child = try spawn(allocator, .{ .argv = &argv, .env = env }, null);
    defer child.deinit() catch {};

    const term = try child.wait();
    try std.testing.expectEqual(term, try child.wait());
    var stdout: [3]u8 = undefined;
    var stderr: [3]u8 = undefined;
    try std.testing.expectEqual(@as(usize, 3), try posix.read(child.stdout_fd, &stdout));
    try std.testing.expectEqual(@as(usize, 3), try posix.read(child.stderr_fd, &stderr));
    try std.testing.expectEqualStrings("out", &stdout);
    try std.testing.expectEqualStrings("err", &stderr);
}

test "rollback cleanup emits TERM then KILL" {
    const allocator = std.testing.allocator;
    const argv = [_][]const u8{
        "/bin/sh",
        "-c",
        "trap '' TERM; while :; do :; done",
    };
    var raw = std.process.Child.init(&argv, allocator);
    raw.stdin_behavior = .Ignore;
    raw.stdout_behavior = .Pipe;
    raw.stderr_behavior = .Pipe;
    raw.pgid = 0;
    try raw.spawn();
    var raw_owned = true;
    defer if (raw_owned) {
        _ = raw.kill() catch {};
        closeSpawnStreams(&raw);
    };
    try raw.waitForSpawn();
    posix.setpgid(raw.id, raw.id) catch |err| switch (err) {
        error.ProcessAlreadyExec, error.ProcessNotFound => {},
        else => return err,
    };

    test_signal_order_count = 0;
    const cleanup_error = killAndReapSpawnedChildWith(&raw, testRecordingSignalGroup);
    raw.stdin = null;
    raw.stdout = null;
    raw.stderr = null;
    raw.err_pipe = null;
    raw.id = undefined;
    raw_owned = false;
    if (cleanup_error) |err| return err;

    try std.testing.expectEqual(@as(usize, 2), test_signal_order_count);
    try std.testing.expectEqual(posix.SIG.TERM, test_signal_order[0]);
    try std.testing.expectEqual(posix.SIG.KILL, test_signal_order[1]);
}

var test_signal_order: [2]u8 = undefined;
var test_signal_order_count: usize = 0;

fn testRecordingSignalGroup(handle: *ChildHandle, signal: u8) !void {
    if (test_signal_order_count < test_signal_order.len) {
        test_signal_order[test_signal_order_count] = signal;
        test_signal_order_count += 1;
    }
    try handle.signalGroup(signal);
}

fn testTimerUnsupported() anyerror!std.time.Timer {
    return error.TimerUnsupported;
}

fn testTimerStart() anyerror!std.time.Timer {
    return std.time.Timer.start();
}

fn readFixturePid(path: []const u8) !pid_t {
    var attempts: usize = 0;
    while (attempts < 100) : (attempts += 1) {
        if (std.fs.cwd().openFile(path, .{})) |file| {
            defer file.close();
            var bytes: [32]u8 = undefined;
            const len = try file.read(&bytes);
            if (len > 0) return std.fmt.parseInt(pid_t, std.mem.trim(u8, bytes[0..len], " \t\r\n"), 10);
        } else |_| {}
        std.Thread.sleep(std.time.ns_per_ms);
    }
    return error.TestUnexpectedResult;
}

fn expectFixtureGone(pid: pid_t) !void {
    var attempts: usize = 0;
    while (attempts < 100 and testProcessIsLive(pid)) : (attempts += 1) {
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expect(!testProcessIsLive(pid));
}

test "deinit reports cleanup failure and can be retried" {
    const allocator = std.testing.allocator;
    var env = EnvMap.init(allocator);
    defer env.deinit();
    const argv = [_][]const u8{ "/bin/sh", "-c", "while :; do :; done" };
    var child = try spawn(allocator, .{ .argv = &argv, .env = env }, null);
    defer child.deinit() catch {};

    try std.testing.expectError(error.TestCleanupFailure, child.deinitWith(testFailCleanup));
    try std.testing.expect(!child.deinitialized);
    try child.deinit();
    try std.testing.expect(child.deinitialized);
    try child.deinit();
}

fn testFailCleanup(_: *ChildHandle) anyerror!void {
    return error.TestCleanupFailure;
}
