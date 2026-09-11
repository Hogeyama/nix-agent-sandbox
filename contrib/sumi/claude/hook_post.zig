//! PostToolUse / PostToolUseFailure: ツール出力の中の値を `*` に置き換える。

const std = @import("std");
const jsonio = @import("../jsonio.zig");
const secrets = @import("../secrets.zig");
const cli = @import("../main.zig");
const mask = @import("mask");

pub const SecretsResult = union(enum) { ok: []const []const u8, err: secrets.LoadError };
pub const Decision = union(enum) {
    pass,
    withhold: struct { event: []const u8, reason: []const u8 },
    report: []const u8,
    replace: struct { event: []const u8, tool_response_json: []u8 },

    pub fn deinit(self: *Decision, allocator: std.mem.Allocator) void {
        switch (self.*) {
            .replace => |r| {
                if (!std.mem.eql(u8, r.event, DEFAULT_EVENT) and !std.mem.eql(u8, r.event, FAILURE_EVENT)) allocator.free(r.event);
                allocator.free(r.tool_response_json);
            },
            .withhold => |w| if (!std.mem.eql(u8, w.event, DEFAULT_EVENT) and !std.mem.eql(u8, w.event, FAILURE_EVENT)) allocator.free(w.event),
            else => {},
        }
        self.* = undefined;
    }
};

const FAILURE_EVENT = "PostToolUseFailure";
const DEFAULT_EVENT = "PostToolUse";
const REPORT_TEXT = "sumi: a failed tool call carried a protected value to the model. A failure's output cannot be replaced by a hook, so mask Bash output at the source instead.";
const FALLBACK_WITHHOLD = "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"updatedToolOutput\":\"sumi: the post-tool hook failed, so this output was withheld.\"},\"systemMessage\":\"sumi: the post-tool hook failed, so this output was withheld.\"}";
const FALLBACK_REPORT = "{\"systemMessage\":\"sumi: the post-tool hook failed while handling PostToolUseFailure; this event's output cannot be replaced.\"}";

const Output = struct {
    context: *anyopaque,
    writeFn: *const fn (context: *anyopaque, bytes: []const u8) anyerror!void,

    fn write(self: Output, bytes: []const u8) !void {
        return self.writeFn(self.context, bytes);
    }
};

const HookArgs = struct { secrets_file: []const u8 };

fn parseArgs(args: []const []const u8) !HookArgs {
    var secrets_file: ?[]const u8 = null;
    var i: usize = 0;
    while (i < args.len) : (i += 2) {
        const name = args[i];
        if (!std.mem.eql(u8, name, "--secrets-file")) return error.UnknownOption;
        if (i + 1 == args.len or std.mem.startsWith(u8, args[i + 1], "--")) return error.MissingOptionValue;
        if (secrets_file != null) return error.DuplicateOption;
        secrets_file = args[i + 1];
    }
    return .{ .secrets_file = secrets_file orelse return error.MissingSecretsFile };
}

fn hexDigit(byte: u8) ?u8 {
    return switch (byte) {
        '0'...'9' => byte - '0',
        'a'...'f' => byte - 'a' + 10,
        'A'...'F' => byte - 'A' + 10,
        else => null,
    };
}

fn jsonStringEqualsAt(text: []const u8, start: usize, expected: []const u8) ?usize {
    if (start >= text.len or text[start] != '"') return null;
    var cursor = start + 1;
    for (expected) |expected_byte| {
        if (cursor >= text.len) return null;
        var decoded = text[cursor];
        if (decoded == '"') return null;
        cursor += 1;
        if (decoded == '\\') {
            if (cursor >= text.len) return null;
            const escaped = text[cursor];
            cursor += 1;
            decoded = switch (escaped) {
                '"', '\\', '/' => escaped,
                'b' => 8,
                'f' => 12,
                'n' => 10,
                'r' => 13,
                't' => 9,
                'u' => blk: {
                    if (cursor + 4 > text.len) return null;
                    const high = (hexDigit(text[cursor]) orelse return null) * 16 + (hexDigit(text[cursor + 1]) orelse return null);
                    const low = (hexDigit(text[cursor + 2]) orelse return null) * 16 + (hexDigit(text[cursor + 3]) orelse return null);
                    cursor += 4;
                    if (high != 0) return null;
                    break :blk low;
                },
                else => return null,
            };
        }
        if (decoded != expected_byte) return null;
    }
    if (cursor >= text.len or text[cursor] != '"') return null;
    return cursor + 1;
}

