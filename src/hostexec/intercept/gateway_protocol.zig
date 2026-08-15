const std = @import("std");

const json = std.json;
const Allocator = std.mem.Allocator;

pub const max_control_bytes: usize = 4 * 1024 * 1024;
pub const max_chunk_bytes: usize = 64 * 1024;

pub const GatewayState = enum {
    awaiting_decision,
    running,
    awaiting_result,
    terminal,
};

pub const StdinMode = enum { fd, none };

pub const ExternalExecuteRequest = struct {
    version: u32,
    type: []const u8,
    sessionId: []const u8,
    requestId: []const u8,
    argv0: []const u8,
    args: []const []const u8,
    cwd: []const u8,
    tty: bool,
    stdinMode: StdinMode,
};

const GatewayExecute = struct { request: ExternalExecuteRequest };
const GatewaySpawned = struct { requestId: []const u8, pid: i32 };
const GatewayRawChunk = struct { requestId: []const u8, fd: u8, data: []const u8 };
const GatewayProcessExit = struct { requestId: []const u8, exitCode: i32 };
const GatewayCancelled = struct { requestId: []const u8, reason: []const u8 };
const GatewayTransportError = struct { requestId: []const u8, message: []const u8 };

pub const GatewayToBroker = union(enum) {
    execute: GatewayExecute,
    spawned: GatewaySpawned,
    raw_chunk: GatewayRawChunk,
    process_exit: GatewayProcessExit,
    cancelled: GatewayCancelled,
    transport_error: GatewayTransportError,

    pub fn jsonParse(allocator: Allocator, source: anytype, options: json.ParseOptions) !@This() {
        const value = try json.parseFromTokenSourceLeaky(json.Value, allocator, source, options);
        return parseTaggedObject(@This(), allocator, value, options);
    }

    pub fn jsonParseFromValue(allocator: Allocator, source: json.Value, options: json.ParseOptions) !@This() {
        return parseTaggedObject(@This(), allocator, source, options);
    }

    pub fn jsonStringify(self: @This(), jws: anytype) !void {
        try jws.beginObject();
        switch (self) {
            .execute => |value| {
                try writeType(jws, "execute");
                try jws.objectField("request");
                try jws.write(value.request);
            },
            .spawned => |value| {
                try writeType(jws, "spawned");
                try jws.objectField("requestId");
                try jws.write(value.requestId);
                try jws.objectField("pid");
                try jws.write(value.pid);
            },
            .raw_chunk => |value| {
                try writeType(jws, "raw_chunk");
                try jws.objectField("requestId");
                try jws.write(value.requestId);
                try jws.objectField("fd");
                try jws.write(value.fd);
                try jws.objectField("data");
                try jws.write(value.data);
            },
            .process_exit => |value| {
                try writeType(jws, "process_exit");
                try jws.objectField("requestId");
                try jws.write(value.requestId);
                try jws.objectField("exitCode");
                try jws.write(value.exitCode);
            },
            .cancelled => |value| {
                try writeType(jws, "cancelled");
                try jws.objectField("requestId");
                try jws.write(value.requestId);
                try jws.objectField("reason");
                try jws.write(value.reason);
            },
            .transport_error => |value| {
                try writeType(jws, "transport_error");
                try jws.objectField("requestId");
                try jws.write(value.requestId);
                try jws.objectField("message");
                try jws.write(value.message);
            },
        }
        try jws.endObject();
    }
};

pub const EnvMap = std.json.ArrayHashMap([]const u8);

const BrokerFallback = struct { requestId: []const u8 };
const BrokerError = struct { requestId: []const u8, message: []const u8 };
const BrokerStart = struct {
    requestId: []const u8,
    argv0: []const u8,
    args: []const []const u8,
    cwd: []const u8,
    env: EnvMap,
};
const BrokerMaskedChunk = struct { requestId: []const u8, fd: u8, data: []const u8 };
const BrokerResult = struct { requestId: []const u8, exitCode: i32 };
const BrokerKill = struct { requestId: []const u8, signal: []const u8 };

