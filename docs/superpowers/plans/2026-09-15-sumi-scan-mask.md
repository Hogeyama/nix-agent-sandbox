# sumi scan credentials mask implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace scan's denyRead registration with verified credential-file mask entries, preserving user-owned settings.

**Architecture:** A pure extraction module recognizes value forms, selects representative line prefixes, renders one capture-group expression, and checks its coverage. The scan command discovers files, calls that module, reconciles entries and ownership records, and saves the resulting settings. A test-only executable exports the extraction module's results for comparison with JavaScript; Bun is not a runtime dependency.

**Tech Stack:** Zig 0.15.2, Bun for development verification, Bash/jq/Python for existing black-box tests.

## Global Constraints

- Specification: `docs/superpowers/specs/2026-09-15-sumi-scan-mask-design.md`. Read it before implementing or reviewing. Evidence: `docs/superpowers/probes/2026-09-15-sumi-credential-mask-results.md`.
- This replaces `sandbox.filesystem.denyRead` generation with `sandbox.credentials.files`, `mode: "mask"`.
- The prefix is the literal content from the start of the line to the value, including indentation and preceding fields. Use `(?:^|\n)`; do not restore the generated key-boundary lookbehind or generalized whitespace prefixes.
- Extract rules always write `maskDuplicates: true`; whole-file rules omit both `extract` and `maskDuplicates`.
- New entries use `injectHosts: []` and `onExtractNoMatch: "deny"`. Regeneration preserves user `injectHosts` and unrelated fields.
- Pattern matching uses `secrets.load`'s existing expansions. No new encoding expansion, entropy threshold, arbitrary regular-expression engine, or runtime Bun dependency.
- Do not write raw or expanded secrets into generated prefixes, regexes, ownership records, or diagnostics. Test only with decoys.
- Preserve exclusion of `.git`, symlinks, non-regular files, and the secrets file. Do not change the shared `src/zig/mask.zig`, hooks, or the secrets-file protection model.
- Do not add a denyRead migration or removal procedure. Existing denyRead entries and invalid old ownership records are handled by the specification's existing validation/conflict rules.
- Read `skills/test-policy/SKILL.md`, `skills/post-change-checks/SKILL.md`, `skills/git-commit/SKILL.md`, and the repository AGENTS.md guidance. The existing sumi Zig and shell test conventions apply to this standalone Zig program; use Bun only for its parity checks.
- Use focused tests during implementation; the controller runs repository fmt/lint/check and the full `bun run test` once as the final check requested by the repository instructions.
- User authorized unattended implementation through push. Task and final automated reviews are required; no human approval wait is needed for this run. Do not push from a subagent.
- Worktree: `/home/hogeyama/repo/nix-agent-sandbox/.worktrees/sumi-scan-mask`, branch `feat/sumi-scan-mask`.

## Task 1: Generate and verify extract rules

**Files:**
- Create `contrib/sumi/claude/extract.zig` (pure extraction and colocated unit tests).
- Create `contrib/sumi/tests/extract-fixtures.zig` (test-only JSON fixture exporter).
- Create `contrib/sumi/tests/extract-parity.ts` (compare Zig matches and JavaScript matches).
- Modify `contrib/sumi/build.zig` (test module and test-only parity executable).

**Interfaces:**
- Consumes: file bytes and expanded patterns, supplied by callers; no filesystem or environment access in `extract.zig`.
- Produces the following public API. Internal helpers remain private unless the fixture exporter needs them. All results allocate from the supplied allocator; callers use an arena for the operation, and input file bytes must live for that arena's use of the rule.

```zig
pub const Span = struct { start: usize, end: usize };
pub const Match = struct { whole: Span, value: Span };
pub const Form = enum { dq, sq, bare, ws };
pub const Prefix = struct { text: []const u8, form: Form, start: usize };
pub const Rule = struct { expression: []const u8, prefixes: []const Prefix };
pub const SkipReason = enum {
    no_form, prefix_contains_value, coverage,
    pub fn code(self: SkipReason) []const u8 {
        return switch (self) {
            .no_form => "no-form",
            .prefix_contains_value => "prefix-contains-value",
            .coverage => "coverage",
        };
    }
};
pub const Result = union(enum) { whole_file, rule: Rule, skip: SkipReason };
pub fn generate(allocator: std.mem.Allocator, content: []const u8,
    patterns: []const []const u8) !Result;
pub fn matches(allocator: std.mem.Allocator, content: []const u8,
    rule: Rule) ![]const Match;
```

