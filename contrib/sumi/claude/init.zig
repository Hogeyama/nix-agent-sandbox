//! Install and verify the Claude Code hooks used by `sumi`.
const std = @import("std");
const jsonio = @import("../jsonio.zig");
const shell = @import("../shell.zig");
const secrets = @import("../secrets.zig");
const cli = @import("../main.zig");

pub const HOOK_TIMEOUT: i64 = 20;
pub const HookEntries = struct { pre_bash: []const u8, post_tool: []const u8, prompt: []const u8 };

pub fn formatTimestamp(buf: *[14]u8, secs: u64) []const u8 {
    const es = std.time.epoch.EpochSeconds{ .secs = secs };
    const yd = es.getEpochDay().calculateYearDay();
    const md = yd.calculateMonthDay();
    const ds = es.getDaySeconds();
    return std.fmt.bufPrint(buf, "{d:0>4}{d:0>2}{d:0>2}{d:0>2}{d:0>2}{d:0>2}", .{ yd.year, md.month.numeric(), md.day_index + 1, ds.getHoursIntoDay(), ds.getMinutesIntoHour(), ds.getSecondsIntoMinute() }) catch unreachable;
}

fn firstWord(command: []const u8, buf: []u8) ?struct { word: []const u8, rest: []const u8 } {
    var i: usize = 0;
    var n: usize = 0;
    var quoted = false;
    while (i < command.len) {
        const c = command[i];
        if (!quoted and (c == ' ' or c == '\t')) break;
        if (c == '\'') {
            quoted = !quoted;
            i += 1;
            continue;
        }
        if (!quoted and c == '\\') {
            i += 1;
            if (i == command.len) return null;
        }
        if (n == buf.len) return null;
        buf[n] = command[i];
        n += 1;
        i += 1;
    }
    if (quoted or n == 0) return null;
    return .{ .word = buf[0..n], .rest = command[i..] };
}

pub fn isOwnEntry(command: []const u8, self_basename: []const u8) bool {
    var buf: [std.fs.max_path_bytes]u8 = undefined;
    const got = firstWord(command, &buf) orelse return false;
    if (!std.mem.eql(u8, std.fs.path.basename(got.word), self_basename)) return false;
    const rest = std.mem.trimLeft(u8, got.rest, " \t");
    return std.mem.startsWith(u8, rest, "hook") and (rest.len == 4 or rest[4] == ' ' or rest[4] == '\t');
}

fn makeEntry(allocator: std.mem.Allocator, command: []const u8, matcher: ?[]const u8) !std.json.Value {
    var hook = std.json.ObjectMap.init(allocator);
    try hook.put("type", .{ .string = "command" });
    try hook.put("command", .{ .string = command });
    try hook.put("timeout", .{ .integer = HOOK_TIMEOUT });
    var list = std.json.Array.init(allocator);
    try list.append(.{ .object = hook });
    var entry = std.json.ObjectMap.init(allocator);
    if (matcher) |value| try entry.put("matcher", .{ .string = value });
    try entry.put("hooks", .{ .array = list });
    return .{ .object = entry };
}

fn validateSettings(settings: std.json.Value) !void {
    if (settings != .object) return error.SettingsMustBeObject;
    const hooks = settings.object.get("hooks") orelse return;
    if (hooks != .object) return error.HooksMustBeObject;
    for (hooks.object.values()) |event| {
        if (event != .array) return error.EventMustBeArray;
        for (event.array.items) |entry| {
            if (entry != .object) return error.EntryMustBeObject;
            if (entry.object.get("hooks")) |list| if (list != .array) return error.EntryHooksMustBeArray;
        }
    }
}

fn mergeEvent(allocator: std.mem.Allocator, hooks: *std.json.ObjectMap, event_name: []const u8, basename: []const u8, command: []const u8, matcher: ?[]const u8) !usize {
    var entries = std.json.Array.init(allocator);
    var removed: usize = 0;
    if (hooks.get(event_name)) |event| for (event.array.items) |original| {
        var entry = original;
        const list_value = entry.object.getPtr("hooks") orelse {
            try entries.append(entry);
            continue;
        };
        var list = std.json.Array.init(allocator);
        for (list_value.array.items) |hook| {
            const value = if (hook == .object) hook.object.get("command") else null;
            if (value != null and value.? == .string and isOwnEntry(value.?.string, basename)) removed += 1 else try list.append(hook);
        }
        if (list.items.len != 0) {
            list_value.* = .{ .array = list };
            try entries.append(entry);
        }
    };
    try entries.append(try makeEntry(allocator, command, matcher));
    try hooks.put(event_name, .{ .array = entries });
    return removed;
}

