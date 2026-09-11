//! Install and verify the Claude Code hooks used by `sumi`.
const std = @import("std");
const jsonio = @import("../jsonio.zig");
const shell = @import("../shell.zig");
const secrets = @import("../secrets.zig");
const cli = @import("../main.zig");

pub const HOOK_TIMEOUT: i64 = 20;
pub const ExecCommand = struct { command: []const u8, args: []const []const u8 };
pub const HookEntries = struct { post_tool: ExecCommand, prompt: ExecCommand };

pub fn formatTimestamp(buf: *[14]u8, secs: u64) []const u8 {
    const es = std.time.epoch.EpochSeconds{ .secs = secs };
    const yd = es.getEpochDay().calculateYearDay();
    const md = yd.calculateMonthDay();
    const ds = es.getDaySeconds();
    return std.fmt.bufPrint(buf, "{d:0>4}{d:0>2}{d:0>2}{d:0>2}{d:0>2}{d:0>2}", .{ yd.year, md.month.numeric(), md.day_index + 1, ds.getHoursIntoDay(), ds.getMinutesIntoHour(), ds.getSecondsIntoMinute() }) catch unreachable;
}

fn isOwnArgv(words: []const []const u8) bool {
    if (words.len < 4) return false;
    if (!std.mem.eql(u8, words[0], "hook") or !std.mem.eql(u8, words[1], "--agent") or !std.mem.eql(u8, words[2], "claude")) return false;
    return std.mem.eql(u8, words[3], "post-tool") or std.mem.eql(u8, words[3], "prompt");
}

fn isOwnHook(hook: std.json.Value, self_path: []const u8) bool {
    if (hook != .object) return false;
    const command = hook.object.get("command") orelse return false;
    if (command != .string or !std.mem.eql(u8, command.string, self_path)) return false;
    const args = hook.object.get("args") orelse return false;
    if (args != .array or args.array.items.len < 4) return false;
    var words: [4][]const u8 = undefined;
    for (args.array.items[0..4], 0..) |value, i| {
        if (value != .string) return false;
        words[i] = value.string;
    }
    return isOwnArgv(&words);
}

