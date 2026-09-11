# sumi Single Binary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `contrib/sumi/` に、Claude Code の hook として動き、列挙した値をツール出力・Bash 出力から `*` に置き換え、値を含む `@` 添付を拒否する単一の静的バイナリ `sumi` を作り、GitHub Release から 1 ファイルで配れるようにする。

**Architecture:** Zig 0.15 の実行ファイル 1 つ。マスク本体 (`src/zig/mask.zig`) と子プロセス監督 (`src/mask-filter/supervise.zig`) を nas と共有し、hook の JSON 入出力・`@` 添付の走査・settings.json のマージだけを `contrib/sumi/` に書く。`init` が `~/.claude/settings.json` に 4 つの hook entry を書き、以後は hook 呼び出しごとに `sumi` が起動して exit 0 で決定を返す。

**Tech Stack:** Zig 0.15.2 (`std.json`、`std.posix`、`std.process.Child`)、musl 静的リンク、Nix flake、GitHub Actions。

Spec: `docs/superpowers/specs/2026-09-11-sumi-single-binary-design.md`

## Global Constraints

- Zig は 0.15.2 (`pkgs.zig_0_15`)。`std.ArrayList` は unmanaged (`.empty` で初期化し、メソッドに allocator を渡す)。ファイルの入出力は `std.fs.File` の `readToEndAlloc` / `writeAll` / `deprecatedReader` / `deprecatedWriter` を使う。
- `--agent` は `init` と `hook` で必須。受け付ける値は `claude` のみ。他は exit 2。既定値を置かない。
- secrets ファイル: 1 行 1 値、空行無視、行末 LF のみ除去、各値は UTF-8 として有効で 4 バイト以上、1024 件以下。違反は `init` では exit 1、hook では fail-closed (exit 0 で decision)。
- hook サブコマンドは引数解釈が終わった後は必ず exit 0 で決定を返す。post-tool は withhold、prompt は `decision: block`、pre-bash は `permissionDecision: deny`。理由文は `sumi: ` で始める。
- pre-bash は `permissionDecision` を返さない。
- `run` は PATH 探索をしない。`init` が `--shell` を PATH から解決して絶対パスを書く。
- `init` は既存 hook を消さない。取り除くのは「command の先頭語の basename が自分の basename と一致し、次の語が `hook`」の entry だけ。
- `init` が書く entry は `timeout: 20`。prompt hook の内部期限は 15 秒。
- `run` が子に付ける環境変数は `SUMI_SUPERVISED=1`。診断文言は `sumi:` で始める。
- `nas-mask-filter` の CLI (`src/mask-filter/mask_filter.zig`) は変更しない。作業ツリーに残っている `mask_filter.zig` の未コミット差分は破棄する。
- コミットメッセージは `git-commit` スキルの形式。コード内に「今回変えた」類のコメントを書かない。
- 実装前に読むもの: spec 全文、`.claude/skills/security-constraints/SKILL.md`。テストの命名・分類は `.claude/skills/test-policy/SKILL.md` (Zig と bash のテストには Unit/e2e の区分だけ適用する)。
- 例示に使うファイル名・値はすべてデコイ (`config/app.properties`、`db.password=`、`Tr0ub4dor`、`hunter2xyz`、`ab"cd-decoy`)。実在のプロジェクトを指す名前を使わない。

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `src/mask-filter/supervise.zig` (modify) | `runLocal` に診断名とマーカー名を受ける `LocalOptions` を足す。`mask_stream` を `pub const` で再エクスポートする。 |
| `contrib/sumi/build.zig` (create) | `sumi` 実行ファイル、`-Dversion` / `-Dstrip` オプション、ホスト向け unit test。 |
| `contrib/sumi/main.zig` (create) | argv の振り分け。`--version`、`filter`、`run`、`hook --agent claude <sub>`、`init --agent claude`。exit 2 の usage。 |
| `contrib/sumi/secrets.zig` (create) | 平文 secrets ファイルの読み込みと検証。 |
| `contrib/sumi/shell.zig` (create) | POSIX シェル向け quote。pre-bash と init が共用。 |
| `contrib/sumi/jsonio.zig` (create) | stdin の読み取り、`Value` の parse (後勝ち)、`Value` の文字列リーフ・キーのマスク、JSON 文字列のエスケープ出力。 |
| `contrib/sumi/claude/hook_bash.zig` (create) | PreToolUse(Bash): command の書き換え。 |
| `contrib/sumi/claude/hook_post.zig` (create) | PostToolUse / PostToolUseFailure。 |
| `contrib/sumi/claude/hook_prompt.zig` (create) | UserPromptSubmit: `@` トークン抽出、ファイル走査、拒否判定。 |
| `contrib/sumi/claude/init.zig` (create) | settings.json のマージ、バックアップ、自己診断。 |
| `contrib/sumi/tests/run-tests.sh` (create) | ビルド済み `sumi` に JSON を流す黒箱テスト。bash と jq を使う。 |
| `contrib/sumi/README.md` (create) | 導入手順、塞ぐ経路、守らないもの、固める構成、実測表。 |
| `flake.nix` (modify) | `packages.sumi`。 |
| `.github/workflows/release.yml` (modify) | `sumi-<system>` を Release に添付。 |
| `.github/workflows/ci.yml` (modify) | `zig build test` と `run-tests.sh` を CI で回す。 |

---

### Task 1: supervise.zig を sumi から使える形にする

**Files:**
- Modify: `src/mask-filter/supervise.zig`
- Revert: `src/mask-filter/mask_filter.zig` (作業ツリーの未コミット差分を破棄)

**Interfaces:**
- Produces: `supervise.LocalOptions { prog_name: []const u8, marker_env: [:0]const u8 }`、`supervise.runLocal(allocator, secrets, argv0, program, args, opts: LocalOptions) !u8`、`supervise.mask_stream` (再エクスポート)、`supervise.EXIT_EXEC_FAILED`。
- Consumes: なし。

- [ ] **Step 1: 作業ツリーの状態を確認し、mask_filter.zig の差分を破棄する**

```bash
cd /home/cq2n-iwym/repo/nix-agent-sandbox
git status --short src/mask-filter
git checkout -- src/mask-filter/mask_filter.zig
git status --short src/mask-filter
```

Expected: 2 行目の出力で `M src/mask-filter/supervise.zig` だけが残る。

- [ ] **Step 2: 既存の supervise.zig テストが通ることを確認する**

```bash
cd src/mask-filter && zig build test 2>&1 | tail -3
```

Expected: エラーなし (成功時は出力なし、または `All N tests passed`)。

- [ ] **Step 3: runLocal が診断名とマーカー名を受けるテストを書く**

`src/mask-filter/supervise.zig` の末尾の tests セクションに追加:

```zig
test "buildChildEnvp: marker name comes from the caller" {
    var environ = [_:null]?[*:0]u8{ @constCast("A=1"), @constCast("SUMI_SUPERVISED=0") };
    const envp = try buildChildEnvp(testing.allocator, &environ, "SUMI_SUPERVISED=1");
    defer testing.allocator.free(envp);

    try testing.expectEqual(@as(usize, 2), envp.len);
    try testing.expectEqualStrings("A=1", std.mem.span(envp[0].?));
    try testing.expectEqualStrings("SUMI_SUPERVISED=1", std.mem.span(envp[1].?));
}
```

既存の 2 つの `buildChildEnvp` テストの呼び出しを `buildChildEnvp(testing.allocator, &environ, "NAS_MASK_SUPERVISED=1")` に変える。

- [ ] **Step 4: テストが落ちることを確認する**

```bash
cd src/mask-filter && zig build test 2>&1 | head -5
```

Expected: `expected 2 argument(s), found 3` のコンパイルエラー。

- [ ] **Step 5: buildChildEnvp とspawnChild をマーカー名を受ける形にし、runLocal に LocalOptions を足す**

`src/mask-filter/supervise.zig` の該当箇所を次のように変える。

`SUPERVISED_ENTRY` / `SUPERVISED_PREFIX` の定義 (109-110 行付近) を置き換える:

```zig
/// nas のコンテナ内ラッパーが使うマーカー。sumi は自前の名前を渡す。
pub const NAS_SUPERVISED_ENTRY: [:0]const u8 = "NAS_MASK_SUPERVISED=1";
```

`buildChildEnvp` のシグネチャと本体:

```zig
/// 子へ渡す環境を組み立てる。**fork の前に**呼ぶこと (子ではアロケートしない)。
///
/// `marker_entry` は `NAME=1` の形。既存の同名エントリは追加ではなく**置換**する。
/// append すると同名の重複エントリが残り、どちらが効くかは getenv の実装依存になる。
fn buildChildEnvp(
    allocator: std.mem.Allocator,
    environ: [*:null]?[*:0]u8,
    marker_entry: [:0]const u8,
) ![:null]?[*:0]const u8 {
    const eq = std.mem.indexOfScalar(u8, marker_entry, '=') orelse marker_entry.len;
    const prefix = marker_entry[0 .. eq + 1];

    var n: usize = 0;
    while (environ[n] != null) : (n += 1) {}

    var replace_at: ?usize = null;
    var i: usize = 0;
    while (i < n) : (i += 1) {
        if (std.mem.startsWith(u8, std.mem.span(environ[i].?), prefix)) {
            replace_at = i;
            break;
        }
    }

    const envp = try allocator.allocSentinel(?[*:0]const u8, if (replace_at == null) n + 1 else n, null);
    i = 0;
    while (i < n) : (i += 1) envp[i] = environ[i].?;
    envp[replace_at orelse n] = marker_entry.ptr;
    return envp;
}
```

`spawnChild` に 2 つの引数を足す。シグネチャ:

```zig
fn spawnChild(
    allocator: std.mem.Allocator,
    argv0: []const u8,
    program: []const u8,
    args: []const []const u8,
    extra_child_close: []const posix.fd_t,
    prog_name: []const u8,
    marker_entry: [:0]const u8,
) !Child {
```

本体の `buildChildEnvp(allocator, std.c.environ)` を `buildChildEnvp(allocator, std.c.environ, marker_entry)` に、exec 失敗時の `std.debug.print("nas-mask-filter: exec {s} failed: {}\n", .{ program, err });` を `std.debug.print("{s}: exec {s} failed: {}\n", .{ prog_name, program, err });` に変える。

`run` 内の `spawnChild(...)` 呼び出しに `"nas-mask-filter", NAS_SUPERVISED_ENTRY` を末尾に足す。

`runLocal` の直前に型を足し、シグネチャと `spawnChild` 呼び出しを変える:

```zig
/// runLocal の呼び出し元ごとに変わるもの。診断のプログラム名と、子に付ける
/// 「監督下にある」印の環境変数。
pub const LocalOptions = struct {
    prog_name: []const u8,
    marker_env: [:0]const u8,
};

pub fn runLocal(
    allocator: std.mem.Allocator,
    secrets: []const []const u8,
    argv0: []const u8,
    program: []const u8,
    args: []const []const u8,
    opts: LocalOptions,
) !u8 {
    var out_mask = try MaskStream.init(allocator, secrets);
    defer out_mask.deinit(allocator);
    var err_mask = try MaskStream.init(allocator, secrets);
    defer err_mask.deinit(allocator);

    const child = try spawnChild(allocator, argv0, program, args, &.{}, opts.prog_name, opts.marker_env);
```

`runLocal` の doc comment を次に置き換える (呼び出し元を特定のオプション名に結び付けない):

```zig
/// ブローカーを介さず、このプロセス内でマスクして中継する supervise。
///
/// マスクの一覧を隔離する相手がいない場面 (呼び出し元がエージェントと同じ UID で
/// ホスト上に動く場合) 向け。socket 版と違って phase 3 が無い。マスクは同期的に
/// 終わり、保持しているのは MaskStream の overlap だけで、それはループを抜けてから
/// `finish` で吐き切る。
```

ファイル先頭付近の `const mask_stream = @import("mask_stream.zig");` を `pub const mask_stream = @import("mask_stream.zig");` に、`const EXIT_EXEC_FAILED: u8 = 127;` を `pub const EXIT_EXEC_FAILED: u8 = 127;` に変える。

- [ ] **Step 6: テストが通ることを確認する**

```bash
cd src/mask-filter && zig build test 2>&1 | tail -3 && zig build 2>&1 | tail -3
```

Expected: エラーなし。`zig-out/bin/nas-mask-filter` が生成される。

- [ ] **Step 7: nas-mask-filter の挙動が変わっていないことを確認する**

```bash
cd src/mask-filter && printf 'x=hunter2\n' | NAS_MASK_SECRETS_FILE=<(printf '\x01\x00\x00\x00\x07\x00\x00\x00hunter2') ./zig-out/bin/nas-mask-filter
```

Expected: `x=*******`

- [ ] **Step 8: Commit**

```bash
git add src/mask-filter/supervise.zig
git commit -F- <<'EOF'
refactor(mask-filter): add an in-process supervise path with caller-owned names

supervise.run relays child output to a broker over a Unix socket because the
container it runs in must not hold the secret list. A caller that runs on the
host as the same user as the agent has nobody to hide the list from, so it
gains nothing from the broker but the resident process. runLocal keeps the
same supervision loop and masks in-process instead.

The child spawn is shared between the two paths. The diagnostic program name
and the "already supervised" environment marker are passed in by the caller
rather than fixed to nas-mask-filter, so another binary linking this file does
not announce itself under the wrong name or read nas's marker.

The nas-mask-filter CLI does not expose runLocal: giving the container-side
binary a way to read the secret list would undo the reason the broker exists.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 2: sumi の骨格 (build.zig、main.zig、secrets.zig、run、filter、--version)

**Files:**
- Create: `contrib/sumi/build.zig`
- Create: `contrib/sumi/main.zig`
- Create: `contrib/sumi/secrets.zig`
- Create: `contrib/sumi/shell.zig`

**Interfaces:**
- Consumes: Task 1 の `supervise.runLocal`、`supervise.mask_stream.streamMask`、`supervise.LocalOptions`。
- Produces:
  - `secrets.load(allocator, path) LoadError![]const []const u8` と `secrets.LoadError = error{ Unreadable, Empty, TooShort, InvalidUtf8, TooMany, OutOfMemory }`、`secrets.describe(err) []const u8`。
  - `shell.quote(allocator, s) ![]u8`。
  - `main.zig` の `Common { secrets_file: []const u8 }` と exit code 定数 `EXIT_USAGE = 2`、`EXIT_SUPPRESSED = 121`。
  - `main.zig` から各 hook モジュールを呼ぶ規約: `pub fn main(allocator, args: []const []const u8, self_path: []const u8) !u8` (Task 3〜6 が実装する)。

- [ ] **Step 1: secrets.zig のテストを書く**

`contrib/sumi/secrets.zig`:

```zig
//! 平文の secrets ファイル: 1 行 1 値。
//!
//! 空行は無視し、行末の LF だけを取り除く。CR や前後の空白は値の一部として扱う
//! (値に空白が含まれる可能性を排除しないため)。各値は UTF-8 として有効で
//! 4 バイト以上。1024 件を上限にする。

const std = @import("std");

pub const MIN_LEN: usize = 4;
pub const MAX_COUNT: usize = 1024;
pub const MAX_FILE_BYTES: usize = 16 * 1024 * 1024;

pub const LoadError = error{
    Unreadable,
    Empty,
    TooShort,
    InvalidUtf8,
    TooMany,
    OutOfMemory,
};

/// 利用者へ見せる理由文。hook の decision と init の診断で共用する。
pub fn describe(err: LoadError) []const u8 {
    return switch (err) {
        error.Unreadable => "the secrets file is missing or unreadable",
        error.Empty => "the secrets file is empty",
        error.TooShort => "the secrets file holds a value shorter than 4 bytes",
        error.InvalidUtf8 => "the secrets file holds a value that is not valid UTF-8",
        error.TooMany => "the secrets file holds more than 1024 values",
        error.OutOfMemory => "out of memory while reading the secrets file",
    };
}