pub fn mergeHooks(allocator: std.mem.Allocator, settings: *std.json.Value, basename: []const u8, commands: HookEntries) !usize {
    try validateSettings(settings.*);
    try settings.object.put("disableAllHooks", .{ .bool = false });
    if (settings.object.get("hooks") == null) try settings.object.put("hooks", .{ .object = std.json.ObjectMap.init(allocator) });
    const hooks = &settings.object.getPtr("hooks").?.object;
    var removed: usize = 0;
    removed += try mergeEvent(allocator, hooks, "PreToolUse", basename, commands.pre_bash, "Bash");
    removed += try mergeEvent(allocator, hooks, "PostToolUse", basename, commands.post_tool, null);
    removed += try mergeEvent(allocator, hooks, "PostToolUseFailure", basename, commands.post_tool, null);
    removed += try mergeEvent(allocator, hooks, "UserPromptSubmit", basename, commands.prompt, null);
    return removed;
}

pub fn buildCommands(allocator: std.mem.Allocator, self_path: []const u8, secrets_file: []const u8, shell_path: []const u8, roots: []const []const u8, deny_paths: []const []const u8) !HookEntries {
    const pre = try shell.join(allocator, &.{ self_path, "hook", "--agent", "claude", "pre-bash", "--secrets-file", secrets_file, "--shell", shell_path });
    const post = try shell.join(allocator, &.{ self_path, "hook", "--agent", "claude", "post-tool", "--secrets-file", secrets_file });
    var argv: std.ArrayList([]const u8) = .empty;
    defer argv.deinit(allocator);
    try argv.appendSlice(allocator, &.{ self_path, "hook", "--agent", "claude", "prompt", "--secrets-file", secrets_file });
    for (roots) |root| try argv.appendSlice(allocator, &.{ "--root", root });
    for (deny_paths) |path| try argv.appendSlice(allocator, &.{ "--deny-path", path });
    return .{ .pre_bash = pre, .post_tool = post, .prompt = try shell.join(allocator, argv.items) };
}

pub fn defaultSettingsPath(allocator: std.mem.Allocator, config_dir: ?[]const u8, home: []const u8) ![]u8 {
    if (config_dir) |dir| return std.fs.path.join(allocator, &.{ dir, "settings.json" });
    return std.fs.path.join(allocator, &.{ home, ".claude", "settings.json" });
}

fn executableFile(path: []const u8) bool {
    const file = std.fs.cwd().openFile(path, .{}) catch return false;
    defer file.close();
    if ((file.stat() catch return false).kind != .file) return false;
    std.posix.access(path, std.posix.X_OK) catch return false;
    return true;
}

pub fn resolveShell(allocator: std.mem.Allocator) !?[]u8 {
    const path = std.posix.getenv("PATH") orelse return null;
    var it = std.mem.splitScalar(u8, path, ':');
    while (it.next()) |dir| {
        if (dir.len == 0) continue;
        const candidate = try std.fs.path.join(allocator, &.{ dir, "bash" });
        defer allocator.free(candidate);
        const absolute = std.fs.cwd().realpathAlloc(allocator, candidate) catch continue;
        if (executableFile(absolute)) return absolute;
        allocator.free(absolute);
    }
    return null;
}

fn fail(message: []const u8) u8 {
    std.debug.print("sumi: {s}\n", .{message});
    return 1;
}

fn usage(message: []const u8) u8 {
    std.debug.print(
        "sumi: {s}\nusage: sumi init --agent claude --secrets-file F [--root DIR]... [--deny-path P]... [--settings FILE] [--shell PATH]\n",
        .{message},
    );
    return cli.EXIT_USAGE;
}
fn warn(message: []const u8) void {
    std.debug.print("sumi: warning: {s}\n", .{message});
}

fn runHook(allocator: std.mem.Allocator, command: []const u8, input: []const u8) !struct { code: u8, stdout: []u8 } {
    var child = std.process.Child.init(&.{ "sh", "-c", command }, allocator);
    child.stdin_behavior = .Pipe;
    child.stdout_behavior = .Pipe;
    child.stderr_behavior = .Pipe;
    try child.spawn();
    errdefer _ = child.kill() catch null;
    try child.stdin.?.writeAll(input);
    child.stdin.?.close();
    child.stdin = null;
    var out: std.ArrayList(u8) = .empty;
    var err: std.ArrayList(u8) = .empty;
    defer err.deinit(allocator);
    try child.collectOutput(allocator, &out, &err, 16 * 1024 * 1024);
    const term = try child.wait();
    return .{ .code = switch (term) {
        .Exited => |code| code,
        else => 1,
    }, .stdout = try out.toOwnedSlice(allocator) };
}