- [ ] **Implement occurrence discovery and candidate recognition with focused unit cases.** Enumerate every overlapping pattern occurrence and the value forms specified by the design. Recognize assignment forms before whitespace forms containing the same occurrence; do not recognize a key inside a URL or a quoted assignment value. A candidate stores the literal line prefix, value span and form. Closed nonempty dq/sq values exclude backslash and their own quote; bare/ws exclude initial quotes and end at SP/HT/CR/LF. Whole-file matching removes at most one trailing LF or CRLF.

The unit tests should use real assertions on inputs/outputs, such as:

```zig
test "same value uses one line prefix" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const got = try generate(arena.allocator(),
        "foo=MY_SECRET\nbar=MY_SECRET\n# MY_SECRET\n", &.{"MY_SECRET"});
    try std.testing.expect(got == .rule);
    try std.testing.expectEqual(@as(usize, 1), got.rule.prefixes.len);
    try std.testing.expectEqualStrings("foo=", got.rule.prefixes[0].text);
}
```

Include the full spec's acceptance matrix: README, repeated values with ws/quotes/comments, two distinct values, dq+sq, JSON, npmrc, netrc, Basic, URL and embedded base64 values, raw versus encoded copies, wrapped values that cannot cover standalone copies, whole-file with LF/CRLF/no newline, missing/escaped quotes, prefixes containing raw secrets including regex punctuation, and overlap exclusions. Use arena-backed tests so every path is freed at test completion.

- [ ] **Render expressions and evaluate the same intermediate representation.** Escape only regex-special characters in each prefix. Sort selected prefixes by form then source position, deduplicate them, and render:

```text
(?:^|\n)(?:P1|P2)(A1|A2)
dq:      (?<=")[^"\\\r\n]+(?=")
sq:      (?<=')[^'\\\r\n]+(?=')
bare/ws: (?<!["'])(?!["'])[^ \t\r\n]+
```

With one prefix, omit only its enclosing noncapture group. `matches` must follow JavaScript global matching: earliest whole match, ordered prefix and value alternatives, greedy values, resume after the whole match. The leading LF belongs to the whole match, not the value. Test non-ASCII UTF-8, LF/CRLF, blank lines, indentation, metacharacters in literal prefixes, adjacent lines, and mixed forms. Do not parse the rendered regex back into a matcher.

- [ ] **Select representatives using complete coverage recomputation.** Sort candidates by value byte length, value position, form, then prefix position. Remove prefixes containing any expanded pattern before selection. Tentatively add one candidate, evaluate the entire composite rule, and keep it only if the covered occurrence set grows without losing existing coverage. Copy ranges come from complete captured strings, must lie outside all whole-match ranges, and overlapping copy candidates are both excluded. Stop when all occurrences are covered; otherwise return the specified skip reason. Check the final rendered expression for pattern leakage. Do not introduce fallback deny entries, partial-success rules, or minimization search.

- [ ] **Export actual Zig results for JavaScript parity.** Add a test-only executable built by `zig build extract-fixtures`, output `zig-out/bin/sumi-extract-fixtures`. Import the production extraction module into it through a build module. It writes JSON to stdout, with fixtures in this shape:

```json
[{"name":"netrc","content":"machine h login u password MY_SECRET\n","patterns":["MY_SECRET"],"expression":"...generated...","matches":[{"whole":{"start":0,"end":35},"value":{"start":26,"end":35}}]}]
```

