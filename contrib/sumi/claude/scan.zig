//! Register verified credential masks and reconcile only confirmed scan results.
const std = @import("std");
const jsonio = @import("../jsonio.zig");
const secrets = @import("../secrets.zig");
const init = @import("init.zig");
const cli = @import("../main.zig");
const mask = @import("mask");
const extract = @import("extract.zig");
const MAX_EXTRACT = 8 * 1024 * 1024;

pub const CHUNK: usize = 1024 * 1024;
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

const Outcome = union(enum) { clean, masked: ?[]const u8, skipped: []const u8 };
const Finding = struct { path: []const u8, outcome: Outcome };
const Findings = struct {
    files: std.ArrayList(Finding) = .empty,
    preserved: std.ArrayList([]const u8) = .empty,
    unreadable: usize = 0,
    skipped_secrets_file: bool = false,

    fn keep(self: *Findings, allocator: std.mem.Allocator, path: []const u8) !void {
        try self.preserved.append(allocator, try allocator.dupe(u8, path));
    }
    fn unknown(self: *Findings, allocator: std.mem.Allocator, path: []const u8) !void {
        try self.keep(allocator, path);
        self.unreadable += 1;
        std.debug.print("sumi: warning: could not be read: {s}\n", .{path});
    }
    fn add(self: *Findings, allocator: std.mem.Allocator, path: []const u8, outcome: Outcome) !void {
        try self.files.append(allocator, .{ .path = try allocator.dupe(u8, path), .outcome = outcome });
    }
    fn isPreserved(self: Findings, path: []const u8) bool {
        for (self.preserved.items) |prefix| if (std.mem.eql(u8, path, prefix) or underRoot(path, prefix)) return true;
        return false;
    }
};

const Walk = struct {
    allocator: std.mem.Allocator,
    values: []const []const u8,
    secrets_path: []const u8,
    findings: *Findings,
    content_buffer: ?[]u8 = null,

    fn file(self: *Walk, path: []const u8) !void {
        if (std.mem.eql(u8, path, self.secrets_path)) {
            self.findings.skipped_secrets_file = true;
            return self.findings.keep(self.allocator, path);
        }
        // NOFOLLOW avoids reading a symlink substituted since directory iteration;
        // NONBLOCK avoids hanging if a regular file was replaced with a FIFO.
        const fd = std.posix.open(path, .{ .ACCMODE = .RDONLY, .NOFOLLOW = true, .NONBLOCK = true, .CLOEXEC = true }, 0) catch
            return self.findings.unknown(self.allocator, path);
        const handle = std.fs.File{ .handle = fd };
        defer handle.close();
        const stat = handle.stat() catch return self.findings.unknown(self.allocator, path);
        if (stat.kind != .file) return self.findings.keep(self.allocator, path);
        const holds = readerHolds(self.allocator, handle, self.values) catch |err| switch (err) {
            error.OutOfMemory => return err,
            else => return self.findings.unknown(self.allocator, path),
        };
        if (!holds) return self.findings.add(self.allocator, path, .clean);
        if (hasGlobBytes(path)) return self.findings.add(self.allocator, path, .{ .skipped = "glob-chars" });
        handle.seekTo(0) catch return self.findings.unknown(self.allocator, path);
        // Read no more than the limit plus one, even if a file grows while read.
        // Reuse the bounded buffer; only the generated expression escapes this
        // call, so borrowed extraction prefixes never outlive their content.
        if (self.content_buffer == null) self.content_buffer = try self.allocator.alloc(u8, MAX_EXTRACT + 1);
        const content = self.content_buffer.?;
        const n = handle.readAll(content) catch return self.findings.unknown(self.allocator, path);
        if (n > MAX_EXTRACT) return self.findings.add(self.allocator, path, .{ .skipped = "too-large" });
        if (!std.unicode.utf8ValidateSlice(content[0..n])) return self.findings.add(self.allocator, path, .{ .skipped = "not-utf8" });
        if (!mask.containsAny(content[0..n], self.values)) return self.findings.add(self.allocator, path, .clean);
        const result = try extract.generate(self.allocator, content[0..n], self.values);
        try self.findings.add(self.allocator, path, switch (result) {
            .whole_file => .{ .masked = null },
            .rule => |rule| .{ .masked = rule.expression },
            .skip => |reason| .{ .skipped = reason.code() },
        });
    }

    fn dir(self: *Walk, path: []const u8) !void {
        var handle = std.fs.cwd().openDir(path, .{ .iterate = true, .no_follow = true }) catch
            return self.findings.unknown(self.allocator, path);
        defer handle.close();
        var it = handle.iterate();
        while (it.next() catch return self.findings.unknown(self.allocator, path)) |entry| {
            const child = try std.fs.path.join(self.allocator, &.{ path, entry.name });
            defer self.allocator.free(child);
            switch (entry.kind) {
                .directory => if (std.mem.eql(u8, entry.name, ".git")) try self.findings.keep(self.allocator, child) else try self.dir(child),
                .file => try self.file(child),
                else => try self.findings.keep(self.allocator, child),
            }
        }
    }
};

