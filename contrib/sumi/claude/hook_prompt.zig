//! UserPromptSubmit: reject protected values in prompts and `@` attachments.
const std = @import("std");
const jsonio = @import("../jsonio.zig");
const secret_file = @import("../secrets.zig");
const cli = @import("../main.zig");
const mask = @import("mask");

pub const SCAN_LIMIT: usize = 32 * 1024 * 1024;
pub const DIR_FILE_LIMIT: usize = 100;
pub const SEARCH_DEPTH: usize = 6;
pub const SEARCH_LIMIT: usize = 50;
pub const DEADLINE_MS: i64 = 15_000;
const FALLBACK_BLOCK = "{\"decision\":\"block\",\"reason\":\"sumi: the prompt hook failed, so this prompt was withheld.\",\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"suppressOriginalPrompt\":true}}";

const Output = struct {
    context: *anyopaque,
    writeFn: *const fn (context: *anyopaque, bytes: []const u8) anyerror!void,

    fn write(self: Output, bytes: []const u8) !void {
        return self.writeFn(self.context, bytes);
    }
};
const DEADLINE_BLOCK = FALLBACK_BLOCK ++ "\n";
const TAIL = " An @-attachment does not reach output masking, so its content cannot be masked. Ask for the lines you need instead.";

pub fn extractTokens(a: std.mem.Allocator, prompt: []const u8) ![]const []const u8 {
    var out: std.ArrayList([]const u8) = .empty;
    errdefer {
        for (out.items) |item| a.free(item);
        out.deinit(a);
    }
    var i: usize = 0;
    while (i < prompt.len) : (i += 1) {
        if (prompt[i] != '@' or (i > 0 and !std.ascii.isWhitespace(prompt[i - 1]))) continue;
        var token: std.ArrayList(u8) = .empty;
        errdefer token.deinit(a);
        var j = i + 1;
        while (j < prompt.len) : (j += 1) {
            if (prompt[j] == '\\' and j + 1 < prompt.len) {
                try token.append(a, prompt[j + 1]);
                j += 1;
            } else if (std.ascii.isWhitespace(prompt[j])) break else try token.append(a, prompt[j]);
        }
        if (token.items.len == 0) token.deinit(a) else try out.append(a, try token.toOwnedSlice(a));
        i = j;
    }
    return out.toOwnedSlice(a);
}

pub fn looksLikePath(token: []const u8) bool {
    if (std.mem.indexOfScalar(u8, token, '/') != null) return true;
    const dot = std.mem.lastIndexOfScalar(u8, token, '.') orelse return false;
    const ext = token[dot + 1 ..];
    if (ext.len == 0 or ext.len > 4 or !std.ascii.isAlphabetic(ext[0])) return false;
    for (ext[1..]) |c| if (!std.ascii.isAlphanumeric(c)) return false;
    return true;
}

pub fn isMcpResource(token: []const u8) bool {
    return std.mem.indexOf(u8, token, "://") != null;
}

pub fn expandHome(a: std.mem.Allocator, token: []const u8, home: []const u8) ![]u8 {
    if (std.mem.startsWith(u8, token, "~/")) return std.fs.path.join(a, &.{ home, token[2..] });
    return a.dupe(u8, token);
}

pub const Verdict = enum { clean, holds_value, denied_name, mcp_resource, unverifiable };