fn octalLine(allocator: std.mem.Allocator, bytes: []const u8) ![]u8 {
    const encoded = try allocator.alloc(u8, bytes.len * 4 + 1);
    for (bytes, 0..) |byte, i| {
        encoded[i * 4] = '\\';
        encoded[i * 4 + 1] = '0' + (byte >> 6);
        encoded[i * 4 + 2] = '0' + ((byte >> 3) & 7);
        encoded[i * 4 + 3] = '0' + (byte & 7);
    }
    encoded[encoded.len - 1] = '\n';
    return encoded;
}

fn validatePostOutput(allocator: std.mem.Allocator, probe: []const u8, output: []const u8) !void {
    if (output.len == 0) {
        if (std.mem.allEqual(u8, probe, '*')) return;
        return error.PostToolCheckFailed;
    }
    var parsed = jsonio.parse(allocator, output) catch return error.PostToolCheckFailed;
    defer parsed.deinit();
    const specific = jsonio.getObject(parsed.value, "hookSpecificOutput") orelse return error.PostToolCheckFailed;
    const masked = jsonio.getString(.{ .object = specific.* }, "updatedToolOutput") orelse return error.PostToolCheckFailed;
    if (masked.len != probe.len or !std.mem.allEqual(u8, masked, '*')) return error.PostToolCheckFailed;
}

fn validateWithholdingDecision(allocator: std.mem.Allocator, output: []const u8) !void {
    var parsed = jsonio.parse(allocator, output) catch return error.PostToolCheckFailed;
    defer parsed.deinit();
    const specific = jsonio.getObject(parsed.value, "hookSpecificOutput") orelse return error.PostToolCheckFailed;
    const event = jsonio.getString(.{ .object = specific.* }, "hookEventName") orelse return error.PostToolCheckFailed;
    if (!std.mem.eql(u8, event, "PostToolUse")) return error.PostToolCheckFailed;
    _ = jsonio.getString(.{ .object = specific.* }, "updatedToolOutput") orelse return error.PostToolCheckFailed;
}

fn selectProbe(values: []const []const u8) []const u8 {
    for (values) |value| if (!std.mem.allEqual(u8, value, '*')) return value;
    return values[0];
}

fn selfCheck(allocator: std.mem.Allocator, commands: HookEntries, probe: []const u8) !void {
    const quoted = try jsonio.quoteString(allocator, probe);
    const payload = try std.fmt.allocPrint(allocator, "{{\"hook_event_name\":\"PostToolUse\",\"tool_response\":{s}}}", .{quoted});
    const post = try runHook(allocator, commands.post_tool, payload);
    if (post.code != 0) return error.PostToolCheckFailed;
    try validatePostOutput(allocator, probe, post.stdout);
    if (std.mem.allEqual(u8, probe, '*')) {
        const malformed = try runHook(allocator, commands.post_tool, "");
        if (malformed.code != 0) return error.PostToolCheckFailed;
        try validateWithholdingDecision(allocator, malformed.stdout);
    }

    const synthetic = "IFS= read -r sumi_probe; printf '%b' \"$sumi_probe\"; exit 3";
    const synthetic_json = try jsonio.quoteString(allocator, synthetic);
    const pre_payload = try std.fmt.allocPrint(allocator, "{{\"tool_input\":{{\"command\":{s}}}}}", .{synthetic_json});
    const pre = try runHook(allocator, commands.pre_bash, pre_payload);
    if (pre.code != 0) return error.PreBashCheckFailed;
    var parsed = jsonio.parse(allocator, pre.stdout) catch return error.PreBashCheckFailed;
    defer parsed.deinit();
    const specific = jsonio.getObject(parsed.value, "hookSpecificOutput") orelse return error.PreBashCheckFailed;
    const updated = specific.get("updatedInput") orelse return error.PreBashCheckFailed;
    const wrapped = jsonio.getString(updated, "command") orelse return error.PreBashCheckFailed;
    const encoded_probe = try octalLine(allocator, probe);
    const ran = try runHook(allocator, wrapped, encoded_probe);
    if (ran.code != 3 or ran.stdout.len != probe.len or !std.mem.allEqual(u8, ran.stdout, '*')) return error.WrappedCommandCheckFailed;
    const prompt = try runHook(allocator, commands.prompt, "{\"prompt\":\"\",\"cwd\":\"/\"}");
    if (prompt.code != 0 or prompt.stdout.len != 0) return error.PromptCheckFailed;
}

