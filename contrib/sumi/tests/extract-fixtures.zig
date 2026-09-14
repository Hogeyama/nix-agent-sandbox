//! Test-only exporter: expected outcomes are fixture data, while expressions
//! and every match span come directly from the production extraction module.
const std = @import("std");
const extract = @import("extract");
const Fixture = struct {
    name: []const u8,
    content: []const u8,
    patterns: []const []const u8 = &.{"MY_SECRET"},
    expected: []const u8 = "rule",
};
const Export = struct {
    name: []const u8,
    content: []const u8,
    patterns: []const []const u8,
    expected: []const u8,
    outcome: []const u8,
    expression: ?[]const u8 = null,
    matches: []const extract.Match = &.{},
};
const fixtures = [_]Fixture{
    .{ .name = "README", .content = "db.password=Tr0ub4dor\n", .patterns = &.{"Tr0ub4dor"} },
    .{ .name = "repeated", .content = "foo=MY_SECRET\nbar=MY_SECRET\n# MY_SECRET\n" },
    .{ .name = "repeated-ws", .content = "foo=MY_SECRET\nbar MY_SECRET ignored\n# MY_SECRET\n" },
    .{ .name = "repeated-quotes", .content = "foo=MY_SECRET\nbar=\"MY_SECRET\"\nbaz='MY_SECRET'\n" },
    .{ .name = "two-values", .content = "foo=FirstSecret9\nbar=SecondSecrt7\ncopy=FirstSecret9\n", .patterns = &.{ "FirstSecret9", "SecondSecrt7" } },
    .{ .name = "dq-sq", .content = "API_KEY=\"DecoyToken9\"\nPASSWORD='DecoyPass\"7'\n", .patterns = &.{ "DecoyToken9", "DecoyPass\"7" } },
    .{ .name = "quoted-assignment-wins", .content = "API_KEY=\"long MY_SECRET\"\n" },
    .{ .name = "json", .content = "{\"user\":\"app\",\"password\":\"MY_SECRET\"}\n" },
    .{ .name = "npmrc", .content = "//registry.npmjs.org/:_authToken=MY_SECRET\n" },
    .{ .name = "netrc", .content = "machine h login u password MY_SECRET\n" },
    .{ .name = "basic", .content = "Authorization: Basic dXNlcjpNWV9TRUNSRVQ=\n", .patterns = &.{"NWV9TRUNSRVQ"} },
    .{ .name = "url", .content = "DATABASE_URL=postgres://app:MY_SECRET@db\n" },
    .{ .name = "url-semicolon-no-inner-key", .content = "https://host/path;token=MY_SECRET\n", .expected = "no-form" },
    .{ .name = "url-ws-captures-whole", .content = "url postgres://app;token=MY_SECRET@db\n" },
    .{ .name = "url-colon-captures-whole", .content = "url:postgres://app:MY_SECRET@db\n" },
    .{ .name = "url-colon-path-equals", .content = "url:postgres://host/token=MY_SECRET\n" },
    .{ .name = "url-colon-path-colon", .content = "url:postgres://host/token:MY_SECRET\n" },
    .{ .name = "url-colon-semicolon", .content = "url:postgres://host;token=MY_SECRET\n" },
    .{ .name = "url-colon-query", .content = "url:postgres://host?token=MY_SECRET\n" },
    .{ .name = "url-colon-fragment", .content = "url:postgres://host#token=MY_SECRET\n" },
    .{ .name = "url-colon-brackets", .content = "url:postgres://[host]/token=MY_SECRET\n" },
    .{ .name = "url-colon-plus-scheme", .content = "url:git+ssh://host/token=MY_SECRET\n" },
    .{ .name = "url-colon-sq-punctuation", .content = "url:postgres://host'part;token=MY_SECRET\n" },
    .{ .name = "url-colon-dq-punctuation", .content = "url:postgres://host\"part;token=MY_SECRET\n" },
    .{ .name = "url-bare-path-equals", .content = "postgres://host/token=MY_SECRET\n", .expected = "no-form" },
    .{ .name = "url-bare-path-colon", .content = "postgres://host/token:MY_SECRET\n", .expected = "no-form" },
    .{ .name = "url-bare-query", .content = "postgres://host?token=MY_SECRET\n", .expected = "no-form" },
    .{ .name = "url-bare-fragment", .content = "postgres://host#token=MY_SECRET\n", .expected = "no-form" },
    .{ .name = "url-bare-brackets", .content = "postgres://[host]/token=MY_SECRET\n", .expected = "no-form" },
    .{ .name = "url-bare-plus-scheme", .content = "git+ssh://host/token=MY_SECRET\n", .expected = "no-form" },
    .{ .name = "url-dq-later-field", .content = "{\"url\":\"https://host\",\"password\":\"MY_SECRET\"}\n" },
    .{ .name = "url-sq-later-field", .content = "{'url':'https://host','password':'MY_SECRET'}\n" },
    .{ .name = "url-dq-other-quote", .content = "url=\"https://host'part\";password='MY_SECRET'\n" },
    .{ .name = "url-sq-other-quote", .content = "url='https://host\"part';password=\"MY_SECRET\"\n" },
    .{ .name = "url-dq-escaped-later-field", .content = "url=\"https://host\\\"part\";password=\"MY_SECRET\"\n" },
    .{ .name = "url-sq-escaped-later-field", .content = "url='https://host\\'part';password='MY_SECRET'\n" },
    .{ .name = "url-dq-key", .content = "{\"https://host\":\"MY_SECRET\"}\n" },
    .{ .name = "url-sq-key", .content = "{'https://host':'MY_SECRET'}\n" },
    .{ .name = "url-quoted-ws-key", .content = "\"https://host\" MY_SECRET\n" },
    .{ .name = "url-dq-escaped-inner-key", .content = "url=\"https://host\\\";password=MY_SECRET\"\n", .expected = "no-form" },
    .{ .name = "url-sq-escaped-inner-key", .content = "url='https://host\\';password=MY_SECRET'\n", .expected = "no-form" },
    .{ .name = "url-bare-sq-inner-key", .content = "https://host'part;token=MY_SECRET\n", .expected = "no-form" },
    .{ .name = "url-bare-dq-inner-key", .content = "https://host\"part;token=MY_SECRET\n", .expected = "no-form" },
    .{ .name = "embedded-base64", .content = "encoded=cHJlZml4TVlfU0VDUkVUIHN1ZmZpeA==\n", .patterns = &.{"TVlfU0VDUkVU"} },
    .{ .name = "raw-encoded", .content = "raw=MY_SECRET\nencoded=TVlfU0VDUkVU\n", .patterns = &.{ "MY_SECRET", "TVlfU0VDUkVU" } },
    .{ .name = "unkeyed-encoded", .content = "raw=MY_SECRET\n# TVlfU0VDUkVU\n", .patterns = &.{ "MY_SECRET", "TVlfU0VDUkVU" }, .expected = "coverage" },
    .{ .name = "wrapped-copy", .content = "foo=abMY_SECRETab\n# MY_SECRET\n", .expected = "coverage" },
    .{ .name = "shorter-representative", .content = "wrapped=abMY_SECRETab\nfoo=MY_SECRET\n" },
    .{ .name = "whole", .content = "MY_SECRET", .expected = "whole_file" },
    .{ .name = "whole-lf", .content = "MY_SECRET\n", .expected = "whole_file" },
    .{ .name = "whole-crlf", .content = "MY_SECRET\r\n", .expected = "whole_file" },
    .{ .name = "two-newlines", .content = "MY_SECRET\n\n", .expected = "no-form" },
    .{ .name = "no-form", .content = "# MY_SECRET\n", .expected = "no-form" },
    .{ .name = "missing-dq", .content = "token=\"MY_SECRET\n", .expected = "no-form" },
    .{ .name = "missing-sq", .content = "token='MY_SECRET\n", .expected = "no-form" },
    .{ .name = "escaped-dq", .content = "token=\"MY_SECRET\\n\"\n", .expected = "no-form" },
    .{ .name = "escaped-interior", .content = "token=\"x\\\" password MY_SECRET\"\n", .expected = "no-form" },
    .{ .name = "url-no-inner-key", .content = "postgres://app:MY_SECRET@db\n", .expected = "no-form" },
    .{ .name = "prefix-secret", .content = "MY_SECRET=MY_SECRET\n", .expected = "prefix-contains-value" },
    .{ .name = "prefix-metachar-secret", .content = "foo.bar=foo.bar\n", .patterns = &.{"foo.bar"}, .expected = "prefix-contains-value" },
    .{ .name = "same-line-secret-prefix", .content = "aa=FirstSecret9; bb=SecondSecrt7\n", .patterns = &.{ "FirstSecret9", "SecondSecrt7" }, .expected = "coverage" },
    .{ .name = "overlapping-copies", .content = "token=aaaa\n# aaaaa\n", .patterns = &.{"aaaa"}, .expected = "coverage" },
    .{ .name = "distinct-overlapping-copies", .content = "aa=abcd\nbb=cdef\n# abcdef\n", .patterns = &.{ "abcd", "cdef" }, .expected = "coverage" },
    .{ .name = "overlapping-patterns", .content = "token=aaaaa\n# aaaaa\n", .patterns = &.{ "aaaa", "aaa" } },
    .{ .name = "repeated-prefix", .content = "token=MY_SECRET\ntoken=MY_SECRET\n# MY_SECRET\n" },
    .{ .name = "all-prefix-metacharacters", .content = "😀 [a](b)^$|?*+\\/; token=秘密9\r\n", .patterns = &.{"秘密9"} },
    .{ .name = "non-ascii-values", .content = "token=\"😀秘密9\"\nother='é秘密7'\n", .patterns = &.{ "😀秘密9", "é秘密7" } },
    .{ .name = "mixed-forms", .content = "bare=FirstSecret9\nqq=\"Long SecondSecret7\"\nss='ThirdSecret8'\npassword FourthSecret6\n", .patterns = &.{ "FirstSecret9", "SecondSecret7", "ThirdSecret8", "FourthSecret6" } },
    .{ .name = "cross-form-dynamic-match", .content = "foo=MY_SECRET\nfoo='not-captured'\nbar=\"OtherSecret9\"\nbar=\"harmless\"\n", .patterns = &.{ "MY_SECRET", "OtherSecret9" } },
};
fn append(allocator: std.mem.Allocator, out: *std.ArrayList(Export), fixture: Fixture) !void {
    const result = try extract.generate(allocator, fixture.content, fixture.patterns);
    var exported = Export{
        .name = fixture.name,
        .content = fixture.content,
        .patterns = fixture.patterns,
        .expected = fixture.expected,
        .outcome = switch (result) {
            .whole_file => "whole_file",
            .rule => "rule",
            .skip => |reason| reason.code(),
        },
    };
    if (result == .rule) {
        exported.expression = result.rule.expression;
        exported.matches = try extract.matches(allocator, fixture.content, result.rule);
    }
    try out.append(allocator, exported);
}
pub fn main() !void {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    var out: std.ArrayList(Export) = .empty;
    for (fixtures) |fixture| try append(allocator, &out, fixture);
    const forms = [_][]const u8{ "token=MY_SECRET", "token=\"MY_SECRET\"", "token='MY_SECRET'", "password MY_SECRET" };
    // Exercise adjacent, blank and indented lines for every pair of forms,
    // including a supplementary Unicode code point before the capture.
    for ([_][]const u8{ "\n", "\r\n" }, 0..) |newline, n| {
        for (forms, 0..) |first, i| {
            for (forms, 0..) |second, j| {
                const other = try std.mem.replaceOwned(u8, allocator, second, "MY_SECRET", "OtherSecret9");
                for ([_][]const u8{ "", "😀 ; " }, 0..) |indent, k| {
                    try append(allocator, &out, .{
                        .name = try std.fmt.allocPrint(allocator, "matrix-{d}-{d}-{d}-{d}", .{ n, i, j, k }),
                        .content = try std.fmt.allocPrint(allocator, "{s}{s}{s}{s}{s}{s}{s}{s}{s}{s}", .{ newline, indent, first, newline, indent, other, newline, newline, first, newline }),
                        .patterns = &.{ "MY_SECRET", "OtherSecret9" },
                    });
                }
            }
        }
    }
    const json = try std.json.Stringify.valueAlloc(allocator, out.items, .{});
    try std.fs.File.stdout().writeAll(json);
    try std.fs.File.stdout().writeAll("\n");
}