pub fn underRoot(entry: []const u8, root: []const u8) bool {
    if (std.mem.eql(u8, root, "/")) return std.fs.path.isAbsolute(entry);
    return entry.len > root.len and std.mem.startsWith(u8, entry, root) and entry[root.len] == '/';
}
fn contains(list: []const []const u8, item: []const u8) bool {
    for (list) |value| if (std.mem.eql(u8, value, item)) return true;
    return false;
}
fn lessThan(_: void, a: []const u8, b: []const u8) bool {
    return std.mem.order(u8, a, b) == .lt;
}
fn findingLessThan(_: void, a: Finding, b: Finding) bool {
    return lessThan({}, a.path, b.path);
}

/// Resolve symlinks in the nearest existing ancestor before appending missing
/// components. Only FileNotFound permits walking up; permission errors do not.
fn resolveParent(allocator: std.mem.Allocator, path: []const u8) ![]const u8 {
    return std.fs.cwd().realpathAlloc(allocator, path) catch |err| switch (err) {
        error.FileNotFound => blk: {
            const parent = std.fs.path.dirname(path) orelse return err;
            if (std.mem.eql(u8, parent, path)) return err;
            const resolved = try resolveParent(allocator, parent);
            break :blk try std.fs.path.resolve(allocator, &.{ resolved, std.fs.path.basename(path) });
        },
        else => return err,
    };
}
fn resolveSettings(allocator: std.mem.Allocator, path: []const u8, user_path: []const u8) ![]const u8 {
    const cwd = try std.fs.cwd().realpathAlloc(allocator, ".");
    const absolute = if (std.fs.path.isAbsolute(path)) path else try std.fs.path.join(allocator, &.{ cwd, path });
    const parent = try resolveParent(allocator, std.fs.path.dirname(absolute).?);
    const user_absolute = if (std.fs.path.isAbsolute(user_path)) user_path else try std.fs.path.join(allocator, &.{ cwd, user_path });
    const user_parent = try resolveParent(allocator, std.fs.path.dirname(user_absolute).?);
    if (std.mem.eql(u8, std.fs.path.basename(parent), ".claude") and !std.mem.eql(u8, parent, user_parent)) return error.ProjectSettings;
    return std.fs.path.join(allocator, &.{ parent, std.fs.path.basename(absolute) });
}

