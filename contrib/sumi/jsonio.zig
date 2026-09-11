//! hook のペイロード (JSON) の読み書きと、`std.json.Value` の文字列リーフのマスク。
//!
//! JSON テキストではなく parse 後の値をマスクする。値が引用符やバックスラッシュ、
//! `\uXXXX` を含んでいてもデコード後のバイト列で一致し、JSON の構造トークンや数値と
//! 同じ綴りの値を secrets に置いても構造が壊れない。数値・真偽値・null のリーフは
//! 対象にしない。

const std = @import("std");
const mask = @import("mask");

pub const MAX_PAYLOAD: usize = 64 * 1024 * 1024;
/// Input is kept well below std.json.Stringify's fixed 256-container stack so
/// recursive visitors stay bounded and generated hook/settings objects have
/// room to add their own containers.
pub const MAX_INPUT_DEPTH: usize = 128;
const MAX_SERIALIZE_DEPTH: usize = MAX_INPUT_DEPTH + 32;

pub fn readStdin(allocator: std.mem.Allocator) ![]u8 {
    return std.fs.File.stdin().readToEndAlloc(allocator, MAX_PAYLOAD);
}

pub fn writeStdout(bytes: []const u8) !void {
    const out = std.fs.File.stdout();
    try out.writeAll(bytes);
    try out.writeAll("\n");
}

pub fn parse(allocator: std.mem.Allocator, text: []const u8) !std.json.Parsed(std.json.Value) {
    try ensureTextDepth(text, MAX_INPUT_DEPTH);
    return std.json.parseFromSlice(std.json.Value, allocator, text, .{
        .duplicate_field_behavior = .use_last,
    });
}

fn ensureTextDepth(text: []const u8, max_depth: usize) !void {
    var depth: usize = 0;
    var in_string = false;
    var escaped = false;
    for (text) |byte| {
        if (in_string) {
            if (escaped) {
                escaped = false;
            } else if (byte == '\\') {
                escaped = true;
            } else if (byte == '"') {
                in_string = false;
            }
            continue;
        }
        switch (byte) {
            '"' => in_string = true,
            '{', '[' => {
                depth += 1;
                if (depth > max_depth) return error.JsonTooDeep;
            },
            '}', ']' => if (depth > 0) {
                depth -= 1;
            },
            else => {},
        }
    }
}

const DepthFrame = struct {
    value: *const std.json.Value,
    next_child: usize,
    depth: usize,
};

/// Validate a parsed or programmatically generated tree without recursion.
fn ensureValueDepth(value: *const std.json.Value, max_depth: usize) !void {
    var stack: [MAX_SERIALIZE_DEPTH]DepthFrame = undefined;
    var stack_len: usize = 0;

    const root_is_container = value.* == .array or value.* == .object;
    if (!root_is_container) return;
    if (max_depth == 0) return error.JsonTooDeep;
    stack[0] = .{ .value = value, .next_child = 0, .depth = 1 };
    stack_len = 1;

    while (stack_len > 0) {
        const frame = &stack[stack_len - 1];
        const child: ?*const std.json.Value = switch (frame.value.*) {
            .array => |array| if (frame.next_child < array.items.len) &array.items[frame.next_child] else null,
            .object => |object| blk: {
                const values = object.values();
                break :blk if (frame.next_child < values.len) &values[frame.next_child] else null;
            },
            else => unreachable,
        };
        if (child) |next| {
            frame.next_child += 1;
            if (next.* != .array and next.* != .object) continue;
            const child_depth = frame.depth + 1;
            if (child_depth > max_depth) return error.JsonTooDeep;
            stack[stack_len] = .{ .value = next, .next_child = 0, .depth = child_depth };
            stack_len += 1;
        } else {
            stack_len -= 1;
        }
    }
}

/// s の中の secrets を '*' に置き換えた新しいバッファを返す。変化が無ければ null。
fn maskCopy(allocator: std.mem.Allocator, s: []const u8, secrets: []const []const u8) !?[]u8 {
    if (!mask.containsAny(s, secrets)) return null;
    const copy = try allocator.dupe(u8, s);
    mask.maskAll(copy, secrets, null);
    return copy;
}