fn jsonStringEndAt(text: []const u8, start: usize) ?usize {
    if (start >= text.len or text[start] != '"') return null;
    var cursor = start + 1;
    var escaped = false;
    while (cursor < text.len) : (cursor += 1) {
        if (escaped) {
            escaped = false;
        } else if (text[cursor] == '\\') {
            escaped = true;
        } else if (text[cursor] == '"') {
            return cursor + 1;
        }
    }
    return null;
}

fn isFailurePayload(text: []const u8) bool {
    // Scanner validation is iterative. Use an allocator independent of the
    // hook arena so fallback classification still works when that arena is
    // exhausted and for valid documents far beyond the accepted depth.
    if (!(std.json.validate(std.heap.page_allocator, text) catch return false)) return false;

    var depth: usize = 0;
    var in_string = false;
    var escaped = false;
    var is_failure = false;
    var i: usize = 0;
    while (i < text.len) : (i += 1) {
        const byte = text[i];
        if (in_string) {
            if (escaped) escaped = false else if (byte == '\\') escaped = true else if (byte == '"') in_string = false;
            continue;
        }
        if (byte == '"' and depth == 1) {
            if (jsonStringEqualsAt(text, i, "hook_event_name")) |key_end| {
                var cursor = key_end;
                while (cursor < text.len and std.ascii.isWhitespace(text[cursor])) cursor += 1;
                if (cursor >= text.len or text[cursor] != ':') continue;
                cursor += 1;
                while (cursor < text.len and std.ascii.isWhitespace(text[cursor])) cursor += 1;
                if (cursor < text.len and text[cursor] == '"') {
                    const value_end = jsonStringEqualsAt(text, cursor, "PostToolUseFailure");
                    is_failure = value_end != null;
                    if (jsonStringEndAt(text, cursor)) |end| i = end - 1;
                } else {
                    is_failure = false;
                    if (cursor > 0) i = cursor - 1;
                }
                continue;
            }
        }
        switch (byte) {
            '"' => in_string = true,
            '{', '[' => depth += 1,
            '}', ']' => if (depth > 0) {
                depth -= 1;
            },
            else => {},
        }
    }
    return is_failure;
}

fn fallbackForText(text: []const u8) []const u8 {
    return if (isFailurePayload(text)) FALLBACK_REPORT else FALLBACK_WITHHOLD;
}

fn fallbackForDecision(d: Decision) []const u8 {
    return switch (d) {
        .report => FALLBACK_REPORT,
        else => FALLBACK_WITHHOLD,
    };
}