const InitArgs = struct {
    secrets_file: []const u8,
    roots: []const []const u8,
    deny_paths: []const []const u8,
    settings: ?[]const u8,
    shell_path: ?[]const u8,
};

fn parseArgs(allocator: std.mem.Allocator, args: []const []const u8) !InitArgs {
    var secrets_file: ?[]const u8 = null;
    var settings: ?[]const u8 = null;
    var shell_path: ?[]const u8 = null;
    var roots: std.ArrayList([]const u8) = .empty;
    var deny_paths: std.ArrayList([]const u8) = .empty;
    var i: usize = 0;
    while (i < args.len) : (i += 2) {
        const name = args[i];
        if (i + 1 == args.len or std.mem.startsWith(u8, args[i + 1], "--")) return error.MissingOptionValue;
        const value = args[i + 1];
        if (std.mem.eql(u8, name, "--secrets-file")) {
            if (secrets_file != null) return error.DuplicateOption;
            secrets_file = value;
        } else if (std.mem.eql(u8, name, "--root")) {
            try roots.append(allocator, value);
        } else if (std.mem.eql(u8, name, "--deny-path")) {
            try deny_paths.append(allocator, value);
        } else if (std.mem.eql(u8, name, "--settings")) {
            if (settings != null) return error.DuplicateOption;
            settings = value;
        } else if (std.mem.eql(u8, name, "--shell")) {
            if (shell_path != null) return error.DuplicateOption;
            shell_path = value;
        } else return error.UnknownOption;
    }
    return .{
        .secrets_file = secrets_file orelse return error.MissingSecretsFile,
        .roots = try roots.toOwnedSlice(allocator),
        .deny_paths = try deny_paths.toOwnedSlice(allocator),
        .settings = settings,
        .shell_path = shell_path,
    };
}

fn backup(allocator: std.mem.Allocator, path: []const u8, stamp: []const u8, data: []const u8) ![]u8 {
    var suffix: usize = 0;
    while (true) : (suffix += 1) {
        const candidate = if (suffix == 0) try std.fmt.allocPrint(allocator, "{s}.bak.{s}", .{ path, stamp }) else try std.fmt.allocPrint(allocator, "{s}.bak.{s}.{d}", .{ path, stamp, suffix });
        const file = std.fs.cwd().createFile(candidate, .{ .exclusive = true, .mode = 0o600 }) catch |err| switch (err) {
            error.PathAlreadyExists => continue,
            else => return err,
        };
        errdefer std.fs.cwd().deleteFile(candidate) catch {};
        try file.writeAll(data);
        file.close();
        return candidate;
    }
}