fn maskValueUnchecked(allocator: std.mem.Allocator, v: *std.json.Value, secrets: []const []const u8) !bool {
    var changed = false;
    switch (v.*) {
        .string => |s| {
            if (try maskCopy(allocator, s, secrets)) |m| {
                v.* = .{ .string = m };
                changed = true;
            }
        },
        .array => |*arr| {
            for (arr.items) |*item| {
                if (try maskValueUnchecked(allocator, item, secrets)) changed = true;
            }
        },
        .object => |*obj| {
            const keys = obj.keys();
            const values = obj.values();
            var key_changed = false;
            for (keys, values) |*k, *val| {
                if (try maskCopy(allocator, k.*, secrets)) |m| {
                    k.* = m;
                    changed = true;
                    key_changed = true;
                }
                if (try maskValueUnchecked(allocator, val, secrets)) changed = true;
            }
            // キーを直接書き換えた後は、ハッシュ索引が古いキーを指したまま残る
            // (std.json.ObjectMap = StringArrayHashMap は要素数が linear_scan_max
            // を超えると索引を持つ)。索引を作り直さない限り、この後の
            // get/getPtr/put がこのオブジェクトに対して不正な結果を返す。
            if (key_changed) try obj.reIndex();
        },
        else => {},
    }
    return changed;
}

pub fn maskValue(allocator: std.mem.Allocator, v: *std.json.Value, secrets: []const []const u8) !bool {
    try ensureValueDepth(v, MAX_INPUT_DEPTH);
    return maskValueUnchecked(allocator, v, secrets);
}

pub fn stringify(allocator: std.mem.Allocator, v: std.json.Value) ![]u8 {
    try ensureValueDepth(&v, MAX_SERIALIZE_DEPTH);
    return std.json.Stringify.valueAlloc(allocator, v, .{});
}

pub fn stringifyPretty(allocator: std.mem.Allocator, v: std.json.Value) ![]u8 {
    try ensureValueDepth(&v, MAX_SERIALIZE_DEPTH);
    return std.json.Stringify.valueAlloc(allocator, v, .{ .whitespace = .indent_2 });
}

pub fn quoteString(allocator: std.mem.Allocator, s: []const u8) ![]u8 {
    return std.json.Stringify.valueAlloc(allocator, s, .{});
}

pub fn getString(v: std.json.Value, key: []const u8) ?[]const u8 {
    if (v != .object) return null;
    const child = v.object.get(key) orelse return null;
    return if (child == .string) child.string else null;
}

pub fn getObject(v: std.json.Value, key: []const u8) ?*std.json.ObjectMap {
    if (v != .object) return null;
    const child = v.object.getPtr(key) orelse return null;
    return if (child.* == .object) &child.object else null;
}

const testing = std.testing;

test "maskValue: string leaves are masked in place and report a change" {
    var parsed = try parse(testing.allocator, "{\"a\":\"x Tr0ub4dor y\",\"n\":1234,\"b\":true}");
    defer parsed.deinit();
    const changed = try maskValue(parsed.arena.allocator(), &parsed.value, &.{"Tr0ub4dor"});
    try testing.expect(changed);
    const out = try stringify(testing.allocator, parsed.value);
    defer testing.allocator.free(out);
    try testing.expectEqualStrings("{\"a\":\"x ********* y\",\"n\":1234,\"b\":true}", out);
}

test "maskValue: escaped characters inside a value are matched after decoding" {
    var parsed = try parse(testing.allocator, "{\"s\":\"pass=ab\\\"cd-decoy\"}");
    defer parsed.deinit();
    const changed = try maskValue(parsed.arena.allocator(), &parsed.value, &.{"ab\"cd-decoy"});
    try testing.expect(changed);
    const out = try stringify(testing.allocator, parsed.value);
    defer testing.allocator.free(out);
    try testing.expectEqualStrings("{\"s\":\"pass=***********\"}", out);
}

test "maskValue: object keys are masked too" {
    var parsed = try parse(testing.allocator, "{\"Tr0ub4dor\":\"v\"}");
    defer parsed.deinit();
    _ = try maskValue(parsed.arena.allocator(), &parsed.value, &.{"Tr0ub4dor"});
    const out = try stringify(testing.allocator, parsed.value);
    defer testing.allocator.free(out);
    try testing.expectEqualStrings("{\"*********\":\"v\"}", out);
}