pub fn decide(allocator: std.mem.Allocator, text: []const u8, list: SecretsResult) !Decision {
    var parsed = jsonio.parse(allocator, text) catch |err| {
        if (err == error.OutOfMemory or err == error.JsonTooDeep) return err;
        return switch (list) {
            .ok => .{ .withhold = .{ .event = DEFAULT_EVENT, .reason = "the hook payload is not valid JSON" } },
            .err => |e| .{ .withhold = .{ .event = DEFAULT_EVENT, .reason = secrets.describe(e) } },
        };
    };
    defer parsed.deinit();
    const event_text = jsonio.getString(parsed.value, "hook_event_name") orelse DEFAULT_EVENT;
    const event = if (std.mem.eql(u8, event_text, DEFAULT_EVENT)) DEFAULT_EVENT else if (std.mem.eql(u8, event_text, FAILURE_EVENT)) FAILURE_EVENT else try allocator.dupe(u8, event_text);
    var event_owned = !std.mem.eql(u8, event, DEFAULT_EVENT) and !std.mem.eql(u8, event, FAILURE_EVENT);
    errdefer if (event_owned) allocator.free(event);
    const is_failure = std.mem.eql(u8, event, FAILURE_EVENT);
    const values = switch (list) {
        .ok => |v| v,
        .err => |e| {
            if (is_failure) {
                if (event_owned) allocator.free(event);
                event_owned = false;
                return .{ .report = REPORT_TEXT };
            }
            return .{ .withhold = .{ .event = event, .reason = secrets.describe(e) } };
        },
    };
    if (is_failure) {
        const failure = jsonio.getString(parsed.value, "error") orelse {
            if (event_owned) allocator.free(event);
            event_owned = false;
            return .pass;
        };
        if (mask.containsAny(failure, values)) {
            if (event_owned) allocator.free(event);
            event_owned = false;
            return .{ .report = REPORT_TEXT };
        }
        if (event_owned) allocator.free(event);
        event_owned = false;
        return .pass;
    }
    const response = blk: {
        if (parsed.value != .object) {
            if (event_owned) allocator.free(event);
            event_owned = false;
            return .pass;
        }
        break :blk parsed.value.object.getPtr("tool_response") orelse {
            if (event_owned) allocator.free(event);
            event_owned = false;
            return .pass;
        };
    };
    const changed = try jsonio.maskValue(parsed.arena.allocator(), response, values);
    if (!changed) {
        if (event_owned) allocator.free(event);
        event_owned = false;
        return .pass;
    }
    const json = try jsonio.stringify(allocator, response.*);
    event_owned = false;
    return .{ .replace = .{ .event = event, .tool_response_json = json } };
}

pub fn render(allocator: std.mem.Allocator, d: Decision) !?[]u8 {
    switch (d) {
        .pass => return null,
        .withhold => |w| {
            const notice = try std.fmt.allocPrint(allocator, "sumi: {s}, so this output was withheld.", .{w.reason});
            defer allocator.free(notice);
            const q = try jsonio.quoteString(allocator, notice);
            defer allocator.free(q);
            const event_q = try jsonio.quoteString(allocator, w.event);
            defer allocator.free(event_q);
            return try std.fmt.allocPrint(allocator, "{{\"hookSpecificOutput\":{{\"hookEventName\":{s},\"updatedToolOutput\":{s}}},\"systemMessage\":{s}}}", .{ event_q, q, q });
        },
        .report => |r| {
            const q = try jsonio.quoteString(allocator, r);
            defer allocator.free(q);
            return try std.fmt.allocPrint(allocator, "{{\"systemMessage\":{s}}}", .{q});
        },
        .replace => |r| {
            const event_q = try jsonio.quoteString(allocator, r.event);
            defer allocator.free(event_q);
            return try std.fmt.allocPrint(allocator, "{{\"hookSpecificOutput\":{{\"hookEventName\":{s},\"updatedToolOutput\":{s}}},\"systemMessage\":\"sumi: masked a protected value in this tool output.\"}}", .{ event_q, r.tool_response_json });
        },
    }
}

fn emitDecision(allocator: std.mem.Allocator, d: Decision, output: Output) !void {
    const rendered = render(allocator, d) catch return output.write(fallbackForDecision(d));
    if (rendered) |out| {
        defer allocator.free(out);
        try output.write(out);
    }
}

fn runHook(allocator: std.mem.Allocator, text: []const u8, list: SecretsResult, output: Output) !void {
    var d = decide(allocator, text, list) catch return output.write(fallbackForText(text));
    defer d.deinit(allocator);
    return emitDecision(allocator, d, output);
}

fn writeStdout(_: *anyopaque, bytes: []const u8) !void {
    return jsonio.writeStdout(bytes);
}

