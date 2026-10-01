//! Codex and Copilot output adapters. Never echo a payload on errors.
const std = @import("std");
const cli = @import("main.zig");
const jsonio = @import("jsonio.zig");
const masker = @import("masker.zig");

pub const Event = enum { post_tool, prompt };
const NOTICE = "sumi: masking could not complete, so this content was withheld.";
// Copilot truncates command-hook stdout at 10 MiB. Stay below that limit so
// truncated JSON cannot silently discard our replacement and restore plaintext.
const MAX_OUTPUT = 8 * 1024 * 1024;
const DEADLINE_SECONDS = 15;

fn fallback(comptime agent: cli.Agent, comptime event: Event) []const u8 {
    return switch (agent) {
        .codex => "{\"decision\":\"block\",\"reason\":\"" ++ NOTICE ++ "\"}",
        .copilot => if (event == .prompt)
            "{\"modifiedTransformedPrompt\":\"" ++ NOTICE ++ "\"}"
        else
            "{\"modifiedResult\":{\"resultType\":\"success\",\"textResultForLlm\":\"" ++ NOTICE ++ "\"}}",
        .claude => @compileError("Claude has its own hook adapter"),
    };
}

fn replacement(a: std.mem.Allocator, comptime agent: cli.Agent, comptime event: Event, content: []const u8) ![]u8 {
    const quoted = try jsonio.quoteString(a, content);
    defer a.free(quoted);
    // Codex does not implement updatedToolOutput. A blocking PostToolUse
    // replaces the original result with feedback, including for code-mode
    // nested calls, which reject with this already-masked reason.
    return switch (agent) {
        .codex => std.fmt.allocPrint(a, "{{\"decision\":\"block\",\"reason\":{s}}}", .{quoted}),
        .copilot => if (event == .prompt)
            std.fmt.allocPrint(a, "{{\"modifiedTransformedPrompt\":{s}}}", .{quoted})
        else
            std.fmt.allocPrint(a, "{{\"modifiedResult\":{{\"resultType\":\"success\",\"textResultForLlm\":{s}}}}}", .{quoted}),
        .claude => @compileError("Claude has its own hook adapter"),
    };
}

fn transform(a: std.mem.Allocator, comptime agent: cli.Agent, comptime event: Event, text: []const u8, resolved: masker.Resolved) !?[]u8 {
    const values = switch (resolved) {
        .ok => |m| m,
        .err => return error.MaskUnavailable,
    };
    var parsed = try jsonio.parse(a, text);
    defer parsed.deinit();
    if (parsed.value != .object) return error.InvalidPayload;
    const value: *std.json.Value = if (agent == .codex)
        parsed.value.object.getPtr("tool_response") orelse return error.InvalidPayload
    else if (event == .prompt)
        parsed.value.object.getPtr("transformedPrompt") orelse return error.InvalidPayload
    else blk: {
        const result = parsed.value.object.getPtr("toolResult") orelse return error.InvalidPayload;
        const kind = jsonio.getString(result.*, "resultType") orelse return error.InvalidPayload;
        if (!std.mem.eql(u8, kind, "success")) return error.InvalidPayload;
        break :blk result.object.getPtr("textResultForLlm") orelse return error.InvalidPayload;
    };
    if (agent == .copilot and value.* != .string) return error.InvalidPayload;
    if (!try jsonio.maskValue(parsed.arena.allocator(), value, values)) return null;
    if (value.* == .string) return try replacement(a, agent, event, value.string);
    const json = try jsonio.stringify(a, value.*);
    defer a.free(json);
    return try replacement(a, agent, event, json);
}

/// Owned output, or null for a clean payload. Errors always replace content.
pub fn respond(a: std.mem.Allocator, comptime agent: cli.Agent, comptime event: Event, text: []const u8, resolved: masker.Resolved) !?[]u8 {
    const output = transform(a, agent, event, text, resolved) catch
        return try a.dupe(u8, fallback(agent, event));
    if (output) |bytes| {
        if (bytes.len > MAX_OUTPUT) {
            a.free(bytes);
            return try a.dupe(u8, fallback(agent, event));
        }
    }
    return output;
}

fn Deadline(comptime agent: cli.Agent, comptime event: Event) type {
    return struct {
        fn expired(_: i32) callconv(.c) void {
            const output = comptime fallback(agent, event) ++ "\n";
            _ = std.c.write(std.posix.STDOUT_FILENO, output.ptr, output.len);
            std.c._exit(0);
        }
    };
}

pub fn main(a: std.mem.Allocator, comptime agent: cli.Agent, comptime event: Event, args: []const []const u8) !u8 {
    var source = masker.SourceOption{};
    var i: usize = 0;
    while (i < args.len) : (i += 2) {
        if (!masker.SourceOption.isName(args[i]) or i + 1 == args.len or std.mem.startsWith(u8, args[i + 1], "--"))
            return cli.usage("hook requires --server ADDR or --secrets-file FILE");
        source.take(args[i], args[i + 1]) catch return cli.usage("hook requires exactly one masking source");
    }
    const selected = source.finish() catch return cli.usage("hook requires a masking source");
    const action: std.posix.Sigaction = .{ .handler = .{ .handler = Deadline(agent, event).expired }, .mask = std.posix.sigemptyset(), .flags = 0 };
    var previous: std.posix.Sigaction = undefined;
    std.posix.sigaction(std.posix.SIG.ALRM, &action, &previous);
    _ = std.c.alarm(DEADLINE_SECONDS);
    defer {
        _ = std.c.alarm(0);
        std.posix.sigaction(std.posix.SIG.ALRM, &previous, null);
    }
    const text = jsonio.readStdin(a) catch {
        _ = std.c.alarm(0);
        try jsonio.writeStdout(fallback(agent, event));
        return 0;
    };
    defer a.free(text);
    const output = respond(a, agent, event, text, masker.resolve(a, selected)) catch {
        _ = std.c.alarm(0);
        try jsonio.writeStdout(fallback(agent, event));
        return 0;
    };
    // Never append a deadline response halfway through a normal JSON write.
    // Mixed output is invalid JSON and the CLI could retain the raw result.
    _ = std.c.alarm(0);
    if (output) |bytes| {
        defer a.free(bytes);
        try jsonio.writeStdout(bytes);
    }
    return 0;
}