pub const Checker = struct {
    allocator: std.mem.Allocator,
    roots: []const []const u8,
    deny_paths: []const []const u8,
    secrets: []const []const u8,
    deadline_ms: i64,

    fn expired(self: *const Checker) bool {
        return std.time.milliTimestamp() >= self.deadline_ms;
    }

    fn fileVerdict(self: *const Checker, path: []const u8) Verdict {
        if (self.expired()) return .unverifiable;
        const fd = std.posix.open(path, .{ .ACCMODE = .RDONLY, .NONBLOCK = true }, 0) catch return .unverifiable;
        const file = std.fs.File{ .handle = fd };
        defer file.close();
        const stat = file.stat() catch return .unverifiable;
        if (stat.kind != .file) return .unverifiable;
        const data = self.allocator.alloc(u8, SCAN_LIMIT) catch return .unverifiable;
        defer self.allocator.free(data);
        const n = file.readAll(data) catch return .unverifiable;
        if (self.expired()) return .unverifiable;
        return if (mask.containsAny(data[0..n], self.secrets)) .holds_value else .clean;
    }

    fn checkPath(self: *const Checker, path: []const u8) ?Verdict {
        if (self.expired()) return .unverifiable;
        const stat = std.fs.cwd().statFile(path) catch return null;
        if (stat.kind == .file) return self.fileVerdict(path);
        if (stat.kind != .directory) return .unverifiable;
        var dir = std.fs.cwd().openDir(path, .{ .iterate = true }) catch return .unverifiable;
        defer dir.close();
        var it = dir.iterate();
        var seen: usize = 0;
        while (it.next() catch return .unverifiable) |entry| {
            if (self.expired()) return .unverifiable;
            if (entry.kind == .directory) continue;
            if (entry.kind != .file) return .unverifiable;
            if (seen >= DIR_FILE_LIMIT) break;
            seen += 1;
            const child = std.fs.path.join(self.allocator, &.{ path, entry.name }) catch return .unverifiable;
            defer self.allocator.free(child);
            const verdict = self.fileVerdict(child);
            if (verdict != .clean) return verdict;
        }
        return if (self.expired()) .unverifiable else .clean;
    }

    fn searchDir(self: *const Checker, path: []const u8, base: []const u8, depth: usize, found: *usize) !?Verdict {
        var dir = std.fs.cwd().openDir(path, .{ .iterate = true }) catch return null;
        defer dir.close();
        var it = dir.iterate();
        while (try it.next()) |entry| {
            if (self.expired()) return .unverifiable;
            if (found.* >= SEARCH_LIMIT) return .clean;
            const full = try std.fs.path.join(self.allocator, &.{ path, entry.name });
            defer self.allocator.free(full);
            if (entry.kind == .directory and depth + 1 < SEARCH_DEPTH) {
                if (try self.searchDir(full, base, depth + 1, found)) |verdict| {
                    if (verdict != .clean) return verdict;
                }
            } else if ((entry.kind == .file or entry.kind == .sym_link or entry.kind == .unknown) and
                std.mem.eql(u8, entry.name, base))
            {
                found.* += 1;
                const verdict = self.checkPath(full) orelse .unverifiable;
                if (verdict != .clean) return verdict;
                if (found.* >= SEARCH_LIMIT) return .clean;
            }
        }
        if (self.expired()) return .unverifiable;
        return if (found.* > 0) .clean else null;
    }

    fn searchByName(self: *const Checker, root: []const u8, base: []const u8) !?Verdict {
        var found: usize = 0;
        return self.searchDir(root, base, 0, &found);
    }

    pub fn check(self: *const Checker, token: []const u8) !Verdict {
        if (self.expired()) return .unverifiable;
        for (self.deny_paths) |deny| if (std.mem.indexOf(u8, token, deny) != null) return .denied_name;
        if (isMcpResource(token)) return .mcp_resource;
        const path = try expandHome(self.allocator, token, std.posix.getenv("HOME") orelse "");
        defer self.allocator.free(path);
        if (std.fs.path.isAbsolute(path)) {
            if (self.checkPath(path)) |v| return v;
        } else {
            var resolved = false;
            for (self.roots) |root| {
                const full = try std.fs.path.join(self.allocator, &.{ root, path });
                defer self.allocator.free(full);
                if (self.checkPath(full)) |v| {
                    if (v != .clean) return v;
                    resolved = true;
                }
            }
            if (resolved) return .clean;
        }
        var found = false;
        for (self.roots) |root| {
            if (try self.searchByName(root, std.fs.path.basename(path))) |v| {
                if (v != .clean) return v;
                found = true;
            }
        }
        if (found) return .clean;
        return if (looksLikePath(path)) .unverifiable else .clean;
    }
};

