//! Deny sandboxed Bash reads of project files that hold protected values.
//!
//! Output masking cannot see through encodings a shell pipeline invents, so the
//! files themselves are listed in `sandbox.filesystem.denyRead`, where the OS
//! refuses the open. Read and Grep keep their masked view: permission rules are
//! not written, because Claude Code merges Read deny rules into the sandbox and
//! would reject those tools outright.
//!
//! The entries sumi added are recorded in a sidecar file, so a rescan removes
//! entries for files that no longer hold a value without touching entries the
//! user wrote.
const std = @import("std");
const jsonio = @import("../jsonio.zig");
const secrets = @import("../secrets.zig");
const init = @import("init.zig");
const cli = @import("../main.zig");
const mask = @import("mask");

pub const CHUNK: usize = 1024 * 1024;
const SKIPPED_DIRS = [_][]const u8{".git"};
const GLOB_BYTES = "*?[]{}\\";

fn fail(message: []const u8) u8 {
    std.debug.print("sumi: {s}\n", .{message});
    return 1;
}

fn usage(message: []const u8) u8 {
    std.debug.print("sumi: {s}\nusage: sumi scan --agent claude --secrets-file F [--root DIR] [--settings FILE]\n", .{message});
    return cli.EXIT_USAGE;
}

const ScanArgs = struct { secrets_file: []const u8, root: ?[]const u8, settings: ?[]const u8 };

fn parseArgs(args: []const []const u8) !ScanArgs {
    var secrets_file: ?[]const u8 = null;
    var root: ?[]const u8 = null;
    var settings: ?[]const u8 = null;
    var i: usize = 0;
    while (i < args.len) : (i += 2) {
        const name = args[i];
        if (i + 1 == args.len or std.mem.startsWith(u8, args[i + 1], "--")) return error.MissingOptionValue;
        const slot = if (std.mem.eql(u8, name, "--secrets-file"))
            &secrets_file
        else if (std.mem.eql(u8, name, "--root"))
            &root
        else if (std.mem.eql(u8, name, "--settings"))
            &settings
        else
            return error.UnknownOption;
        if (slot.* != null) return error.DuplicateOption;
        slot.* = args[i + 1];
    }
    return .{ .secrets_file = secrets_file orelse return error.MissingSecretsFile, .root = root, .settings = settings };
}

/// Whether a path would be read as a pattern rather than a literal name.
pub fn hasGlobBytes(path: []const u8) bool {
    return std.mem.indexOfAny(u8, path, GLOB_BYTES) != null;
}

/// Scan a stream in chunks, carrying `max_len - 1` bytes across each boundary
/// so a value split between two reads is still found.
pub fn readerHolds(allocator: std.mem.Allocator, reader: anytype, values: []const []const u8) !bool {
    const max_len = mask.maxSecretLen(values);
    if (max_len == 0) return false;
    const buf = try allocator.alloc(u8, CHUNK + max_len);
    defer allocator.free(buf);
    var keep: usize = 0;
    while (true) {
        const n = try reader.read(buf[keep..]);
        if (n == 0) return false;
        const total = keep + n;
        if (mask.containsAny(buf[0..total], values)) return true;
        keep = @min(total, max_len - 1);
        std.mem.copyForwards(u8, buf[0..keep], buf[total - keep .. total]);
    }
}

const Findings = struct {
    holding: std.ArrayList([]const u8) = .empty,
    unreadable: usize = 0,
    unexpressible: usize = 0,
    skipped_secrets_file: bool = false,
};