pub fn parse(allocator: std.mem.Allocator, text: []const u8) LoadError![]const []const u8 {
    var list: std.ArrayList([]const u8) = .empty;
    var it = std.mem.splitScalar(u8, text, '\n');
    while (it.next()) |line| {
        if (line.len == 0) continue;
        if (line.len < MIN_LEN) return error.TooShort;
        if (!std.unicode.utf8ValidateSlice(line)) return error.InvalidUtf8;
        if (list.items.len >= MAX_COUNT) return error.TooMany;
        list.append(allocator, line) catch return error.OutOfMemory;
    }
    if (list.items.len == 0) return error.Empty;
    return list.toOwnedSlice(allocator) catch return error.OutOfMemory;
}

pub fn load(allocator: std.mem.Allocator, path: []const u8) LoadError![]const []const u8 {
    const text = std.fs.cwd().readFileAlloc(allocator, path, MAX_FILE_BYTES) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return error.Unreadable,
    };
    return parse(allocator, text);
}

const testing = std.testing;

test "parse: one value per line, blank lines ignored, LF only stripped" {
    const got = try parse(testing.allocator, "Tr0ub4dor\n\nhunter2xyz\r\n  padded  \n");
    defer testing.allocator.free(got);
    try testing.expectEqual(@as(usize, 3), got.len);
    try testing.expectEqualStrings("Tr0ub4dor", got[0]);
    try testing.expectEqualStrings("hunter2xyz\r", got[1]);
    try testing.expectEqualStrings("  padded  ", got[2]);
}

test "parse: last line without trailing newline is kept" {
    const got = try parse(testing.allocator, "Tr0ub4dor");
    defer testing.allocator.free(got);
    try testing.expectEqual(@as(usize, 1), got.len);
}

test "parse: empty file is an error" {
    try testing.expectError(error.Empty, parse(testing.allocator, ""));
    try testing.expectError(error.Empty, parse(testing.allocator, "\n\n"));
}

test "parse: a value shorter than 4 bytes is an error" {
    try testing.expectError(error.TooShort, parse(testing.allocator, "Tr0ub4dor\nabc\n"));
}

test "parse: invalid UTF-8 is an error" {
    try testing.expectError(error.InvalidUtf8, parse(testing.allocator, "ab\xff\xfecd\n"));
}

test "parse: more than 1024 values is an error" {
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(testing.allocator);
    var i: usize = 0;
    while (i < 1025) : (i += 1) try buf.writer(testing.allocator).print("value{d:0>5}\n", .{i});
    try testing.expectError(error.TooMany, parse(testing.allocator, buf.items));
}

test "load: missing file is Unreadable" {
    try testing.expectError(error.Unreadable, load(testing.allocator, "/nonexistent/sumi-secrets"));
}
```

- [ ] **Step 2: shell.zig を書く**

`contrib/sumi/shell.zig`:

```zig
//! POSIX シェル向けの quote。
//!
//! hook の command は Claude Code が `sh -c` で実行し、pre-bash が書き換えた
//! command も同じ経路を通る。英数字と `_ / . - = : @ ,` だけの文字列はそのまま返し、
//! それ以外は単引用符で包み、内側の単引用符は `'\''` にする。

const std = @import("std");

fn isBare(c: u8) bool {
    return std.ascii.isAlphanumeric(c) or switch (c) {
        '_', '/', '.', '-', '=', ':', '@', ',' => true,
        else => false,
    };
}

pub fn needsQuote(s: []const u8) bool {
    if (s.len == 0) return true;
    for (s) |c| if (!isBare(c)) return true;
    return false;
}

pub fn quote(allocator: std.mem.Allocator, s: []const u8) ![]u8 {
    if (!needsQuote(s)) return allocator.dupe(u8, s);
    var out: std.ArrayList(u8) = .empty;
    try out.append(allocator, '\'');
    for (s) |c| {
        if (c == '\'') {
            try out.appendSlice(allocator, "'\\''");
        } else {
            try out.append(allocator, c);
        }
    }
    try out.append(allocator, '\'');
    return out.toOwnedSlice(allocator);
}

/// 引数列を空白で繋いだ 1 本のコマンド行にする。
pub fn join(allocator: std.mem.Allocator, argv: []const []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    for (argv, 0..) |arg, i| {
        if (i > 0) try out.append(allocator, ' ');
        const q = try quote(allocator, arg);
        defer allocator.free(q);
        try out.appendSlice(allocator, q);
    }
    return out.toOwnedSlice(allocator);
}

const testing = std.testing;

test "quote: bare strings pass through" {
    const q = try quote(testing.allocator, "/usr/local/bin/sumi");
    defer testing.allocator.free(q);
    try testing.expectEqualStrings("/usr/local/bin/sumi", q);
}

test "quote: spaces and shell metacharacters are single-quoted" {
    const q = try quote(testing.allocator, "cat 'a b' && false");
    defer testing.allocator.free(q);
    try testing.expectEqualStrings("'cat '\\''a b'\\'' && false'", q);
}

test "quote: empty string becomes ''" {
    const q = try quote(testing.allocator, "");
    defer testing.allocator.free(q);
    try testing.expectEqualStrings("''", q);
}

