//! Pure credential extraction. Allocations belong to the supplied operation
//! arena; Prefix.text borrows content, which must outlive every use of the rule.
const std = @import("std");

pub const Span = struct { start: usize, end: usize };
pub const Match = struct { whole: Span, value: Span };
pub const Form = enum { dq, sq, bare, ws };
pub const Prefix = struct { text: []const u8, form: Form, start: usize };
pub const Rule = struct { expression: []const u8, prefixes: []const Prefix };
pub const SkipReason = enum {
    no_form,
    prefix_contains_value,
    coverage,

    pub fn code(self: SkipReason) []const u8 {
        return switch (self) {
            .no_form => "no-form",
            .prefix_contains_value => "prefix-contains-value",
            .coverage => "coverage",
        };
    }
};
pub const Result = union(enum) { whole_file, rule: Rule, skip: SkipReason };
const Candidate = struct { prefix: Prefix, value: Span };

fn contains(outer: Span, inner: Span) bool {
    return outer.start <= inner.start and inner.end <= outer.end;
}
fn overlaps(a: Span, b: Span) bool {
    return a.start < b.end and b.start < a.end;
}
fn sameSpan(a: Span, b: Span) bool {
    return a.start == b.start and a.end == b.end;
}
fn hasPattern(text: []const u8, patterns: []const []const u8) bool {
    for (patterns) |pattern| {
        if (pattern.len > 0 and std.mem.indexOf(u8, text, pattern) != null) return true;
    }
    return false;
}
fn occurrences(allocator: std.mem.Allocator, content: []const u8, patterns: []const []const u8) ![]const Span {
    var out: std.ArrayList(Span) = .empty;
    for (patterns) |pattern| {
        if (pattern.len == 0) continue;
        var pos: usize = 0;
        while (std.mem.indexOfPos(u8, content, pos, pattern)) |start| {
            const span = Span{ .start = start, .end = start + pattern.len };
            var duplicate = false;
            for (out.items) |item| {
                if (sameSpan(item, span)) {
                    duplicate = true;
                    break;
                }
            }
            if (!duplicate) try out.append(allocator, span);
            pos = start + 1;
        }
    }
    return out.toOwnedSlice(allocator);
}
fn space(c: u8) bool {
    return c == ' ' or c == '\t';
}
fn endValue(c: u8) bool {
    return space(c) or c == '\r' or c == '\n';
}
fn quote(c: u8) bool {
    return c == '"' or c == '\'';
}
fn keyByte(c: u8) bool {
    return std.ascii.isAlphanumeric(c) or std.mem.indexOfScalar(u8, "_.-/:", c) != null;
}
fn schemeByte(c: u8) bool {
    return std.ascii.isAlphanumeric(c) or c == '+' or c == '.' or c == '-';
}
// This recognizes only the token boundary used by candidate discovery. It is
// intentionally not a URL parser: a scheme followed by :// owns the rest of
// its whitespace-delimited token, including punctuation that could resemble a
// later assignment.
fn urlTokenEnd(content: []const u8, start: usize, limit: usize) ?usize {
    if (start >= limit or !std.ascii.isAlphabetic(content[start])) return null;
    var scheme_end = start + 1;
    while (scheme_end < limit and schemeByte(content[scheme_end])) : (scheme_end += 1) {}
    if (scheme_end + 3 > limit or !std.mem.eql(u8, content[scheme_end .. scheme_end + 3], "://")) return null;
    var end = scheme_end + 3;
    while (end < limit and !endValue(content[end])) : (end += 1) {}
    return end;
}
fn boundary(content: []const u8, pos: usize) bool {
    return pos == 0 or endValue(content[pos - 1]) or std.mem.indexOfScalar(u8, "{,;", content[pos - 1]) != null;
}
const Key = struct { value_start: usize };
fn keyAt(content: []const u8, pos: usize, limit: usize, assignment: bool) ?Key {
    if (!boundary(content, pos)) return null;
    var start = pos;
    const quoted = quote(content[start]);
    if (quoted) start += 1;
    var end = start;
    while (end < limit and keyByte(content[end])) : (end += 1) {}
    if (end - start < 2) return null;
    const scheme_colon = if (!quoted) std.mem.indexOf(u8, content[start..end], "://") else null;
    if (quoted) {
        if (end == limit or content[end] != content[pos]) return null;
        end += 1;
    }
    var after = end;
    while (after < limit and space(content[after])) : (after += 1) {}
    if (assignment) {
        // Once the scanned bytes contain a URL scheme colon, any later
        // separator belongs to that URL. Resolve the outer colon first.
        if (scheme_colon == null and after < limit and (content[after] == '=' or content[after] == ':')) {
            after += 1;
        } else if (!quoted) {
            // ':' is also a key byte. Backtrack only to an actual separator.
            // For url:postgres://..., stop before the URL's scheme colon so
            // the outer assignment remains visible after URL tokens block
            // their internal fields below.
            if (end <= start + 2) return null;
            var split = if (scheme_colon) |offset| start + offset else end;
            while (split > start + 2) {
                split -= 1;
                if (content[split] == ':') break;
            }
            if (split < start + 2 or content[split] != ':') return null;
            after = split + 1;
        } else return null;
        while (after < limit and space(content[after])) : (after += 1) {}
    } else {
        if (after == end or after == limit or content[after] == '=' or content[after] == ':') return null;
    }
    return .{ .value_start = after };
}