const Walk = struct {
    allocator: std.mem.Allocator,
    values: []const []const u8,
    secrets_path: []const u8,
    findings: *Findings,

    fn warnPath(message: []const u8, path: []const u8) void {
        std.debug.print("sumi: warning: {s}: {s}\n", .{ message, path });
    }

    fn file(self: *Walk, path: []const u8) !void {
        if (std.mem.eql(u8, path, self.secrets_path)) {
            self.findings.skipped_secrets_file = true;
            return;
        }
        const handle = std.fs.cwd().openFile(path, .{}) catch {
            self.findings.unreadable += 1;
            return warnPath("could not be read", path);
        };
        defer handle.close();
        const holds = readerHolds(self.allocator, handle, self.values) catch |err| switch (err) {
            error.OutOfMemory => return err,
            else => {
                self.findings.unreadable += 1;
                return warnPath("could not be read", path);
            },
        };
        if (!holds) return;
        if (hasGlobBytes(path)) {
            self.findings.unexpressible += 1;
            return warnPath("holds a value but its name contains pattern characters, so it was not listed", path);
        }
        try self.findings.holding.append(self.allocator, try self.allocator.dupe(u8, path));
    }

    fn dir(self: *Walk, path: []const u8) !void {
        var handle = std.fs.cwd().openDir(path, .{ .iterate = true }) catch {
            self.findings.unreadable += 1;
            return warnPath("directory could not be read", path);
        };
        defer handle.close();
        var it = handle.iterate();
        while (it.next() catch {
            self.findings.unreadable += 1;
            return warnPath("directory could not be read", path);
        }) |entry| {
            const child = try std.fs.path.join(self.allocator, &.{ path, entry.name });
            defer self.allocator.free(child);
            switch (entry.kind) {
                .directory => {
                    const skipped = for (SKIPPED_DIRS) |name| {
                        if (std.mem.eql(u8, entry.name, name)) break true;
                    } else false;
                    if (!skipped) try self.dir(child);
                },
                .file => try self.file(child),
                // Symlinks are not followed: a target inside the root is scanned
                // under its own path, and one outside is out of scope.
                else => {},
            }
        }
    }
};

/// A sandbox path starting with "./" resolves against the project root only
/// when it sits in project settings; in user settings it resolves against
/// ~/.claude, and for any other file the base is unknown. Entries are therefore
/// project-relative exactly when the settings file is the root's own
/// `.claude/` settings, so a shared `.claude/settings.json` stays portable.
pub fn isProjectSettings(allocator: std.mem.Allocator, root: []const u8, settings_path: []const u8) !bool {
    const resolved = try std.fs.path.resolve(allocator, &.{settings_path});
    defer allocator.free(resolved);
    const dir = std.fs.path.dirname(resolved) orelse return false;
    const claude_dir = try std.fs.path.join(allocator, &.{ root, ".claude" });
    defer allocator.free(claude_dir);
    return std.mem.eql(u8, dir, claude_dir);
}

/// `path` is an absolute path found under `root`.
pub fn entryFor(allocator: std.mem.Allocator, root: []const u8, path: []const u8, relative: bool) ![]const u8 {
    if (!relative) return allocator.dupe(u8, path);
    const rel = try std.fs.path.relative(allocator, root, path);
    defer allocator.free(rel);
    return std.fmt.allocPrint(allocator, "./{s}", .{rel});
}

/// Whether an entry names a path this scan's root covers, and so may be removed
/// when the scan no longer finds it.
pub fn underRoot(entry: []const u8, root: []const u8) bool {
    if (std.mem.startsWith(u8, entry, "./")) return true;
    if (std.mem.eql(u8, root, "/")) return std.mem.startsWith(u8, entry, "/");
    return entry.len > root.len and std.mem.startsWith(u8, entry, root) and entry[root.len] == '/';
}

fn lessThan(_: void, a: []const u8, b: []const u8) bool {
    return std.mem.order(u8, a, b) == .lt;
}

fn contains(list: []const []const u8, item: []const u8) bool {
    for (list) |value| if (std.mem.eql(u8, value, item)) return true;
    return false;
}

pub const Merge = struct {
    deny_read: []const []const u8,
    managed: []const []const u8,
    added: usize,
    removed: usize,
};

/// Replace the entries sumi owns under `root` with the current findings. An
/// existing entry sumi did not write stays in place and is not claimed, so a
/// later rescan never removes it. Entries sumi wrote for another root, as when
/// several projects share user settings, are kept and stay owned.
pub fn merge(allocator: std.mem.Allocator, root: []const u8, existing: []const []const u8, previous: []const []const u8, found: []const []const u8) !Merge {
    var deny: std.ArrayList([]const u8) = .empty;
    var managed: std.ArrayList([]const u8) = .empty;
    var removed: usize = 0;
    for (existing) |entry| {
        const owned = contains(previous, entry);
        const covered = underRoot(entry, root);
        if (owned and covered and !contains(found, entry)) {
            removed += 1;
            continue;
        }
        if (contains(deny.items, entry)) continue;
        try deny.append(allocator, entry);
        if (owned and !covered) try managed.append(allocator, entry);
    }
    var added: usize = 0;
    for (found) |path| {
        if (contains(existing, path)) {
            if (contains(previous, path)) try managed.append(allocator, path);
            continue;
        }
        try deny.append(allocator, path);
        try managed.append(allocator, path);
        added += 1;
    }
    return .{ .deny_read = try deny.toOwnedSlice(allocator), .managed = try managed.toOwnedSlice(allocator), .added = added, .removed = removed };
}