pub const BrokerToGateway = union(enum) {
    fallback: BrokerFallback,
    @"error": BrokerError,
    start: BrokerStart,
    masked_chunk: BrokerMaskedChunk,
    result: BrokerResult,
    kill: BrokerKill,

    pub fn jsonParse(allocator: Allocator, source: anytype, options: json.ParseOptions) !@This() {
        const value = try json.parseFromTokenSourceLeaky(json.Value, allocator, source, options);
        return parseTaggedObject(@This(), allocator, value, options);
    }

    pub fn jsonParseFromValue(allocator: Allocator, source: json.Value, options: json.ParseOptions) !@This() {
        return parseTaggedObject(@This(), allocator, source, options);
    }

    pub fn jsonStringify(self: @This(), jws: anytype) !void {
        try jws.beginObject();
        switch (self) {
            .fallback => |value| {
                try writeType(jws, "fallback");
                try jws.objectField("requestId");
                try jws.write(value.requestId);
            },
            .@"error" => |value| {
                try writeType(jws, "error");
                try jws.objectField("requestId");
                try jws.write(value.requestId);
                try jws.objectField("message");
                try jws.write(value.message);
            },
            .start => |value| {
                try writeType(jws, "start");
                try jws.objectField("requestId");
                try jws.write(value.requestId);
                try jws.objectField("argv0");
                try jws.write(value.argv0);
                try jws.objectField("args");
                try jws.write(value.args);
                try jws.objectField("cwd");
                try jws.write(value.cwd);
                try jws.objectField("env");
                try jws.write(value.env);
            },
            .masked_chunk => |value| {
                try writeType(jws, "masked_chunk");
                try jws.objectField("requestId");
                try jws.write(value.requestId);
                try jws.objectField("fd");
                try jws.write(value.fd);
                try jws.objectField("data");
                try jws.write(value.data);
            },
            .result => |value| {
                try writeType(jws, "result");
                try jws.objectField("requestId");
                try jws.write(value.requestId);
                try jws.objectField("exitCode");
                try jws.write(value.exitCode);
            },
            .kill => |value| {
                try writeType(jws, "kill");
                try jws.objectField("requestId");
                try jws.write(value.requestId);
                try jws.objectField("signal");
                try jws.write(value.signal);
            },
        }
        try jws.endObject();
    }
};

const ProtocolError = error{
    InvalidProtocolVersion,
    InvalidMessageType,
    InvalidMessage,
    InvalidState,
    MissingField,
    UnknownField,
    MessageTooLong,
    ChunkTooLong,
    InvalidBase64,
};

fn parseTaggedObject(
    comptime Union: type,
    allocator: Allocator,
    source: json.Value,
    options: json.ParseOptions,
) !Union {
    if (source != .object) return error.UnexpectedToken;
    const type_value = source.object.get("type") orelse return error.MissingField;
    if (type_value != .string) return error.InvalidEnumTag;

    var payload_source = source;
    _ = payload_source.object.swapRemove("type");
    inline for (@typeInfo(Union).@"union".fields) |field| {
        if (std.mem.eql(u8, field.name, type_value.string)) {
            return @unionInit(
                Union,
                field.name,
                try json.parseFromValueLeaky(field.type, allocator, payload_source, options),
            );
        }
    }
    return error.InvalidEnumTag;
}

fn writeType(jws: anytype, type_name: []const u8) !void {
    try jws.objectField("type");
    try jws.write(type_name);
}

fn trimControl(input: []const u8) ProtocolError![]const u8 {
    // `input` is normally the line returned by fd_transport without its LF,
    // but accepting a complete NDJSON line here makes the boundary explicit.
    // Count every physical byte except exactly one trailing LF and its
    // optional CR. Do not normalize JSON whitespace before applying the limit.
    var payload_len = input.len;
    if (payload_len > 0 and input[payload_len - 1] == '\n') {
        payload_len -= 1;
        if (payload_len > 0 and input[payload_len - 1] == '\r') payload_len -= 1;
    }
    if (payload_len > max_control_bytes) return error.MessageTooLong;
    if (payload_len == 0) return error.InvalidMessage;
    return input[0..payload_len];
}