pub fn blockJson(a: std.mem.Allocator, reason: []const u8) ![]u8 {
    const prefixed = try std.fmt.allocPrint(a, "sumi: {s}", .{reason});
    defer a.free(prefixed);
    const quoted = try jsonio.quoteString(a, prefixed);
    defer a.free(quoted);
    return std.fmt.allocPrint(a, "{{\"decision\":\"block\",\"reason\":{s},\"hookSpecificOutput\":{{\"hookEventName\":\"UserPromptSubmit\",\"suppressOriginalPrompt\":true}}}}", .{quoted});
}

fn emitBlock(a: std.mem.Allocator, reason: []const u8, output: Output) !void {
    const rendered = blockJson(a, reason) catch return output.write(FALLBACK_BLOCK);
    defer a.free(rendered);
    return output.write(rendered);
}

fn writeStdout(_: *anyopaque, bytes: []const u8) !void {
    return jsonio.writeStdout(bytes);
}

fn block(a: std.mem.Allocator, reason: []const u8) u8 {
    var output_context: u8 = 0;
    emitBlock(a, reason, .{ .context = &output_context, .writeFn = writeStdout }) catch {
        std.debug.print("sumi: prompt could not write its block decision\n", .{});
    };
    return 0;
}

const HookArgs = struct {
    secrets_file: []const u8,
    roots: []const []const u8,
    deny_paths: []const []const u8,

    fn deinit(self: *HookArgs, a: std.mem.Allocator) void {
        a.free(self.roots);
        a.free(self.deny_paths);
        self.* = undefined;
    }
};

fn parseArgs(a: std.mem.Allocator, args: []const []const u8) !HookArgs {
    var secrets_file: ?[]const u8 = null;
    var roots: std.ArrayList([]const u8) = .empty;
    errdefer roots.deinit(a);
    var deny_paths: std.ArrayList([]const u8) = .empty;
    errdefer deny_paths.deinit(a);

    var i: usize = 0;
    while (i < args.len) : (i += 2) {
        const name = args[i];
        const known = std.mem.eql(u8, name, "--secrets-file") or std.mem.eql(u8, name, "--root") or std.mem.eql(u8, name, "--deny-path");
        if (!known) return error.UnknownOption;
        if (i + 1 == args.len or std.mem.startsWith(u8, args[i + 1], "--")) return error.MissingOptionValue;
        const value = args[i + 1];
        if (std.mem.eql(u8, name, "--secrets-file")) {
            if (secrets_file != null) return error.DuplicateOption;
            secrets_file = value;
        } else if (std.mem.eql(u8, name, "--root")) {
            try roots.append(a, value);
        } else {
            try deny_paths.append(a, value);
        }
    }
    const path = secrets_file orelse return error.MissingSecretsFile;
    const root_slice = try roots.toOwnedSlice(a);
    errdefer a.free(root_slice);
    const deny_slice = try deny_paths.toOwnedSlice(a);
    return .{ .secrets_file = path, .roots = root_slice, .deny_paths = deny_slice };
}

fn freeTokens(a: std.mem.Allocator, tokens: []const []const u8) void {
    for (tokens) |token| a.free(token);
    a.free(tokens);
}

fn onDeadline(_: i32) callconv(.c) void {
    _ = std.c.write(std.posix.STDOUT_FILENO, DEADLINE_BLOCK.ptr, DEADLINE_BLOCK.len);
    std.c._exit(0);
}