test "join: arguments are quoted individually" {
    const j = try join(testing.allocator, &.{ "/bin/bash", "-c", "echo hi; exit 3" });
    defer testing.allocator.free(j);
    try testing.expectEqualStrings("/bin/bash -c 'echo hi; exit 3'", j);
}
```

- [ ] **Step 3: build.zig を書く**

`contrib/sumi/build.zig`:

```zig
const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const host_target = b.resolveTargetQuery(.{});
    const strip = b.option(bool, "strip", "Strip debug info from the executable") orelse false;
    const version = b.option([]const u8, "version", "Version string shown by --version") orelse "dev";

    const build_options = b.addOptions();
    build_options.addOption([]const u8, "version", version);

    // sumi 実行ファイル。supervise.zig は mask_stream.zig と relay.zig を相対 import
    // しているので、1 つのモジュールとして取り込む (ファイルは 1 モジュールにしか属せない)。
    const mask_mod = b.createModule(.{
        .root_source_file = b.path("../../src/zig/mask.zig"),
        .target = target,
        .optimize = optimize,
    });
    const supervise_mod = b.createModule(.{
        .root_source_file = b.path("../../src/mask-filter/supervise.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    supervise_mod.addImport("mask", mask_mod);

    const exe_mod = b.createModule(.{
        .root_source_file = b.path("main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .strip = strip,
    });
    exe_mod.addImport("mask", mask_mod);
    exe_mod.addImport("supervise", supervise_mod);
    exe_mod.addOptions("build_options", build_options);

    const exe = b.addExecutable(.{ .name = "sumi", .root_module = exe_mod });
    b.installArtifact(exe);

    // unit test はクロスターゲットでは走らせられないので、常にホスト向けにビルドする。
    const test_mask_mod = b.createModule(.{
        .root_source_file = b.path("../../src/zig/mask.zig"),
        .target = host_target,
        .optimize = optimize,
    });
    const test_supervise_mod = b.createModule(.{
        .root_source_file = b.path("../../src/mask-filter/supervise.zig"),
        .target = host_target,
        .optimize = optimize,
        .link_libc = true,
    });
    test_supervise_mod.addImport("mask", test_mask_mod);
    const test_mod = b.createModule(.{
        .root_source_file = b.path("main.zig"),
        .target = host_target,
        .optimize = optimize,
        .link_libc = true,
    });
    test_mod.addImport("mask", test_mask_mod);
    test_mod.addImport("supervise", test_supervise_mod);
    test_mod.addOptions("build_options", build_options);
    const unit_tests = b.addTest(.{ .root_module = test_mod });
    const run_tests = b.addRunArtifact(unit_tests);
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_tests.step);
}
```

- [ ] **Step 4: main.zig を書く (hook と init はこの時点では未対応の stub)**

`contrib/sumi/main.zig`:

```zig
//! sumi: 列挙した値を Claude Code に見せない単一バイナリ。
//!
//!   sumi init   --agent claude --secrets-file F [--root DIR]... [--deny-path P]... [--settings FILE] [--shell PATH]
//!   sumi hook   --agent claude post-tool --secrets-file F
//!   sumi hook   --agent claude prompt    --secrets-file F [--root DIR]... [--deny-path P]...
//!   sumi hook   --agent claude pre-bash  --secrets-file F --shell PATH
//!   sumi run    --secrets-file F -- PROGRAM [ARGS...]
//!   sumi filter --secrets-file F
//!   sumi --version
//!
//! 終了コード: 引数の解釈に失敗したときだけ 2。hook サブコマンドはそれ以降どの失敗でも
//! 0 で決定 (withhold / block / deny) を返す。run は子の終了ステータスで終わり、マスク
//! されたと確信できないバイト列が生じたときだけ出力を捨てて 121 で終わる。

const std = @import("std");
const build_options = @import("build_options");
const supervise = @import("supervise");
const secrets = @import("secrets.zig");
const claude_post = @import("claude/hook_post.zig");
const claude_prompt = @import("claude/hook_prompt.zig");
const claude_bash = @import("claude/hook_bash.zig");
const claude_init = @import("claude/init.zig");

pub const EXIT_USAGE: u8 = 2;
pub const EXIT_SUPPRESSED: u8 = 121;
pub const PROG: []const u8 = "sumi";
pub const MARKER_ENV: [:0]const u8 = "SUMI_SUPERVISED=1";

const usage_text =
    \\usage: sumi init   --agent claude --secrets-file F [--root DIR]... [--deny-path P]... [--settings FILE] [--shell PATH]
    \\       sumi hook   --agent claude post-tool --secrets-file F
    \\       sumi hook   --agent claude prompt    --secrets-file F [--root DIR]... [--deny-path P]...
    \\       sumi hook   --agent claude pre-bash  --secrets-file F --shell PATH
    \\       sumi run    --secrets-file F -- PROGRAM [ARGS...]
    \\       sumi filter --secrets-file F
    \\       sumi --version
    \\
;

fn usage(msg: []const u8) u8 {
    std.debug.print("sumi: {s}\n{s}", .{ msg, usage_text });
    return EXIT_USAGE;
}

pub const Agent = enum { claude };

/// `--agent VALUE` を argv から取り出す。無ければ null、未対応の値は error。
pub fn takeAgent(args: []const []const u8) !struct { agent: ?Agent, rest: []const []const u8 } {
    if (args.len >= 2 and std.mem.eql(u8, args[0], "--agent")) {
        const agent = std.meta.stringToEnum(Agent, args[1]) orelse return error.UnsupportedAgent;
        return .{ .agent = agent, .rest = args[2..] };
    }
    return .{ .agent = null, .rest = args };
}

/// `--secrets-file F` を argv のどこからでも取り出す。
pub fn findOption(args: []const []const u8, name: []const u8) ?[]const u8 {
    var i: usize = 0;
    while (i + 1 < args.len) : (i += 1) {
        if (std.mem.eql(u8, args[i], name)) return args[i + 1];
    }
    return null;
}

fn runFilter(allocator: std.mem.Allocator, args: []const []const u8) u8 {
    const path = findOption(args, "--secrets-file") orelse return usage("filter needs --secrets-file");
    const list = secrets.load(allocator, path) catch |err| {
        std.debug.print("sumi: {s}\n", .{secrets.describe(err)});
        return 1;
    };
    const stdin = std.fs.File.stdin();
    const stdout = std.fs.File.stdout();
    supervise.mask_stream.streamMask(stdin.deprecatedReader(), stdout.deprecatedWriter(), list) catch |err| {
        std.debug.print("sumi: stream error: {}\n", .{err});
        return 1;
    };
    return 0;
}

fn runSupervised(allocator: std.mem.Allocator, args: []const []const u8) u8 {
    // 形は `--secrets-file F -- PROGRAM [ARGS...]` に固定する。
    if (args.len < 4 or !std.mem.eql(u8, args[0], "--secrets-file") or !std.mem.eql(u8, args[2], "--")) {
        return usage("run takes --secrets-file F -- PROGRAM [ARGS...]");
    }
    const program = args[3];
    const list = secrets.load(allocator, args[1]) catch |err| {
        // 一覧が読めないまま走らせるとマスクなしで素通しになる。
        std.debug.print("sumi: {s}; output suppressed\n", .{secrets.describe(err)});
        return EXIT_SUPPRESSED;
    };
    return supervise.runLocal(allocator, list, program, program, args[4..], .{
        .prog_name = PROG,
        .marker_env = MARKER_ENV,
    }) catch |err| {
        std.debug.print("sumi: supervise failed: {}; output suppressed\n", .{err});
        return EXIT_SUPPRESSED;
    };
}

fn selfPath(allocator: std.mem.Allocator) ![]u8 {
    return std.fs.selfExePathAlloc(allocator);
}

pub fn main() !u8 {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    const argv = try std.process.argsAlloc(allocator);
    if (argv.len < 2) return usage("no subcommand");
    const sub = argv[1];
    const args: []const []const u8 = @ptrCast(argv[2..]);

    if (std.mem.eql(u8, sub, "--version")) {
        try std.fs.File.stdout().writeAll("sumi ");
        try std.fs.File.stdout().writeAll(build_options.version);
        try std.fs.File.stdout().writeAll("\n");
        return 0;
    }
    if (std.mem.eql(u8, sub, "filter")) return runFilter(allocator, args);
    if (std.mem.eql(u8, sub, "run")) return runSupervised(allocator, args);

    if (std.mem.eql(u8, sub, "hook") or std.mem.eql(u8, sub, "init")) {
        const taken = takeAgent(args) catch return usage("unsupported --agent value (only 'claude' is implemented)");
        const agent = taken.agent orelse return usage("--agent is required");
        const self = try selfPath(allocator);
        switch (agent) {
            .claude => {
                if (std.mem.eql(u8, sub, "init")) return claude_init.main(allocator, taken.rest, self);
                if (taken.rest.len == 0) return usage("hook needs a subcommand: post-tool | prompt | pre-bash");
                const hook = taken.rest[0];
                const hook_args = taken.rest[1..];
                if (std.mem.eql(u8, hook, "post-tool")) return claude_post.main(allocator, hook_args, self);
                if (std.mem.eql(u8, hook, "prompt")) return claude_prompt.main(allocator, hook_args, self);
                if (std.mem.eql(u8, hook, "pre-bash")) return claude_bash.main(allocator, hook_args, self);
                return usage("unknown hook subcommand");
            },
        }
    }
    return usage("unknown subcommand");
}

test {
    _ = @import("secrets.zig");
    _ = @import("shell.zig");
    _ = @import("jsonio.zig");
    _ = @import("claude/hook_post.zig");
    _ = @import("claude/hook_prompt.zig");
    _ = @import("claude/hook_bash.zig");
    _ = @import("claude/init.zig");
}

const testing = std.testing;

test "takeAgent: claude is accepted and consumed" {
    const t = try takeAgent(&.{ "--agent", "claude", "post-tool" });
    try testing.expectEqual(Agent.claude, t.agent.?);
    try testing.expectEqual(@as(usize, 1), t.rest.len);
}

test "takeAgent: missing --agent yields null" {
    const t = try takeAgent(&.{"post-tool"});
    try testing.expectEqual(@as(?Agent, null), t.agent);
}

test "takeAgent: unsupported agent is an error" {
    try testing.expectError(error.UnsupportedAgent, takeAgent(&.{ "--agent", "copilot" }));
}

test "findOption: returns the value following the flag" {
    try testing.expectEqualStrings("/x", findOption(&.{ "a", "--secrets-file", "/x" }, "--secrets-file").?);
    try testing.expectEqual(@as(?[]const u8, null), findOption(&.{"--secrets-file"}, "--secrets-file"));
}
```

hook と init のモジュールはこの Task では stub として置く。`contrib/sumi/jsonio.zig`、`contrib/sumi/claude/hook_post.zig`、`contrib/sumi/claude/hook_prompt.zig`、`contrib/sumi/claude/hook_bash.zig`、`contrib/sumi/claude/init.zig` をそれぞれ次の内容で作る (`jsonio.zig` は `const std = @import("std");` のみ):

```zig
const std = @import("std");

pub fn main(allocator: std.mem.Allocator, args: []const []const u8, self_path: []const u8) !u8 {
    _ = allocator;
    _ = args;
    _ = self_path;
    std.debug.print("sumi: not implemented\n", .{});
    return 2;
}
```

- [ ] **Step 5: ビルドと unit test を通す**

```bash
cd contrib/sumi && zig build test 2>&1 | tail -5 && zig build 2>&1 | tail -3 && ./zig-out/bin/sumi --version
```

Expected: テストが通り、`sumi dev` が出る。

- [ ] **Step 6: run と filter を手で確認する**

```bash
cd contrib/sumi
printf 'Tr0ub4dor\n' > /tmp/sumi-test-secrets
printf 'db.password=Tr0ub4dor\n' | ./zig-out/bin/sumi filter --secrets-file /tmp/sumi-test-secrets
./zig-out/bin/sumi run --secrets-file /tmp/sumi-test-secrets -- /bin/sh -c 'echo db.password=Tr0ub4dor; echo err Tr0ub4dor >&2; exit 3'; echo "exit=$?"
./zig-out/bin/sumi run --secrets-file /tmp/sumi-test-secrets -- /bin/sh -c 'env | grep SUMI_'
./zig-out/bin/sumi run --secrets-file /nonexistent -- /bin/sh -c 'echo leak Tr0ub4dor'; echo "exit=$?"
rm /tmp/sumi-test-secrets
```

Expected:
```
db.password=*********
db.password=*********
err *********
exit=3
SUMI_SUPERVISED=1
sumi: the secrets file is missing or unreadable; output suppressed
exit=121
```

- [ ] **Step 7: musl 静的ビルドを確認する**

```bash
cd contrib/sumi && zig build -Dtarget=x86_64-linux-musl -Doptimize=ReleaseSafe -Dstrip=true -Dversion=test --prefix /tmp/sumi-static && ldd /tmp/sumi-static/bin/sumi; /tmp/sumi-static/bin/sumi --version; ls -la /tmp/sumi-static/bin/sumi
```

Expected: `not a dynamic executable`、`sumi test`、サイズは数 MB 以下。

- [ ] **Step 8: Commit**

```bash
git add contrib/sumi/build.zig contrib/sumi/main.zig contrib/sumi/secrets.zig contrib/sumi/shell.zig contrib/sumi/jsonio.zig contrib/sumi/claude
git commit -F- <<'EOF'
feat(sumi): scaffold the binary with run, filter and --version

sumi is a single static binary that keeps values listed in a plain-text file
out of what Claude Code sends to the model. It shares the byte-exact masking
and the child-process supervision with nas-mask-filter but is used outside
nas, so it lives under contrib/ and is not referenced by the nas pipeline.

The secrets file is plain text, one value per line, read directly by the
binary: no intermediate frame file, so the plaintext exists only in that file
and in process memory. Values shorter than 4 bytes are refused because they
match unrelated output and blank out most of it; invalid UTF-8 is refused
because Claude Code replaces such bytes before a hook can see them.

`run` supervises a child and masks its stdout/stderr in-process, exiting with
the child's status, or 121 with no output when masking cannot be trusted.
`--agent` is required for the hook and init subcommands and has no default,
since the hook payload format is per-agent; only claude is implemented.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 3: jsonio.zig (ペイロードの読み取り、Value のマスク、JSON 出力)

**Files:**
- Create: `contrib/sumi/jsonio.zig` (stub を置き換える)

**Interfaces:**
- Consumes: `mask` モジュール (`mask.maskAll(buf, secrets, null)`、`mask.containsAny(haystack, secrets)`)。
- Produces:
  - `jsonio.readStdin(allocator) ![]u8` (上限 64 MiB)。
  - `jsonio.parse(allocator, text) !std.json.Parsed(std.json.Value)` (重複キー後勝ち)。
  - `jsonio.maskValue(allocator, v: *std.json.Value, secrets) !bool` (文字列リーフとキーをマスク。何か変えたら true)。
  - `jsonio.stringify(allocator, v) ![]u8` (1 行)。
  - `jsonio.stringifyPretty(allocator, v) ![]u8` (2 スペース)。
  - `jsonio.quoteString(allocator, s) ![]u8` (JSON 文字列リテラル)。
  - `jsonio.getString(v: std.json.Value, key) ?[]const u8`、`jsonio.getObject(v, key) ?*std.json.ObjectMap`。
  - `jsonio.writeStdout(bytes) !void` (末尾に改行を足す)。

- [ ] **Step 1: テストを書く**

`contrib/sumi/jsonio.zig` の末尾に置くテスト:

```zig
const testing = std.testing;

test "maskValue: string leaves are masked in place and report a change" {
    var parsed = try parse(testing.allocator, "{\"a\":\"x Tr0ub4dor y\",\"n\":1234,\"b\":true}");
    defer parsed.deinit();
    const changed = try maskValue(testing.allocator, &parsed.value, &.{"Tr0ub4dor"});
    try testing.expect(changed);
    const out = try stringify(testing.allocator, parsed.value);
    defer testing.allocator.free(out);
    try testing.expectEqualStrings("{\"a\":\"x ********* y\",\"n\":1234,\"b\":true}", out);
}

test "maskValue: escaped characters inside a value are matched after decoding" {
    var parsed = try parse(testing.allocator, "{\"s\":\"pass=ab\\\"cd-decoy\"}");
    defer parsed.deinit();
    const changed = try maskValue(testing.allocator, &parsed.value, &.{"ab\"cd-decoy"});
    try testing.expect(changed);
    const out = try stringify(testing.allocator, parsed.value);
    defer testing.allocator.free(out);
    try testing.expectEqualStrings("{\"s\":\"pass=***********\"}", out);
}

test "maskValue: object keys are masked too" {
    var parsed = try parse(testing.allocator, "{\"Tr0ub4dor\":\"v\"}");
    defer parsed.deinit();
    _ = try maskValue(testing.allocator, &parsed.value, &.{"Tr0ub4dor"});
    const out = try stringify(testing.allocator, parsed.value);
    defer testing.allocator.free(out);
    try testing.expectEqualStrings("{\"*********\":\"v\"}", out);
}

test "maskValue: a secret equal to a JSON token does not break structure" {
    var parsed = try parse(testing.allocator, "{\"ok\":true,\"s\":\"true\"}");
    defer parsed.deinit();
    _ = try maskValue(testing.allocator, &parsed.value, &.{"true"});
    const out = try stringify(testing.allocator, parsed.value);
    defer testing.allocator.free(out);
    try testing.expectEqualStrings("{\"ok\":true,\"s\":\"****\"}", out);
}

test "maskValue: nested arrays and objects are visited" {
    var parsed = try parse(testing.allocator, "[{\"x\":[\"Tr0ub4dor\"]}]");
    defer parsed.deinit();
    try testing.expect(try maskValue(testing.allocator, &parsed.value, &.{"Tr0ub4dor"}));
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

test "getString / getObject: typed lookups on an object" {
    var parsed = try parse(testing.allocator, "{\"prompt\":\"hi\",\"tool_input\":{\"command\":\"ls\"}}");
    defer parsed.deinit();
    try testing.expectEqualStrings("hi", getString(parsed.value, "prompt").?);
    try testing.expect(getObject(parsed.value, "tool_input") != null);
    try testing.expectEqual(@as(?[]const u8, null), getString(parsed.value, "missing"));
    try testing.expectEqual(@as(?[]const u8, null), getString(parsed.value, "tool_input"));
}
```

- [ ] **Step 2: テストが落ちることを確認する**

```bash
cd contrib/sumi && zig build test 2>&1 | head -5
```

Expected: `parse`、`maskValue` などが未定義のコンパイルエラー。

- [ ] **Step 3: 実装する**

`contrib/sumi/jsonio.zig` の本体 (テストの前に置く):

```zig
//! hook のペイロード (JSON) の読み書きと、`std.json.Value` の文字列リーフのマスク。
//!
//! JSON テキストではなく parse 後の値をマスクする。値が引用符やバックスラッシュ、
//! `\uXXXX` を含んでいてもデコード後のバイト列で一致し、JSON の構造トークンや数値と
//! 同じ綴りの値を secrets に置いても構造が壊れない。数値・真偽値・null のリーフは
//! 対象にしない。

const std = @import("std");
const mask = @import("mask");

pub const MAX_PAYLOAD: usize = 64 * 1024 * 1024;

pub fn readStdin(allocator: std.mem.Allocator) ![]u8 {
    return std.fs.File.stdin().readToEndAlloc(allocator, MAX_PAYLOAD);
}

pub fn writeStdout(bytes: []const u8) !void {
    const out = std.fs.File.stdout();
    try out.writeAll(bytes);
    try out.writeAll("\n");
}

pub fn parse(allocator: std.mem.Allocator, text: []const u8) !std.json.Parsed(std.json.Value) {
    return std.json.parseFromSlice(std.json.Value, allocator, text, .{
        .duplicate_field_behavior = .use_last,
    });
}

/// s の中の secrets を '*' に置き換えた新しいバッファを返す。変化が無ければ null。
fn maskCopy(allocator: std.mem.Allocator, s: []const u8, secrets: []const []const u8) !?[]u8 {
    if (!mask.containsAny(s, secrets)) return null;
    const copy = try allocator.dupe(u8, s);
    mask.maskAll(copy, secrets, null);
    return copy;
}

pub fn maskValue(allocator: std.mem.Allocator, v: *std.json.Value, secrets: []const []const u8) !bool {
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
                if (try maskValue(allocator, item, secrets)) changed = true;
            }
        },
        .object => |*obj| {
            const keys = obj.keys();
            const values = obj.values();
            for (keys, values) |*k, *val| {
                if (try maskCopy(allocator, k.*, secrets)) |m| {
                    k.* = m;
                    changed = true;
                }
                if (try maskValue(allocator, val, secrets)) changed = true;
            }
        },
        else => {},
    }
    return changed;
}

pub fn stringify(allocator: std.mem.Allocator, v: std.json.Value) ![]u8 {
    return std.json.Stringify.valueAlloc(allocator, v, .{});
}

pub fn stringifyPretty(allocator: std.mem.Allocator, v: std.json.Value) ![]u8 {
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
```

- [ ] **Step 4: テストを通す**

```bash
cd contrib/sumi && zig build test 2>&1 | tail -5
```

Expected: エラーなし。

- [ ] **Step 5: Commit**

```bash
git add contrib/sumi/jsonio.zig
git commit -F- <<'EOF'
feat(sumi): mask JSON string leaves after parsing instead of the raw text

Masking the raw hook payload text would break the JSON whenever a listed value
is spelled like a structural token or a number (`true`, `1234`), and would
miss values that JSON-escaping changes (quotes, backslashes, \uXXXX). Parsing
first and masking the decoded string leaves and object keys avoids both:
the replacement keeps each leaf's length and the structure is never touched.

Duplicate keys resolve last-wins to match how Claude Code itself reads
settings.json with JSON.parse.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 4: hook pre-bash (claude/hook_bash.zig)

**Files:**
- Create: `contrib/sumi/claude/hook_bash.zig` (stub を置き換える)

**Interfaces:**
- Consumes: `jsonio.readStdin/parse/getObject/getString/stringify/quoteString/writeStdout`、`shell.quote/join`、`secrets.load/describe`、`main.findOption`。
- Produces: `hook_bash.rewrite(allocator, self_path, secrets_file, shell, command) ![]u8` と `hook_bash.isWrapped(self_path, command) bool`。

- [ ] **Step 1: テストを書く**

`contrib/sumi/claude/hook_bash.zig` の末尾:

```zig
const testing = std.testing;

test "rewrite: wraps the command under sumi run with every argument quoted" {
    const got = try rewrite(testing.allocator, "/opt/sumi/sumi", "/opt/sumi/secrets.txt", "/bin/bash", "cat 'a b' && false");
    defer testing.allocator.free(got);
    try testing.expectEqualStrings(
        "/opt/sumi/sumi run --secrets-file /opt/sumi/secrets.txt -- /bin/bash -c 'cat '\\''a b'\\'' && false'",
        got,
    );
}

test "rewrite: a self path with spaces is quoted" {
    const got = try rewrite(testing.allocator, "/home/u/my tools/sumi", "/s", "/bin/bash", "ls");
    defer testing.allocator.free(got);
    try testing.expect(std.mem.startsWith(u8, got, "'/home/u/my tools/sumi' run "));
}

test "isWrapped: detects a command already rewritten by this binary" {
    try testing.expect(isWrapped("/opt/sumi/sumi", "/opt/sumi/sumi run --secrets-file /s -- /bin/bash -c ls"));
    try testing.expect(!isWrapped("/opt/sumi/sumi", "ls"));
    try testing.expect(!isWrapped("/opt/sumi/sumi", "/other/sumi run -- x"));
}

test "buildDecision: rewritten input keeps the other tool_input fields" {
    var parsed = try jsonio.parse(testing.allocator, "{\"tool_input\":{\"command\":\"ls\",\"description\":\"list\"}}");
    defer parsed.deinit();
    const out = try buildDecision(testing.allocator, &parsed.value, "WRAPPED");
    defer testing.allocator.free(out);
    try testing.expectEqualStrings(
        "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"updatedInput\":{\"command\":\"WRAPPED\",\"description\":\"list\"}}}",
        out,
    );
}

test "denyJson: carries the reason with the sumi prefix" {
    const out = try denyJson(testing.allocator, "the secrets file is empty");
    defer testing.allocator.free(out);
    try testing.expectEqualStrings(
        "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"sumi: the secrets file is empty, so the command was not run.\"}}",
        out,
    );
}
```

- [ ] **Step 2: テストが落ちることを確認する**

```bash
cd contrib/sumi && zig build test 2>&1 | head -5
```

Expected: `rewrite` などが未定義のコンパイルエラー。

- [ ] **Step 3: 実装する**

`contrib/sumi/claude/hook_bash.zig`:

```zig
//! PreToolUse(Bash): コマンドを `sumi run` の下に書き換える。
//!
//! 失敗したツール呼び出しの出力は後から差し替えられない (PostToolUseFailure の
//! `error` は updatedToolOutput を受け付けない)。Bash だけは生成源で潰せるので、
//! Claude Code が 1 バイトも読む前のパイプでマスクする。
//!
//! `permissionDecision` は返さない。返すと通常の権限判定を上書きしてしまう
//! (`allow` なら全 Bash が承認プロンプトを迂回する)。返さなければ書き換え後の
//! command に対して通常どおり判定される。
//!
//! 代償: Claude Code からは本来のコマンドが見えなくなる。パスベースの Read deny が
//! Bash の cat に効かなくなり、Bash(...) の allow ルールはラッパーに対して照合される。

const std = @import("std");
const jsonio = @import("../jsonio.zig");
const shell = @import("../shell.zig");
const secrets = @import("../secrets.zig");
const cli = @import("../main.zig");

pub fn rewrite(
    allocator: std.mem.Allocator,
    self_path: []const u8,
    secrets_file: []const u8,
    shell_path: []const u8,
    command: []const u8,
) ![]u8 {
    return shell.join(allocator, &.{
        self_path, "run", "--secrets-file", secrets_file, "--", shell_path, "-c", command,
    });
}

/// 既に書き換え済みなら二重に包まない。先頭語が (quote 後の) 自分のパスで、
/// 次の語が `run` であることで判定する。
pub fn isWrapped(self_path: []const u8, command: []const u8) bool {
    var buf: [std.fs.max_path_bytes * 4 + 8]u8 = undefined;
    var fba = std.heap.FixedBufferAllocator.init(&buf);
    const q = shell.quote(fba.allocator(), self_path) catch return false;
    if (!std.mem.startsWith(u8, command, q)) return false;
    return std.mem.startsWith(u8, command[q.len..], " run ");
}

pub fn buildDecision(allocator: std.mem.Allocator, payload: *std.json.Value, wrapped: []const u8) ![]u8 {
    const tool_input = jsonio.getObject(payload.*, "tool_input") orelse return error.NoToolInput;
    try tool_input.put("command", .{ .string = wrapped });
    const input_json = try jsonio.stringify(allocator, .{ .object = tool_input.* });
    return std.fmt.allocPrint(
        allocator,
        "{{\"hookSpecificOutput\":{{\"hookEventName\":\"PreToolUse\",\"updatedInput\":{s}}}}}",
        .{input_json},
    );
}

pub fn denyJson(allocator: std.mem.Allocator, reason: []const u8) ![]u8 {
    const text = try std.fmt.allocPrint(allocator, "sumi: {s}, so the command was not run.", .{reason});
    const quoted = try jsonio.quoteString(allocator, text);
    return std.fmt.allocPrint(
        allocator,
        "{{\"hookSpecificOutput\":{{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":{s}}}}}",
        .{quoted},
    );
}