pub fn main(allocator: std.mem.Allocator, args: []const []const u8) !u8 {
    const parsed_args = parseArgs(args) catch return cli.usage("invalid post-tool arguments");
    const secrets_file = parsed_args.secrets_file;
    var output_context: u8 = 0;
    const output: Output = .{ .context = &output_context, .writeFn = writeStdout };
    const text = jsonio.readStdin(allocator) catch |read_err| {
        output.write(FALLBACK_WITHHOLD) catch |write_err| {
            std.debug.print("sumi: post-tool could not write its fallback decision after read error {}: {}\n", .{ read_err, write_err });
        };
        return 0;
    };
    const list: SecretsResult = if (secrets.load(allocator, secrets_file)) |v| .{ .ok = v } else |e| .{ .err = e };
    runHook(allocator, text, list, output) catch |write_err| {
        std.debug.print("sumi: post-tool could not write its decision: {}\n", .{write_err});
    };
    return 0;
}

const testing = std.testing;
const decoy = "Tr0ub4dor";
fn decideText(text: []const u8, list: []const []const u8) !Decision {
    return decide(testing.allocator, text, .{ .ok = list });
}

test "parseArgs: post-tool consumes exactly one secrets option" {
    const got = try parseArgs(&.{ "--secrets-file", "/s" });
    try testing.expectEqualStrings("/s", got.secrets_file);
    try testing.expectError(error.DuplicateOption, parseArgs(&.{ "--secrets-file", "/s", "--secrets-file", "/other" }));
    try testing.expectError(error.UnknownOption, parseArgs(&.{ "--secrets-file", "/s", "--wat", "x" }));
    try testing.expectError(error.MissingOptionValue, parseArgs(&.{"--secrets-file"}));
    try testing.expectError(error.UnknownOption, parseArgs(&.{ "--secrets-file", "/s", "stray" }));
}

test "decide: a masked tool_response is replaced" {
    var d = try decideText("{\"hook_event_name\":\"PostToolUse\",\"tool_response\":{\"stdout\":\"pw=Tr0ub4dor\",\"stderr\":\"\"}}", &.{decoy});
    defer d.deinit(testing.allocator);
    try testing.expectEqualStrings("PostToolUse", d.replace.event);
    try testing.expectEqualStrings("{\"stdout\":\"pw=*********\",\"stderr\":\"\"}", d.replace.tool_response_json);
}
test "decide: unrelated output passes" {
    var d = try decideText("{\"tool_response\":{\"stdout\":\"README.md\\n\"}}", &.{decoy});
    defer d.deinit(testing.allocator);
    try testing.expectEqual(Decision.pass, d);
}
test "decide: a value only in tool_input does not trigger a replacement" {
    var d = try decideText("{\"tool_input\":{\"command\":\"echo Tr0ub4dor\"},\"tool_response\":{\"stdout\":\"done\"}}", &.{decoy});
    defer d.deinit(testing.allocator);
    try testing.expectEqual(Decision.pass, d);
}
test "decide: a value that JSON-escapes is still masked" {
    var d = try decideText("{\"tool_response\":{\"stdout\":\"pass=ab\\\"cd-decoy\"}}", &.{"ab\"cd-decoy"});
    defer d.deinit(testing.allocator);
    try testing.expectEqualStrings("{\"stdout\":\"pass=***********\"}", d.replace.tool_response_json);
}
test "decide: unreadable secrets withholds a PostToolUse payload" {
    var d = try decide(testing.allocator, "{\"tool_response\":{\"stdout\":\"x\"}}", .{ .err = error.Unreadable });
    defer d.deinit(testing.allocator);
    try testing.expectEqualStrings("PostToolUse", d.withhold.event);
}
test "decide: unreadable secrets on a failure payload can only report" {
    var d = try decide(testing.allocator, "{\"hook_event_name\":\"PostToolUseFailure\",\"error\":\"x\"}", .{ .err = error.Unreadable });
    defer d.deinit(testing.allocator);
    try testing.expect(d == .report);
}
test "decide: unparseable payload withholds under PostToolUse" {
    var d = try decideText("not json", &.{decoy});
    defer d.deinit(testing.allocator);
    try testing.expectEqualStrings("PostToolUse", d.withhold.event);
}
test "decide: a failure carrying the value is reported, not replaced" {
    var d = try decideText("{\"hook_event_name\":\"PostToolUseFailure\",\"error\":\"Exit code 1\\npw=Tr0ub4dor\"}", &.{decoy});
    defer d.deinit(testing.allocator);
    try testing.expect(d == .report);
}
test "decide: a failure without the value passes" {
    var d = try decideText("{\"hook_event_name\":\"PostToolUseFailure\",\"error\":\"Exit code 1\\nno such file\"}", &.{decoy});
    defer d.deinit(testing.allocator);
    try testing.expectEqual(Decision.pass, d);
}
test "decide: the failure event name is echoed on a replacement-capable payload" {
    var d = try decideText("{\"hook_event_name\":\"PostToolUse\",\"tool_name\":\"Read\",\"tool_response\":{\"file\":{\"content\":\"db.password=Tr0ub4dor\"}}}", &.{decoy});
    defer d.deinit(testing.allocator);
    try testing.expectEqualStrings("{\"file\":{\"content\":\"db.password=*********\"}}", d.replace.tool_response_json);
}
test "render: replace carries updatedToolOutput and a systemMessage" {
    const json = try testing.allocator.dupe(u8, "{\"stdout\":\"***\"}");
    var d: Decision = .{ .replace = .{ .event = "PostToolUse", .tool_response_json = json } };
    defer d.deinit(testing.allocator);
    const out = (try render(testing.allocator, d)).?;
    defer testing.allocator.free(out);
    try testing.expectEqualStrings("{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"updatedToolOutput\":{\"stdout\":\"***\"}},\"systemMessage\":\"sumi: masked a protected value in this tool output.\"}", out);
}
test "render: pass produces no output" {
    try testing.expectEqual(@as(?[]u8, null), try render(testing.allocator, .pass));
}