pub fn main(a: std.mem.Allocator, args: []const []const u8) !u8 {
    var parsed_args = parseArgs(a, args) catch |err| switch (err) {
        error.OutOfMemory => return block(a, "the prompt hook ran out of memory"),
        else => return cli.usage("invalid prompt arguments"),
    };
    defer parsed_args.deinit(a);
    const started = std.time.milliTimestamp();
    const secrets_path = parsed_args.secrets_file;
    const deadline_action: std.posix.Sigaction = .{
        .handler = .{ .handler = onDeadline },
        .mask = std.posix.sigemptyset(),
        .flags = 0,
    };
    var previous_action: std.posix.Sigaction = undefined;
    std.posix.sigaction(std.posix.SIG.ALRM, &deadline_action, &previous_action);
    _ = std.c.alarm(@intCast((DEADLINE_MS + 999) / 1000));
    defer {
        _ = std.c.alarm(0);
        std.posix.sigaction(std.posix.SIG.ALRM, &previous_action, null);
    }
    const deadline = started + DEADLINE_MS;
    const text = jsonio.readStdin(a) catch return block(a, "the hook payload could not be read");
    defer a.free(text);
    if (text.len == 0) return block(a, "the hook payload is not valid JSON");
    var parsed = jsonio.parse(a, text) catch return block(a, "the hook payload is not valid JSON");
    defer parsed.deinit();
    const prompt = jsonio.getString(parsed.value, "prompt") orelse return block(a, "the hook payload has no prompt");
    const values = secret_file.load(a, secrets_path) catch |err| return block(a, secret_file.describe(err));
    defer a.free(values);
    if (prompt.len == 0) return 0;
    if (std.time.milliTimestamp() >= deadline) return block(a, "the prompt could not be checked before the deadline");
    var roots: std.ArrayList([]const u8) = .empty;
    defer roots.deinit(a);
    const cwd = jsonio.getString(parsed.value, "cwd") orelse ".";
    roots.append(a, if (cwd.len == 0) "." else cwd) catch return block(a, "the prompt hook ran out of memory");
    for (parsed_args.roots) |root| roots.append(a, root) catch return block(a, "the prompt hook ran out of memory");
    const checker = Checker{ .allocator = a, .roots = roots.items, .deny_paths = parsed_args.deny_paths, .secrets = values, .deadline_ms = deadline };
    const attachments = extractTokens(a, prompt) catch return block(a, "the prompt attachments could not be parsed");
    defer freeTokens(a, attachments);
    for (attachments) |token| {
        const verdict = checker.check(token) catch return block(a, "an attachment could not be checked");
        const reason = switch (verdict) {
            .clean => continue,
            .holds_value => "an attachment was rejected because it holds a protected value." ++ TAIL,
            .denied_name => "an attachment was rejected because its name is on the deny list." ++ TAIL,
            .mcp_resource => "an MCP resource attachment was rejected because it cannot be checked here. Read it with the ReadMcpResource tool instead, whose output is masked.",
            .unverifiable => "an attachment was rejected because its content could not be verified." ++ TAIL,
        };
        return block(a, reason);
    }
    if (checker.expired()) return block(a, "the prompt could not be checked before the deadline");
    if (mask.containsAny(prompt, values)) return block(a, "this prompt carries a protected value. A prompt cannot be masked in place, so it was not submitted.");
    if (checker.expired()) return block(a, "the prompt could not be checked before the deadline");
    return 0;
}

const testing = std.testing;