fn parseOwned(comptime T: type, allocator: Allocator, input: []const u8) !json.Parsed(T) {
    const trimmed = try trimControl(input);
    return json.parseFromSlice(T, allocator, trimmed, .{}) catch |err| switch (err) {
        error.OutOfMemory => error.OutOfMemory,
        error.MissingField => error.MissingField,
        error.UnknownField => error.UnknownField,
        else => error.InvalidMessage,
    };
}

fn requireType(allocator: Allocator, input: []const u8, allowed: []const []const u8) !void {
    const trimmed = try trimControl(input);
    var parsed = json.parseFromSlice(json.Value, allocator, trimmed, .{}) catch |err| {
        return switch (err) {
            error.OutOfMemory => error.OutOfMemory,
            else => error.InvalidMessage,
        };
    };
    defer parsed.deinit();

    if (parsed.value != .object) return error.InvalidMessage;
    const type_value = parsed.value.object.get("type") orelse return error.MissingField;
    if (type_value != .string) return error.InvalidMessageType;
    for (allowed) |candidate| {
        if (std.mem.eql(u8, type_value.string, candidate)) return;
    }
    return error.InvalidMessageType;
}

fn validateBase64Chunk(data: []const u8) !void {
    const decoded_len = std.base64.standard.Decoder.calcSizeForSlice(data) catch return error.InvalidBase64;
    if (decoded_len > max_chunk_bytes) return error.ChunkTooLong;
    var decoded: [max_chunk_bytes]u8 = undefined;
    std.base64.standard.Decoder.decode(decoded[0..decoded_len], data) catch return error.InvalidBase64;
    const canonical_len = std.base64.standard.Encoder.calcSize(decoded_len);
    var canonical: [std.base64.standard.Encoder.calcSize(max_chunk_bytes)]u8 = undefined;
    _ = std.base64.standard.Encoder.encode(canonical[0..canonical_len], decoded[0..decoded_len]);
    if (!std.mem.eql(u8, canonical[0..canonical_len], data)) return error.InvalidBase64;
}

fn validateExternal(request: ExternalExecuteRequest) !void {
    if (request.version != 2) return error.InvalidProtocolVersion;
    if (!std.mem.eql(u8, request.type, "execute")) return error.InvalidMessageType;
}

fn validFd(fd: u8) bool {
    return fd == 1 or fd == 2;
}

fn gatewayStateAllowed(tag: std.meta.Tag(GatewayToBroker), state: GatewayState) bool {
    return switch (tag) {
        .execute => state == .awaiting_decision,
        .spawned, .raw_chunk, .process_exit => state == .running,
        .cancelled, .transport_error => state != .terminal,
    };
}

fn brokerStateAllowed(tag: std.meta.Tag(BrokerToGateway), state: GatewayState) bool {
    return switch (tag) {
        .fallback, .start => state == .awaiting_decision,
        .@"error" => state == .awaiting_decision or state == .awaiting_result,
        .masked_chunk => state == .running or state == .awaiting_result,
        .result => state == .awaiting_result,
        .kill => state == .running,
    };
}

pub fn parseExternalExecute(allocator: Allocator, input: []const u8) !json.Parsed(ExternalExecuteRequest) {
    try requireType(allocator, input, &.{"execute"});
    var parsed = try parseOwned(ExternalExecuteRequest, allocator, input);
    errdefer parsed.deinit();
    try validateExternal(parsed.value);
    return parsed;
}

pub fn parseGatewayToBroker(allocator: Allocator, input: []const u8, state: GatewayState) !json.Parsed(GatewayToBroker) {
    try requireType(allocator, input, &.{ "execute", "spawned", "raw_chunk", "process_exit", "cancelled", "transport_error" });
    var parsed = try parseOwned(GatewayToBroker, allocator, input);
    errdefer parsed.deinit();
    const tag = std.meta.activeTag(parsed.value);
    if (!gatewayStateAllowed(tag, state)) return error.InvalidState;
    switch (parsed.value) {
        .execute => |message| try validateExternal(message.request),
        .spawned => {},
        .raw_chunk => |message| {
            if (!validFd(message.fd)) return error.InvalidMessage;
            try validateBase64Chunk(message.data);
        },
        .process_exit => {},
        .cancelled => {},
        .transport_error => {},
    }
    return parsed;
}