fn deny(allocator: std.mem.Allocator, reason: []const u8) u8 {
    const out = denyJson(allocator, reason) catch return 0;
    jsonio.writeStdout(out) catch {};
    return 0;
}

/// 引数解釈が終わった後の失敗はすべて exit 0 の deny。非ゼロで終わると Claude Code は
/// 元のコマンドをそのまま実行する。
pub fn main(allocator: std.mem.Allocator, args: []const []const u8, self_path: []const u8) !u8 {
    const secrets_file = cli.findOption(args, "--secrets-file") orelse {
        std.debug.print("sumi: pre-bash needs --secrets-file\n", .{});
        return cli.EXIT_USAGE;
    };
    const shell_path = cli.findOption(args, "--shell") orelse {
        std.debug.print("sumi: pre-bash needs --shell\n", .{});
        return cli.EXIT_USAGE;
    };

    const text = jsonio.readStdin(allocator) catch return deny(allocator, "the hook payload could not be read");
    if (text.len == 0) return 0;
    var parsed = jsonio.parse(allocator, text) catch return deny(allocator, "the hook payload is not valid JSON");
    defer parsed.deinit();

    const command = jsonio.getString(parsed.value, "tool_input") orelse blk: {
        const ti = jsonio.getObject(parsed.value, "tool_input") orelse return 0;
        const c = ti.get("command") orelse return 0;
        break :blk if (c == .string) c.string else return 0;
    };
    if (command.len == 0) return 0;
    if (isWrapped(self_path, command)) return 0;

    // 一覧が使えないコマンドを走らせると、run 側で 121 になるだけでなく、そもそも
    // 書き換えの意味が無い。ここで止めて理由を見せる。
    _ = secrets.load(allocator, secrets_file) catch |err| return deny(allocator, secrets.describe(err));
    std.fs.cwd().access(shell_path, .{}) catch return deny(allocator, "the shell given by --shell does not exist");

    const wrapped = try rewrite(allocator, self_path, secrets_file, shell_path, command);
    const out = buildDecision(allocator, &parsed.value, wrapped) catch return deny(allocator, "the rewritten command could not be encoded");
    try jsonio.writeStdout(out);
    return 0;
}
```

注意: `jsonio.getString(parsed.value, "tool_input")` は `tool_input` が文字列のときだけ値を返すので通常 null になり、`blk` 側で object から `command` を取る。この二段構えは `tool_input` が無い・object でないペイロードで素通り (exit 0、何も出さない) するためのもの。

- [ ] **Step 4: テストを通す**

```bash
cd contrib/sumi && zig build test 2>&1 | tail -5 && zig build
```

Expected: エラーなし。

- [ ] **Step 5: 手で確認する**

```bash
cd contrib/sumi
printf 'Tr0ub4dor\n' > /tmp/sumi-test-secrets
printf '{"tool_input":{"command":"cat decoy && false"}}' | ./zig-out/bin/sumi hook --agent claude pre-bash --secrets-file /tmp/sumi-test-secrets --shell /bin/bash
printf '{"tool_input":{"command":"ls"}}' | ./zig-out/bin/sumi hook --agent claude pre-bash --secrets-file /nonexistent --shell /bin/bash
printf '{"tool_input":{"command":"ls"}}' | ./zig-out/bin/sumi hook --agent claude pre-bash --secrets-file /tmp/sumi-test-secrets --shell /bin/bash | jq -e '.hookSpecificOutput.permissionDecision == null' && echo "no permissionDecision"
rm /tmp/sumi-test-secrets
```

Expected: 1 行目は `updatedInput.command` が `<abs path>/sumi run --secrets-file /tmp/sumi-test-secrets -- /bin/bash -c 'cat decoy && false'` の JSON。2 行目は `permissionDecision: deny` と `the secrets file is missing or unreadable`。3 行目は `no permissionDecision`。

- [ ] **Step 6: Commit**

```bash
git add contrib/sumi/claude/hook_bash.zig
git commit -F- <<'EOF'
feat(sumi): rewrite Bash commands to run under sumi run

A failed tool call cannot be masked after the fact: Claude Code delivers its
output through PostToolUseFailure, whose payload does not accept a replacement.
Bash is the one tool whose output can be masked at the source, so the
PreToolUse hook wraps the command in `sumi run -- <shell> -c <command>` and
the masking happens in the pipe before Claude Code reads a byte.

The hook returns only updatedInput. Adding permissionDecision would override
the normal permission check for every Bash call; leaving it out lets the
rewritten command go through the usual rules.

Any failure after argument parsing is an exit-0 deny rather than a non-zero
exit, because Claude Code treats a hook error as non-blocking and would run
the original command unmasked.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 5: hook post-tool (claude/hook_post.zig)

**Files:**
- Create: `contrib/sumi/claude/hook_post.zig` (stub を置き換える)

**Interfaces:**
- Consumes: `jsonio.*`、`secrets.load/describe`、`mask.containsAny`、`main.findOption`。
- Produces: `hook_post.decide(allocator, payload_text, secrets_result) !Decision` と `Decision = union(enum) { pass, withhold: struct{event, reason}, report: reason, replace: struct{event, tool_response_json} }`、`hook_post.render(allocator, Decision) !?[]u8`。

- [ ] **Step 1: テストを書く**

```zig
const testing = std.testing;

const decoy = "Tr0ub4dor";

fn decideText(text: []const u8, list: []const []const u8) !Decision {
    return decide(testing.allocator, text, .{ .ok = list });
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
    const out = (try render(testing.allocator, .{ .replace = .{ .event = "PostToolUse", .tool_response_json = "{\"stdout\":\"***\"}" } })).?;
    defer testing.allocator.free(out);
    try testing.expectEqualStrings(
        "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"updatedToolOutput\":{\"stdout\":\"***\"}},\"systemMessage\":\"sumi: masked a protected value in this tool output.\"}",
        out,
    );
}

test "render: pass produces no output" {
    try testing.expectEqual(@as(?[]u8, null), try render(testing.allocator, .pass));
}
```

- [ ] **Step 2: テストが落ちることを確認する**

```bash
cd contrib/sumi && zig build test 2>&1 | head -5
```

Expected: `decide` 未定義のコンパイルエラー。

- [ ] **Step 3: 実装する**

```zig
//! PostToolUse / PostToolUseFailure: ツール出力の中の値を `*` に置き換える。
//!
//! PostToolUse では `tool_response` を `updatedToolOutput` で差し替えられる。
//! PostToolUseFailure の `error` は差し替えを受け付けず、exit 2 でも出力は残る
//! (Claude Code 2.1.266 で実測) ので、値が含まれていれば `systemMessage` で報告する
//! だけになる。Bash の失敗は pre-bash が生成源で潰しているので、ここに来るのは
//! Bash 以外のツールの失敗本文である。
//!
//! 引数解釈の後はどの失敗でも exit 0 で決定を返す。非ゼロで終わると元の出力が
//! そのままモデルへ渡る。

const std = @import("std");
const jsonio = @import("../jsonio.zig");
const secrets = @import("../secrets.zig");
const cli = @import("../main.zig");
const mask = @import("mask");

pub const SecretsResult = union(enum) {
    ok: []const []const u8,
    err: secrets.LoadError,
};

pub const Decision = union(enum) {
    pass,
    withhold: struct { event: []const u8, reason: []const u8 },
    report: []const u8,
    replace: struct { event: []const u8, tool_response_json: []u8 },

    pub fn deinit(self: *Decision, allocator: std.mem.Allocator) void {
        switch (self.*) {
            .replace => |r| allocator.free(r.tool_response_json),
            else => {},
        }
        self.* = undefined;
    }
};

const FAILURE_EVENT = "PostToolUseFailure";
const DEFAULT_EVENT = "PostToolUse";
const REPORT_TEXT = "sumi: a failed tool call carried a protected value to the model. A failure's output cannot be replaced by a hook, so mask Bash output at the source instead.";

pub fn decide(allocator: std.mem.Allocator, text: []const u8, list: SecretsResult) !Decision {
    var parsed = jsonio.parse(allocator, text) catch {
        return switch (list) {
            .ok => .{ .withhold = .{ .event = DEFAULT_EVENT, .reason = "the hook payload is not valid JSON" } },
            .err => |e| .{ .withhold = .{ .event = DEFAULT_EVENT, .reason = secrets.describe(e) } },
        };
    };
    defer parsed.deinit();

    const event = jsonio.getString(parsed.value, "hook_event_name") orelse DEFAULT_EVENT;
    const is_failure = std.mem.eql(u8, event, FAILURE_EVENT);

    const values = switch (list) {
        .ok => |v| v,
        .err => |e| {
            if (is_failure) return .{ .report = REPORT_TEXT };
            return .{ .withhold = .{ .event = event, .reason = secrets.describe(e) } };
        },
    };

    if (is_failure) {
        const failure = jsonio.getString(parsed.value, "error") orelse return .pass;
        return if (mask.containsAny(failure, values)) .{ .report = REPORT_TEXT } else .pass;
    }

    const response = blk: {
        if (parsed.value != .object) return .pass;
        break :blk parsed.value.object.getPtr("tool_response") orelse return .pass;
    };
    const changed = try jsonio.maskValue(allocator, response, values);
    if (!changed) return .pass;
    const json = try jsonio.stringify(allocator, response.*);
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
            return try std.fmt.allocPrint(
                allocator,
                "{{\"hookSpecificOutput\":{{\"hookEventName\":\"{s}\",\"updatedToolOutput\":{s}}},\"systemMessage\":{s}}}",
                .{ w.event, q, q },
            );
        },
        .report => |r| {
            const q = try jsonio.quoteString(allocator, r);
            defer allocator.free(q);
            return try std.fmt.allocPrint(allocator, "{{\"systemMessage\":{s}}}", .{q});
        },
        .replace => |r| {
            return try std.fmt.allocPrint(
                allocator,
                "{{\"hookSpecificOutput\":{{\"hookEventName\":\"{s}\",\"updatedToolOutput\":{s}}},\"systemMessage\":\"sumi: masked a protected value in this tool output.\"}}",
                .{ r.event, r.tool_response_json },
            );
        },
    }
}

pub fn main(allocator: std.mem.Allocator, args: []const []const u8, self_path: []const u8) !u8 {
    _ = self_path;
    const secrets_file = cli.findOption(args, "--secrets-file") orelse {
        std.debug.print("sumi: post-tool needs --secrets-file\n", .{});
        return cli.EXIT_USAGE;
    };
    const text = jsonio.readStdin(allocator) catch "";
    if (text.len == 0) return 0;
    const list: SecretsResult = if (secrets.load(allocator, secrets_file)) |v| .{ .ok = v } else |e| .{ .err = e };
    var d = try decide(allocator, text, list);
    defer d.deinit(allocator);
    if (try render(allocator, d)) |out| try jsonio.writeStdout(out);
    return 0;
}
```

- [ ] **Step 4: テストを通す**

```bash
cd contrib/sumi && zig build test 2>&1 | tail -5 && zig build
```

Expected: エラーなし。

- [ ] **Step 5: 手で確認する**

```bash
cd contrib/sumi
printf 'Tr0ub4dor\n' > /tmp/sumi-test-secrets
printf '{"hook_event_name":"PostToolUse","tool_name":"Read","tool_response":{"type":"text","file":{"content":"db.password=Tr0ub4dor\n"}}}' | ./zig-out/bin/sumi hook --agent claude post-tool --secrets-file /tmp/sumi-test-secrets
printf '{"tool_response":{"stdout":"clean"}}' | ./zig-out/bin/sumi hook --agent claude post-tool --secrets-file /tmp/sumi-test-secrets; echo "(empty above) exit=$?"
rm /tmp/sumi-test-secrets
```

Expected: 1 行目は `updatedToolOutput.file.content` が `db.password=*********\n` の JSON。2 行目は出力なしで `exit=0`。

- [ ] **Step 6: Commit**

```bash
git add contrib/sumi/claude/hook_post.zig
git commit -F- <<'EOF'
feat(sumi): replace masked tool_response in PostToolUse

The PostToolUse hook parses the payload, masks the string leaves and keys of
tool_response, and returns the result as updatedToolOutput only when something
changed. tool_input is left alone: the model wrote it, and it is not output
being delivered to the model.

PostToolUseFailure carries the output in `error`, which Claude Code does not
let a hook replace, so a failure that contains a listed value is reported
through systemMessage rather than masked. The same applies when the secrets
file cannot be read: on PostToolUse the output is withheld, on a failure
payload there is nothing to withhold with.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 6: hook prompt (claude/hook_prompt.zig)

**Files:**
- Create: `contrib/sumi/claude/hook_prompt.zig` (stub を置き換える)

**Interfaces:**
- Consumes: `jsonio.*`、`secrets.load/describe`、`mask.containsAny`、`main.findOption`。
- Produces: `hook_prompt.extractTokens(allocator, prompt) ![]const []const u8`、`hook_prompt.looksLikePath(token) bool`、`hook_prompt.isMcpResource(token) bool`、`hook_prompt.Checker` (roots、deny_paths、secrets、deadline を持ち `check(token) !Verdict`)、`hook_prompt.blockJson(allocator, reason) ![]u8`。

- [ ] **Step 1: テストを書く**

```zig
const testing = std.testing;

fn tokens(prompt: []const u8) ![]const []const u8 {
    return extractTokens(testing.allocator, prompt);
}

test "extractTokens: @ at start or after whitespace, escaped spaces kept" {
    const got = try tokens("see @a.txt and @dir/b\\ c.md but not user@example.com");
    defer testing.allocator.free(got);
    try testing.expectEqual(@as(usize, 2), got.len);
    try testing.expectEqualStrings("a.txt", got[0]);
    try testing.expectEqualStrings("dir/b c.md", got[1]);
}

test "extractTokens: a lone @ or a prompt without @ yields nothing" {
    const got = try tokens("nothing here @ ");
    defer testing.allocator.free(got);
    try testing.expectEqual(@as(usize, 0), got.len);
}

test "looksLikePath: slashes or a short alphabetic extension" {
    try testing.expect(looksLikePath("src/main.zig"));
    try testing.expect(looksLikePath("gone.java"));
    try testing.expect(looksLikePath("notes.md"));
    try testing.expect(!looksLikePath("Override"));
    try testing.expect(!looksLikePath("v1.2.3"));
    try testing.expect(!looksLikePath("agent-general-purpose"));
    try testing.expect(!looksLikePath("file.12345"));
}