test "parseArgs: prompt consumes all options and keeps repeated policy values" {
    var got = try parseArgs(testing.allocator, &.{ "--root", "/a", "--secrets-file", "/s", "--deny-path", "x", "--root", "/b" });
    defer got.deinit(testing.allocator);
    try testing.expectEqualStrings("/s", got.secrets_file);
    try testing.expectEqualSlices([]const u8, &.{ "/a", "/b" }, got.roots);
    try testing.expectEqualSlices([]const u8, &.{"x"}, got.deny_paths);

    try testing.expectError(error.DuplicateOption, parseArgs(testing.allocator, &.{ "--secrets-file", "/s", "--secrets-file", "/other" }));
    try testing.expectError(error.UnknownOption, parseArgs(testing.allocator, &.{ "--secrets-file", "/s", "--wat", "x" }));
    try testing.expectError(error.MissingOptionValue, parseArgs(testing.allocator, &.{ "--secrets-file", "/s", "--deny-path" }));
    try testing.expectError(error.UnknownOption, parseArgs(testing.allocator, &.{ "--secrets-file", "/s", "stray" }));
}

test "extractTokens: attachments and escaped spaces" {
    const got = try extractTokens(testing.allocator, "see @a.txt and @dir/b\\ c.md but not user@example.com");
    defer freeTokens(testing.allocator, got);
    try testing.expectEqual(@as(usize, 2), got.len);
    try testing.expectEqualStrings("a.txt", got[0]);
    try testing.expectEqualStrings("dir/b c.md", got[1]);
}

test "extractTokens: lone marker yields nothing" {
    const got = try extractTokens(testing.allocator, "nothing @ ");
    defer freeTokens(testing.allocator, got);
    try testing.expectEqual(@as(usize, 0), got.len);
}

test "path and MCP resource recognition" {
    try testing.expect(looksLikePath("src/main.zig"));
    try testing.expect(looksLikePath("gone.java"));
    try testing.expect(!looksLikePath("gone.properties"));
    try testing.expect(!looksLikePath("Override"));
    try testing.expect(!looksLikePath("v1.2.3"));
    try testing.expect(!looksLikePath("file.12345"));
    try testing.expect(isMcpResource("github:repo://owner/name"));
    try testing.expect(isMcpResource("https://example.invalid"));
}

test "expandHome: only leading home marker expands" {
    const expanded = try expandHome(testing.allocator, "~/notes.md", "/home/u");
    defer testing.allocator.free(expanded);
    try testing.expectEqualStrings("/home/u/notes.md", expanded);
    const same = try expandHome(testing.allocator, "x/~/y", "/home/u");
    defer testing.allocator.free(same);
    try testing.expectEqualStrings("x/~/y", same);
}

test "Checker: real files, missing paths, and plain names" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(.{ .sub_path = "holds.java", .data = "db.password=Tr0ub4dor\n" });
    try tmp.dir.writeFile(.{ .sub_path = "clean.java", .data = "nothing\n" });
    const root = try tmp.dir.realpathAlloc(testing.allocator, ".");
    defer testing.allocator.free(root);
    const c = Checker{ .allocator = testing.allocator, .roots = &.{root}, .deny_paths = &.{}, .secrets = &.{"Tr0ub4dor"}, .deadline_ms = std.time.milliTimestamp() + 15_000 };
    try testing.expectEqual(Verdict.holds_value, try c.check("holds.java"));
    try testing.expectEqual(Verdict.clean, try c.check("clean.java"));
    try testing.expectEqual(Verdict.unverifiable, try c.check("gone.java"));
    try testing.expectEqual(Verdict.clean, try c.check("Override"));
}

test "Checker: directory and basename search use real files" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.makePath("sub");
    try tmp.dir.writeFile(.{ .sub_path = "sub/nested.java", .data = "x=Tr0ub4dor\n" });
    const root = try tmp.dir.realpathAlloc(testing.allocator, ".");
    defer testing.allocator.free(root);
    const c = Checker{ .allocator = testing.allocator, .roots = &.{root}, .deny_paths = &.{}, .secrets = &.{"Tr0ub4dor"}, .deadline_ms = std.time.milliTimestamp() + 15_000 };
    try testing.expectEqual(Verdict.holds_value, try c.check("sub"));
    try testing.expectEqual(Verdict.holds_value, try c.check("elsewhere/nested.java"));
}