fn collectStrings(allocator: std.mem.Allocator, value: std.json.Value) ![]const []const u8 {
    if (value != .array) return error.NotStringArray;
    const out = try allocator.alloc([]const u8, value.array.items.len);
    for (value.array.items, 0..) |item, i| {
        if (item != .string) return error.NotStringArray;
        out[i] = item.string;
    }
    return out;
}

fn objectAt(allocator: std.mem.Allocator, parent: *std.json.ObjectMap, key: []const u8) !*std.json.ObjectMap {
    if (parent.getPtr(key)) |value| {
        if (value.* != .object) return error.NotObject;
        return &value.object;
    }
    try parent.put(key, .{ .object = std.json.ObjectMap.init(allocator) });
    return &parent.getPtr(key).?.object;
}

/// `<dir>/settings.local.json` -> `<dir>/settings.local.sumi-scan.json`.
pub fn sidecarPath(allocator: std.mem.Allocator, settings_path: []const u8) ![]u8 {
    const stem = if (std.mem.endsWith(u8, settings_path, ".json")) settings_path[0 .. settings_path.len - ".json".len] else settings_path;
    return std.fmt.allocPrint(allocator, "{s}.sumi-scan.json", .{stem});
}

fn readOptional(allocator: std.mem.Allocator, path: []const u8) !?[]u8 {
    return std.fs.cwd().readFileAlloc(allocator, path, 16 * 1024 * 1024) catch |err| switch (err) {
        error.FileNotFound => null,
        else => error.Unreadable,
    };
}

fn note(settings: std.json.Value, settings_path: []const u8) void {
    const sandbox = jsonio.getObject(settings, "sandbox") orelse return noteMissing(settings_path, "sandbox.enabled", "true");
    const enabled = sandbox.get("enabled");
    if (enabled == null or enabled.? != .bool or !enabled.?.bool) noteMissing(settings_path, "sandbox.enabled", "true");
    const unsandboxed = sandbox.get("allowUnsandboxedCommands");
    if (unsandboxed == null or unsandboxed.? != .bool or unsandboxed.?.bool) noteMissing(settings_path, "sandbox.allowUnsandboxedCommands", "false");
}

fn noteMissing(settings_path: []const u8, key: []const u8, value: []const u8) void {
    std.debug.print("sumi: note: {s} is not {s} in {s}; denyRead is only enforced when another settings scope sets it\n", .{ key, value, settings_path });
}