pub fn parseBrokerToGateway(allocator: Allocator, input: []const u8, state: GatewayState) !json.Parsed(BrokerToGateway) {
    try requireType(allocator, input, &.{ "fallback", "error", "start", "masked_chunk", "result", "kill" });
    var parsed = try parseOwned(BrokerToGateway, allocator, input);
    errdefer parsed.deinit();
    const tag = std.meta.activeTag(parsed.value);
    if (!brokerStateAllowed(tag, state)) return error.InvalidState;
    switch (parsed.value) {
        .fallback => {},
        .@"error" => {},
        .start => {},
        .masked_chunk => |message| {
            if (!validFd(message.fd)) return error.InvalidMessage;
            try validateBase64Chunk(message.data);
        },
        .result => {},
        .kill => |message| {
            if (!std.mem.eql(u8, message.signal, "SIGTERM") and !std.mem.eql(u8, message.signal, "SIGKILL")) {
                return error.InvalidMessage;
            }
        },
    }
    return parsed;
}

fn validateStringifyMessage(message: anytype) !void {
    switch (@TypeOf(message)) {
        GatewayToBroker => switch (message) {
            .execute => |value| try validateExternal(value.request),
            .raw_chunk => |value| {
                if (!validFd(value.fd)) return error.InvalidMessage;
                try validateBase64Chunk(value.data);
            },
            .spawned, .process_exit, .cancelled, .transport_error => {},
        },
        BrokerToGateway => switch (message) {
            .masked_chunk => |value| {
                if (!validFd(value.fd)) return error.InvalidMessage;
                try validateBase64Chunk(value.data);
            },
            .kill => |value| {
                if (!std.mem.eql(u8, value.signal, "SIGTERM") and !std.mem.eql(u8, value.signal, "SIGKILL")) {
                    return error.InvalidMessage;
                }
            },
            .fallback, .@"error", .start, .result => {},
        },
        ExternalExecuteRequest => try validateExternal(message),
        else => {},
    }
}

pub fn stringifyMessage(allocator: Allocator, message: anytype) ![]u8 {
    try validateStringifyMessage(message);
    const encoded = try json.Stringify.valueAlloc(allocator, message, .{});
    defer allocator.free(encoded);
    if (encoded.len > max_control_bytes) return error.MessageTooLong;
    const result = try allocator.alloc(u8, encoded.len + 1);
    @memcpy(result[0..encoded.len], encoded);
    result[encoded.len] = '\n';
    return result;
}

test "external execute v2 fixture requires stdinMode and version 2" {
    const allocator = std.testing.allocator;
    var parsed = try parseExternalExecute(
        allocator,
        "{\"version\":2,\"type\":\"execute\",\"sessionId\":\"s\",\"requestId\":\"r\",\"argv0\":\"cat\",\"args\":[],\"cwd\":\"/work\",\"tty\":false,\"stdinMode\":\"fd\"}",
    );
    defer parsed.deinit();
    try std.testing.expectEqual(@as(u32, 2), parsed.value.version);
    try std.testing.expectEqual(StdinMode.fd, parsed.value.stdinMode);

    try std.testing.expectError(error.InvalidProtocolVersion, parseExternalExecute(
        allocator,
        "{\"version\":1,\"type\":\"execute\",\"sessionId\":\"s\",\"requestId\":\"r\",\"argv0\":\"cat\",\"args\":[],\"cwd\":\"/work\",\"tty\":false,\"stdinMode\":\"fd\"}",
    ));
    try std.testing.expectError(error.MissingField, parseExternalExecute(
        allocator,
        "{\"version\":2,\"type\":\"execute\",\"sessionId\":\"s\",\"requestId\":\"r\",\"argv0\":\"cat\",\"args\":[],\"cwd\":\"/work\",\"tty\":false}",
    ));
}