/// Check each ancestor without following symlinks. A missing target behind a
/// symlink is excluded, not evidence that an owned file disappeared.
fn confirmUnseen(walk: *Walk, root: []const u8, path: []const u8) !void {
    if (!underRoot(path, root) or walk.findings.isPreserved(path)) return;
    var end: usize = if (std.mem.eql(u8, root, "/")) 1 else root.len + 1;
    while (end <= path.len) : (end += 1) {
        if (end != path.len and path[end] != '/') continue;
        const prefix = path[0..end];
        if (std.mem.eql(u8, std.fs.path.basename(prefix), ".git") or std.mem.eql(u8, prefix, walk.secrets_path)) return walk.findings.keep(walk.allocator, prefix);
        const stat = std.posix.fstatat(std.posix.AT.FDCWD, prefix, std.posix.AT.SYMLINK_NOFOLLOW) catch |err| switch (err) {
            error.FileNotFound => return walk.findings.add(walk.allocator, path, .clean),
            else => return walk.findings.unknown(walk.allocator, prefix),
        };
        if (std.posix.S.ISLNK(stat.mode)) return walk.findings.keep(walk.allocator, prefix);
        if (end < path.len and !std.posix.S.ISDIR(stat.mode)) return walk.findings.keep(walk.allocator, prefix);
        if (end == path.len) {
            if (std.posix.S.ISREG(stat.mode)) return walk.file(path);
            return walk.findings.keep(walk.allocator, path);
        }
    }
}

const Settings = struct { files: []const std.json.Value, deny: []const []const u8 };
fn validateSettings(allocator: std.mem.Allocator, value: std.json.Value) !Settings {
    if (value != .object) return error.NotObject;
    var result = Settings{ .files = &.{}, .deny = &.{} };
    if (value.object.get("sandbox")) |sandbox| {
        if (sandbox != .object) return error.NotObject;
        if (sandbox.object.get("filesystem")) |filesystem| {
            if (filesystem != .object) return error.NotObject;
            if (filesystem.object.get("denyRead")) |deny| result.deny = try collectStrings(allocator, deny);
        }
        if (sandbox.object.get("credentials")) |credentials| {
            if (credentials != .object) return error.NotObject;
            if (credentials.object.get("files")) |files| {
                if (files != .array) return error.NotArray;
                for (files.array.items) |entry| if (jsonio.getString(entry, "path") == null) return error.NotEntry;
                result.files = files.array.items;
            }
        }
    }
    return result;
}
fn ownedPaths(allocator: std.mem.Allocator, record: std.json.Value) ![]const []const u8 {
    if (record != .object) return error.NotObject;
    const paths = try collectStrings(allocator, record.object.get("credentialsFiles") orelse return error.MissingOwnership);
    for (paths) |path| if (!std.fs.path.isAbsolute(path)) return error.RelativeOwnership;
    return paths;
}
const Event = struct { path: []const u8, action: enum { mask, unmask, skip }, reason: ?[]const u8 = null };
const Reconciled = struct { events: std.ArrayList(Event) = .empty, failed: bool = false };