const testing = std.testing;
const secret = "Tr0ub4dor";
const local: masker.Resolved = .{ .ok = .{ .values = &.{secret} } };

test "Codex uses masked feedback for text, structured keys, and escaped values" {
    inline for (.{
        "{\"tool_response\":\"pw=Tr0ub4dor\"}",
        "{\"tool_response\":{\"Tr0ub4dor\":[\"pw=Tr0ub4dor\"]}}",
        "{\"tool_response\":\"pw=Tr0ub4dor\\nquoted=\\\"Tr0ub4dor\\\"\"}",
    }) |payload| {
        const output = (try respond(testing.allocator, .codex, .post_tool, payload, local)).?;
        defer testing.allocator.free(output);
        try testing.expect(std.mem.indexOf(u8, output, secret) == null);
        var parsed = try jsonio.parse(testing.allocator, output);
        defer parsed.deinit();
        try testing.expectEqualStrings("block", jsonio.getString(parsed.value, "decision").?);
        try testing.expect(std.mem.indexOf(u8, jsonio.getString(parsed.value, "reason").?, "*********") != null);
        try testing.expect(parsed.value.object.get("hookSpecificOutput") == null);
    }
}

test "Copilot masks only model-facing text and preserves the success contract" {
    const payload = "{\"toolArgs\":{\"x\":\"Tr0ub4dor\"},\"toolResult\":{\"resultType\":\"success\",\"textResultForLlm\":\"pw=Tr0ub4dor\"}}";
    const output = (try respond(testing.allocator, .copilot, .post_tool, payload, local)).?;
    defer testing.allocator.free(output);
    try testing.expectEqualStrings("{\"modifiedResult\":{\"resultType\":\"success\",\"textResultForLlm\":\"pw=*********\"}}", output);
}

test "Copilot masks transformed prompt including attached content" {
    const output = (try respond(testing.allocator, .copilot, .prompt, "{\"prompt\":\"@file\",\"transformedPrompt\":\"file content: Tr0ub4dor\"}", local)).?;
    defer testing.allocator.free(output);
    try testing.expectEqualStrings("{\"modifiedTransformedPrompt\":\"file content: *********\"}", output);
}

test "clean payloads do not replace output, regardless of secrets in tool input" {
    try testing.expectEqual(@as(?[]u8, null), try respond(testing.allocator, .codex, .post_tool, "{\"tool_input\":\"Tr0ub4dor\",\"tool_response\":\"clean\"}", local));
    try testing.expectEqual(@as(?[]u8, null), try respond(testing.allocator, .copilot, .post_tool, "{\"toolResult\":{\"resultType\":\"success\",\"textResultForLlm\":\"clean\"}}", local));
    try testing.expectEqual(@as(?[]u8, null), try respond(testing.allocator, .copilot, .prompt, "{\"transformedPrompt\":\"clean\"}", local));
}

test "malformed or missing payloads and an unavailable masking source withhold" {
    inline for (.{ cli.Agent.codex, cli.Agent.copilot }) |agent| {
        inline for (.{ "not JSON", "{}", "{\"toolResult\":{\"resultType\":\"failure\",\"textResultForLlm\":\"Tr0ub4dor\"}}" }) |payload| {
            const output = (try respond(testing.allocator, agent, .post_tool, payload, local)).?;
            defer testing.allocator.free(output);
            try testing.expectEqualStrings(fallback(agent, .post_tool), output);
        }
        const output = (try respond(testing.allocator, agent, .post_tool, "{}", .{ .err = "unavailable" })).?;
        defer testing.allocator.free(output);
        try testing.expectEqualStrings(fallback(agent, .post_tool), output);
    }
    const output = (try respond(testing.allocator, .copilot, .prompt, "{}", local)).?;
    defer testing.allocator.free(output);
    try testing.expectEqualStrings(fallback(.copilot, .prompt), output);
}

test "Copilot withholds a replacement larger than the command output limit" {
    const large = try testing.allocator.alloc(u8, MAX_OUTPUT + 1);
    defer testing.allocator.free(large);
    @memset(large, 'a');
    @memcpy(large[0..secret.len], secret);
    const quoted = try jsonio.quoteString(testing.allocator, large);
    defer testing.allocator.free(quoted);
    const payload = try std.fmt.allocPrint(testing.allocator, "{{\"transformedPrompt\":{s}}}", .{quoted});
    defer testing.allocator.free(payload);
    const output = (try respond(testing.allocator, .copilot, .prompt, payload, local)).?;
    defer testing.allocator.free(output);
    try testing.expectEqualStrings(fallback(.copilot, .prompt), output);
}