test "gateway protocol parses every direction fixture and round trips JSON" {
    const allocator = std.testing.allocator;
    const gateway_fixtures = [_]struct { line: []const u8, state: GatewayState }{
        .{ .line = "{\"type\":\"execute\",\"request\":{\"version\":2,\"type\":\"execute\",\"sessionId\":\"s\",\"requestId\":\"r\",\"argv0\":\"cat\",\"args\":[],\"cwd\":\"/work\",\"tty\":false,\"stdinMode\":\"none\"}}", .state = .awaiting_decision },
        .{ .line = "{\"type\":\"spawned\",\"requestId\":\"r\",\"pid\":42}", .state = .running },
        .{ .line = "{\"type\":\"raw_chunk\",\"requestId\":\"r\",\"fd\":1,\"data\":\"eA==\"}", .state = .running },
        .{ .line = "{\"type\":\"process_exit\",\"requestId\":\"r\",\"exitCode\":0}", .state = .running },
        .{ .line = "{\"type\":\"cancelled\",\"requestId\":\"r\",\"reason\":\"client disconnected\"}", .state = .running },
        .{ .line = "{\"type\":\"transport_error\",\"requestId\":\"r\",\"message\":\"closed\"}", .state = .running },
    };
    for (gateway_fixtures) |fixture| {
        var parsed = try parseGatewayToBroker(allocator, fixture.line, fixture.state);
        defer parsed.deinit();
        const encoded = try stringifyMessage(allocator, parsed.value);
        defer allocator.free(encoded);
        try std.testing.expect(std.mem.endsWith(u8, encoded, "\n"));
    }

    const broker_fixtures = [_]struct { line: []const u8, state: GatewayState }{
        .{ .line = "{\"type\":\"fallback\",\"requestId\":\"r\"}", .state = .awaiting_decision },
        .{ .line = "{\"type\":\"error\",\"requestId\":\"r\",\"message\":\"denied\"}", .state = .awaiting_decision },
        .{ .line = "{\"type\":\"start\",\"requestId\":\"r\",\"argv0\":\"cat\",\"args\":[],\"cwd\":\"/work\",\"env\":{}}", .state = .awaiting_decision },
        .{ .line = "{\"type\":\"masked_chunk\",\"requestId\":\"r\",\"fd\":2,\"data\":\"eA==\"}", .state = .running },
        .{ .line = "{\"type\":\"result\",\"requestId\":\"r\",\"exitCode\":0}", .state = .awaiting_result },
        .{ .line = "{\"type\":\"kill\",\"requestId\":\"r\",\"signal\":\"SIGTERM\"}", .state = .running },
    };
    for (broker_fixtures) |fixture| {
        var parsed = try parseBrokerToGateway(allocator, fixture.line, fixture.state);
        defer parsed.deinit();
        const encoded = try stringifyMessage(allocator, parsed.value);
        defer allocator.free(encoded);
        try std.testing.expect(std.mem.endsWith(u8, encoded, "\n"));
    }
}

test "gateway protocol rejects wrong direction and state" {
    const allocator = std.testing.allocator;
    try std.testing.expectError(error.InvalidState, parseGatewayToBroker(
        allocator,
        "{\"type\":\"raw_chunk\",\"requestId\":\"r\",\"fd\":1,\"data\":\"eA==\"}",
        .awaiting_decision,
    ));
    try std.testing.expectError(error.InvalidState, parseBrokerToGateway(
        allocator,
        "{\"type\":\"fallback\",\"requestId\":\"r\"}",
        .running,
    ));
    try std.testing.expectError(error.InvalidState, parseBrokerToGateway(
        allocator,
        "{\"type\":\"error\",\"requestId\":\"r\",\"message\":\"failed\"}",
        .running,
    ));
    try std.testing.expectError(error.InvalidState, parseBrokerToGateway(
        allocator,
        "{\"type\":\"kill\",\"requestId\":\"r\",\"signal\":\"SIGTERM\"}",
        .awaiting_result,
    ));
    try std.testing.expectError(error.InvalidMessageType, parseGatewayToBroker(
        allocator,
        "{\"type\":\"masked_chunk\",\"requestId\":\"r\",\"fd\":1,\"data\":\"eA==\"}",
        .running,
    ));
}