fn reconcile(allocator: std.mem.Allocator, settings: *std.json.Value, record: *std.json.Value, root: []const u8, findings: Findings) !Reconciled {
    const current = try validateSettings(allocator, settings.*);
    const previous = try ownedPaths(allocator, record.*);
    var files = std.json.Array.init(allocator);
    try files.appendSlice(current.files);
    var owned: std.ArrayList([]const u8) = .empty;
    for (previous) |path| if (!contains(owned.items, path)) try owned.append(allocator, path);
    var result = Reconciled{};
    for (findings.files.items) |finding| {
        const path = finding.path;
        if (!underRoot(path, root) or findings.isPreserved(path)) continue;
        var count: usize = 0;
        var index: usize = 0;
        for (files.items, 0..) |entry, i| if (std.mem.eql(u8, jsonio.getString(entry, "path").?, path)) {
            count += 1;
            index = i;
        };
        const is_owned = contains(previous, path);
        // Conflicts take priority even for clean, missing or unregeneratable files.
        const conflict: ?[]const u8 = if (count > 1 or (count == 1 and !is_owned)) "existing-entry" else if (contains(current.deny, path)) "denyread-conflict" else null;
        if (conflict) |reason| {
            try result.events.append(allocator, .{ .path = path, .action = .skip, .reason = reason });
            continue;
        }
        switch (finding.outcome) {
            .masked => |expression| {
                var entry = if (count == 1) files.items[index] else std.json.Value{ .object = std.json.ObjectMap.init(allocator) };
                try entry.object.put("path", .{ .string = path });
                try entry.object.put("mode", .{ .string = "mask" });
                if (expression) |rule| {
                    try entry.object.put("extract", .{ .string = rule });
                    try entry.object.put("maskDuplicates", .{ .bool = true });
                } else {
                    _ = entry.object.orderedRemove("extract");
                    _ = entry.object.orderedRemove("maskDuplicates");
                }
                if (count == 0) try entry.object.put("injectHosts", .{ .array = std.json.Array.init(allocator) });
                try entry.object.put("onExtractNoMatch", .{ .string = "deny" });
                if (count == 1) files.items[index] = entry else try files.append(entry);
                if (!contains(owned.items, path)) try owned.append(allocator, path);
                try result.events.append(allocator, .{ .path = path, .action = .mask });
            },
            .clean, .skipped => {
                const reason: ?[]const u8 = if (finding.outcome == .skipped) finding.outcome.skipped else null;
                if (is_owned) {
                    if (count == 1) _ = files.orderedRemove(index);
                    for (owned.items, 0..) |old, i| if (std.mem.eql(u8, old, path)) {
                        _ = owned.orderedRemove(i);
                        break;
                    };
                    try result.events.append(allocator, .{ .path = path, .action = .unmask, .reason = reason });
                    if (reason != null) result.failed = true;
                } else if (reason) |why| try result.events.append(allocator, .{ .path = path, .action = .skip, .reason = why });
            },
        }
    }
    // Do not insert any parents until child values have been collected. Pointers
    // into ObjectMap values cannot survive insertions into that same map.
    if (files.items.len != 0 or current.files.len != 0) {
        const sandbox = try objectAt(allocator, &settings.object, "sandbox");
        const credentials = try objectAt(allocator, sandbox, "credentials");
        try credentials.put("files", .{ .array = files });
    }
    std.mem.sort([]const u8, owned.items, {}, lessThan);
    var paths = std.json.Array.init(allocator);
    for (owned.items) |path| try paths.append(.{ .string = path });
    try record.object.put("credentialsFiles", .{ .array = paths });
    return result;
}

/// Injectable only at the write boundary: rollback still writes/deletes actual
/// files in tests. All output construction and validation precede this boundary.
const Writer = struct {
    context: ?*anyopaque = null,
    writeFn: *const fn (?*anyopaque, []const u8, []const u8) anyerror!void = writeFile,
    fn writeFile(_: ?*anyopaque, path: []const u8, data: []const u8) !void {
        try std.fs.cwd().writeFile(.{ .sub_path = path, .data = data });
    }
    fn write(self: Writer, path: []const u8, data: []const u8) !void {
        try self.writeFn(self.context, path, data);
    }
};
fn differs(original: ?[]const u8, output: []const u8) bool {
    return original == null or !std.mem.eql(u8, original.?, output);
}
fn save(writer: Writer, settings_path: []const u8, sidecar: []const u8, original: ?[]const u8, output: []const u8, record_original: ?[]const u8, record_output: []const u8) !void {
    const settings_changed = differs(original, output);
    if (settings_changed) try writer.write(settings_path, output);
    if (differs(record_original, record_output)) writer.write(sidecar, record_output) catch {
        if (settings_changed) {
            if (original) |bytes| {
                writer.write(settings_path, bytes) catch return error.RestoreFailed;
            } else std.fs.cwd().deleteFile(settings_path) catch return error.RestoreFailed;
        }
        return error.RecordWriteFailed;
    };
}
fn note(settings: std.json.Value, settings_path: []const u8) void {
    const sandbox = jsonio.getObject(settings, "sandbox");
    const enabled = if (sandbox) |s| s.get("enabled") else null;
    if (enabled == null or enabled.? != .bool or !enabled.?.bool) std.debug.print("sumi: note: sandbox.enabled is not true in {s}; enable the sandbox in another settings scope\n", .{settings_path});
    if (sandbox) |s| {
        if (s.get("credentials")) |credentials| {
            if (credentials.object.get("files")) |files| {
                for (files.array.items) |entry| {
                    const mode = jsonio.getString(entry, "mode") orelse continue;
                    if (!std.mem.eql(u8, mode, "mask")) continue;
                    if (entry.object.get("injectHosts")) |hosts| {
                        if (hosts == .array and hosts.array.items.len == 0) {
                            std.debug.print("sumi: note: empty injectHosts does not restore real values when sending and causes a Claude Code startup warning: {s}\n", .{jsonio.getString(entry, "path").?});
                        }
                    }
                }
            }
        }
    }
    std.debug.print("sumi: note: scan can check only this settings file: {s}\n", .{settings_path});
}