fn discover(allocator: std.mem.Allocator, content: []const u8, found: []const Span) ![]Candidate {
    var all: std.ArrayList(Candidate) = .empty;
    // Even invalid quoted assignment values block key recognition inside them.
    const blocked = try allocator.alloc(bool, content.len);
    @memset(blocked, false);
    const blocked_ws = try allocator.alloc(bool, content.len);
    @memset(blocked_ws, false);
    var line: usize = 0;
    while (line < content.len) {
        const line_end = std.mem.indexOfScalarPos(u8, content, line, '\n') orelse content.len;
        const limit = if (line_end > line and content[line_end - 1] == '\r') line_end - 1 else line_end;
        for ([_]bool{ true, false }) |assignment| {
            var pos = line;
            while (pos < limit) : (pos += 1) {
                if (if (assignment) blocked[pos] else blocked_ws[pos]) continue;
                // Visit URLs only after earlier keys and quoted values have
                // established their boundaries. Quotes inside a bare URL are
                // still part of that URL's whitespace-delimited token.
                if (assignment) {
                    if (urlTokenEnd(content, pos, limit)) |url_end| {
                        @memset(blocked[pos..url_end], true);
                        @memset(blocked_ws[pos..url_end], true);
                        pos = url_end - 1;
                        continue;
                    }
                }
                const key = keyAt(content, pos, limit, assignment) orelse {
                    // A quoted ws key can itself contain ://. Its interior
                    // belongs to the key, while its value is visited next.
                    if (assignment and quote(content[pos])) {
                        if (keyAt(content, pos, limit, false)) |ws_key| pos = ws_key.value_start - 1;
                    }
                    continue;
                };
                const start = key.value_start;
                // Do not revisit the interior of a recognized quoted key.
                pos = start - 1;
                if (start >= limit or endValue(content[start])) continue;
                var value = Span{ .start = start, .end = start };
                var form: Form = if (assignment) .bare else .ws;
                var valid = true;
                if (quote(content[start])) {
                    if (!assignment) continue;
                    form = if (content[start] == '"') .dq else .sq;
                    value.start += 1;
                    value.end = value.start;
                    while (value.end < limit and content[value.end] != content[start] and content[value.end] != '\r') : (value.end += 1) {
                        if (content[value.end] == '\\') {
                            valid = false;
                            // Skip an escaped byte only to locate the enclosing
                            // value; escaped values never become candidates.
                            if (value.end + 1 < limit) value.end += 1;
                        }
                    }
                    valid = valid and value.end < limit and content[value.end] == content[start] and value.end > value.start;
                    @memset(blocked[start..@min(value.end + 1, limit)], true);
                    @memset(blocked_ws[start..@min(value.end + 1, limit)], true);
                } else {
                    while (value.end < limit and !endValue(content[value.end])) : (value.end += 1) {}
                    if (assignment) {
                        @memset(blocked[start..value.end], true);
                        // Basic may itself be an assignment value and a ws key.
                        // Its following value is outside the assignment span.
                        const ws_start = if (urlTokenEnd(content, start, value.end) != null) start else start + 1;
                        @memset(blocked_ws[ws_start..value.end], true);
                    }
                }
                if (valid and value.end > value.start) try all.append(allocator, .{
                    .prefix = .{ .text = content[line..value.start], .form = form, .start = line },
                    .value = value,
                });
            }
        }
        line = line_end + 1;
    }
    var out: std.ArrayList(Candidate) = .empty;
    for (found) |occurrence| {
        var best: ?Candidate = null;
        for (all.items) |candidate| {
            if (contains(candidate.value, occurrence) and (best == null or @intFromEnum(candidate.prefix.form) < @intFromEnum(best.?.prefix.form))) best = candidate;
        }
        if (best) |candidate| {
            var duplicate = false;
            for (out.items) |item| {
                if (sameSpan(item.value, candidate.value) and item.prefix.form == candidate.prefix.form) {
                    duplicate = true;
                    break;
                }
            }
            if (!duplicate) try out.append(allocator, candidate);
        }
    }
    return out.toOwnedSlice(allocator);
}