test "isMcpResource: server:scheme://path" {
    try testing.expect(isMcpResource("github:repo://owner/name"));
    try testing.expect(!isMcpResource("src/x.zig"));
}

test "expandHome: ~/ is replaced with HOME" {
    const got = try expandHome(testing.allocator, "~/notes.md", "/home/u");
    defer testing.allocator.free(got);
    try testing.expectEqualStrings("/home/u/notes.md", got);
    const same = try expandHome(testing.allocator, "x/~/y", "/home/u");
    defer testing.allocator.free(same);
    try testing.expectEqualStrings("x/~/y", same);
}

test "Checker: file holding the value is rejected, clean file allowed, missing path-like token rejected" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(.{ .sub_path = "holds.java", .data = "db.password=Tr0ub4dor\n" });
    try tmp.dir.writeFile(.{ .sub_path = "clean.java", .data = "nothing\n" });
    const root = try tmp.dir.realpathAlloc(testing.allocator, ".");
    defer testing.allocator.free(root);

    var c = Checker{
        .allocator = testing.allocator,
        .roots = &.{root},
        .deny_paths = &.{},
        .secrets = &.{"Tr0ub4dor"},
        .deadline_ms = std.time.milliTimestamp() + 15_000,
    };
    try testing.expectEqual(Verdict.holds_value, try c.check("holds.java"));
    try testing.expectEqual(Verdict.clean, try c.check("clean.java"));
    try testing.expectEqual(Verdict.unverifiable, try c.check("gone.java"));
    try testing.expectEqual(Verdict.clean, try c.check("Override"));
}

test "Checker: a directory is checked file by file and a name is found deeper in the tree" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.makePath("sub");
    try tmp.dir.writeFile(.{ .sub_path = "sub/nested.java", .data = "x=Tr0ub4dor\n" });
    const root = try tmp.dir.realpathAlloc(testing.allocator, ".");
    defer testing.allocator.free(root);

    var c = Checker{
        .allocator = testing.allocator,
        .roots = &.{root},
        .deny_paths = &.{},
        .secrets = &.{"Tr0ub4dor"},
        .deadline_ms = std.time.milliTimestamp() + 15_000,
    };
    try testing.expectEqual(Verdict.holds_value, try c.check("sub"));
    try testing.expectEqual(Verdict.holds_value, try c.check("elsewhere/nested.java"));
}

test "Checker: deny_paths and MCP resources are rejected before any lookup" {
    var c = Checker{
        .allocator = testing.allocator,
        .roots = &.{"/nonexistent-root"},
        .deny_paths = &.{"app.properties"},
        .secrets = &.{"Tr0ub4dor"},
        .deadline_ms = std.time.milliTimestamp() + 15_000,
    };
    try testing.expectEqual(Verdict.denied_name, try c.check("config/app.properties"));
    try testing.expectEqual(Verdict.mcp_resource, try c.check("github:repo://o/n"));
}

test "Checker: an expired deadline makes every token unverifiable" {
    var c = Checker{
        .allocator = testing.allocator,
        .roots = &.{"/"},
        .deny_paths = &.{},
        .secrets = &.{"Tr0ub4dor"},
        .deadline_ms = std.time.milliTimestamp() - 1,
    };
    try testing.expectEqual(Verdict.unverifiable, try c.check("Override"));
}

test "blockJson: decision block with the sumi prefix and suppressed prompt" {
    const out = try blockJson(testing.allocator, "this prompt carries a protected value");
    defer testing.allocator.free(out);
    try testing.expectEqualStrings(
        "{\"decision\":\"block\",\"reason\":\"sumi: this prompt carries a protected value\",\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"suppressOriginalPrompt\":true}}",
        out,
    );
}
```

- [ ] **Step 2: テストが落ちることを確認する**

```bash
cd contrib/sumi && zig build test 2>&1 | head -5
```

Expected: `extractTokens` 未定義のコンパイルエラー。

- [ ] **Step 3: 実装する**

```zig
//! UserPromptSubmit: 保護対象の値を含む `@` 添付と、値そのものを含むプロンプトを拒否する。
//!
//! ペイロードには `@path` という文字だけが入り、添付された内容は入らない (実測)。
//! プロンプトは書き換えられないので、添付先をここで開いて調べ、値があれば拒否する。
//! 相対パスの基準はペイロードの `cwd` と `--root`。Claude Code は `--add-dir` で
//! 足したディレクトリにも `@` を解決するがペイロードはそれを教えてくれないので、
//! 見つからないトークンは同じ名前を各基準の下で探し、それでも見つからずパスの形を
//! していれば「検証できなかった」として拒否する。
//!
//! hook 全体に 15 秒の期限を置く。settings の timeout (20 秒) を超えると Claude Code 側で
//! fail-open になるので、その前に自分で fail-closed に倒す。

const std = @import("std");
const jsonio = @import("../jsonio.zig");
const secrets = @import("../secrets.zig");
const cli = @import("../main.zig");
const mask = @import("mask");

pub const SCAN_LIMIT: usize = 32 * 1024 * 1024;
pub const DIR_FILE_LIMIT: usize = 100;
pub const SEARCH_DEPTH: usize = 6;
pub const SEARCH_LIMIT: usize = 50;
pub const DEADLINE_MS: i64 = 15_000;

/// `@` は行頭か空白の直後にあるものだけを添付と見る。バックスラッシュでエスケープ
/// した空白はトークンの一部。
pub fn extractTokens(allocator: std.mem.Allocator, prompt: []const u8) ![]const []const u8 {
    var out: std.ArrayList([]const u8) = .empty;
    var i: usize = 0;
    while (i < prompt.len) : (i += 1) {
        if (prompt[i] != '@') continue;
        if (i > 0 and !std.ascii.isWhitespace(prompt[i - 1])) continue;
        var tok: std.ArrayList(u8) = .empty;
        var j = i + 1;
        while (j < prompt.len) : (j += 1) {
            const c = prompt[j];
            if (c == '\\' and j + 1 < prompt.len) {
                try tok.append(allocator, prompt[j + 1]);
                j += 1;
                continue;
            }
            if (std.ascii.isWhitespace(c)) break;
            try tok.append(allocator, c);
        }
        if (tok.items.len > 0) {
            try out.append(allocator, try tok.toOwnedSlice(allocator));
        } else {
            tok.deinit(allocator);
        }
        i = j;
    }
    return out.toOwnedSlice(allocator);
}

/// `/` を含むか、英字始まり 1〜4 文字の拡張子で終わるものだけをパスの形と見る。
pub fn looksLikePath(token: []const u8) bool {
    if (std.mem.indexOfScalar(u8, token, '/') != null) return true;
    const dot = std.mem.lastIndexOfScalar(u8, token, '.') orelse return false;
    const ext = token[dot + 1 ..];
    if (ext.len < 1 or ext.len > 4) return false;
    if (!std.ascii.isAlphabetic(ext[0])) return false;
    for (ext[1..]) |c| if (!std.ascii.isAlphanumeric(c)) return false;
    return true;
}

pub fn isMcpResource(token: []const u8) bool {
    return std.mem.indexOf(u8, token, "://") != null;
}

pub fn expandHome(allocator: std.mem.Allocator, token: []const u8, home: []const u8) ![]u8 {
    if (std.mem.startsWith(u8, token, "~/")) {
        return std.fs.path.join(allocator, &.{ home, token[2..] });
    }
    return allocator.dupe(u8, token);
}

pub const Verdict = enum { clean, holds_value, denied_name, mcp_resource, unverifiable };

pub const Checker = struct {
    allocator: std.mem.Allocator,
    roots: []const []const u8,
    deny_paths: []const []const u8,
    secrets: []const []const u8,
    deadline_ms: i64,

    fn expired(self: *const Checker) bool {
        return std.time.milliTimestamp() >= self.deadline_ms;
    }

    /// 0 = 値なし。読めない・値がある、のどちらも「値がある」側に倒す。
    fn fileHoldsValue(self: *const Checker, path: []const u8) bool {
        const data = std.fs.cwd().readFileAlloc(self.allocator, path, SCAN_LIMIT) catch |err| switch (err) {
            error.FileTooBig => blk: {
                const f = std.fs.cwd().openFile(path, .{}) catch return true;
                defer f.close();
                const buf = self.allocator.alloc(u8, SCAN_LIMIT) catch return true;
                const n = f.readAll(buf) catch return true;
                break :blk buf[0..n];
            },
            else => return true,
        };
        return mask.containsAny(data, self.secrets);
    }

    /// パスが指すものを検査する。見つからなければ null。
    fn checkPath(self: *const Checker, path: []const u8) ?Verdict {
        const st = std.fs.cwd().statFile(path) catch return null;
        switch (st.kind) {
            .file => return if (self.fileHoldsValue(path)) .holds_value else .clean,
            .directory => {
                var dir = std.fs.cwd().openDir(path, .{ .iterate = true }) catch return .holds_value;
                defer dir.close();
                var it = dir.iterate();
                var seen: usize = 0;
                while (it.next() catch return .holds_value) |entry| {
                    if (entry.kind != .file) continue;
                    if (seen >= DIR_FILE_LIMIT) break;
                    seen += 1;
                    if (self.expired()) return .unverifiable;
                    const child = std.fs.path.join(self.allocator, &.{ path, entry.name }) catch return .holds_value;
                    if (self.fileHoldsValue(child)) return .holds_value;
                }
                return .clean;
            },
            else => return .clean,
        }
    }

    /// 同じ basename を root の下で深さ SEARCH_DEPTH まで探し、見つかったものを検査する。
    /// 1 つでも見つかれば検査結果を、見つからなければ null を返す。
    fn searchByName(self: *const Checker, root: []const u8, base: []const u8) !?Verdict {
        var dir = std.fs.cwd().openDir(root, .{ .iterate = true }) catch return null;
        defer dir.close();
        var walker = try dir.walk(self.allocator);
        defer walker.deinit();
        var found: usize = 0;
        var any = false;
        while (try walker.next()) |entry| {
            if (self.expired()) return .unverifiable;
            if (std.mem.count(u8, entry.path, "/") >= SEARCH_DEPTH) continue;
            if (entry.kind != .file) continue;
            if (!std.mem.eql(u8, entry.basename, base)) continue;
            any = true;
            found += 1;
            const full = try std.fs.path.join(self.allocator, &.{ root, entry.path });
            if (self.fileHoldsValue(full)) return .holds_value;
            if (found >= SEARCH_LIMIT) break;
        }
        return if (any) .clean else null;
    }

    pub fn check(self: *const Checker, token: []const u8) !Verdict {
        if (self.expired()) return .unverifiable;
        for (self.deny_paths) |deny| {
            if (std.mem.indexOf(u8, token, deny) != null) return .denied_name;
        }
        if (isMcpResource(token)) return .mcp_resource;

        const home = std.posix.getenv("HOME") orelse "";
        const path = try expandHome(self.allocator, token, home);

        if (std.fs.path.isAbsolute(path)) {
            if (self.checkPath(path)) |v| return v;
        } else {
            var resolved = false;
            for (self.roots) |root| {
                const full = try std.fs.path.join(self.allocator, &.{ root, path });
                if (self.checkPath(full)) |v| {
                    if (v != .clean) return v;
                    resolved = true;
                }
            }
            if (resolved) return .clean;
        }

        const base = std.fs.path.basename(path);
        var any = false;
        for (self.roots) |root| {
            if (try self.searchByName(root, base)) |v| {
                if (v != .clean) return v;
                any = true;
            }
        }
        if (any) return .clean;

        return if (looksLikePath(path)) .unverifiable else .clean;
    }
};

pub fn blockJson(allocator: std.mem.Allocator, reason: []const u8) ![]u8 {
    const text = try std.fmt.allocPrint(allocator, "sumi: {s}", .{reason});
    defer allocator.free(text);
    const q = try jsonio.quoteString(allocator, text);
    defer allocator.free(q);
    return std.fmt.allocPrint(
        allocator,
        "{{\"decision\":\"block\",\"reason\":{s},\"hookSpecificOutput\":{{\"hookEventName\":\"UserPromptSubmit\",\"suppressOriginalPrompt\":true}}}}",
        .{q},
    );
}

fn block(allocator: std.mem.Allocator, reason: []const u8) u8 {
    const out = blockJson(allocator, reason) catch return 0;
    jsonio.writeStdout(out) catch {};
    return 0;
}

const ATTACHMENT_TAIL = " An @-attachment is not a tool call and never reaches output masking, so its content cannot be masked. Ask for the lines you need instead.";

fn collectRepeated(allocator: std.mem.Allocator, args: []const []const u8, name: []const u8) ![]const []const u8 {
    var out: std.ArrayList([]const u8) = .empty;
    var i: usize = 0;
    while (i + 1 < args.len) : (i += 1) {
        if (std.mem.eql(u8, args[i], name)) {
            try out.append(allocator, args[i + 1]);
            i += 1;
        }
    }
    return out.toOwnedSlice(allocator);
}

pub fn main(allocator: std.mem.Allocator, args: []const []const u8, self_path: []const u8) !u8 {
    _ = self_path;
    const started = std.time.milliTimestamp();
    const secrets_file = cli.findOption(args, "--secrets-file") orelse {
        std.debug.print("sumi: prompt needs --secrets-file\n", .{});
        return cli.EXIT_USAGE;
    };
    const extra_roots = try collectRepeated(allocator, args, "--root");
    const deny_paths = try collectRepeated(allocator, args, "--deny-path");

    const text = jsonio.readStdin(allocator) catch return block(allocator, "the hook payload could not be read");
    if (text.len == 0) return 0;
    var parsed = jsonio.parse(allocator, text) catch return block(allocator, "the hook payload is not valid JSON");
    defer parsed.deinit();

    const prompt = jsonio.getString(parsed.value, "prompt") orelse return 0;
    if (prompt.len == 0) return 0;

    const list = secrets.load(allocator, secrets_file) catch |err| return block(allocator, secrets.describe(err));

    var roots: std.ArrayList([]const u8) = .empty;
    const cwd = jsonio.getString(parsed.value, "cwd") orelse ".";
    try roots.append(allocator, if (cwd.len == 0) "." else cwd);
    for (extra_roots) |r| try roots.append(allocator, r);

    const checker = Checker{
        .allocator = allocator,
        .roots = roots.items,
        .deny_paths = deny_paths,
        .secrets = list,
        .deadline_ms = started + DEADLINE_MS,
    };

    const attachments = try extractTokens(allocator, prompt);
    for (attachments) |token| {
        const verdict = checker.check(token) catch return block(allocator, "an attachment could not be checked");
        const reason = switch (verdict) {
            .clean => continue,
            .holds_value => try std.fmt.allocPrint(allocator, "the attachment @{s} was rejected: it holds a protected value.{s}", .{ token, ATTACHMENT_TAIL }),
            .denied_name => try std.fmt.allocPrint(allocator, "the attachment @{s} was rejected: its name is on the deny list.{s}", .{ token, ATTACHMENT_TAIL }),
            .mcp_resource => try std.fmt.allocPrint(allocator, "the attachment @{s} was rejected: an MCP resource cannot be checked here. Read it with the ReadMcpResource tool instead, whose output is masked.", .{token}),
            .unverifiable => try std.fmt.allocPrint(allocator, "the attachment @{s} was rejected: no such file under the directories this hook knows about, so its content could not be checked.{s}", .{ token, ATTACHMENT_TAIL }),
        };
        return block(allocator, reason);
    }

    if (mask.containsAny(prompt, list)) {
        return block(allocator, "this prompt carries a protected value. A prompt cannot be masked in place, only rejected, so it was not submitted.");
    }
    return 0;
}
```

- [ ] **Step 4: テストを通す**

```bash
cd contrib/sumi && zig build test 2>&1 | tail -5 && zig build
```

Expected: エラーなし。

- [ ] **Step 5: 手で確認する**

```bash
cd contrib/sumi
printf 'Tr0ub4dor\n' > /tmp/sumi-test-secrets
mkdir -p /tmp/sumi-attach && printf 'db.password=Tr0ub4dor\n' > /tmp/sumi-attach/holds.properties
printf '{"prompt":"see @holds.properties","cwd":"/tmp/sumi-attach"}' | ./zig-out/bin/sumi hook --agent claude prompt --secrets-file /tmp/sumi-test-secrets
printf '{"prompt":"add @Override to it","cwd":"/tmp/sumi-attach"}' | ./zig-out/bin/sumi hook --agent claude prompt --secrets-file /tmp/sumi-test-secrets; echo "(empty above) exit=$?"
rm -r /tmp/sumi-attach /tmp/sumi-test-secrets
```

Expected: 1 行目は `decision: block` と `holds a protected value`。2 行目は出力なし、`exit=0`。

- [ ] **Step 6: Commit**

```bash
git add contrib/sumi/claude/hook_prompt.zig
git commit -F- <<'EOF'
feat(sumi): reject @-attachments that hold a listed value