fn makeEntry(allocator: std.mem.Allocator, command: ExecCommand, matcher: ?[]const u8) !std.json.Value {
    var hook = std.json.ObjectMap.init(allocator);
    try hook.put("type", .{ .string = "command" });
    try hook.put("command", .{ .string = command.command });
    var args = std.json.Array.init(allocator);
    for (command.args) |arg| try args.append(.{ .string = arg });
    try hook.put("args", .{ .array = args });
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
    if (settings.object.get("env")) |env| if (env != .object) return error.EnvMustBeObject;
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

fn mergeEvent(allocator: std.mem.Allocator, hooks: *std.json.ObjectMap, event_name: []const u8, self_path: []const u8, command: ExecCommand, matcher: ?[]const u8) !usize {
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
            if (isOwnHook(hook, self_path)) removed += 1 else try list.append(hook);
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

pub fn mergeHooks(allocator: std.mem.Allocator, settings: *std.json.Value, self_path: []const u8, commands: HookEntries) !usize {
    try validateSettings(settings.*);
    try settings.object.put("disableAllHooks", .{ .bool = false });
    if (settings.object.get("hooks") == null) try settings.object.put("hooks", .{ .object = std.json.ObjectMap.init(allocator) });
    const hooks = &settings.object.getPtr("hooks").?.object;
    var removed: usize = 0;
    removed += try mergeEvent(allocator, hooks, "PostToolUse", self_path, commands.post_tool, null);
    removed += try mergeEvent(allocator, hooks, "PostToolUseFailure", self_path, commands.post_tool, null);
    removed += try mergeEvent(allocator, hooks, "UserPromptSubmit", self_path, commands.prompt, null);
    return removed;
}

pub fn buildCommands(allocator: std.mem.Allocator, self_path: []const u8, secret_path: []const u8, roots: []const []const u8, deny_paths: []const []const u8) !HookEntries {
    const post_args = try allocator.dupe([]const u8, &.{ "hook", "--agent", "claude", "post-tool", "--secrets-file", secret_path });
    errdefer allocator.free(post_args);
    var argv: std.ArrayList([]const u8) = .empty;
    defer argv.deinit(allocator);
    try argv.appendSlice(allocator, &.{ "hook", "--agent", "claude", "prompt", "--secrets-file", secret_path });
    for (roots) |root| try argv.appendSlice(allocator, &.{ "--root", root });
    for (deny_paths) |path| try argv.appendSlice(allocator, &.{ "--deny-path", path });
    return .{
        .post_tool = .{ .command = self_path, .args = post_args },
        .prompt = .{ .command = self_path, .args = try argv.toOwnedSlice(allocator) },
    };
}

pub fn defaultSettingsPath(allocator: std.mem.Allocator, config_dir: ?[]const u8, home: []const u8) ![]u8 {
    if (config_dir) |dir| return std.fs.path.join(allocator, &.{ dir, "settings.json" });
    return std.fs.path.join(allocator, &.{ home, ".claude", "settings.json" });
}

fn validateEnvironment(settings: std.json.Value, expected_prefix: []const u8) !void {
    const env = settings.object.get("env") orelse return;
    if (env != .object) return error.EnvMustBeObject;
    const prefix = env.object.get("CLAUDE_CODE_SHELL_PREFIX") orelse return;
    if (prefix != .string) return error.ForeignShellPrefix;
    if (prefix.string.len != 0 and !std.mem.eql(u8, prefix.string, expected_prefix)) return error.ForeignShellPrefix;
}

fn installEnvironment(allocator: std.mem.Allocator, settings: *std.json.Value, shell_path: []const u8, prefix: []const u8) !void {
    if (settings.object.get("env") == null) try settings.object.put("env", .{ .object = std.json.ObjectMap.init(allocator) });
    const env = &settings.object.getPtr("env").?.object;
    try env.put("CLAUDE_CODE_SHELL", .{ .string = shell_path });
    try env.put("CLAUDE_CODE_SHELL_PREFIX", .{ .string = prefix });
}

fn isSupportedClaudeShell(path: []const u8) bool {
    const name = std.fs.path.basename(path);
    return std.mem.eql(u8, name, "bash") or std.mem.eql(u8, name, "zsh");
}

fn quotePrefixArg(allocator: std.mem.Allocator, arg: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    try out.append(allocator, '\'');
    for (arg, 0..) |byte, i| {
        if (byte == '\'') {
            try out.appendSlice(allocator, "'\\''");
        } else if (byte == ' ' and i + 1 < arg.len and arg[i + 1] == '-') {
            try out.appendSlice(allocator, " ''");
        } else {
            try out.append(allocator, byte);
        }
    }
    try out.append(allocator, '\'');
    return out.toOwnedSlice(allocator);
}

fn formatShellPrefix(allocator: std.mem.Allocator, self_path: []const u8, secret_path: []const u8, shell_path: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(allocator, shell_path);
    try out.appendSlice(allocator, " -c");
    const args = [_][]const u8{ "exec \"$@\"", "sumi-prefix", self_path, "run", "--secrets-file", secret_path, "--shell", shell_path };
    for (&args) |arg| {
        try out.append(allocator, ' ');
        const quoted = try quotePrefixArg(allocator, arg);
        defer allocator.free(quoted);
        try out.appendSlice(allocator, quoted);
    }
    return out.toOwnedSlice(allocator);
}

fn formatClaudeInvocation(allocator: std.mem.Allocator, prefix: []const u8, command: []const u8) ![]u8 {
    // Claude Code 2.1.268 splits a prefix at its last literal ` -`, treats the
    // left side as the executable, leaves the suffix as arguments, and appends
    // the Bash command as one quoted argument. Prefix arguments are encoded so
    // the intended ` -c` is always that final delimiter.
    const split = std.mem.lastIndexOf(u8, prefix, " -") orelse return error.InvalidShellPrefix;
    if (split == 0 or split + 2 >= prefix.len) return error.InvalidShellPrefix;
    const executable = try quotePrefixArg(allocator, prefix[0..split]);
    defer allocator.free(executable);
    const quoted_command = try quotePrefixArg(allocator, command);
    defer allocator.free(quoted_command);
    return std.fmt.allocPrint(allocator, "{s} {s} {s}", .{ executable, prefix[split + 1 ..], quoted_command });
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

fn runCommand(allocator: std.mem.Allocator, command: ExecCommand, input: []const u8, env: *const std.process.EnvMap) !struct { code: u8, stdout: []u8 } {
    const argv = try allocator.alloc([]const u8, command.args.len + 1);
    defer allocator.free(argv);
    argv[0] = command.command;
    @memcpy(argv[1..], command.args);
    var child = std.process.Child.init(argv, allocator);
    child.env_map = env;
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

fn selfCheck(allocator: std.mem.Allocator, commands: HookEntries, self_path: []const u8, secret_path: []const u8, shell_path: []const u8, prefix: []const u8, probe: []const u8) !void {
    var env = try std.process.getEnvMap(allocator);
    defer env.deinit();
    try env.put("CLAUDE_CODE_SHELL", shell_path);
    try env.put("CLAUDE_CODE_SHELL_PREFIX", prefix);

    const quoted = try jsonio.quoteString(allocator, probe);
    const payload = try std.fmt.allocPrint(allocator, "{{\"hook_event_name\":\"PostToolUse\",\"tool_response\":{s}}}", .{quoted});
    const post = try runCommand(allocator, commands.post_tool, payload, &env);
    if (post.code != 0) return error.PostToolCheckFailed;
    try validatePostOutput(allocator, probe, post.stdout);
    if (std.mem.allEqual(u8, probe, '*')) {
        const malformed = try runCommand(allocator, commands.post_tool, "", &env);
        if (malformed.code != 0) return error.PostToolCheckFailed;
        try validateWithholdingDecision(allocator, malformed.stdout);
    }

    const synthetic = "IFS= read -r sumi_probe; printf '%b' \"$sumi_probe\"; exit 3";
    const expected_prefix = try formatShellPrefix(allocator, self_path, secret_path, shell_path);
    if (!std.mem.eql(u8, prefix, expected_prefix)) return error.PrefixCheckFailed;
    const invocation = try formatClaudeInvocation(allocator, prefix, synthetic);
    const run_args = [_][]const u8{ "-c", invocation };
    const encoded_probe = try octalLine(allocator, probe);
    const ran = try runCommand(allocator, .{ .command = shell_path, .args = &run_args }, encoded_probe, &env);
    if (ran.code != 3 or ran.stdout.len != probe.len or !std.mem.allEqual(u8, ran.stdout, '*')) return error.WrappedCommandCheckFailed;
    const prompt = try runCommand(allocator, commands.prompt, "{\"prompt\":\"\",\"cwd\":\"/\"}", &env);
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
    const shell_path = if (parsed_args.shell_path) |path| (std.fs.cwd().realpathAlloc(allocator, path) catch return fail("the shell given by --shell does not exist")) else ((try shell.resolveBash(allocator)) orelse return fail("bash was not found on PATH; pass --shell"));
    if (!shell.isExecutableFile(shell_path)) return fail("the shell is not a regular executable file");
    if (!isSupportedClaudeShell(shell_path)) return fail("the shell must be bash or zsh");
    const settings_path = if (parsed_args.settings) |path| try allocator.dupe(u8, path) else try defaultSettingsPath(allocator, std.posix.getenv("CLAUDE_CONFIG_DIR"), home);
    const existing = std.fs.cwd().readFileAlloc(allocator, settings_path, 16 * 1024 * 1024) catch |err| switch (err) {
        error.FileNotFound => null,
        else => return fail("the settings file could not be read"),
    };
    var parsed = jsonio.parse(allocator, existing orelse "{}") catch return fail("the settings file is not valid JSON");
    defer parsed.deinit();
    validateSettings(parsed.value) catch return fail("the settings file has an incompatible hooks structure");
    const prefix = try formatShellPrefix(allocator, self_path, secret_path, shell_path);
    validateEnvironment(parsed.value, prefix) catch return fail("CLAUDE_CODE_SHELL_PREFIX is already set by another tool; remove it or choose which prefix to keep");
    const commands = try buildCommands(allocator, self_path, secret_path, parsed_args.roots, parsed_args.deny_paths);
    const removed = try mergeHooks(parsed.arena.allocator(), &parsed.value, self_path, commands);
    try installEnvironment(parsed.arena.allocator(), &parsed.value, shell_path, prefix);
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
    selfCheck(allocator, commands, self_path, secret_path, shell_path, prefix, selectProbe(values)) catch |err| {
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
test "isOwnHook: recognizes current exec form only" {
    var exec = try jsonio.parse(testing.allocator, "{\"type\":\"command\",\"command\":\"/moved/renamed-masker\",\"args\":[\"hook\",\"--agent\",\"claude\",\"prompt\",\"--root\",\"/x\"]}");
    defer exec.deinit();
    try testing.expect(isOwnHook(exec.value, "/moved/renamed-masker"));
    try testing.expect(!isOwnHook(exec.value, "/other/renamed-masker"));

    var foreign = try jsonio.parse(testing.allocator, "{\"command\":\"/opt/sumi run\"}");
    defer foreign.deinit();
    try testing.expect(!isOwnHook(foreign.value, "/opt/sumi"));
}
test "mergeHooks: keeps foreign hooks in mixed groups and is idempotent" {
    var parsed = try jsonio.parse(testing.allocator, "{\"theme\":\"dark\",\"hooks\":{\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"command\":\"foreign-pre\"}]}],\"PostToolUse\":[{\"matcher\":\"foreign\",\"hooks\":[{\"command\":\"prettier --write\"},{\"type\":\"command\",\"command\":\"/new/sumi\",\"args\":[\"hook\",\"--agent\",\"claude\",\"post-tool\"]}]}]}}");
    defer parsed.deinit();
    const post_args = [_][]const u8{ "hook", "--agent", "claude", "post-tool" };
    const prompt_args = [_][]const u8{ "hook", "--agent", "claude", "prompt" };
    const commands = HookEntries{
        .post_tool = .{ .command = "/new/sumi", .args = &post_args },
        .prompt = .{ .command = "/new/sumi", .args = &prompt_args },
    };
    try testing.expectEqual(@as(usize, 1), try mergeHooks(parsed.arena.allocator(), &parsed.value, "/new/sumi", commands));
    try testing.expectEqual(@as(usize, 3), try mergeHooks(parsed.arena.allocator(), &parsed.value, "/new/sumi", commands));
    const out = try jsonio.stringify(testing.allocator, parsed.value);
    defer testing.allocator.free(out);
    try testing.expect(std.mem.indexOf(u8, out, "prettier --write") != null);
    try testing.expect(std.mem.indexOf(u8, out, "foreign-pre") != null);
    try testing.expect(std.mem.indexOf(u8, out, "\"matcher\":\"foreign\"") != null);
    try testing.expectEqual(@as(usize, 3), std.mem.count(u8, out, "\"command\":\"/new/sumi\""));
}
test "mergeHooks: incompatible input is unchanged" {
    var parsed = try jsonio.parse(testing.allocator, "{\"theme\":\"dark\",\"hooks\":[]}");
    defer parsed.deinit();
    const args = [_][]const u8{ "hook", "--agent", "claude", "post-tool" };
    const commands = HookEntries{ .post_tool = .{ .command = "a", .args = &args }, .prompt = .{ .command = "a", .args = &args } };
    try testing.expectError(error.HooksMustBeObject, mergeHooks(parsed.arena.allocator(), &parsed.value, "a", commands));
    try testing.expectEqualStrings("dark", parsed.value.object.get("theme").?.string);
}
test "buildCommands: creates exec-form argv with the absolute secrets path" {
    const got = try buildCommands(testing.allocator, "/opt/s/sumi", "/secret path/list", &.{"/extra dir"}, &.{"app.properties"});
    defer testing.allocator.free(got.post_tool.args);
    defer testing.allocator.free(got.prompt.args);
    try testing.expectEqualStrings("/opt/s/sumi", got.post_tool.command);
    try testing.expectEqualSlices([]const u8, &.{ "hook", "--agent", "claude", "post-tool", "--secrets-file", "/secret path/list" }, got.post_tool.args);
    try testing.expectEqualSlices([]const u8, &.{ "hook", "--agent", "claude", "prompt", "--secrets-file", "/secret path/list", "--root", "/extra dir", "--deny-path", "app.properties" }, got.prompt.args);
}
test "environment install preserves unrelated keys and sets one supported shell" {
    var parsed = try jsonio.parse(testing.allocator, "{\"env\":{\"KEEP\":\"yes\",\"CLAUDE_CODE_SHELL_PREFIX\":\"/old/sumi run --secrets-file /s --shell /bin/zsh\"},\"permissions\":{\"deny\":[\"Bash(git:*)\"]}}");
    defer parsed.deinit();
    try validateEnvironment(parsed.value, "/old/sumi run --secrets-file /s --shell /bin/zsh");
    try installEnvironment(parsed.arena.allocator(), &parsed.value, "/bin/zsh", "'/new path/sumi' run --secrets-file '/secret path/list' --shell /bin/zsh");
    const env = parsed.value.object.get("env").?.object;
    try testing.expectEqualStrings("yes", env.get("KEEP").?.string);
    try testing.expectEqualStrings("/bin/zsh", env.get("CLAUDE_CODE_SHELL").?.string);
    try testing.expectEqualStrings("'/new path/sumi' run --secrets-file '/secret path/list' --shell /bin/zsh", env.get("CLAUDE_CODE_SHELL_PREFIX").?.string);
    try testing.expectEqualStrings("Bash(git:*)", parsed.value.object.get("permissions").?.object.get("deny").?.array.items[0].string);
}
test "environment validation rejects malformed env and foreign prefixes" {
    var malformed = try jsonio.parse(testing.allocator, "{\"env\":[]}");
    defer malformed.deinit();
    try testing.expectError(error.EnvMustBeObject, validateSettings(malformed.value));

    var foreign = try jsonio.parse(testing.allocator, "{\"env\":{\"CLAUDE_CODE_SHELL_PREFIX\":\"other-wrapper\"}}");
    defer foreign.deinit();
    try testing.expectError(error.ForeignShellPrefix, validateEnvironment(foreign.value, "/new/sumi run"));

    var non_string = try jsonio.parse(testing.allocator, "{\"env\":{\"CLAUDE_CODE_SHELL_PREFIX\":true}}");
    defer non_string.deinit();
    try testing.expectError(error.ForeignShellPrefix, validateEnvironment(non_string.value, "/new/sumi run"));
}
test "supported Claude shells are limited to bash and zsh" {
    try testing.expect(isSupportedClaudeShell("/bin/bash"));
    try testing.expect(isSupportedClaudeShell("/usr/bin/zsh"));
    try testing.expect(!isSupportedClaudeShell("/bin/sh"));
}
test "shell prefix uses one Claude executable delimiter" {
    const prefix = try formatShellPrefix(testing.allocator, "/opt/sumi", "/secret list", "/bin/bash");
    defer testing.allocator.free(prefix);
    try testing.expectEqualStrings(
        "/bin/bash -c 'exec \"$@\"' 'sumi-prefix' '/opt/sumi' 'run' '--secrets-file' '/secret list' '--shell' '/bin/bash'",
        prefix,
    );
    try testing.expectEqual(@as(?usize, "/bin/bash".len), std.mem.lastIndexOf(u8, prefix, " -"));
}
test "shell prefix hides delimiter-like bytes in every argument" {
    const selected_shell = "/shell - choice/bash";
    const prefix = try formatShellPrefix(testing.allocator, "/tool - dir/it's/sumi", "/secret - list", selected_shell);
    defer testing.allocator.free(prefix);
    try testing.expectEqual(@as(?usize, selected_shell.len), std.mem.lastIndexOf(u8, prefix, " -"));
    try testing.expect(std.mem.indexOf(u8, prefix, "'/tool ''- dir/it'\\''s/sumi'") != null);

    const invocation = try formatClaudeInvocation(testing.allocator, prefix, "printf '%s' 'ok - value'");
    defer testing.allocator.free(invocation);
    try testing.expect(std.mem.startsWith(u8, invocation, "'/shell ''- choice/bash' -c "));
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