fn prefixLess(_: void, a: Prefix, b: Prefix) bool {
    if (a.form != b.form) return @intFromEnum(a.form) < @intFromEnum(b.form);
    return a.start < b.start;
}
fn candidateLess(_: void, a: Candidate, b: Candidate) bool {
    const a_len = a.value.end - a.value.start;
    const b_len = b.value.end - b.value.start;
    if (a_len != b_len) return a_len < b_len;
    if (a.value.start != b.value.start) return a.value.start < b.value.start;
    return prefixLess({}, a.prefix, b.prefix);
}
fn samePrefix(a: Prefix, b: Prefix) bool {
    return a.form == b.form and std.mem.eql(u8, a.text, b.text);
}
const alternatives = [_][]const u8{
    "(?<=\")[^\"\\\\\\r\\n]+(?=\")",
    "(?<=')[^'\\\\\\r\\n]+(?=')",
    "(?<![\"'])(?![\"'])[^ \\t\\r\\n]+",
};
fn forms(prefixes: []const Prefix) [3]bool {
    var used = [_]bool{ false, false, false };
    for (prefixes) |prefix| used[@min(@intFromEnum(prefix.form), 2)] = true;
    return used;
}
fn makeRule(allocator: std.mem.Allocator, selected: []const Prefix) !Rule {
    const sorted = try allocator.dupe(Prefix, selected);
    std.mem.sort(Prefix, sorted, {}, prefixLess);
    var prefixes: std.ArrayList(Prefix) = .empty;
    for (sorted) |prefix| {
        var duplicate = false;
        for (prefixes.items) |item| {
            if (samePrefix(item, prefix)) {
                duplicate = true;
                break;
            }
        }
        if (!duplicate) try prefixes.append(allocator, prefix);
    }
    var expression: std.ArrayList(u8) = .empty;
    try expression.appendSlice(allocator, "(?:^|\\n)");
    if (prefixes.items.len > 1) try expression.appendSlice(allocator, "(?:");
    for (prefixes.items, 0..) |prefix, i| {
        if (i > 0) try expression.append(allocator, '|');
        for (prefix.text) |c| {
            if (std.mem.indexOfScalar(u8, "\\^$.|?*+()[]{}/", c) != null) try expression.append(allocator, '\\');
            try expression.append(allocator, c);
        }
    }
    if (prefixes.items.len > 1) try expression.append(allocator, ')');
    try expression.append(allocator, '(');
    var first = true;
    for (forms(prefixes.items), alternatives) |used, alternative| {
        if (!used) continue;
        if (!first) try expression.append(allocator, '|');
        try expression.appendSlice(allocator, alternative);
        first = false;
    }
    try expression.append(allocator, ')');
    return .{ .expression = try expression.toOwnedSlice(allocator), .prefixes = try prefixes.toOwnedSlice(allocator) };
}

fn valueEnd(content: []const u8, start: usize, form: usize) ?usize {
    if (start >= content.len) return null;
    if (form < 2) {
        const q: u8 = if (form == 0) '"' else '\'';
        if (start == 0 or content[start - 1] != q) return null;
        var end = start;
        while (end < content.len and content[end] != q and content[end] != '\\' and content[end] != '\r' and content[end] != '\n') : (end += 1) {}
        return if (end > start and end < content.len and content[end] == q) end else null;
    }
    if (quote(content[start]) or (start > 0 and quote(content[start - 1]))) return null;
    var end = start;
    while (end < content.len and !endValue(content[end])) : (end += 1) {}
    return if (end > start) end else null;
}