test "Checker: basename search does not descend past depth six" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.makePath("a/b/c/d/e");
    try tmp.dir.makePath("a/b/c/d/e/f");
    try tmp.dir.writeFile(.{ .sub_path = "a/b/c/d/e/target.java", .data = "clean\n" });
    try tmp.dir.writeFile(.{ .sub_path = "a/b/c/d/e/f/target.java", .data = "Tr0ub4dor\n" });
    const root = try tmp.dir.realpathAlloc(testing.allocator, ".");
    defer testing.allocator.free(root);
    const c = Checker{ .allocator = testing.allocator, .roots = &.{root}, .deny_paths = &.{}, .secrets = &.{"Tr0ub4dor"}, .deadline_ms = std.time.milliTimestamp() + 15_000 };
    try testing.expectEqual(Verdict.clean, try c.check("elsewhere/target.java"));
}

test "Checker: deny list and MCP reject before lookup" {
    const c = Checker{ .allocator = testing.allocator, .roots = &.{"/nonexistent"}, .deny_paths = &.{"app.properties"}, .secrets = &.{"Tr0ub4dor"}, .deadline_ms = std.time.milliTimestamp() + 15_000 };
    try testing.expectEqual(Verdict.denied_name, try c.check("config/app.properties"));
    try testing.expectEqual(Verdict.mcp_resource, try c.check("github:repo://o/n"));
}

test "Checker: expired deadlines reject every token" {
    const c = Checker{ .allocator = testing.allocator, .roots = &.{"/"}, .deny_paths = &.{}, .secrets = &.{"Tr0ub4dor"}, .deadline_ms = std.time.milliTimestamp() - 1 };
    try testing.expectEqual(Verdict.unverifiable, try c.check("Override"));
}

test "Checker: unreadable file-like target is unverifiable" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.symLink("missing-target", "broken.java", .{});
    const root = try tmp.dir.realpathAlloc(testing.allocator, ".");
    defer testing.allocator.free(root);
    const c = Checker{ .allocator = testing.allocator, .roots = &.{root}, .deny_paths = &.{}, .secrets = &.{"Tr0ub4dor"}, .deadline_ms = std.time.milliTimestamp() + 15_000 };
    try testing.expectEqual(Verdict.unverifiable, try c.check("broken.java"));
}

test "blockJson: Claude prompt suppression decision" {
    const output = try blockJson(testing.allocator, "this prompt carries a protected value");
    defer testing.allocator.free(output);
    try testing.expectEqualStrings("{\"decision\":\"block\",\"reason\":\"sumi: this prompt carries a protected value\",\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"suppressOriginalPrompt\":true}}", output);
}

const FailingOutput = struct {
    calls: usize = 0,
    partial_bytes: usize = 0,
    received_fallback: bool = false,

    fn write(context: *anyopaque, bytes: []const u8) anyerror!void {
        const self: *FailingOutput = @ptrCast(@alignCast(context));
        self.calls += 1;
        self.partial_bytes += @min(bytes.len, 7);
        self.received_fallback = std.mem.eql(u8, bytes, FALLBACK_BLOCK);
        return error.BrokenPipe;
    }
};

test "block output does not retry after a partial rendered decision" {
    var sink = FailingOutput{};
    try testing.expectError(error.BrokenPipe, emitBlock(testing.allocator, "reason", .{ .context = &sink, .writeFn = FailingOutput.write }));
    try testing.expectEqual(@as(usize, 1), sink.calls);
    try testing.expect(sink.partial_bytes > 0);
    try testing.expect(!sink.received_fallback);
}

test "block output reports a failed static fallback without retrying" {
    var sink = FailingOutput{};
    try testing.expectError(error.BrokenPipe, emitBlock(testing.failing_allocator, "reason", .{ .context = &sink, .writeFn = FailingOutput.write }));
    try testing.expectEqual(@as(usize, 1), sink.calls);
    try testing.expect(sink.received_fallback);
}