pub fn main(allocator: std.mem.Allocator, args: []const []const u8, self_path: []const u8) !u8 {
    const parsed_args = parseArgs(allocator, args) catch |err| switch (err) {
        error.OutOfMemory => return err,
        else => return usage("invalid arguments"),
    };
    const secret_arg = parsed_args.secrets_file;
    const values = secrets.load(allocator, secret_arg) catch |err| return fail(secrets.describe(err));
    const secret_path = std.fs.cwd().realpathAlloc(allocator, secret_arg) catch return fail("the secrets file path could not be resolved");
    const secret_file = std.fs.cwd().openFile(secret_path, .{}) catch return fail("the secrets file could not be opened");
    defer secret_file.close();
    const mode = (secret_file.stat() catch return fail("the secrets file could not be inspected")).mode & 0o777;
    if (mode != 0o600 and mode != 0o640 and mode != 0o400) warn("the secrets file is not mode 0600/0640/0400; other users may read it");
    const home = std.posix.getenv("HOME") orelse return fail("HOME is not set");
    const downloads = try std.fs.path.join(allocator, &.{ home, "Downloads" });
    const tmpdir = std.posix.getenv("TMPDIR") orelse "/tmp";
    if (std.mem.startsWith(u8, self_path, "/tmp/") or std.mem.startsWith(u8, self_path, tmpdir) or std.mem.startsWith(u8, self_path, downloads)) warn("this binary may be removed or moved; install it permanently and rerun init");
    const shell_path = if (parsed_args.shell_path) |path| (std.fs.cwd().realpathAlloc(allocator, path) catch return fail("the shell given by --shell does not exist")) else ((try resolveShell(allocator)) orelse return fail("bash was not found on PATH; pass --shell"));
    if (!executableFile(shell_path)) return fail("the shell is not a regular executable file");
    const settings_path = if (parsed_args.settings) |path| try allocator.dupe(u8, path) else try defaultSettingsPath(allocator, std.posix.getenv("CLAUDE_CONFIG_DIR"), home);
    const existing = std.fs.cwd().readFileAlloc(allocator, settings_path, 16 * 1024 * 1024) catch |err| switch (err) {
        error.FileNotFound => null,
        else => return fail("the settings file could not be read"),
    };
    var parsed = jsonio.parse(allocator, existing orelse "{}") catch return fail("the settings file is not valid JSON");
    defer parsed.deinit();
    validateSettings(parsed.value) catch return fail("the settings file has an incompatible hooks structure");
    const commands = try buildCommands(allocator, self_path, secret_path, shell_path, parsed_args.roots, parsed_args.deny_paths);
    const removed = try mergeHooks(parsed.arena.allocator(), &parsed.value, std.fs.path.basename(self_path), commands);
    var backup_path: ?[]u8 = null;
    if (existing) |data| {
        var ts: [14]u8 = undefined;
        backup_path = backup(allocator, settings_path, formatTimestamp(&ts, @intCast(std.time.timestamp())), data) catch return fail("the backup could not be written");
    }
    const output = try jsonio.stringifyPretty(allocator, parsed.value);
    if (std.fs.path.dirname(settings_path)) |dir| std.fs.cwd().makePath(dir) catch return fail("the settings directory could not be created");
    std.fs.cwd().writeFile(.{ .sub_path = settings_path, .data = output }) catch return fail("the settings file could not be written");
    std.debug.print("sumi: hooks written to {s}\n", .{settings_path});
    if (removed != 0) std.debug.print("sumi: replaced {d} existing sumi hook(s)\n", .{removed});
    if (backup_path) |path| std.debug.print("sumi: backup at {s}\n", .{path});
    selfCheck(allocator, commands, selectProbe(values)) catch |err| {
        std.debug.print("sumi: self-check failed ({s}); settings were written", .{@errorName(err)});
        if (backup_path) |path| std.debug.print("; restore {s}", .{path});
        std.debug.print("\n", .{});
        return 1;
    };
    return 0;
}