test "gateway protocol rejects malformed numeric fields, secret extras, and oversized chunks" {
    const allocator = std.testing.allocator;
    try std.testing.expectError(error.InvalidMessage, parseGatewayToBroker(
        allocator,
        "{\"type\":\"spawned\",\"requestId\":\"r\",\"pid\":1.5}",
        .running,
    ));
    try std.testing.expectError(error.UnknownField, parseBrokerToGateway(
        allocator,
        "{\"type\":\"start\",\"requestId\":\"r\",\"argv0\":\"cat\",\"args\":[],\"cwd\":\"/work\",\"env\":{},\"extra\":\"secret\"}",
        .awaiting_decision,
    ));

    var huge_data: [64 * 1024 + 1]u8 = undefined;
    @memset(&huge_data, 0x78);
    var encoded_buf: [((64 * 1024 + 1 + 2) / 3) * 4]u8 = undefined;
    const encoded_len = std.base64.standard.Encoder.calcSize(huge_data.len);
    _ = std.base64.standard.Encoder.encode(&encoded_buf, &huge_data);
    try std.testing.expect(encoded_len > 0);
    // Keep this fixture allocation-free while still exercising the parser's
    // decoded-size guard: a syntactically valid base64 string is generated in
    // the fixed buffer above and copied into a JSON line below.
    var line = std.ArrayList(u8).empty;
    defer line.deinit(allocator);
    try line.appendSlice(allocator, "{\"type\":\"raw_chunk\",\"requestId\":\"r\",\"fd\":1,\"data\":\"");
    try line.appendSlice(allocator, encoded_buf[0..encoded_len]);
    try line.appendSlice(allocator, "\"}");
    try std.testing.expectError(error.ChunkTooLong, parseGatewayToBroker(allocator, line.items, .running));
}

test "PID and exit code use the same signed 32-bit domain" {
    const allocator = std.testing.allocator;
    const min: i32 = -2_147_483_648;
    const max: i32 = 2_147_483_647;

    var spawned_min = try parseGatewayToBroker(allocator, "{\"type\":\"spawned\",\"requestId\":\"r\",\"pid\":-2147483648}", .running);
    defer spawned_min.deinit();
    try std.testing.expectEqual(min, spawned_min.value.spawned.pid);
    var spawned_max = try parseGatewayToBroker(allocator, "{\"type\":\"spawned\",\"requestId\":\"r\",\"pid\":2147483647}", .running);
    defer spawned_max.deinit();
    try std.testing.expectEqual(max, spawned_max.value.spawned.pid);
    var result_min = try parseBrokerToGateway(allocator, "{\"type\":\"result\",\"requestId\":\"r\",\"exitCode\":-2147483648}", .awaiting_result);
    defer result_min.deinit();
    try std.testing.expectEqual(min, result_min.value.result.exitCode);
    var result_max = try parseBrokerToGateway(allocator, "{\"type\":\"result\",\"requestId\":\"r\",\"exitCode\":2147483647}", .awaiting_result);
    defer result_max.deinit();
    try std.testing.expectEqual(max, result_max.value.result.exitCode);

    try std.testing.expectError(error.InvalidMessage, parseGatewayToBroker(allocator, "{\"type\":\"spawned\",\"requestId\":\"r\",\"pid\":2147483648}", .running));
    try std.testing.expectError(error.InvalidMessage, parseBrokerToGateway(allocator, "{\"type\":\"result\",\"requestId\":\"r\",\"exitCode\":-2147483649}", .awaiting_result));
}

test "chunk parsers require canonical standard base64 padding bits" {
    const allocator = std.testing.allocator;
    var raw_one = try parseGatewayToBroker(allocator, "{\"type\":\"raw_chunk\",\"requestId\":\"r\",\"fd\":1,\"data\":\"AA==\"}", .running);
    defer raw_one.deinit();
    try std.testing.expectEqualStrings("AA==", raw_one.value.raw_chunk.data);
    var masked_two = try parseBrokerToGateway(allocator, "{\"type\":\"masked_chunk\",\"requestId\":\"r\",\"fd\":2,\"data\":\"AAA=\"}", .running);
    defer masked_two.deinit();
    try std.testing.expectEqualStrings("AAA=", masked_two.value.masked_chunk.data);
    try std.testing.expectError(error.InvalidBase64, parseGatewayToBroker(allocator, "{\"type\":\"raw_chunk\",\"requestId\":\"r\",\"fd\":1,\"data\":\"AB==\"}", .running));
    try std.testing.expectError(error.InvalidBase64, parseBrokerToGateway(allocator, "{\"type\":\"masked_chunk\",\"requestId\":\"r\",\"fd\":2,\"data\":\"AB==\"}", .running));
}