pub fn main(allocator: std.mem.Allocator, args: []const []const u8) !u8 {
    const parsed_args = parseArgs(args) catch return usage("invalid arguments");
    const values = secrets.load(allocator, parsed_args.secrets_file) catch |err| return fail(secrets.describe(err));
    const secrets_path = std.fs.cwd().realpathAlloc(allocator, parsed_args.secrets_file) catch return fail("the secrets file path could not be resolved");
    const root = std.fs.cwd().realpathAlloc(allocator, parsed_args.root orelse ".") catch return fail("the root directory could not be resolved");
    const settings_path = if (parsed_args.settings) |path| try allocator.dupe(u8, path) else try std.fs.path.join(allocator, &.{ root, ".claude", "settings.local.json" });
    const sidecar = try sidecarPath(allocator, settings_path);

    const existing = readOptional(allocator, settings_path) catch return fail("the settings file could not be read");
    var parsed = jsonio.parse(allocator, existing orelse "{}") catch return fail("the settings file is not valid JSON");
    defer parsed.deinit();
    if (parsed.value != .object) return fail("the settings file is not a JSON object");
    const arena = parsed.arena.allocator();
    const sandbox = objectAt(arena, &parsed.value.object, "sandbox") catch return fail("sandbox in the settings file is not an object");
    const filesystem = objectAt(arena, sandbox, "filesystem") catch return fail("sandbox.filesystem in the settings file is not an object");
    const current = if (filesystem.get("denyRead")) |value|
        collectStrings(allocator, value) catch return fail("sandbox.filesystem.denyRead in the settings file is not an array of strings")
    else
        &.{};

    const sidecar_text = readOptional(allocator, sidecar) catch return fail("the scan record could not be read");
    var previous: []const []const u8 = &.{};
    var sidecar_parsed: ?std.json.Parsed(std.json.Value) = null;
    defer if (sidecar_parsed) |*p| p.deinit();
    if (sidecar_text) |text| {
        sidecar_parsed = jsonio.parse(allocator, text) catch return fail("the scan record is not valid JSON; remove it after checking denyRead by hand");
        const list = if (sidecar_parsed.?.value == .object) sidecar_parsed.?.value.object.get("denyRead") else null;
        previous = collectStrings(allocator, list orelse return fail("the scan record has no denyRead list")) catch return fail("the scan record denyRead is not an array of strings");
    }

    var findings = Findings{};
    var walk = Walk{ .allocator = allocator, .values = values, .secrets_path = secrets_path, .findings = &findings };
    try walk.dir(root);
    const relative = try isProjectSettings(allocator, root, settings_path);
    const found = try allocator.alloc([]const u8, findings.holding.items.len);
    for (findings.holding.items, 0..) |path, i| found[i] = try entryFor(allocator, root, path, relative);
    std.mem.sort([]const u8, found, {}, lessThan);

    const merged = try merge(allocator, root, current, previous, found);
    var deny_array = std.json.Array.init(arena);
    for (merged.deny_read) |entry| try deny_array.append(.{ .string = entry });
    try filesystem.put("denyRead", .{ .array = deny_array });

    const output = try jsonio.stringifyPretty(allocator, parsed.value);
    const changed = existing == null or !std.mem.eql(u8, std.mem.trimRight(u8, existing.?, "\n"), std.mem.trimRight(u8, output, "\n"));
    if (changed) {
        if (existing) |data| {
            var ts: [14]u8 = undefined;
            const backup_path = init.backup(allocator, settings_path, init.formatTimestamp(&ts, @intCast(std.time.timestamp())), data) catch return fail("the backup could not be written");
            std.debug.print("sumi: backup at {s}\n", .{backup_path});
        }
        if (std.fs.path.dirname(settings_path)) |dir| std.fs.cwd().makePath(dir) catch return fail("the settings directory could not be created");
        std.fs.cwd().writeFile(.{ .sub_path = settings_path, .data = output }) catch return fail("the settings file could not be written");
    }

    var record = std.json.ObjectMap.init(arena);
    var managed_array = std.json.Array.init(arena);
    for (merged.managed) |entry| try managed_array.append(.{ .string = entry });
    try record.put("denyRead", .{ .array = managed_array });
    const record_text = try jsonio.stringifyPretty(allocator, .{ .object = record });
    std.fs.cwd().writeFile(.{ .sub_path = sidecar, .data = record_text }) catch return fail("the scan record could not be written; denyRead was updated but a rescan will not remove these entries");

    for (found) |entry| std.debug.print("sumi: deny read {s}\n", .{entry});
    std.debug.print("sumi: {d} file(s) hold a value; {d} entr{s} added, {d} removed in {s}\n", .{ found.len, merged.added, if (merged.added == 1) "y" else "ies", merged.removed, settings_path });
    if (findings.skipped_secrets_file) std.debug.print("sumi: warning: the secrets file is inside the root and was not listed, because sumi run reads it inside the sandbox; keep it outside the project\n", .{});
    note(parsed.value, settings_path);
    if (findings.unreadable != 0 or findings.unexpressible != 0) {
        std.debug.print("sumi: {d} path(s) could not be scanned and {d} could not be listed; the list is incomplete\n", .{ findings.unreadable, findings.unexpressible });
        return 1;
    }
    return 0;
}

const testing = std.testing;

test "parseArgs: options, defaults and errors" {
    const got = try parseArgs(&.{ "--root", "/r", "--secrets-file", "/s", "--settings", "/cfg.json" });
    try testing.expectEqualStrings("/s", got.secrets_file);
    try testing.expectEqualStrings("/r", got.root.?);
    try testing.expectEqualStrings("/cfg.json", got.settings.?);
    const bare = try parseArgs(&.{ "--secrets-file", "/s" });
    try testing.expectEqual(@as(?[]const u8, null), bare.root);
    try testing.expectError(error.MissingSecretsFile, parseArgs(&.{}));
    try testing.expectError(error.MissingOptionValue, parseArgs(&.{ "--secrets-file", "/s", "--root" }));
    try testing.expectError(error.DuplicateOption, parseArgs(&.{ "--secrets-file", "/s", "--root", "/a", "--root", "/b" }));
    try testing.expectError(error.UnknownOption, parseArgs(&.{ "--secrets-file", "/s", "--deny-path", "x" }));
}