const testing = std.testing;
test "formatTimestamp: YYYYmmddHHMMSS in UTC" {
    var buf: [14]u8 = undefined;
    try testing.expectEqualStrings("20260911033337", formatTimestamp(&buf, 1789097617));
}
test "backup: mode 0600 is preserved under umask 022" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const root = try tmp.dir.realpathAlloc(testing.allocator, ".");
    defer testing.allocator.free(root);
    const settings_path = try std.fs.path.join(testing.allocator, &.{ root, "settings.json" });
    defer testing.allocator.free(settings_path);

    const old_umask = std.c.umask(0o022);
    defer _ = std.c.umask(old_umask);
    const backup_path = try backup(testing.allocator, settings_path, "20260911033337", "private");
    defer testing.allocator.free(backup_path);
    const file = try std.fs.cwd().openFile(backup_path, .{});
    defer file.close();
    try testing.expectEqual(@as(u32, 0o600), (try file.stat()).mode & 0o777);
}
test "isOwnEntry: parses shell.join quoting" {
    try testing.expect(isOwnEntry("/opt/x/sumi hook --agent claude post-tool", "sumi"));
    try testing.expect(isOwnEntry("'/home/u/my tools/sumi' hook", "sumi"));
    try testing.expect(isOwnEntry("'/home/u/it'\\''s tools/sumi' hook", "sumi"));
    try testing.expect(!isOwnEntry("/opt/x/sumi run -- bash", "sumi"));
}
test "mergeHooks: keeps foreign hooks in mixed groups and is idempotent" {
    var parsed = try jsonio.parse(testing.allocator, "{\"theme\":\"dark\",\"hooks\":{\"PostToolUse\":[{\"matcher\":\"foreign\",\"hooks\":[{\"command\":\"prettier --write\"},{\"command\":\"/old/sumi hook post-tool\"}]}]}}");
    defer parsed.deinit();
    const commands = HookEntries{ .pre_bash = "/new/sumi hook pre-bash", .post_tool = "/new/sumi hook post-tool", .prompt = "/new/sumi hook prompt" };
    try testing.expectEqual(@as(usize, 1), try mergeHooks(parsed.arena.allocator(), &parsed.value, "sumi", commands));
    try testing.expectEqual(@as(usize, 4), try mergeHooks(parsed.arena.allocator(), &parsed.value, "sumi", commands));
    const out = try jsonio.stringify(testing.allocator, parsed.value);
    defer testing.allocator.free(out);
    try testing.expect(std.mem.indexOf(u8, out, "prettier --write") != null);
    try testing.expect(std.mem.indexOf(u8, out, "\"matcher\":\"foreign\"") != null);
    try testing.expectEqual(@as(usize, 2), std.mem.count(u8, out, commands.post_tool));
}
test "mergeHooks: incompatible input is unchanged" {
    var parsed = try jsonio.parse(testing.allocator, "{\"theme\":\"dark\",\"hooks\":[]}");
    defer parsed.deinit();
    const commands = HookEntries{ .pre_bash = "a", .post_tool = "b", .prompt = "c" };
    try testing.expectError(error.HooksMustBeObject, mergeHooks(parsed.arena.allocator(), &parsed.value, "sumi", commands));
    try testing.expectEqualStrings("dark", parsed.value.object.get("theme").?.string);
}
test "buildCommands: routes and quotes options" {
    const got = try buildCommands(testing.allocator, "/opt/s/sumi", "/opt/s/secrets.txt", "/bin/bash", &.{"/extra dir"}, &.{"app.properties"});
    defer testing.allocator.free(got.pre_bash);
    defer testing.allocator.free(got.post_tool);
    defer testing.allocator.free(got.prompt);
    try testing.expectEqualStrings("/opt/s/sumi hook --agent claude pre-bash --secrets-file /opt/s/secrets.txt --shell /bin/bash", got.pre_bash);
    try testing.expectEqualStrings("/opt/s/sumi hook --agent claude prompt --secrets-file /opt/s/secrets.txt --root '/extra dir' --deny-path app.properties", got.prompt);
}
test "defaultSettingsPath: config directory or home" {
    const a = try defaultSettingsPath(testing.allocator, "/cfg", "/home/u");
    defer testing.allocator.free(a);
    try testing.expectEqualStrings("/cfg/settings.json", a);
    const b = try defaultSettingsPath(testing.allocator, null, "/home/u");
    defer testing.allocator.free(b);
    try testing.expectEqualStrings("/home/u/.claude/settings.json", b);
}
test "parseArgs: accepts and collects every init option" {
    const got = try parseArgs(testing.allocator, &.{ "--root", "/a", "--secrets-file", "/s", "--deny-path", "x", "--root", "/b", "--settings", "/cfg", "--shell", "/bin/sh" });
    defer testing.allocator.free(got.roots);
    defer testing.allocator.free(got.deny_paths);
    try testing.expectEqualStrings("/s", got.secrets_file);
    try testing.expectEqualSlices([]const u8, &.{ "/a", "/b" }, got.roots);
    try testing.expectEqualSlices([]const u8, &.{"x"}, got.deny_paths);
}
test "parseArgs: rejects missing values and unknown options" {
    try testing.expectError(error.MissingSecretsFile, parseArgs(testing.allocator, &.{}));
    inline for (&.{ "--secrets-file", "--root", "--deny-path", "--settings", "--shell" }) |option| {
        try testing.expectError(error.MissingOptionValue, parseArgs(testing.allocator, &.{ "--secrets-file", "/s", option }));
    }
    try testing.expectError(error.MissingOptionValue, parseArgs(testing.allocator, &.{ "--secrets-file", "--root", "/x" }));
    try testing.expectError(error.UnknownOption, parseArgs(testing.allocator, &.{ "--secrets-file", "/s", "--wat", "x" }));
    try testing.expectError(error.UnknownOption, parseArgs(testing.allocator, &.{ "--secrets-file", "/s", "stray", "x" }));
}
test "selectProbe: prefers a value whose masking changes bytes" {
    try testing.expectEqualStrings("secret", selectProbe(&.{ "***", "secret", "*****" }));
    try testing.expectEqualStrings("***", selectProbe(&.{ "***", "*****" }));
}
test "all-star post-tool check requires a withholding decision" {
    try validatePostOutput(testing.allocator, "***", "");
    try testing.expectError(error.PostToolCheckFailed, validateWithholdingDecision(testing.allocator, ""));
    try validateWithholdingDecision(testing.allocator,
        \\{"hookSpecificOutput":{"hookEventName":"PostToolUse","updatedToolOutput":"sumi: withheld"}}
    );
}