test "stringifyMessage round trips tagged fields and escaped strings" {
    const allocator = std.testing.allocator;
    var start = try parseBrokerToGateway(
        allocator,
        "{\"type\":\"start\",\"requestId\":\"r\",\"argv0\":\"tool\\\"name\",\"args\":[\"line\\nnext\"],\"cwd\":\"/work\",\"env\":{\"TOKEN\":\"secret\\\"\\nvalue\"}}",
        .awaiting_decision,
    );
    defer start.deinit();
    const start_encoded = try stringifyMessage(allocator, start.value);
    defer allocator.free(start_encoded);
    try std.testing.expect(std.mem.indexOf(u8, start_encoded, "\"type\":\"start\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, start_encoded, "\\\"name") != null);
    try std.testing.expect(std.mem.indexOf(u8, start_encoded, "line\\nnext") != null);

    var start_round_trip = try parseBrokerToGateway(allocator, start_encoded, .awaiting_decision);
    defer start_round_trip.deinit();
    switch (start_round_trip.value) {
        .start => |value| {
            try std.testing.expectEqualStrings("tool\"name", value.argv0);
            try std.testing.expectEqualStrings("line\nnext", value.args[0]);
            try std.testing.expectEqualStrings("secret\"\nvalue", value.env.map.get("TOKEN").?);
        },
        else => return error.UnexpectedMessageType,
    }

    var transport_error = try parseGatewayToBroker(
        allocator,
        "{\"type\":\"transport_error\",\"requestId\":\"r\\\"id\",\"message\":\"line \\\"quoted\\\"\\nnext\"}",
        .running,
    );
    defer transport_error.deinit();
    const error_encoded = try stringifyMessage(allocator, transport_error.value);
    defer allocator.free(error_encoded);
    try std.testing.expect(std.mem.indexOf(u8, error_encoded, "\"type\":\"transport_error\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, error_encoded, "line \\\"quoted\\\"\\nnext") != null);
    var error_round_trip = try parseGatewayToBroker(allocator, error_encoded, .running);
    defer error_round_trip.deinit();
    try std.testing.expectEqualStrings("line \"quoted\"\nnext", error_round_trip.value.transport_error.message);

    var raw_chunk = try parseGatewayToBroker(
        allocator,
        "{\"type\":\"raw_chunk\",\"requestId\":\"r\\\"id\",\"fd\":1,\"data\":\"eA==\"}",
        .running,
    );
    defer raw_chunk.deinit();
    const chunk_encoded = try stringifyMessage(allocator, raw_chunk.value);
    defer allocator.free(chunk_encoded);
    var chunk_round_trip = try parseGatewayToBroker(allocator, chunk_encoded, .running);
    defer chunk_round_trip.deinit();
    try std.testing.expectEqualStrings("r\"id", chunk_round_trip.value.raw_chunk.requestId);
    try std.testing.expectEqualStrings("eA==", chunk_round_trip.value.raw_chunk.data);
}

test "gateway protocol rejects control lines over 4 MiB" {
    const allocator = std.testing.allocator;
    var line = std.ArrayList(u8).empty;
    defer line.deinit(allocator);
    try line.appendSlice(allocator, "{\"type\":\"transport_error\",\"requestId\":\"r\",\"message\":\"");
    try line.appendNTimes(allocator, 'x', max_control_bytes);
    try line.appendSlice(allocator, "\"}");
    try std.testing.expectError(error.MessageTooLong, parseGatewayToBroker(allocator, line.items, .running));
}

test "gateway protocol counts leading JSON whitespace toward the physical limit" {
    const allocator = std.testing.allocator;
    var line = std.ArrayList(u8).empty;
    defer line.deinit(allocator);
    try line.appendNTimes(allocator, ' ', max_control_bytes);
    try line.appendSlice(allocator, "{\"type\":\"spawned\",\"requestId\":\"r\",\"pid\":42}");
    try std.testing.expectError(error.MessageTooLong, parseGatewayToBroker(allocator, line.items, .running));
}