/// Evaluate the IR with JavaScript `g` ordering. A leading LF is part of whole,
/// while a closing quote is only a lookahead and belongs to neither span.
pub fn matches(allocator: std.mem.Allocator, content: []const u8, rule: Rule) ![]const Match {
    var out: std.ArrayList(Match) = .empty;
    const used = forms(rule.prefixes);
    var pos: usize = 0;
    while (pos < content.len) {
        if (pos != 0 and content[pos] != '\n') {
            pos += 1;
            continue;
        }
        // At zero, ^ is tried before the LF alternative.
        const starts: []const usize = if (pos == 0 and content[0] == '\n') &.{ 0, 1 } else if (pos == 0) &.{0} else &.{pos + 1};
        var got: ?Match = null;
        outer: for (starts) |line| {
            for (rule.prefixes) |prefix| {
                if (!std.mem.startsWith(u8, content[line..], prefix.text)) continue;
                const start = line + prefix.text.len;
                for (used, 0..) |enabled, form| {
                    if (!enabled) continue;
                    if (valueEnd(content, start, form)) |end| {
                        got = .{ .whole = .{ .start = pos, .end = end }, .value = .{ .start = start, .end = end } };
                        break :outer;
                    }
                }
            }
        }
        if (got) |match| {
            try out.append(allocator, match);
            pos = match.whole.end;
        } else pos += 1;
    }
    return out.toOwnedSlice(allocator);
}

fn coverage(allocator: std.mem.Allocator, content: []const u8, found: []const Span, matched: []const Match) ![]bool {
    var values: std.ArrayList([]const u8) = .empty;
    for (matched) |match| {
        const value = content[match.value.start..match.value.end];
        var duplicate = false;
        for (values.items) |item| {
            if (std.mem.eql(u8, item, value)) {
                duplicate = true;
                break;
            }
        }
        if (!duplicate) try values.append(allocator, value);
    }
    const copies = try occurrences(allocator, content, values.items);
    const eligible = try allocator.alloc(bool, copies.len);
    for (copies, 0..) |copy, i| {
        eligible[i] = true;
        for (matched) |match| {
            if (overlaps(copy, match.whole)) {
                eligible[i] = false;
                break;
            }
        }
    }
    // First exclude whole-match intersections, then reject both members of
    // every overlapping pair among the remaining copy candidates.
    const isolated = try allocator.dupe(bool, eligible);
    for (copies, 0..) |a, i| {
        if (!eligible[i]) continue;
        for (copies[i + 1 ..], i + 1..) |b, j| {
            if (eligible[j] and overlaps(a, b)) {
                isolated[i] = false;
                isolated[j] = false;
            }
        }
    }
    const covered = try allocator.alloc(bool, found.len);
    @memset(covered, false);
    for (found, 0..) |occurrence, i| {
        for (matched) |match| {
            if (contains(match.value, occurrence)) {
                covered[i] = true;
                break;
            }
        }
        if (!covered[i]) for (copies, isolated) |copy, keep| {
            if (keep and contains(copy, occurrence)) {
                covered[i] = true;
                break;
            }
        };
    }
    return covered;
}

/// Generate only when every overlapping occurrence is covered. Empty patterns
/// are ignored; a caller with no occurrences receives no_form.
pub fn generate(allocator: std.mem.Allocator, content: []const u8, patterns: []const []const u8) !Result {
    var trimmed = content;
    if (std.mem.endsWith(u8, trimmed, "\r\n")) trimmed = trimmed[0 .. trimmed.len - 2] else if (std.mem.endsWith(u8, trimmed, "\n")) trimmed = trimmed[0 .. trimmed.len - 1];
    for (patterns) |pattern| {
        if (pattern.len > 0 and std.mem.eql(u8, trimmed, pattern)) return .whole_file;
    }
    const found = try occurrences(allocator, content, patterns);
    const candidates = try discover(allocator, content, found);
    if (candidates.len == 0) return .{ .skip = .no_form };
    std.mem.sort(Candidate, candidates, {}, candidateLess);
    var selected: std.ArrayList(Prefix) = .empty;
    var covered = try allocator.alloc(bool, found.len);
    @memset(covered, false);
    var eligible: usize = 0;
    for (candidates) |candidate| {
        if (hasPattern(candidate.prefix.text, patterns)) continue;
        eligible += 1;
        var duplicate = false;
        for (selected.items) |prefix| {
            if (samePrefix(prefix, candidate.prefix)) {
                duplicate = true;
                break;
            }
        }
        if (duplicate) continue;
        try selected.append(allocator, candidate.prefix);
        const rule = try makeRule(allocator, selected.items);
        const next = try coverage(allocator, content, found, try matches(allocator, content, rule));
        var grows = false;
        var loses = false;
        var complete = true;
        for (covered, next) |old, new| {
            grows = grows or (!old and new);
            loses = loses or (old and !new);
            complete = complete and new;
        }
        if (!grows or loses) {
            _ = selected.pop();
            continue;
        }
        covered = next;
        if (complete) {
            if (hasPattern(rule.expression, patterns)) return .{ .skip = .prefix_contains_value };
            return .{ .rule = rule };
        }
    }
    return .{ .skip = if (eligible == 0) .prefix_contains_value else .coverage };
}