The values above illustrate the wire shape; generate the actual positions with `extract.matches`, not hardcoded spans. Include success, whole-file and skip results as tagged fixture outcomes. `tests/extract-parity.ts` invokes this test-only executable, verifies expected fixture outcomes, compares whole/value spans against `new RegExp(expression, "gd")`, translates UTF-16 indices to UTF-8 byte positions with `Buffer.byteLength`, checks `gmd` capture parity for LF/CRLF cases, and verifies all listed patterns disappear after conservative capture/copy replacement. Fail with a fixture name and clear mismatch; do not implement another candidate recognizer in TypeScript.

- [ ] **Verify and commit.** Run `zig fmt` on touched Zig files, `zig build test --summary all`, `zig build extract-fixtures`, and `bun tests/extract-parity.ts` from `contrib/sumi`. Include the extraction tests in the `zig build test` target while retaining all existing tests. Ensure the ordinary executable has no dependency on the test-only target. Record exact test evidence in the report, then commit following `git-commit`.

## Task 2: Register masks, reconcile settings, and document the command

**Files:**
- Modify `contrib/sumi/claude/scan.zig`.
- Modify `contrib/sumi/tests/run-tests.sh`.
- Modify `contrib/sumi/README.md` and `contrib/sumi/CHANGELOG.md`.
- Modify `.github/workflows/ci.yml` only to require and run the parity checks in the existing sumi test lane.

**Interfaces:**
- Consumes Task 1 `extract.generate`, `Result`, `SkipReason.code`. Uses `init.defaultSettingsPath`, `init.backup`, `init.formatTimestamp`, `jsonio.parse/stringifyPretty`, and `secrets.load` unchanged.
- Produces the existing `scan.main(allocator, args) !u8` command contract. Private helpers may be reorganized within scan.zig. Keep `readerHolds` for chunked presence detection, including its chunk-boundary tests; new pure settings helpers can replace the old denyRead merge API.

- [ ] **Validate inputs and resolve paths before writes.** Keep current argument parsing and usage status2. Default settings through `init.defaultSettingsPath(allocator, getenv("CLAUDE_CONFIG_DIR"), home)`. Resolve root, secrets file, and settings parent through realpath (nearest existing ancestor for nonexistent directories). Reject a settings parent whose resolved basename is `.claude` unless it is the resolved user settings directory. Entries are always absolute, never `./...`. Validate present JSON parents, credentials.files entry shapes, and denyRead string arrays without adding an unused filesystem object. Validate the sidecar's `credentialsFiles` absolute-path string array and preserve unrelated JSON fields.

- [ ] **Represent scan results so unknown files cannot become deletions.** Walk regular files under root with the existing exclusions. Record unreadable directories/files and excluded paths as preserved subtrees/paths, and mark a failed directory iteration's subtree unknown. For each file, use `readerHolds`; if a secret is present, apply path-character, size and UTF-8 checks in that order, then call `extract.generate`. Read at most 8 MiB + 1 for extraction, and verify presence/coverage against the content actually used. Do not optimize multi-pattern scanning or modify shared mask code.

A suitable internal outcome representation is:

```zig
const Outcome = union(enum) {
    clean,
    masked: ?[]const u8, // null = whole-file; otherwise owned expression
    skipped: []const u8, // one of the specified reason codes
};
const Finding = struct { path: []const u8, outcome: Outcome };
```

Keep failure/unknown records separate from confirmed clean/missing findings. For old owned paths not found during traversal, confirm disappearance or exclusion without following symlinks before deleting. No errors that lose filesystem knowledge may be treated as confirmed absence.

- [ ] **Reconcile credential entries and ownership.** The user/duplicate-entry/denyRead conflict checks precede changes. For generated paths, create or update exactly the spec fields; omit/delete extract and maskDuplicates for whole-file entries. Preserve injectHosts even if absent, other fields, other roots, excluded paths and unknown paths. Remove owned entries and ownership when the file is confirmed gone/clean, or when regeneration fails (the latter emits unmask and returns1). New non-generatable files emit skip and do not force failure. Maintain deterministic order and do not claim existing user entries.

The fixed fields for a new extracted entry are:

```json
{"path":"/absolute/file","mode":"mask","extract":"generated expression","maskDuplicates":true,"injectHosts":[],"onExtractNoMatch":"deny"}
```