test "maskValue: a secret equal to a JSON token does not break structure" {
    var parsed = try parse(testing.allocator, "{\"ok\":true,\"s\":\"true\"}");
    defer parsed.deinit();
    _ = try maskValue(parsed.arena.allocator(), &parsed.value, &.{"true"});
    const out = try stringify(testing.allocator, parsed.value);
    defer testing.allocator.free(out);
    try testing.expectEqualStrings("{\"ok\":true,\"s\":\"****\"}", out);
}

test "maskValue: nested arrays and objects are visited" {
    var parsed = try parse(testing.allocator, "[{\"x\":[\"Tr0ub4dor\"]}]");
    defer parsed.deinit();
    try testing.expect(try maskValue(parsed.arena.allocator(), &parsed.value, &.{"Tr0ub4dor"}));
}

test "maskValue: nothing to mask reports no change" {
    var parsed = try parse(testing.allocator, "{\"a\":\"clean\"}");
    defer parsed.deinit();
    try testing.expect(!(try maskValue(testing.allocator, &parsed.value, &.{"Tr0ub4dor"})));
}

test "parse: duplicate keys keep the last value like JSON.parse" {
    var parsed = try parse(testing.allocator, "{\"a\":1,\"a\":2}");
    defer parsed.deinit();
    try testing.expectEqual(@as(i64, 2), parsed.value.object.get("a").?.integer);
}

test "quoteString: escapes quotes, backslashes and control characters" {
    const q = try quoteString(testing.allocator, "a\"b\\c\n");
    defer testing.allocator.free(q);
    try testing.expectEqualStrings("\"a\\\"b\\\\c\\n\"", q);
}

test "maskValue: masking a key in a large object leaves lookups on it correct" {
    var parsed = try parse(
        testing.allocator,
        "{\"k0\":0,\"k1\":1,\"Tr0ub4dor\":2,\"k3\":3,\"k4\":4,\"k5\":5,\"k6\":6,\"k7\":7}",
    );
    defer parsed.deinit();
    try testing.expect(try maskValue(parsed.arena.allocator(), &parsed.value, &.{"Tr0ub4dor"}));

    const obj = &parsed.value.object;
    try testing.expectEqual(@as(?std.json.Value, null), obj.get("Tr0ub4dor"));
    try testing.expectEqual(@as(i64, 2), obj.get("*********").?.integer);
    try testing.expectEqual(@as(i64, 3), obj.get("k3").?.integer);
}

test "stringifyPretty: nested object with indent_2 whitespace" {
    var parsed = try parse(testing.allocator, "{\"a\":{\"b\":1}}");
    defer parsed.deinit();
    const out = try stringifyPretty(testing.allocator, parsed.value);
    defer testing.allocator.free(out);
    try testing.expectEqualStrings("{\n  \"a\": {\n    \"b\": 1\n  }\n}", out);
}

test "getString / getObject: typed lookups on an object" {
    var parsed = try parse(testing.allocator, "{\"prompt\":\"hi\",\"tool_input\":{\"command\":\"ls\"}}");
    defer parsed.deinit();
    try testing.expectEqualStrings("hi", getString(parsed.value, "prompt").?);
    try testing.expect(getObject(parsed.value, "tool_input") != null);
    try testing.expectEqual(@as(?[]const u8, null), getString(parsed.value, "missing"));
    try testing.expectEqual(@as(?[]const u8, null), getString(parsed.value, "tool_input"));
}

fn nestedArrayJson(allocator: std.mem.Allocator, depth: usize) ![]u8 {
    const text = try allocator.alloc(u8, depth * 2 + 1);
    @memset(text[0..depth], '[');
    text[depth] = '0';
    @memset(text[depth + 1 ..], ']');
    return text;
}

test "parse: accepts 128 containers and rejects deeper input" {
    const boundary = try nestedArrayJson(testing.allocator, 128);
    defer testing.allocator.free(boundary);
    var parsed = try parse(testing.allocator, boundary);
    parsed.deinit();

    const too_deep = try nestedArrayJson(testing.allocator, 129);
    defer testing.allocator.free(too_deep);
    try testing.expectError(error.JsonTooDeep, parse(testing.allocator, too_deep));
}

test "stringify: rejects values beyond generated-output headroom" {
    const text = try nestedArrayJson(testing.allocator, 161);
    defer testing.allocator.free(text);
    var parsed = try std.json.parseFromSlice(std.json.Value, testing.allocator, text, .{});
    defer parsed.deinit();
    try testing.expectError(error.JsonTooDeep, stringify(testing.allocator, parsed.value));
}