pub fn main(allocator: std.mem.Allocator, args: []const []const u8) !u8 {
    const parsed_args = parseArgs(args) catch return usage("invalid arguments");
    const values = secrets.load(allocator, parsed_args.secrets_file) catch |err| return fail(secrets.describe(err));
    const secrets_path = std.fs.cwd().realpathAlloc(allocator, parsed_args.secrets_file) catch return fail("the secrets file path could not be resolved");
    const root = std.fs.cwd().realpathAlloc(allocator, parsed_args.root orelse ".") catch return fail("the root directory could not be resolved");
    const home = std.posix.getenv("HOME") orelse return fail("HOME is not set");
    const user_path = try init.defaultSettingsPath(allocator, std.posix.getenv("CLAUDE_CONFIG_DIR"), home);
    const settings_path = resolveSettings(allocator, parsed_args.settings orelse user_path, user_path) catch return fail("the settings parent could not be resolved or is a project .claude directory");
    const sidecar = try sidecarPath(allocator, settings_path);
    const existing = readOptional(allocator, settings_path) catch return fail("the settings file could not be read");
    var parsed = jsonio.parse(allocator, existing orelse "{}") catch return fail("the settings file is not valid JSON");
    defer parsed.deinit();
    _ = validateSettings(allocator, parsed.value) catch return fail("the settings file has an invalid sandbox shape");
    const settings_before = try jsonio.stringifyPretty(allocator, parsed.value);
    const record_existing = readOptional(allocator, sidecar) catch return fail("the scan record could not be read");
    var record = jsonio.parse(allocator, record_existing orelse "{\"credentialsFiles\":[]}") catch return fail("the scan record is not valid JSON");
    defer record.deinit();
    const previous = ownedPaths(allocator, record.value) catch return fail("the scan record credentialsFiles must be an array of absolute paths");
    const record_before = try jsonio.stringifyPretty(allocator, record.value);
    var findings = Findings{};
    var walk = Walk{ .allocator = allocator, .values = values, .secrets_path = secrets_path, .findings = &findings };
    try walk.dir(root);
    for (previous) |path| {
        const seen = for (findings.files.items) |finding| {
            if (std.mem.eql(u8, path, finding.path)) break true;
        } else false;
        if (!seen) try confirmUnseen(&walk, root, path);
    }
    std.mem.sort(Finding, findings.files.items, {}, findingLessThan);
    const result = try reconcile(allocator, &parsed.value, &record.value, root, findings);
    const formatted = try jsonio.stringifyPretty(allocator, parsed.value);
    const record_formatted = try jsonio.stringifyPretty(allocator, record.value);
    const output = if (existing != null and std.mem.eql(u8, settings_before, formatted)) existing.? else formatted;
    const record_output = if (record_existing != null and std.mem.eql(u8, record_before, record_formatted)) record_existing.? else record_formatted;
    if (differs(existing, output)) if (existing) |data| {
        var ts: [14]u8 = undefined;
        const backup_path = init.backup(allocator, settings_path, init.formatTimestamp(&ts, @intCast(std.time.timestamp())), data) catch return fail("the backup could not be written");
        std.debug.print("sumi: backup at {s}\n", .{backup_path});
    };
    if (differs(existing, output) or differs(record_existing, record_output)) std.fs.cwd().makePath(std.fs.path.dirname(settings_path).?) catch return fail("the settings directory could not be created");
    save(.{}, settings_path, sidecar, existing, output, record_existing, record_output) catch |err| {
        if (err == error.RestoreFailed) {
            std.debug.print("sumi: settings recovery required: {s}; scan record: {s}\n", .{ settings_path, sidecar });
            return 1;
        }
        return fail(if (err == error.RecordWriteFailed) "the scan record could not be written; settings restored" else "the settings file could not be written");
    };
    var masked: usize = 0;
    var unmasked: usize = 0;
    var skipped: usize = 0;
    for (result.events.items) |event| {
        switch (event.action) {
            .mask => {
                masked += 1;
                std.debug.print("sumi: mask {s}\n", .{event.path});
            },
            .unmask => {
                unmasked += 1;
                if (event.reason) |reason| std.debug.print("sumi: unmask {s}: was masked, now {s}\n", .{ event.path, reason }) else std.debug.print("sumi: unmask {s}\n", .{event.path});
            },
            .skip => {
                skipped += 1;
                std.debug.print("sumi: skip {s}: {s}\n", .{ event.path, event.reason.? });
            },
        }
    }
    std.debug.print("sumi: {d} masked, {d} unmasked, {d} skipped in {s}\n", .{ masked, unmasked, skipped, settings_path });
    if (findings.skipped_secrets_file) std.debug.print("sumi: warning: the secrets file is inside the root and was excluded; sumi reads it inside the sandbox; keep it outside the project\n", .{});
    note(parsed.value, settings_path);
    return if (findings.unreadable != 0 or result.failed) 1 else 0;
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

test "hasGlobBytes and sidecarPath" {
    try testing.expect(hasGlobBytes("/p/a*b"));
    try testing.expect(hasGlobBytes("/p/[x]"));
    try testing.expect(!hasGlobBytes("/p/config/app.properties"));
    const side = try sidecarPath(testing.allocator, "/p/.claude/settings.local.json");
    defer testing.allocator.free(side);
    try testing.expectEqualStrings("/p/.claude/settings.local.sumi-scan.json", side);
}

test "reconcile: owned transitions preserve metadata and missing injectHosts" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var settings = try jsonio.parse(a, "{\"sandbox\":{\"credentials\":{\"files\":[{\"path\":\"/p/a\",\"mode\":\"deny\",\"extract\":\"old\",\"maskDuplicates\":false,\"extra\":7}]}}}");
    var record = try jsonio.parse(a, "{\"credentialsFiles\":[\"/p/a\"],\"extra\":true}");
    var findings = Findings{};
    try findings.add(a, "/p/a", .{ .masked = "generated" });
    _ = try reconcile(a, &settings.value, &record.value, "/p", findings);
    var entry = (try validateSettings(a, settings.value)).files[0];
    try testing.expectEqualStrings("mask", jsonio.getString(entry, "mode").?);
    try testing.expectEqualStrings("generated", jsonio.getString(entry, "extract").?);
    try testing.expect(entry.object.get("maskDuplicates").?.bool);
    try testing.expect(entry.object.get("injectHosts") == null);
    try testing.expectEqual(@as(i64, 7), entry.object.get("extra").?.integer);
    try testing.expect(record.value.object.get("extra").?.bool);
    findings.files.items[0].outcome = .{ .masked = null };
    _ = try reconcile(a, &settings.value, &record.value, "/p", findings);
    entry = (try validateSettings(a, settings.value)).files[0];
    try testing.expect(entry.object.get("extract") == null);
    try testing.expect(entry.object.get("maskDuplicates") == null);
    findings.files.items[0].outcome = .{ .masked = "regenerated" };
    _ = try reconcile(a, &settings.value, &record.value, "/p", findings);
    try testing.expect((try validateSettings(a, settings.value)).files[0].object.get("maskDuplicates").?.bool);
    findings.files.items[0].outcome = .{ .skipped = "coverage" };
    const removed = try reconcile(a, &settings.value, &record.value, "/p", findings);
    try testing.expect(removed.failed);
    try testing.expect(removed.events.items[0].action == .unmask);
    try testing.expectEqual(@as(usize, 0), (try validateSettings(a, settings.value)).files.len);
    try testing.expectEqual(@as(usize, 0), (try ownedPaths(a, record.value)).len);
}