const TestSink = struct {
    bytes: []const u8 = "",
    fail: bool = false,

    fn write(context: *anyopaque, bytes: []const u8) anyerror!void {
        const self: *TestSink = @ptrCast(@alignCast(context));
        if (self.fail) return error.BrokenPipe;
        self.bytes = bytes;
    }
};

test "orchestration: allocator failure emits a static withhold decision" {
    var sink = TestSink{};
    try runHook(testing.failing_allocator, "{}", .{ .ok = &.{decoy} }, .{ .context = &sink, .writeFn = TestSink.write });
    try testing.expect(std.mem.indexOf(u8, sink.bytes, "updatedToolOutput") != null);
    try testing.expect(std.mem.indexOf(u8, sink.bytes, "PostToolUse") != null);
}

test "orchestration: allocator failure on recognized failure event only reports" {
    try testing.expect(isFailurePayload("{\"hook_event_name\":\"PostToolUseFailure\",\"error\":\"x\"}"));
    var sink = TestSink{};
    try runHook(testing.failing_allocator, "{\"hook_event_name\":\"PostToolUseFailure\",\"error\":\"x\"}", .{ .ok = &.{decoy} }, .{ .context = &sink, .writeFn = TestSink.write });
    try testing.expect(std.mem.indexOf(u8, sink.bytes, "systemMessage") != null);
    try testing.expect(std.mem.indexOf(u8, sink.bytes, "updatedToolOutput") == null);
}

test "orchestration: excessive depth on a failure event only reports" {
    const prefix = "{\"hook_event_name\":\"PostToolUseFailure\",\"error\":\"x\",\"nested\":";
    const depth = jsonio.MAX_INPUT_DEPTH;
    const text = try testing.allocator.alloc(u8, prefix.len + depth + 1 + depth + 1);
    defer testing.allocator.free(text);
    @memcpy(text[0..prefix.len], prefix);
    @memset(text[prefix.len .. prefix.len + depth], '[');
    text[prefix.len + depth] = '0';
    @memset(text[prefix.len + depth + 1 .. text.len - 1], ']');
    text[text.len - 1] = '}';

    try testing.expectError(error.JsonTooDeep, decideText(text, &.{decoy}));
    const fallback = fallbackForText(text);
    try testing.expect(std.mem.indexOf(u8, fallback, "systemMessage") != null);
    try testing.expect(std.mem.indexOf(u8, fallback, "updatedToolOutput") == null);
}