fn expectRule(allocator: std.mem.Allocator, content: []const u8, patterns: []const []const u8, prefixes: []const []const u8) !Rule {
    const got = try generate(allocator, content, patterns);
    try std.testing.expect(got == .rule);
    try std.testing.expectEqual(prefixes.len, got.rule.prefixes.len);
    for (prefixes, got.rule.prefixes) |expected, actual| try std.testing.expectEqualStrings(expected, actual.text);
    const found = try occurrences(allocator, content, patterns);
    for (try coverage(allocator, content, found, try matches(allocator, content, got.rule))) |covered| try std.testing.expect(covered);
    return got.rule;
}
fn expectSkip(allocator: std.mem.Allocator, content: []const u8, patterns: []const []const u8, reason: SkipReason) !void {
    const got = try generate(allocator, content, patterns);
    try std.testing.expect(got == .skip);
    try std.testing.expectEqual(reason, got.skip);
}

test "README expression escapes the literal property prefix" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const rule = try expectRule(arena.allocator(), "db.password=Tr0ub4dor\n", &.{"Tr0ub4dor"}, &.{"db.password="});
    try std.testing.expectEqualStrings("(?:^|\\n)db\\.password=((?<![\"'])(?![\"'])[^ \\t\\r\\n]+)", rule.expression);
}
test "same value uses one line prefix including whitespace quotes and comments" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    for ([_][]const u8{
        "foo=MY_SECRET\nbar=MY_SECRET\n# MY_SECRET\n",
        "foo=MY_SECRET\nbar MY_SECRET ignored\n# MY_SECRET\n",
        "foo=MY_SECRET\nbar=\"MY_SECRET\"\nbaz='MY_SECRET'\n",
    }) |content| _ = try expectRule(arena.allocator(), content, &.{"MY_SECRET"}, &.{"foo="});
}
test "distinct values select representatives rather than every key" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    _ = try expectRule(arena.allocator(), "foo=FirstSecret9\nbar=SecondSecrt7\ncopy=FirstSecret9\n", &.{ "FirstSecret9", "SecondSecrt7" }, &.{ "foo=", "bar=" });
}
test "quoted forms preserve quotes and assignment wins over inner whitespace" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const content = "API_KEY=\"long DecoyToken9\"\nPASSWORD='DecoyPass\"7'\n";
    const rule = try expectRule(arena.allocator(), content, &.{ "DecoyToken9", "DecoyPass\"7" }, &.{ "API_KEY=\"", "PASSWORD='" });
    const got = try matches(arena.allocator(), content, rule);
    try std.testing.expectEqualStrings("long DecoyToken9", content[got[0].value.start..got[0].value.end]);
    try std.testing.expectEqualStrings("DecoyPass\"7", content[got[1].value.start..got[1].value.end]);
}
test "JSON npmrc netrc and Basic retain full line prefixes" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const cases = [_]struct { content: []const u8, prefix: []const u8, pattern: []const u8 = "MY_SECRET" }{
        .{ .content = "{\"user\":\"app\",\"password\":\"MY_SECRET\"}\n", .prefix = "{\"user\":\"app\",\"password\":\"" },
        .{ .content = "//registry.npmjs.org/:_authToken=MY_SECRET\n", .prefix = "//registry.npmjs.org/:_authToken=" },
        .{ .content = "machine h login u password MY_SECRET\n", .prefix = "machine h login u password " },
        .{ .content = "Authorization: Basic dXNlcjpNWV9TRUNSRVQ=\n", .prefix = "Authorization: Basic ", .pattern = "NWV9TRUNSRVQ" },
    };
    for (cases) |case| _ = try expectRule(arena.allocator(), case.content, &.{case.pattern}, &.{case.prefix});
}
test "URL and base64 wrappers are captured whole" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const content = "DATABASE_URL=postgres://app:MY_SECRET@db\nencoded=cHJlZml4TVlfU0VDUkVUIHN1ZmZpeA==\n";
    const rule = try expectRule(arena.allocator(), content, &.{ "MY_SECRET", "TVlfU0VDUkVU" }, &.{ "DATABASE_URL=", "encoded=" });
    const got = try matches(arena.allocator(), content, rule);
    try std.testing.expectEqualStrings("postgres://app:MY_SECRET@db", content[got[0].value.start..got[0].value.end]);
    try std.testing.expectEqualStrings("cHJlZml4TVlfU0VDUkVUIHN1ZmZpeA==", content[got[1].value.start..got[1].value.end]);
    try expectSkip(arena.allocator(), "postgres://app:MY_SECRET@db\n", &.{"MY_SECRET"}, .no_form);
}
test "URL tokens block internal keys while outer assignments capture them whole" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try expectSkip(a, "https://host/path;token=MY_SECRET\n", &.{"MY_SECRET"}, .no_form);

    const ws_content = "url postgres://app;token=MY_SECRET@db\n";
    const ws_rule = try expectRule(a, ws_content, &.{"MY_SECRET"}, &.{"url "});
    const ws_matches = try matches(a, ws_content, ws_rule);
    try std.testing.expectEqualStrings("postgres://app;token=MY_SECRET@db", ws_content[ws_matches[0].value.start..ws_matches[0].value.end]);

    const colon_content = "url:postgres://app:MY_SECRET@db\n";
    const colon_rule = try expectRule(a, colon_content, &.{"MY_SECRET"}, &.{"url:"});
    const colon_matches = try matches(a, colon_content, colon_rule);
    try std.testing.expectEqualStrings("postgres://app:MY_SECRET@db", colon_content[colon_matches[0].value.start..colon_matches[0].value.end]);
}
test "outer colon assignments precede separators inside URL tokens" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const urls = [_][]const u8{
        "postgres://host/token=MY_SECRET",
        "postgres://host/token:MY_SECRET",
        "postgres://host;token=MY_SECRET",
        "postgres://host?token=MY_SECRET",
        "postgres://host#token=MY_SECRET",
        "postgres://app:MY_SECRET@db",
        "postgres://[host]/token=MY_SECRET",
        "git+ssh://host/token=MY_SECRET",
        "postgres://host'part;token=MY_SECRET",
        "postgres://host\"part;token=MY_SECRET",
    };
    for (urls) |url| {
        const content = try std.fmt.allocPrint(a, "url:{s}\n", .{url});
        const rule = try expectRule(a, content, &.{"MY_SECRET"}, &.{"url:"});
        try std.testing.expectEqual(Form.bare, rule.prefixes[0].form);
        const got = try matches(a, content, rule);
        try std.testing.expectEqual(@as(usize, 1), got.len);
        try std.testing.expectEqualStrings(url, content[got[0].value.start..got[0].value.end]);
        const bare = try std.fmt.allocPrint(a, "{s}\n", .{url});
        try expectSkip(a, bare, &.{"MY_SECRET"}, .no_form);
    }
}
test "quoted URL contexts preserve later fields and URL-like quoted keys" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const cases = [_]struct { prefix: []const u8, suffix: []const u8, form: Form }{
        .{ .prefix = "{\"url\":\"https://host\",\"password\":\"", .suffix = "\"}\n", .form = .dq },
        .{ .prefix = "{'url':'https://host','password':'", .suffix = "'}\n", .form = .sq },
        .{ .prefix = "url=\"https://host'part\";password='", .suffix = "'\n", .form = .sq },
        .{ .prefix = "url='https://host\"part';password=\"", .suffix = "\"\n", .form = .dq },
        .{ .prefix = "url=\"https://host\\\"part\";password=\"", .suffix = "\"\n", .form = .dq },
        .{ .prefix = "url='https://host\\'part';password='", .suffix = "'\n", .form = .sq },
        .{ .prefix = "{\"https://host\":\"", .suffix = "\"}\n", .form = .dq },
        .{ .prefix = "{'https://host':'", .suffix = "'}\n", .form = .sq },
        .{ .prefix = "\"https://host\" ", .suffix = "\n", .form = .ws },
    };
    for (cases) |case| {
        const content = try std.fmt.allocPrint(a, "{s}MY_SECRET{s}", .{ case.prefix, case.suffix });
        const rule = try expectRule(a, content, &.{"MY_SECRET"}, &.{case.prefix});
        try std.testing.expectEqual(case.form, rule.prefixes[0].form);
        const got = try matches(a, content, rule);
        try std.testing.expectEqual(@as(usize, 1), got.len);
        try std.testing.expectEqualStrings("MY_SECRET", content[got[0].value.start..got[0].value.end]);
    }
    // Escapes do not turn a quoted URL's interior into supported assignments.
    try expectSkip(a, "url=\"https://host\\\";password=MY_SECRET\"\n", &.{"MY_SECRET"}, .no_form);
    try expectSkip(a, "url='https://host\\';password=MY_SECRET'\n", &.{"MY_SECRET"}, .no_form);
    // Quotes in an unquoted URL do not end its whitespace-delimited token.
    try expectSkip(a, "https://host'part;token=MY_SECRET\n", &.{"MY_SECRET"}, .no_form);
    try expectSkip(a, "https://host\"part;token=MY_SECRET\n", &.{"MY_SECRET"}, .no_form);
}
test "encoded copies need their own captured value" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    try expectSkip(arena.allocator(), "foo=MY_SECRET\n# TVlfU0VDUkVU\n", &.{ "MY_SECRET", "TVlfU0VDUkVU" }, .coverage);
    _ = try expectRule(arena.allocator(), "foo=MY_SECRET\nencoded=TVlfU0VDUkVU\n", &.{ "MY_SECRET", "TVlfU0VDUkVU" }, &.{ "foo=", "encoded=" });
    try expectSkip(arena.allocator(), "foo=abMY_SECRETab\n# MY_SECRET\n", &.{"MY_SECRET"}, .coverage);
}
test "shorter complete values represent larger wrappers" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    _ = try expectRule(arena.allocator(), "wrapped=abMY_SECRETab\nfoo=MY_SECRET\n", &.{"MY_SECRET"}, &.{"foo="});
}
test "whole file strips at most one LF or CRLF" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    for ([_][]const u8{ "MY_SECRET", "MY_SECRET\n", "MY_SECRET\r\n" }) |content| {
        try std.testing.expect((try generate(arena.allocator(), content, &.{"MY_SECRET"})) == .whole_file);
    }
    for ([_][]const u8{ "MY_SECRET\n\n", "MY_SECRET\r\n\r\n", "MY_SECRET\r" }) |content| try expectSkip(arena.allocator(), content, &.{"MY_SECRET"}, .no_form);
}
test "missing escaped or empty quotes never become bare or inner keys" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    for ([_][]const u8{
        "token=\"MY_SECRET\n",       "token='MY_SECRET\n",                   "token=\"long MY_SECRET\\n\"\n",
        "token='MY_SECRET\\x'\n",    "token=\"inner=MY_SECRET\n",            "token=\"inner MY_SECRET\n",
        "token=\"\"\n# MY_SECRET\n", "token=\"x\\\" password MY_SECRET\"\n",
    }) |content| try expectSkip(arena.allocator(), content, &.{"MY_SECRET"}, .no_form);
}
test "prefix secrets are rejected before regex escaping" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    try expectSkip(arena.allocator(), "MY_SECRET=MY_SECRET\n", &.{"MY_SECRET"}, .prefix_contains_value);
    try expectSkip(arena.allocator(), "foo.bar=foo.bar\n", &.{"foo.bar"}, .prefix_contains_value);
    try expectSkip(arena.allocator(), "aa=FirstSecret9; bb=SecondSecrt7\n", &.{ "FirstSecret9", "SecondSecrt7" }, .coverage);
    // A raw pattern can also arise in the regex syntax itself.
    try expectSkip(arena.allocator(), "token=aaaa\n", &.{ "aaaa", "[^" }, .prefix_contains_value);
}
test "copies cannot intersect whole matches or other copies" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try expectSkip(a, "token=aaaa\n# aaaaa\n", &.{"aaaa"}, .coverage);
    // Different captured strings also conflict where their copies overlap.
    try expectSkip(a, "aa=abcd\nbb=cdef\n# abcdef\n", &.{ "abcd", "cdef" }, .coverage);
    const content = "token=abcd\n# token=abcd\n";
    const matched = [_]Match{.{ .whole = .{ .start = 0, .end = 10 }, .value = .{ .start = 6, .end = 10 } }};
    const got = try coverage(a, content, &.{ .{ .start = 0, .end = 4 }, .{ .start = 6, .end = 10 }, .{ .start = 19, .end = 23 } }, &matched);
    try std.testing.expectEqualSlices(bool, &.{ false, true, true }, got);
}
test "all overlapping pattern occurrences count and duplicates do not conflict" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const found = try occurrences(a, "aaaaa", &.{ "aaaa", "aaaa", "aaa" });
    try std.testing.expectEqual(@as(usize, 5), found.len);
    _ = try expectRule(a, "token=aaaaa\n# aaaaa\n", &.{ "aaaa", "aaa" }, &.{"token="});
    _ = try expectRule(a, "token=MY_SECRET\ntoken=MY_SECRET\n# MY_SECRET\n", &.{ "MY_SECRET", "MY_SECRET" }, &.{"token="});
}
test "UTF8 literal prefixes indentation blank lines and CRLF have byte spans" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const content = "\n😀 [a](b)^$|?*+\\/; token=秘密9\r\n\r\n  token=OtherSecret9\n";
    const rule = try expectRule(a, content, &.{ "秘密9", "OtherSecret9" }, &.{ "😀 [a](b)^$|?*+\\/; token=", "  token=" });
    const got = try matches(a, content, rule);
    try std.testing.expectEqual(@as(usize, 2), got.len);
    try std.testing.expectEqual(@as(usize, 0), got[0].whole.start);
    try std.testing.expectEqualStrings("秘密9", content[got[0].value.start..got[0].value.end]);
    try std.testing.expectEqualStrings("OtherSecret9", content[got[1].value.start..got[1].value.end]);
    try std.testing.expectEqual(@as(u8, '\n'), content[got[1].whole.start]);
    try std.testing.expectEqual(@as(usize, 0), (try matches(a, "extra  token=OtherSecret9\n", rule)).len);
}
test "ordered composite alternatives and global restart follow the IR" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const rule = try makeRule(a, &.{
        .{ .text = "aa=", .form = .bare, .start = 0 },
        .{ .text = "aa=pre", .form = .bare, .start = 10 },
        .{ .text = "qq='", .form = .sq, .start = 20 },
        .{ .text = "qq=\"", .form = .dq, .start = 30 },
        .{ .text = "aa=", .form = .bare, .start = 40 },
    });
    try std.testing.expectEqual(@as(usize, 4), rule.prefixes.len);
    const content = "aa=prefix\naa=next\r\nqq='with spaces'\nqq=\"double\"\n";
    const got = try matches(a, content, rule);
    try std.testing.expectEqual(@as(usize, 4), got.len);
    try std.testing.expectEqualStrings("prefix", content[got[0].value.start..got[0].value.end]);
    try std.testing.expectEqual(got[0].whole.end, got[1].whole.start);
    try std.testing.expectEqualStrings("with spaces", content[got[2].value.start..got[2].value.end]);
    try std.testing.expectEqualStrings("double", content[got[3].value.start..got[3].value.end]);
}
test "two-character keys and allowed preceding boundaries are required" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    for ([_][]const u8{ "x=MY_SECRET\n", "!token=MY_SECRET\n", "token \"MY_SECRET\"\n" }) |content| try expectSkip(a, content, &.{"MY_SECRET"}, .no_form);
    for ([_][]const u8{ "aa: MY_SECRET\n", "'aa' = MY_SECRET\n", "\t{aa=MY_SECRET\n", ";aa=MY_SECRET\n", ",aa=MY_SECRET\n" }) |content| {
        try std.testing.expect((try generate(a, content, &.{"MY_SECRET"})) == .rule);
    }
    try expectSkip(a, "empty=\n", &.{ "", "absent" }, .no_form);
}

test "whole-match intersections are removed before copy overlap exclusion" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    // The rightmost copy is outside H. Earlier overlapping copies intersect H
    // and must not disqualify it after that first exclusion step.
    const got = try coverage(arena.allocator(), "aa=aaaaaaaa", &.{.{ .start = 7, .end = 11 }}, &.{.{
        .whole = .{ .start = 0, .end = 7 },
        .value = .{ .start = 3, .end = 7 },
    }});
    try std.testing.expectEqualSlices(bool, &.{true}, got);
}

test "short key at EOF and embedded CR do not form values" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    try expectSkip(arena.allocator(), "# MY_SECRET\naa", &.{"MY_SECRET"}, .no_form);
    try expectSkip(arena.allocator(), "token=\r# MY_SECRET\n", &.{"MY_SECRET"}, .no_form);
}