test "reconcile: conflicts precede deletions and excluded unknown other roots survive" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var settings = try jsonio.parse(a,
        \\{"sandbox":{"filesystem":{"denyRead":["/p/deny"]},"credentials":{"files":[{"path":"/p/user"},{"path":"/p/duplicate"},{"path":"/p/duplicate"},{"path":"/p/deny"},{"path":"/p/unknown"},{"path":"/p/.git/owned"},{"path":"/pp/outside"},{"path":"/p/clean"}]}}}
    );
    var record = try jsonio.parse(a,
        \\{"credentialsFiles":["/p/duplicate","/p/deny","/p/unknown","/p/.git/owned","/pp/outside","/p/clean"]}
    );
    var findings = Findings{};
    for ([_][]const u8{ "/p/user", "/p/duplicate", "/p/deny", "/p/unknown", "/p/.git/owned", "/pp/outside", "/p/clean" }) |path| try findings.add(a, path, .clean);
    findings.files.items[0].outcome = .{ .masked = null };
    try findings.keep(a, "/p/unknown");
    try findings.keep(a, "/p/.git");
    const result = try reconcile(a, &settings.value, &record.value, "/p", findings);
    try testing.expect(!result.failed);
    try testing.expectEqual(@as(usize, 4), result.events.items.len);
    try testing.expectEqualStrings("existing-entry", result.events.items[0].reason.?);
    try testing.expectEqualStrings("existing-entry", result.events.items[1].reason.?);
    try testing.expectEqualStrings("denyread-conflict", result.events.items[2].reason.?);
    const owned = try ownedPaths(a, record.value);
    try testing.expectEqual(@as(usize, 5), owned.len);
    try testing.expect(!contains(owned, "/p/user"));
    try testing.expect(contains(owned, "/pp/outside"));
    try testing.expectEqual(@as(usize, 7), (try validateSettings(a, settings.value)).files.len);
}