In-memory settings tests should cover all branches of the specification's reconciliation table, including exact path boundaries (`/p` versus `/pp`, and root `/`), duplicate paths, mode/extract/maskDuplicates changes, preserved absent injectHosts, and unknown/excluded owned paths. Use allocator-owned JSON values with safe lifetimes; pointers into hash maps must not survive reallocating insertions into the same map.

- [ ] **Save changed outputs and report accurately.** Construct and serialize both outputs before writing; compare each independently to avoid unnecessary settings, record, or backup writes. Back up existing settings with the established 0600 format only if settings change. Write settings first, record second; a record-write failure restores original settings bytes (or deletes a newly created settings file). Failure to restore reports both paths and returns1. Exercise rollback through a testable file-write boundary or real filesystem failure, not a test asserting only a mocked call.

Emit only specified paths, reason codes, counts and fixed diagnostics. Print file results and `N masked, N unmasked, N skipped in <settings>` to stderr. Notes depend on sandbox.enabled and final injectHosts state. Remove old denyRead-specific status text and unsolicited manual-migration advice. Preserve existing path/argument and chunked-reader regression tests unless their behavior was deliberately replaced.

- [ ] **Replace the obsolete scan black-box tests with the new contract.** Keep the other existing test sections intact. Use explicit settings paths or a command-scoped CLAUDE_CONFIG_DIR in the test directory, never a real user's settings. Build test fixtures for new/add/update/delete, default user path, project .claude rejection (including resolved aliases and nonexistent parents), ownership conflicts, exact denyRead conflict, exclusion/unreadability retention, oversized/invalid UTF-8/glob/no-form/coverage skip, false-to-true maskDuplicates, extracted-to-whole-file transitions, injectHosts-aware notes, zero writes on unchanged rescan, invalid inputs, and rollback. Use checked exit statuses, compare settings contents, and ensure decoys are absent from new settings/record/diagnostics.

At the end of the shell test lane, run parity when Bun exists and print an explicit skip otherwise. CI must have Bun and must fail if it is unavailable; it should build the fixture target before invoking the shell lane:

```yaml
- name: sumi black-box tests
  run: nix develop -c bash -lc 'command -v bun >/dev/null && cd contrib/sumi && zig build && zig build extract-fixtures && ./tests/run-tests.sh'
```

- [ ] **Update the reader-facing behavior.** Rewrite only the scan subsection of README around reading masked files rather than denying reads, with the existing app.properties example. Cover user settings/default override, ignored project settings, mask/skip/unmask results, rescanning, user-owned settings, masks not enabling authentication until the user sets injectHosts/allowedDomains/tlsTerminate, empty injectHosts warning, and value/copy replacement. Explain the existing scope limit around the secrets file without adding migration procedures. Add an Unreleased Changed entry in CHANGELOG. Preserve historical 0.1.0 notes; if the heading link changes, update its link target to the current scan section.

- [ ] **Verify and commit.** Run touched-file `zig fmt`, `zig build test --summary all`, `zig build`, `zig build extract-fixtures`, `bun tests/extract-parity.ts`, and `./tests/run-tests.sh` from `contrib/sumi`. Validate shell syntax and diff whitespace. Do not run the repository full test suite here; the controller runs it once after task/final reviews. Write the report and commit following `git-commit`.

## Controller completion

- Review each task using `skills/patched-superpowers/code-reviewer-prompt.md` and `.superpowers/review-config.yml`, with a task brief, report, and full range diff.
- Validate and fix findings in separate commits, then re-review. Final broad review uses the most capable model and high reasoning over implementation-base..HEAD.
- Run final sumi verification and repository `fmt`, `lint`, `check`, then `bun run test` once. Report skips accurately; new Claude Code masks cannot be claimed host-validated when the CLI is absent.
- Keep no background host probe or disposable review server. The user removed the old probe and authorized unattended completion.
- Fixup purely corrective commits into their relevant implementation commits after review, then verify final tree identity.
- Integrate into the original main checkout only if it is clean and has not moved incompatibly; fetch origin and push the completed work without force. If main has advanced, reconcile on the implementation branch and revalidate affected code before pushing.