test "readerHolds: finds a value split across chunk boundaries" {
    const values = [_][]const u8{"split-value"};
    var data = try testing.allocator.alloc(u8, CHUNK * 2 + 64);
    defer testing.allocator.free(data);
    @memset(data, 'x');
    @memcpy(data[CHUNK - 5 .. CHUNK - 5 + values[0].len], values[0]);
    var stream = std.io.fixedBufferStream(data);
    try testing.expect(try readerHolds(testing.allocator, stream.reader(), &values));

    @memset(data, 'x');
    var clean = std.io.fixedBufferStream(data);
    try testing.expect(!try readerHolds(testing.allocator, clean.reader(), &values));
}

test "merge: replaces owned entries and never claims or drops foreign ones" {
    const got = try merge(testing.allocator, "/p", &.{ "/user/manual", "/p/stale", "/p/kept", "/p/also-user" }, &.{ "/p/stale", "/p/kept" }, &.{ "/p/also-user", "/p/kept", "/p/new" });
    defer testing.allocator.free(got.deny_read);
    defer testing.allocator.free(got.managed);
    try testing.expectEqualSlices([]const u8, &.{ "/user/manual", "/p/kept", "/p/also-user", "/p/new" }, got.deny_read);
    try testing.expectEqualSlices([]const u8, &.{ "/p/kept", "/p/new" }, got.managed);
    try testing.expectEqual(@as(usize, 1), got.added);
    try testing.expectEqual(@as(usize, 1), got.removed);
}

test "merge: entries owned for another root survive and stay owned" {
    const got = try merge(testing.allocator, "/b", &.{ "/a/secret", "/b/stale", "/bb/secret" }, &.{ "/a/secret", "/b/stale", "/bb/secret" }, &.{"/b/new"});
    defer testing.allocator.free(got.deny_read);
    defer testing.allocator.free(got.managed);
    try testing.expectEqualSlices([]const u8, &.{ "/a/secret", "/bb/secret", "/b/new" }, got.deny_read);
    try testing.expectEqualSlices([]const u8, &.{ "/a/secret", "/bb/secret", "/b/new" }, got.managed);
    try testing.expectEqual(@as(usize, 1), got.removed);
}

test "merge: absolute entries from an older scan give way to relative ones" {
    const got = try merge(testing.allocator, "/p", &.{"/p/config/app.properties"}, &.{"/p/config/app.properties"}, &.{"./config/app.properties"});
    defer testing.allocator.free(got.deny_read);
    defer testing.allocator.free(got.managed);
    try testing.expectEqualSlices([]const u8, &.{"./config/app.properties"}, got.deny_read);
    try testing.expectEqual(@as(usize, 1), got.removed);
}

test "path form follows the settings scope" {
    try testing.expect(try isProjectSettings(testing.allocator, "/p", "/p/.claude/settings.local.json"));
    try testing.expect(try isProjectSettings(testing.allocator, "/p", "/p/.claude/settings.json"));
    try testing.expect(!try isProjectSettings(testing.allocator, "/p", "/home/u/.claude/settings.json"));
    try testing.expect(!try isProjectSettings(testing.allocator, "/p", "/p/sub/.claude/settings.json"));

    const rel = try entryFor(testing.allocator, "/p", "/p/config/app.properties", true);
    defer testing.allocator.free(rel);
    try testing.expectEqualStrings("./config/app.properties", rel);
    const abs = try entryFor(testing.allocator, "/p", "/p/config/app.properties", false);
    defer testing.allocator.free(abs);
    try testing.expectEqualStrings("/p/config/app.properties", abs);

    try testing.expect(underRoot("./x", "/p"));
    try testing.expect(underRoot("/p/x", "/p"));
    try testing.expect(!underRoot("/pp/x", "/p"));
    try testing.expect(!underRoot("/p", "/p"));
    try testing.expect(underRoot("/x", "/"));
}

test "hasGlobBytes and sidecarPath" {
    try testing.expect(hasGlobBytes("/p/a*b"));
    try testing.expect(hasGlobBytes("/p/[x]"));
    try testing.expect(!hasGlobBytes("/p/config/app.properties"));
    const side = try sidecarPath(testing.allocator, "/p/.claude/settings.local.json");
    defer testing.allocator.free(side);
    try testing.expectEqualStrings("/p/.claude/settings.local.sumi-scan.json", side);
}