test "reconcile: new skipped files succeed, root slash covers all absolute paths" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var settings = try jsonio.parse(a, "{}");
    var record = try jsonio.parse(a, "{\"credentialsFiles\":[]}");
    var findings = Findings{};
    try findings.add(a, "/a", .{ .skipped = "no-form" });
    var result = try reconcile(a, &settings.value, &record.value, "/", findings);
    try testing.expect(!result.failed);
    try testing.expect(settings.value.object.get("sandbox") == null);
    findings.files.items[0].outcome = .{ .masked = null };
    result = try reconcile(a, &settings.value, &record.value, "/", findings);
    const entry = (try validateSettings(a, settings.value)).files[0];
    try testing.expectEqual(@as(usize, 0), entry.object.get("injectHosts").?.array.items.len);
    try testing.expectEqualStrings("deny", jsonio.getString(entry, "onExtractNoMatch").?);
    try testing.expect(jsonio.getObject(settings.value, "sandbox").?.get("filesystem") == null);
    try testing.expect(!underRoot("/pp/x", "/p"));
    try testing.expect(!underRoot("/p", "/p"));
    try testing.expect(!underRoot("./x", "/"));
    try testing.expect(underRoot("/p/x", "/p"));
}

test "save: record failure restores exact bytes or removes new settings" {
    const Failing = struct {
        record: []const u8,
        fail_restore: bool = false,
        writes: usize = 0,
        fn write(context: ?*anyopaque, path: []const u8, data: []const u8) !void {
            const self: *@This() = @ptrCast(@alignCast(context.?));
            self.writes += 1;
            if (std.mem.eql(u8, path, self.record) or (self.fail_restore and self.writes == 3)) return error.AccessDenied;
            try Writer.writeFile(null, path, data);
        }
    };
    var temp = testing.tmpDir(.{});
    defer temp.cleanup();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const dir = try temp.dir.realpathAlloc(a, ".");
    const settings = try std.fs.path.join(a, &.{ dir, "settings.json" });
    const record = try std.fs.path.join(a, &.{ dir, "record.json" });
    const original = "{ \"original\": true }\n";
    try Writer.writeFile(null, settings, original);
    var failure = Failing{ .record = record };
    const writer = Writer{ .context = &failure, .writeFn = Failing.write };
    try testing.expectError(error.RecordWriteFailed, save(writer, settings, record, original, "changed", null, "record"));
    try testing.expectEqualStrings(original, (try readOptional(a, settings)).?);
    try std.fs.cwd().deleteFile(settings);
    try testing.expectError(error.RecordWriteFailed, save(writer, settings, record, null, "new", null, "record"));
    try testing.expect((try readOptional(a, settings)) == null);
    failure.writes = 0;
    failure.fail_restore = true;
    try testing.expectError(error.RestoreFailed, save(writer, settings, record, original, "changed", null, "record"));
    try testing.expectEqualStrings("changed", (try readOptional(a, settings)).?);
    failure.writes = 0;
    try save(writer, settings, record, "same", "same", "same", "same");
    try testing.expectEqual(@as(usize, 0), failure.writes);
    failure.fail_restore = false;
    failure.writes = 0;
    try save(writer, settings, record, "before", "after", "same", "same");
    try testing.expectEqual(@as(usize, 1), failure.writes);
    try testing.expectError(error.RecordWriteFailed, save(writer, settings, record, "same", "same", "before", "after"));
    try testing.expectEqual(@as(usize, 2), failure.writes);
}