An @-attachment is not a tool call: the UserPromptSubmit payload carries only
the literal "@path" and the prompt cannot be rewritten, so the hook opens the
attached file itself and blocks the prompt when it holds a listed value.
Directories are checked file by file.

Claude Code also resolves @ against --add-dir roots the payload does not name.
A token that resolves under no known root is looked up by name under each root,
and one that still cannot be found but is shaped like a path is rejected as
unverifiable rather than waved through. MCP resource references are rejected
for the same reason; the ReadMcpResource tool is the masked alternative.

The hook gives itself a 15 second deadline and rejects whatever it has not
checked by then, so it fails closed before Claude Code's own 20 second hook
timeout would fail open.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 7: init (claude/init.zig)

**Files:**
- Create: `contrib/sumi/claude/init.zig` (stub を置き換える)

**Interfaces:**
- Consumes: `jsonio.*`、`shell.join`、`secrets.load/describe`、`main.findOption`、`hook_bash.rewrite`。
- Produces: `init.mergeHooks(allocator, settings: *std.json.Value, self_basename, entries: HookEntries) !usize` (取り除いた自分の entry 数を返す)、`init.HookEntries { pre_bash, post_tool, prompt: []const u8 }`、`init.buildCommands(...)`、`init.formatTimestamp(buf, secs) []const u8`、`init.resolveShell(allocator) !?[]u8`。

- [ ] **Step 1: テストを書く**

```zig
const testing = std.testing;

test "formatTimestamp: YYYYmmddHHMMSS in UTC" {
    var buf: [14]u8 = undefined;
    try testing.expectEqualStrings("20260911093337", formatTimestamp(&buf, 1789097617));
}

test "isOwnEntry: matches by basename of the first word followed by hook" {
    try testing.expect(isOwnEntry("/opt/x/sumi hook --agent claude post-tool --secrets-file /s", "sumi"));
    try testing.expect(isOwnEntry("'/home/u/my tools/sumi' hook --agent claude prompt", "sumi"));
    try testing.expect(!isOwnEntry("/opt/x/sumi run --secrets-file /s -- bash", "sumi"));
    try testing.expect(!isOwnEntry("prettier --write", "sumi"));
    try testing.expect(!isOwnEntry("/opt/x/other hook", "sumi"));
}

test "mergeHooks: adds four events, keeps foreign entries, replaces own entries idempotently" {
    var parsed = try jsonio.parse(testing.allocator,
        \\{"theme":"dark","hooks":{"PostToolUse":[{"hooks":[{"type":"command","command":"prettier --write"}]},{"hooks":[{"type":"command","command":"/old/sumi hook --agent claude post-tool --secrets-file /s"}]}]}}
    );
    defer parsed.deinit();
    const entries = HookEntries{
        .pre_bash = "/new/sumi hook --agent claude pre-bash --secrets-file /s --shell /bin/bash",
        .post_tool = "/new/sumi hook --agent claude post-tool --secrets-file /s",
        .prompt = "/new/sumi hook --agent claude prompt --secrets-file /s",
    };
    const removed = try mergeHooks(testing.allocator, &parsed.value, "sumi", entries);
    try testing.expectEqual(@as(usize, 1), removed);

    const removed_again = try mergeHooks(testing.allocator, &parsed.value, "sumi", entries);
    try testing.expectEqual(@as(usize, 4), removed_again);

    const out = try jsonio.stringify(testing.allocator, parsed.value);
    defer testing.allocator.free(out);
    try testing.expect(std.mem.indexOf(u8, out, "\"theme\":\"dark\"") != null);
    try testing.expect(std.mem.indexOf(u8, out, "prettier --write") != null);
    try testing.expect(std.mem.indexOf(u8, out, "/old/sumi") == null);
    try testing.expect(std.mem.indexOf(u8, out, "\"disableAllHooks\":false") != null);
    try testing.expect(std.mem.indexOf(u8, out, "\"matcher\":\"Bash\"") != null);
    try testing.expect(std.mem.indexOf(u8, out, "\"timeout\":20") != null);
    try testing.expectEqual(@as(usize, 1), std.mem.count(u8, out, entries.post_tool));
    // PostToolUse と PostToolUseFailure が同じ command を持つので合計 2 回現れる。
    try testing.expectEqual(@as(usize, 2), std.mem.count(u8, out, "post-tool --secrets-file /s"));
}

test "buildCommands: options are copied to the right hooks and quoted" {
    const cmds = try buildCommands(testing.allocator, "/opt/s/sumi", "/opt/s/secrets.txt", "/bin/bash", &.{"/extra dir"}, &.{"app.properties"});
    try testing.expectEqualStrings("/opt/s/sumi hook --agent claude pre-bash --secrets-file /opt/s/secrets.txt --shell /bin/bash", cmds.pre_bash);
    try testing.expectEqualStrings("/opt/s/sumi hook --agent claude post-tool --secrets-file /opt/s/secrets.txt", cmds.post_tool);
    try testing.expectEqualStrings("/opt/s/sumi hook --agent claude prompt --secrets-file /opt/s/secrets.txt --root '/extra dir' --deny-path app.properties", cmds.prompt);
}

test "defaultSettingsPath: honours CLAUDE_CONFIG_DIR, falls back to ~/.claude" {
    const a = try defaultSettingsPath(testing.allocator, "/cfg", "/home/u");
    defer testing.allocator.free(a);
    try testing.expectEqualStrings("/cfg/settings.json", a);
    const b = try defaultSettingsPath(testing.allocator, null, "/home/u");
    defer testing.allocator.free(b);
    try testing.expectEqualStrings("/home/u/.claude/settings.json", b);
}
```

- [ ] **Step 2: テストが落ちることを確認する**

```bash
cd contrib/sumi && zig build test 2>&1 | head -5
```

- [ ] **Step 3: 実装する**

```zig
//! `sumi init --agent claude`: Claude Code のユーザー設定に hook を書き込む。
//!
//! 4 イベント (PreToolUse(Bash)、PostToolUse、PostToolUseFailure、UserPromptSubmit) に
//! 自分の entry を置く。既存の entry は「先頭語の basename が自分と同じで次の語が
//! hook」のものだけを取り除き、利用者の formatter や通知の hook は残す。再実行は冪等。
//!
//! 書き終えたら、書いた command を `sh -c` で実際に起動して確認する。settings は
//! 書き込み済みなので、失敗時はバックアップの場所を示す。

const std = @import("std");
const jsonio = @import("../jsonio.zig");
const shell = @import("../shell.zig");
const secrets = @import("../secrets.zig");
const cli = @import("../main.zig");
const hook_bash = @import("hook_bash.zig");

pub const HOOK_TIMEOUT: i64 = 20;

pub const HookEntries = struct {
    pre_bash: []const u8,
    post_tool: []const u8,
    prompt: []const u8,
};

pub fn formatTimestamp(buf: *[14]u8, secs: u64) []const u8 {
    const es = std.time.epoch.EpochSeconds{ .secs = secs };
    const day = es.getEpochDay();
    const yd = day.calculateYearDay();
    const md = yd.calculateMonthDay();
    const ds = es.getDaySeconds();
    return std.fmt.bufPrint(buf, "{d:0>4}{d:0>2}{d:0>2}{d:0>2}{d:0>2}{d:0>2}", .{
        yd.year,
        md.month.numeric(),
        md.day_index + 1,
        ds.getHoursIntoDay(),
        ds.getMinutesIntoHour(),
        ds.getSecondsIntoMinute(),
    }) catch unreachable;
}

/// 先頭語 (単引用符で包まれていてもよい) の basename が self_basename と一致し、
/// 次の語が `hook` なら自分の entry。
pub fn isOwnEntry(command: []const u8, self_basename: []const u8) bool {
    var rest = command;
    var first: []const u8 = undefined;
    if (rest.len > 0 and rest[0] == '\'') {
        const end = std.mem.indexOfScalarPos(u8, rest, 1, '\'') orelse return false;
        first = rest[1..end];
        rest = rest[end + 1 ..];
    } else {
        const end = std.mem.indexOfScalar(u8, rest, ' ') orelse rest.len;
        first = rest[0..end];
        rest = rest[end..];
    }
    if (!std.mem.eql(u8, std.fs.path.basename(first), self_basename)) return false;
    return std.mem.startsWith(u8, rest, " hook ") or std.mem.eql(u8, rest, " hook");
}

fn entryIsOwn(entry: std.json.Value, self_basename: []const u8) bool {
    const hooks = jsonio.getObject(entry, "hooks");
    _ = hooks;
    if (entry != .object) return false;
    const list = entry.object.get("hooks") orelse return false;
    if (list != .array) return false;
    for (list.array.items) |h| {
        const cmd = jsonio.getString(h, "command") orelse continue;
        if (isOwnEntry(cmd, self_basename)) return true;
    }
    return false;
}

fn makeEntry(allocator: std.mem.Allocator, command: []const u8, matcher: ?[]const u8) !std.json.Value {
    var hook = std.json.ObjectMap.init(allocator);
    try hook.put("type", .{ .string = "command" });
    try hook.put("command", .{ .string = command });
    try hook.put("timeout", .{ .integer = HOOK_TIMEOUT });
    var hooks = std.json.Array.init(allocator);
    try hooks.append(.{ .object = hook });
    var entry = std.json.ObjectMap.init(allocator);
    if (matcher) |m| try entry.put("matcher", .{ .string = m });
    try entry.put("hooks", .{ .array = hooks });
    return .{ .object = entry };
}

fn ensureObject(allocator: std.mem.Allocator, parent: *std.json.ObjectMap, key: []const u8) !*std.json.ObjectMap {
    const gop = try parent.getOrPut(key);
    if (!gop.found_existing or gop.value_ptr.* != .object) {
        gop.value_ptr.* = .{ .object = std.json.ObjectMap.init(allocator) };
    }
    return &gop.value_ptr.object;
}

fn mergeEvent(
    allocator: std.mem.Allocator,
    hooks: *std.json.ObjectMap,
    event: []const u8,
    self_basename: []const u8,
    command: []const u8,
    matcher: ?[]const u8,
) !usize {
    var kept = std.json.Array.init(allocator);
    var removed: usize = 0;
    if (hooks.get(event)) |existing| {
        if (existing == .array) {
            for (existing.array.items) |entry| {
                if (entryIsOwn(entry, self_basename)) {
                    removed += 1;
                } else {
                    try kept.append(entry);
                }
            }
        }
    }
    try kept.append(try makeEntry(allocator, command, matcher));
    try hooks.put(event, .{ .array = kept });
    return removed;
}

pub fn mergeHooks(allocator: std.mem.Allocator, settings: *std.json.Value, self_basename: []const u8, entries: HookEntries) !usize {
    if (settings.* != .object) settings.* = .{ .object = std.json.ObjectMap.init(allocator) };
    try settings.object.put("disableAllHooks", .{ .bool = false });
    const hooks = try ensureObject(allocator, &settings.object, "hooks");
    var removed: usize = 0;
    removed += try mergeEvent(allocator, hooks, "PreToolUse", self_basename, entries.pre_bash, "Bash");
    removed += try mergeEvent(allocator, hooks, "PostToolUse", self_basename, entries.post_tool, null);
    removed += try mergeEvent(allocator, hooks, "PostToolUseFailure", self_basename, entries.post_tool, null);
    removed += try mergeEvent(allocator, hooks, "UserPromptSubmit", self_basename, entries.prompt, null);
    return removed;
}

pub fn buildCommands(
    allocator: std.mem.Allocator,
    self_path: []const u8,
    secrets_file: []const u8,
    shell_path: []const u8,
    roots: []const []const u8,
    deny_paths: []const []const u8,
) !HookEntries {
    const pre_bash = try shell.join(allocator, &.{ self_path, "hook", "--agent", "claude", "pre-bash", "--secrets-file", secrets_file, "--shell", shell_path });
    const post_tool = try shell.join(allocator, &.{ self_path, "hook", "--agent", "claude", "post-tool", "--secrets-file", secrets_file });
    var prompt_argv: std.ArrayList([]const u8) = .empty;
    try prompt_argv.appendSlice(allocator, &.{ self_path, "hook", "--agent", "claude", "prompt", "--secrets-file", secrets_file });
    for (roots) |r| try prompt_argv.appendSlice(allocator, &.{ "--root", r });
    for (deny_paths) |d| try prompt_argv.appendSlice(allocator, &.{ "--deny-path", d });
    const prompt = try shell.join(allocator, prompt_argv.items);
    return .{ .pre_bash = pre_bash, .post_tool = post_tool, .prompt = prompt };
}

pub fn defaultSettingsPath(allocator: std.mem.Allocator, config_dir: ?[]const u8, home: []const u8) ![]u8 {
    if (config_dir) |d| return std.fs.path.join(allocator, &.{ d, "settings.json" });
    return std.fs.path.join(allocator, &.{ home, ".claude", "settings.json" });
}

/// PATH から bash を探して絶対パスを返す。無ければ null。
pub fn resolveShell(allocator: std.mem.Allocator) !?[]u8 {
    const path_env = std.posix.getenv("PATH") orelse return null;
    var it = std.mem.splitScalar(u8, path_env, ':');
    while (it.next()) |dir| {
        if (dir.len == 0) continue;
        const candidate = try std.fs.path.join(allocator, &.{ dir, "bash" });
        std.fs.cwd().access(candidate, .{ .mode = .read_only }) catch continue;
        return try std.fs.cwd().realpathAlloc(allocator, candidate);
    }
    return null;
}

fn fail(msg: []const u8) u8 {
    std.debug.print("sumi init: {s}\n", .{msg});
    return 1;
}

fn warn(msg: []const u8) void {
    std.debug.print("sumi init: warning: {s}\n", .{msg});
}

/// command を `sh -c` で起動し、stdin を渡して stdout を返す。
fn runHook(allocator: std.mem.Allocator, command: []const u8, stdin: []const u8) !struct { code: u8, stdout: []u8 } {
    var child = std.process.Child.init(&.{ "sh", "-c", command }, allocator);
    child.stdin_behavior = .Pipe;
    child.stdout_behavior = .Pipe;
    child.stderr_behavior = .Pipe;
    try child.spawn();
    try child.stdin.?.writeAll(stdin);
    child.stdin.?.close();
    child.stdin = null;
    var out: std.ArrayList(u8) = .empty;
    var err_out: std.ArrayList(u8) = .empty;
    try child.collectOutput(allocator, &out, &err_out, 16 * 1024 * 1024);
    const term = try child.wait();
    const code: u8 = switch (term) {
        .Exited => |c| c,
        else => 1,
    };
    return .{ .code = code, .stdout = try out.toOwnedSlice(allocator) };
}

fn selfCheck(allocator: std.mem.Allocator, entries: HookEntries, probe: []const u8) !void {
    // post-tool: 値を含む合成ペイロードが差し替えられること。
    const post_payload = try std.fmt.allocPrint(allocator, "{{\"hook_event_name\":\"PostToolUse\",\"tool_response\":{{\"stdout\":\"probe={s}\"}}}}", .{probe});
    const post = try runHook(allocator, entries.post_tool, post_payload);
    if (post.code != 0 or std.mem.indexOf(u8, post.stdout, "updatedToolOutput") == null or std.mem.indexOf(u8, post.stdout, probe) != null) {
        return error.PostToolCheckFailed;
    }
    // pre-bash: 書き換え後の command を実行し、値がマスクされ終了ステータスが保たれること。
    const bash_payload = try std.fmt.allocPrint(allocator, "{{\"tool_input\":{{\"command\":\"echo probe={s}; exit 3\"}}}}", .{probe});
    const pre = try runHook(allocator, entries.pre_bash, bash_payload);
    if (pre.code != 0) return error.PreBashCheckFailed;
    var parsed = try jsonio.parse(allocator, pre.stdout);
    defer parsed.deinit();
    const hso = jsonio.getObject(parsed.value, "hookSpecificOutput") orelse return error.PreBashCheckFailed;
    const updated = hso.get("updatedInput") orelse return error.PreBashCheckFailed;
    const wrapped = jsonio.getString(updated, "command") orelse return error.PreBashCheckFailed;
    const ran = try runHook(allocator, wrapped, "");
    if (ran.code != 3 or std.mem.indexOf(u8, ran.stdout, probe) != null or std.mem.indexOf(u8, ran.stdout, "probe=") == null) {
        return error.WrappedCommandCheckFailed;
    }
    // prompt: 無害なプロンプトが素通りすること。
    const prompt_res = try runHook(allocator, entries.prompt, "{\"prompt\":\"hello\",\"cwd\":\"/\"}");
    if (prompt_res.code != 0 or prompt_res.stdout.len != 0) return error.PromptCheckFailed;
}

fn collectRepeated(allocator: std.mem.Allocator, args: []const []const u8, name: []const u8) ![]const []const u8 {
    var out: std.ArrayList([]const u8) = .empty;
    var i: usize = 0;
    while (i + 1 < args.len) : (i += 1) {
        if (std.mem.eql(u8, args[i], name)) {
            try out.append(allocator, args[i + 1]);
            i += 1;
        }
    }
    return out.toOwnedSlice(allocator);
}

fn absolutize(allocator: std.mem.Allocator, path: []const u8) ![]u8 {
    return std.fs.cwd().realpathAlloc(allocator, path);
}

pub fn main(allocator: std.mem.Allocator, args: []const []const u8, self_path: []const u8) !u8 {
    const secrets_arg = cli.findOption(args, "--secrets-file") orelse {
        std.debug.print("sumi: init needs --secrets-file\n", .{});
        return cli.EXIT_USAGE;
    };
    const roots = try collectRepeated(allocator, args, "--root");
    const deny_paths = try collectRepeated(allocator, args, "--deny-path");
    const home = std.posix.getenv("HOME") orelse return fail("HOME is not set");

    // 1. secrets ファイル。
    const values = secrets.load(allocator, secrets_arg) catch |err| return fail(secrets.describe(err));
    const secrets_file = absolutize(allocator, secrets_arg) catch return fail("the secrets file path could not be resolved");
    {
        const f = try std.fs.cwd().openFile(secrets_file, .{});
        defer f.close();
        const mode = (try f.stat()).mode & 0o777;
        if (mode != 0o600 and mode != 0o640 and mode != 0o400) {
            warn("the secrets file is not mode 0600/0640/0400; other users may read it");
        }
    }

    // 2. 自分のパス。片付けられそうな場所なら警告する。
    const tmpdir = std.posix.getenv("TMPDIR") orelse "/tmp";
    const downloads = try std.fs.path.join(allocator, &.{ home, "Downloads" });
    if (std.mem.startsWith(u8, self_path, "/tmp/") or std.mem.startsWith(u8, self_path, tmpdir) or std.mem.startsWith(u8, self_path, downloads)) {
        warn("this binary lives in a temporary or download directory; the hooks stop working (and fail open) if it is moved. Install it somewhere permanent and run init again.");
    }

    // 3. シェル。
    const shell_path = if (cli.findOption(args, "--shell")) |s|
        (absolutize(allocator, s) catch return fail("the shell given by --shell does not exist"))
    else
        ((try resolveShell(allocator)) orelse return fail("bash was not found on PATH; pass --shell"));
    std.fs.cwd().access(shell_path, .{}) catch return fail("the shell is not executable");

    // 4. settings。
    const settings_path = if (cli.findOption(args, "--settings")) |s|
        try allocator.dupe(u8, s)
    else
        try defaultSettingsPath(allocator, std.posix.getenv("CLAUDE_CONFIG_DIR"), home);
    const existing = std.fs.cwd().readFileAlloc(allocator, settings_path, 16 * 1024 * 1024) catch |err| switch (err) {
        error.FileNotFound => null,
        else => return fail("the settings file could not be read"),
    };
    var parsed = jsonio.parse(allocator, existing orelse "{}") catch return fail("the settings file is not valid JSON");
    defer parsed.deinit();

    // 5. バックアップ。
    var backup_path: ?[]u8 = null;
    if (existing != null) {
        var ts: [14]u8 = undefined;
        const stamp = formatTimestamp(&ts, @intCast(std.time.timestamp()));
        const bp = try std.fmt.allocPrint(allocator, "{s}.bak.{s}", .{ settings_path, stamp });
        std.fs.cwd().writeFile(.{ .sub_path = bp, .data = existing.? }) catch return fail("the backup could not be written");
        backup_path = bp;
    }

    // 6-7. マージ。
    const entries = try buildCommands(allocator, self_path, secrets_file, shell_path, roots, deny_paths);
    const removed = try mergeHooks(allocator, &parsed.value, std.fs.path.basename(self_path), entries);
    if (removed > 0) std.debug.print("sumi init: replaced {d} existing sumi hook entr{s}\n", .{ removed, if (removed == 1) "y" else "ies" });

    // 8. 書き戻し。
    const pretty = try jsonio.stringifyPretty(allocator, parsed.value);
    if (std.fs.path.dirname(settings_path)) |dir| try std.fs.cwd().makePath(dir);
    std.fs.cwd().writeFile(.{ .sub_path = settings_path, .data = pretty }) catch return fail("the settings file could not be written");
    std.debug.print("sumi init: hooks written to {s}\n", .{settings_path});
    if (backup_path) |bp| std.debug.print("sumi init: backup at {s}\n", .{bp});

    // 9. 自己診断。
    selfCheck(allocator, entries, values[0]) catch |err| {
        std.debug.print("sumi init: self-check failed ({s}). The hooks were written but did not behave as expected; restore the backup or fix the cause and run init again.\n", .{@errorName(err)});
        return 1;
    };
    std.debug.print("sumi init: self-check passed\n", .{});
    return 0;
}
```