test "orchestration: allocator failure follows the last duplicate event name" {
    var withhold_sink = TestSink{};
    try runHook(testing.failing_allocator, "{\"hook_event_name\":\"PostToolUseFailure\",\"hook_event_name\":\"PostToolUse\",\"error\":\"x\"}", .{ .ok = &.{decoy} }, .{ .context = &withhold_sink, .writeFn = TestSink.write });
    try testing.expect(std.mem.indexOf(u8, withhold_sink.bytes, "updatedToolOutput") != null);

    var report_sink = TestSink{};
    try runHook(testing.failing_allocator, "{\"hook_event_name\":\"PostToolUse\",\"hook_event_name\":\"PostToolUseFailure\",\"error\":\"x\"}", .{ .ok = &.{decoy} }, .{ .context = &report_sink, .writeFn = TestSink.write });
    try testing.expect(std.mem.indexOf(u8, report_sink.bytes, "updatedToolOutput") == null);
    try testing.expect(std.mem.indexOf(u8, report_sink.bytes, "systemMessage") != null);
}

test "orchestration: allocator failure decodes escaped duplicate event keys" {
    var sink = TestSink{};
    try runHook(testing.failing_allocator, "{\"hook_event_name\":\"PostToolUseFailure\",\"\\u0068ook_event_name\":\"PostToolUse\",\"error\":\"x\"}", .{ .ok = &.{decoy} }, .{ .context = &sink, .writeFn = TestSink.write });
    try testing.expect(std.mem.indexOf(u8, sink.bytes, "updatedToolOutput") != null);
    try testing.expect(std.mem.indexOf(u8, sink.bytes, "PostToolUseFailure") == null);
}

test "orchestration: malformed failure events withhold on allocator failure" {
    var malformed_sink = TestSink{};
    try runHook(testing.failing_allocator, "{\"hook_event_name\":\"PostToolUseFailure\",\"error\":\"x\"", .{ .ok = &.{decoy} }, .{ .context = &malformed_sink, .writeFn = TestSink.write });
    try testing.expect(std.mem.indexOf(u8, malformed_sink.bytes, "updatedToolOutput") != null);

    var trailing_sink = TestSink{};
    try runHook(testing.failing_allocator, "{\"hook_event_name\":\"PostToolUseFailure\",\"error\":\"x\"} trailing", .{ .ok = &.{decoy} }, .{ .context = &trailing_sink, .writeFn = TestSink.write });
    try testing.expect(std.mem.indexOf(u8, trailing_sink.bytes, "updatedToolOutput") != null);
}

test "orchestration: render allocation failure uses a decision-specific static fallback" {
    var withhold_sink = TestSink{};
    try emitDecision(testing.failing_allocator, .{ .withhold = .{ .event = DEFAULT_EVENT, .reason = "reason" } }, .{ .context = &withhold_sink, .writeFn = TestSink.write });
    try testing.expect(std.mem.indexOf(u8, withhold_sink.bytes, "updatedToolOutput") != null);

    var report_sink = TestSink{};
    try emitDecision(testing.failing_allocator, .{ .report = REPORT_TEXT }, .{ .context = &report_sink, .writeFn = TestSink.write });
    try testing.expect(std.mem.indexOf(u8, report_sink.bytes, "systemMessage") != null);
    try testing.expect(std.mem.indexOf(u8, report_sink.bytes, "updatedToolOutput") == null);
}

test "orchestration: stdout failure is returned to the caller" {
    var sink = TestSink{ .fail = true };
    try testing.expectError(error.BrokenPipe, runHook(testing.failing_allocator, "{}", .{ .ok = &.{decoy} }, .{ .context = &sink, .writeFn = TestSink.write }));
}