test "settings parent resolves symlinks before dotdot and missing suffixes" {
    var temp = testing.tmpDir(.{});
    defer temp.cleanup();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try temp.dir.makePath("real/child");
    try temp.dir.makePath("real/.claude");
    try temp.dir.symLink("real/child", "alias", .{ .is_directory = true });
    const dir = try temp.dir.realpathAlloc(a, ".");
    const user = try std.fs.path.join(a, &.{ dir, "real/.claude/settings.json" });
    const alias = try std.fs.path.join(a, &.{ dir, "alias/../.claude/settings.json" });
    try testing.expectEqualStrings(user, try resolveSettings(a, alias, user));
    const missing = try std.fs.path.join(a, &.{ dir, "alias/new/.claude/settings.json" });
    try testing.expectError(error.ProjectSettings, resolveSettings(a, missing, user));
    const custom = try std.fs.path.join(a, &.{ dir, "alias/new/config.json" });
    const expected = try std.fs.path.join(a, &.{ dir, "real/child/new/config.json" });
    try testing.expectEqualStrings(expected, try resolveSettings(a, custom, user));
}

test "walk and reconcile never serialize secrets.load expansions" {
    var temp = testing.tmpDir(.{});
    defer temp.cleanup();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try temp.dir.writeFile(.{ .sub_path = "secrets", .data = "Decoy/Token9\n" });
    try temp.dir.writeFile(.{ .sub_path = "config", .data = "password=Decoy/Token9\nencoded=RGVjb3kvVG9rZW45\n" });
    const root = try temp.dir.realpathAlloc(a, ".");
    const secret_path = try std.fs.path.join(a, &.{ root, "secrets" });
    const path = try std.fs.path.join(a, &.{ root, "config" });
    const values = try secrets.load(a, secret_path);
    var findings = Findings{};
    var walk = Walk{ .allocator = a, .values = values, .secrets_path = secret_path, .findings = &findings };
    try walk.file(path);
    try testing.expect(findings.files.items[0].outcome == .masked);
    var settings = try jsonio.parse(a, "{}");
    var record = try jsonio.parse(a, "{\"credentialsFiles\":[]}");
    _ = try reconcile(a, &settings.value, &record.value, root, findings);
    try testing.expect(!mask.containsAny(try jsonio.stringifyPretty(a, settings.value), values));
    try testing.expect(!mask.containsAny(try jsonio.stringifyPretty(a, record.value), values));
}