注意: `entryIsOwn` の先頭 2 行 (`const hooks = ...; _ = hooks;`) は不要なので実装時に書かない。テストの `isOwnEntry` 期待値は上のとおり。

- [ ] **Step 4: テストを通す**

```bash
cd contrib/sumi && zig build test 2>&1 | tail -5 && zig build
```

Expected: エラーなし。

- [ ] **Step 5: 空の settings と既存 settings に対して手で確認する**

```bash
cd contrib/sumi
export SUMI_T=$(mktemp -d)
printf 'Tr0ub4dor\n' > $SUMI_T/secrets.txt && chmod 600 $SUMI_T/secrets.txt
./zig-out/bin/sumi init --agent claude --secrets-file $SUMI_T/secrets.txt --settings $SUMI_T/settings.json; echo "exit=$?"
jq '.hooks | keys' $SUMI_T/settings.json
printf '{"theme":"dark","hooks":{"PostToolUse":[{"hooks":[{"type":"command","command":"prettier --write"}]}]}}' > $SUMI_T/s2.json
./zig-out/bin/sumi init --agent claude --secrets-file $SUMI_T/secrets.txt --settings $SUMI_T/s2.json; echo "exit=$?"
./zig-out/bin/sumi init --agent claude --secrets-file $SUMI_T/secrets.txt --settings $SUMI_T/s2.json; echo "exit=$?"
jq -c '[.theme, (.hooks.PostToolUse | length), (.hooks.PostToolUse[].hooks[].command | select(startswith("prettier")))]' $SUMI_T/s2.json
ls $SUMI_T/s2.json.bak.* | wc -l
./zig-out/bin/sumi init --agent claude --secrets-file /nonexistent --settings $SUMI_T/s3.json; echo "exit=$?"; ls $SUMI_T/s3.json 2>&1
rm -r $SUMI_T
```

Expected: 1 回目 `self-check passed`、`exit=0`、keys は 4 イベント。s2 は 2 回とも exit 0 で、`["dark",2,"prettier --write"]`、バックアップは 2 個。s3 は `exit=1` で settings は作られない。

- [ ] **Step 6: Commit**

```bash
git add contrib/sumi/claude/init.zig
git commit -F- <<'EOF'
feat(sumi): init writes the hooks into settings.json and verifies them

init validates the secrets file, resolves bash from PATH (runLocal does not
search PATH, and /bin/bash does not exist on every system), backs up the
settings file, and merges four hook entries pointing at this binary's absolute
path. Only entries whose command starts with this binary's basename followed
by `hook` are replaced, so a user's own hooks survive and rerunning init is
idempotent.

It then runs each written command through `sh -c` with a synthetic payload,
including executing the command that pre-bash produces, because a hook that
cannot start is a hook that fails open and the user would not otherwise learn
about it until a value leaked.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 8: 黒箱テスト (tests/run-tests.sh)

**Files:**
- Create: `contrib/sumi/tests/run-tests.sh`

**Interfaces:**
- Consumes: ビルド済み `contrib/sumi/zig-out/bin/sumi` (環境変数 `SUMI_BIN` で上書き可)。bash と jq。

- [ ] **Step 1: スクリプトを書く**

```bash
#!/usr/bin/env bash
# Exercise the built sumi binary against decoy values. Never touches a real
# repository; needs bash and jq.
set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sumi="${SUMI_BIN:-$script_dir/../zig-out/bin/sumi}"
[ -x "$sumi" ] || { echo "sumi not found at $sumi; run 'zig build' in contrib/sumi first" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

current="Tr0ub4dor"
retired="hunter2xyz"
quoted='ab"cd-decoy'

printf '%s\n%s\n' "$current" "$retired" > "$work/secrets.txt"
printf '%s\n' "$quoted" > "$work/quoted.txt"
printf 'true\n' > "$work/token.txt"
: > "$work/empty.txt"

passed=0
failed=0

check() {
  local name="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    printf 'ok  %s\n' "$name"
    passed=$((passed + 1))
  else
    printf 'FAIL %s\n  expected: %s\n  actual:   %s\n' "$name" "$expected" "$actual"
    failed=$((failed + 1))
  fi
}

post() { printf '%s' "$1" | "$sumi" hook --agent claude post-tool --secrets-file "${2:-$work/secrets.txt}"; }
prompt() { printf '%s' "$1" | "$sumi" hook --agent claude prompt --secrets-file "$work/secrets.txt" "${@:2}"; }
prebash() { printf '%s' "$1" | "$sumi" hook --agent claude pre-bash --secrets-file "${2:-$work/secrets.txt}" --shell /bin/bash; }

delivered() { jq -r '.hookSpecificOutput.updatedToolOutput | if type == "string" then . else tojson end' 2>/dev/null; }
decision() { jq -r '.decision // ""'; }
leaks() {
  case "$1" in
    *"$current"* | *"$retired"* | *"$quoted"*) echo yes ;;
    *) echo no ;;
  esac
}

# --- post-tool ---------------------------------------------------------------

out="$(post "$(jq -nc --arg v "$current" '{hook_event_name:"PostToolUse",tool_name:"Read",tool_input:{file_path:"/decoy/config/app.properties"},tool_response:{type:"text",file:{content:("db.password=" + $v + "\n")}}}')" | delivered)"
check "Read output, current value" 'db.password=*********\n' "$(jq -nr --arg o "$out" '$o | fromjson | .file.content | @json' | sed 's/^"//;s/"$//')"

out="$(post "$(jq -nc --arg v "$retired" '{tool_name:"Bash",tool_input:{command:"git show HEAD~9:config/app.properties"},tool_response:{stdout:("db.password=" + $v),stderr:""}}')" | delivered)"
check "Bash git show, value only in history" "no" "$(leaks "$out")"

check "unrelated output passes through" "" "$(post '{"tool_name":"Bash","tool_input":{"command":"ls"},"tool_response":{"stdout":"README.md\n","stderr":""}}')"

check "value in tool_input alone does not replace output" "" "$(post "$(jq -nc --arg v "$current" '{tool_name:"Bash",tool_input:{command:("echo " + $v)},tool_response:{stdout:"done\n"}}')")"

out="$(post "$(jq -nc --arg v "$quoted" '{tool_response:{stdout:("pass=" + $v)}}')" "$work/quoted.txt" | delivered)"
check "value that JSON-escapes is masked" 'pass=***********' "$(jq -nr --arg o "$out" '$o | fromjson | .stdout')"

out="$(post '{"tool_response":{"ok":true,"s":"true"}}' "$work/token.txt" | delivered)"
check "a secret spelled like a JSON token leaves the structure intact" '{"ok":true,"s":"****"}' "$out"

out="$(post '{"tool_response":{"stdout":"x"}}' "$work/missing.txt" | delivered)"
case "$out" in
  sumi:*withheld*) check "missing secrets file withholds output" "ok" "ok" ;;
  *) check "missing secrets file withholds output" "ok" "$out" ;;
esac

out="$(post "$(jq -nc --arg v "$current" '{tool_response:{stdout:("p=" + $v)}}')" "$work/empty.txt" | delivered)"
check "empty secrets file does not pass the value" "no" "$(leaks "$out")"

out="$(post "$(jq -nc --arg v "$current" '{hook_event_name:"PostToolUseFailure",tool_name:"Bash",tool_input:{command:"cat decoy && false"},error:("Exit code 1\ndb.password=" + $v)}')" | jq -r 'keys | join(",")')"
check "failed call reports rather than masks" "systemMessage" "$out"

check "failed call without the value stays quiet" "" "$(post '{"hook_event_name":"PostToolUseFailure","error":"Exit code 1\nno such file"}')"

# --- prompt ------------------------------------------------------------------

check "prompt carrying the value is blocked" "block" "$(prompt "$(jq -nc --arg v "$current" '{prompt:("is the password " + $v + "?")}')" | decision)"
check "attachment of an explicitly denied path is blocked" "block" "$(prompt '{"prompt":"please read @/decoy/real-repo/config/app.properties"}' --deny-path /decoy/real-repo | decision)"
check "ordinary prompt is allowed" "" "$(prompt '{"prompt":"please summarise the build failure"}' --deny-path /decoy/real-repo)"
check "naming the file without attaching it is allowed" "" "$(prompt '{"prompt":"what does app.properties hold?"}' --deny-path app.properties)"
check "attaching the file under any path is blocked" "block" "$(prompt '{"prompt":"look at @config/app.properties"}' --deny-path app.properties | decision)"

mkdir -p "$work/attach/sub"
printf 'db.password=%s\n' "$current" > "$work/attach/holds.properties"
printf 'nothing of interest\n' > "$work/attach/clean.properties"
printf 'x=%s\n' "$current" > "$work/attach/sub/nested.properties"
head -c 64 /dev/urandom > "$work/attach/blob.bin"
printf '%s' "$current" >> "$work/attach/blob.bin"

attach() { jq -nc --arg p "$1" --arg c "$work/attach" '{prompt:$p,cwd:$c}' | "$sumi" hook --agent claude prompt --secrets-file "$work/secrets.txt" "${@:2}" | decision; }

check "attachment holding the value is blocked" "block" "$(attach 'see @holds.properties')"
check "attachment without the value is allowed" "" "$(attach 'see @clean.properties')"
check "attached directory is checked file by file" "block" "$(attach 'see @sub')"
check "attachment holding the value in binary is blocked" "block" "$(attach 'see @blob.bin')"
check "absolute attachment path is resolved" "block" "$(attach "see @$work/attach/holds.properties")"
check "attachment found by name elsewhere in the tree" "block" "$(attach 'see @elsewhere/nested.properties')"
check "unverifiable attachment is rejected" "block" "$(attach 'see @gone.properties')"
check "an annotation is not an attachment" "" "$(attach 'add @Override to it')"
check "a mail address is not an attachment" "" "$(attach 'write to user@example.com')"
check "a version tag is not an attachment" "" "$(attach 'cut @v1.2.3')"
check "a subagent mention is not an attachment" "" "$(attach 'ask @agent-general-purpose')"
check "an MCP resource is rejected" "block" "$(attach 'read @github:repo://owner/name')"

mkdir -p "$work/other"
printf 'nothing of interest\n' > "$work/other/elsewhere.properties"
check "--root makes another directory checkable" "" "$(attach 'see @elsewhere.properties' --root "$work/other")"

# --- pre-bash ----------------------------------------------------------------

wrapped="$(prebash '{"tool_input":{"command":"cat decoy && false"}}' | jq -r '.hookSpecificOutput.updatedInput.command')"
case "$wrapped" in
  *" run --secrets-file "*" -- /bin/bash -c 'cat decoy && false'") check "pre-bash wraps the command" "ok" "ok" ;;
  *) check "pre-bash wraps the command" "ok" "$wrapped" ;;
esac

check "pre-bash returns no permissionDecision" "null" "$(prebash '{"tool_input":{"command":"ls"}}' | jq -r '.hookSpecificOutput.permissionDecision')"

printf 'db.password=%s\n' "$current" > "$work/decoy.txt"
observed="$(bash -c "$(prebash "$(jq -nc --arg f "$work/decoy.txt" '{tool_input:{command:("cat " + $f + " && false")}}')" | jq -r '.hookSpecificOutput.updatedInput.command')" 2>&1)"
check "wrapped command masks a failing command's output" "no" "$(leaks "$observed")"
check "wrapped command keeps the exit status" "7" "$(bash -c "$(prebash '{"tool_input":{"command":"exit 7"}}' | jq -r '.hookSpecificOutput.updatedInput.command')" >/dev/null 2>&1; echo $?)"
check "already wrapped command is left alone" "" "$(prebash "$(jq -nc --arg w "$wrapped" '{tool_input:{command:$w}}')")"
check "pre-bash denies when the list is unreadable" "deny" "$(prebash '{"tool_input":{"command":"ls"}}' "$work/missing.txt" | jq -r '.hookSpecificOutput.permissionDecision // ""')"
check "pre-bash denies on an empty list" "deny" "$(prebash '{"tool_input":{"command":"ls"}}' "$work/empty.txt" | jq -r '.hookSpecificOutput.permissionDecision // ""')"

# --- argument errors ---------------------------------------------------------

"$sumi" hook --agent copilot post-tool --secrets-file "$work/secrets.txt" </dev/null >/dev/null 2>&1
check "unsupported --agent exits 2" "2" "$?"
"$sumi" hook post-tool --secrets-file "$work/secrets.txt" </dev/null >/dev/null 2>&1
check "missing --agent exits 2" "2" "$?"

printf '\npassed %d, failed %d\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
```

- [ ] **Step 2: 実行可能にして走らせる**

```bash
chmod +x contrib/sumi/tests/run-tests.sh
cd contrib/sumi && zig build && ./tests/run-tests.sh
```

Expected: 全項目 `ok`、末尾に `passed 38, failed 0`。落ちた項目があれば該当 Task のコードを直し、直した Task のコミットとは別に `fix(sumi): ...` でコミットする。

- [ ] **Step 3: Commit**

```bash
git add contrib/sumi/tests/run-tests.sh
git commit -F- <<'EOF'
test(sumi): add black-box tests for the three hooks

Drives the built binary with the JSON each Claude Code hook event delivers and
checks the decision it returns, using decoy values only. Covers replacement
and pass-through for PostToolUse, report-only for PostToolUseFailure, every
@-attachment case the prompt hook distinguishes, the pre-bash rewrite
including running the rewritten command, and the exit-2 argument errors.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 9: Nix package と CI

**Files:**
- Modify: `flake.nix` (`maskFilter` の直後に `sumi` を足し、`packages` に登録)
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: flake.nix に sumi derivation を足す**

`maskFilter = pkgs.stdenv.mkDerivation { ... };` の直後に追加:

```nix
        # 単一の静的バイナリとして配る。Zig が musl を同梱しているので、
        # nix-bundle-elf で glibc を束ねる必要が無い。テストは実行ファイルの
        # ターゲットとは別にホスト向けにビルドされる (build.zig を参照)。
        sumi = pkgs.stdenv.mkDerivation {
          pname = "sumi";
          version = self.shortRev or self.dirtyShortRev or "dirty";
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [
              ./contrib/sumi
              ./src/mask-filter
              ./src/zig
            ];
          };
          sourceRoot = "source/contrib/sumi";
          nativeBuildInputs = [ zig ];
          dontConfigure = true;
          dontFixup = true;
          doCheck = true;
          buildPhase = ''
            export HOME=$TMPDIR
            zig build \
              --global-cache-dir "$TMPDIR/zig-cache" \
              -Dtarget=${pkgs.stdenv.hostPlatform.parsed.cpu.name}-linux-musl \
              -Doptimize=ReleaseSafe \
              -Dstrip=true \
              -Dversion=${self.shortRev or self.dirtyShortRev or "dirty"}
          '';
          checkPhase = ''
            export HOME=$TMPDIR
            zig build test --global-cache-dir "$TMPDIR/zig-cache"
          '';
          installPhase = ''
            mkdir -p $out/bin
            cp zig-out/bin/sumi $out/bin/
          '';
        };
```

`packages = { ... mask-filter = maskFilter; };` に `sumi = sumi;` を足す。

- [ ] **Step 2: ビルドして静的リンクを確認する**

```bash
cd /home/cq2n-iwym/repo/nix-agent-sandbox && nix build .#sumi --print-build-logs 2>&1 | tail -5 && ldd result/bin/sumi; result/bin/sumi --version; ls -la result/bin/sumi
```

Expected: `not a dynamic executable`、`sumi <rev または dirty>`。サンドボックス内で `nix build` がネットワークを要求して失敗する場合は `hostexec nix build .#sumi` を試し、それも通らなければ「未確認」として ledger に記録する (Task 2 Step 7 の `zig build -Dtarget=...` で静的リンク自体は確認済み)。

- [ ] **Step 3: ci.yml に Zig テストと黒箱テストを足す**

`Hostexec Zig tests` の step の直後に追加:

```yaml
      - name: sumi Zig tests
        run: nix develop -c bash -lc 'cd contrib/sumi && zig build test'

      - name: sumi black-box tests
        run: nix develop -c bash -lc 'cd contrib/sumi && zig build && ./tests/run-tests.sh'
```

devShell に `zig` が入っていることを確認する (`flake.nix` の `devShells.default.packages` に `zig` があるか grep)。無ければ足す。

- [ ] **Step 4: Commit**

```bash
git add flake.nix .github/workflows/ci.yml
git commit -F- <<'EOF'
build(sumi): package as a static musl binary and test it in CI

The derivation cross-compiles for <cpu>-linux-musl so the output has no glibc
dependency and can be downloaded as a single file. The CPU comes from the host
platform rather than `native`, which would bake the build machine's CPU
extensions into a binary meant for other machines. Unit tests still run,
because build.zig compiles them for the host regardless of the target.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 10: Release workflow

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: build job に sumi を足す**

`Build maskfs bundled binary` の step の直後:

```yaml
      - name: Build sumi static binary
        run: nix build .#sumi --out-link result-sumi --print-build-logs
```

`Prepare artifacts` の run に追加:

```yaml
          cp -L result-sumi/bin/sumi sumi-${{ matrix.system }}
          chmod 755 sumi-${{ matrix.system }}
```

`upload-artifact` の `path` に `sumi-${{ matrix.system }}` を足す。

`release` job の `gh release create` の引数に次を足す:

```
            "sumi-x86_64-linux" \
            "sumi-aarch64-linux"
```

- [ ] **Step 2: YAML を検証する**

```bash
cd /home/cq2n-iwym/repo/nix-agent-sandbox && nix develop -c bun -e 'const y=require("yaml"); y.parse(require("fs").readFileSync(".github/workflows/release.yml","utf8")); console.log("ok")' 2>/dev/null || python3 -c 'import yaml,sys; yaml.safe_load(open(".github/workflows/release.yml")); print("ok")'
```

Expected: `ok`。

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -F- <<'EOF'
ci(release): attach sumi-<system> binaries to GitHub releases

The asset name carries no tag so that
releases/latest/download/sumi-<system> stays a stable URL for the one-line
install. The existing nas and maskfs tarballs keep their tagged names.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 11: README

**Files:**
- Create: `contrib/sumi/README.md`

- [ ] **Step 1: README を書く**

spec の内容を利用者向けに並べ直す。章立てと各章に書くことを固定する:

1. **見出しと 1 段落の説明**: 何をするか (列挙した値を Claude Code に見せない)、`db.password=Tr0ub4dor` → `*********` の例。
2. **インストール**: spec「利用時の動作」の curl / install / init のブロックをそのまま。aarch64 は `sumi-aarch64-linux`。secrets ファイルの形式 (1 行 1 値、4 バイト以上、UTF-8、1024 件以下、0600)。
3. **塞ぐ経路**: spec の表と図をそのまま。
4. **CLI**: spec の CLI ブロックとオプションの意味の箇条書き。
5. **守らないもの**: spec「守らないもの」の箇条書きをそのまま。末尾に運用前提の段落。
6. **固める構成**: 
   ```bash
   sudo install -d -o root -g root -m 0755 /opt/sumi
   sudo install -o root -g root -m 0755 ~/.local/bin/sumi /opt/sumi/sumi
   sudo install -o root -g root -m 0640 ~/.claude/sumi/secrets.txt /opt/sumi/secrets.txt
   sudo chgrp "$(id -gn)" /opt/sumi/secrets.txt
   sudo install -d -o root -g root -m 0755 /etc/claude-code
   sudo /opt/sumi/sumi init --agent claude --secrets-file /opt/sumi/secrets.txt --settings /etc/claude-code/managed-settings.json
   ```
   と、管理者設定は下位から上書きされないこと、`--bare` は禁止できないこと。
7. **hook を外す**: PreToolUse の entry だけを削る手順と、その代償 (失敗コマンドの出力が素通る)、再 init で戻ること。
8. **更新が必要になるとき**: ローテーション・履歴書き換え時に secrets ファイルへ足すこと。バイナリを動かしたら init を再実行すること。
9. **実測**: 次の表を「未確認」の状態で置く (Task 12 で埋める):

   | 確認したこと | 結果 |
   | --- | --- |
   | `Read` の出力 | |
   | `Grep` の content 出力 | |
   | `cat path` | |
   | `git show HEAD:path` | |
   | `cat path && false` (失敗) | |
   | `@path` の添付 | |
   | hook 無しでの `@` 添付 | |
   | UserPromptSubmit のペイロードに添付内容が入らないこと | |
   | `--add-dir` 越しの `@` 添付 | |
   | 権限プロンプトが従来どおり出ること | |
   | Bash の allow ルールがラッパーに対して照合されること | |
   | トランスクリプト (`~/.claude/projects/**/*.jsonl`) に平文が無いこと | |

10. **テスト**: `cd contrib/sumi && zig build test && zig build && ./tests/run-tests.sh`。
11. **必要なもの**: Linux、Claude Code 2.1.266 以降 (`updatedToolOutput` と `PostToolUseFailure`)、`bash`。ビルドするなら Zig 0.15。

例に使う名前は `config/app.properties`、`db.password`、値は `Tr0ub4dor` に統一する。

- [ ] **Step 2: 文章の確認**

```bash
grep -n "TODO\|TBD" contrib/sumi/README.md; wc -l contrib/sumi/README.md
```

Expected: TODO なし。

- [ ] **Step 3: Commit**

```bash
git add contrib/sumi/README.md
git commit -F- <<'EOF'
docs(sumi): add the user guide

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 12: Claude Code に対する実測

**Files:**
- Modify: `contrib/sumi/README.md` (実測表を埋める)

この Task はホスト上の Claude Code (2.1.266 以降) を人間が操作して行う。サンドボックス内からは実行できないので、実装者はユーザーに手順を渡し、結果を受け取って README に転記する。

- [ ] **Step 1: 手順を用意する**

```bash
# 捨てリポジトリ
export T=$(mktemp -d) && cd $T && git init -q
mkdir config && printf 'db.host=localhost\ndb.password=Tr0ub4dor\n' > config/app.properties
git add -A && git commit -qm init
printf 'db.host=localhost\ndb.password=rotated-value-1\n' > config/app.properties && git commit -qam rotate
printf 'Tr0ub4dor\nrotated-value-1\n' > $T/secrets.txt && chmod 600 $T/secrets.txt
sumi init --agent claude --secrets-file $T/secrets.txt --settings $T/settings.json
# 以降 claude --settings $T/settings.json で起動し、表の各行を 1 つずつ試す。
```

各行で聞くこと:
- `Read config/app.properties` を実行させる → 値が `*` か。
- `Grep -n password config/app.properties` の content 出力 → 値が `*` か。
- `cat config/app.properties`、`git show HEAD~1:config/app.properties`、`cat config/app.properties && false` → いずれも `*` か。
- `@config/app.properties` を添付 → 拒否されるか。settings を外して同じことをすると平文が届くか。
- `claude --add-dir /somewhere` で別ディレクトリのファイルを `@` 添付 → 拒否されるか (`--root` 無し)、`--root` を init に渡して再 init すると通るか。
- 権限プロンプトが Bash 実行時に従来どおり出るか。`Bash(cat:*)` の allow を置いてもラッパーには効かないか。
- 終了後 `grep -r Tr0ub4dor ~/.claude/projects/` が 0 件か。

- [ ] **Step 2: README の実測表を結果で埋め、Claude Code のバージョンを書く**

- [ ] **Step 3: Commit**

```bash
git add contrib/sumi/README.md
git commit -F- <<'EOF'
docs(sumi): record the measured behaviour against Claude Code

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

## Self-Review (plan 作成時に実施済み)

- **Spec coverage**: 利用時の動作 (Task 2, 7, 11)、塞ぐ経路と 3 hook (Task 4, 5, 6)、守らないもの (Task 11)、CLI とオプション (Task 2, 4, 5, 6, 7)、init の 9 手順 (Task 7)、終了コードの規約 (Task 2, 4, 5, 6)、内部構造と共有コード (Task 1, 2)、JSON の扱い (Task 3)、配布 Nix / Release (Task 9, 10)、nas 側の変更 (Task 1)、検証と受け入れ条件 (Task 8, 9, 12)。
- **Placeholder scan**: README (Task 11) は章ごとに書く内容を固定した。Task 12 は人間の操作が要るので手順と転記先を固定した。
- **Type consistency**: `main.findOption` / `main.EXIT_USAGE` / `main.PROG` / `main.MARKER_ENV` を Task 4〜7 が `cli.` 経由で参照。`jsonio.getObject` は `?*std.json.ObjectMap` を返し、Task 4 と 7 でそのまま `put` / `get` している。`supervise.runLocal` の 6 引数目 `LocalOptions` は Task 1 と Task 2 で一致。`Decision` の `deinit` は Task 5 内で閉じている。
