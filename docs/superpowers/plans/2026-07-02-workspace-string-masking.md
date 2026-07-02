# ワークスペース文字列マスク (maskfs) 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ワークスペース内の秘密文字列を、コンテナ内の AI agent からどのファイルアクセス経路でも同一長の `*` として見せる FUSE フィルタ (maskfs) を実装する。

**Architecture:** ホスト側で動く Zig 製 FUSE パススルー FS がワークスペース実体のマスク済みビューを `$RUNTIME/nas/maskfs/sessions/<sessionId>/mnt` に提供し、Docker はそのマウントポイントをバインドする。パイプラインには MountStage 直前に MaskFsStage を挿入し、`WorkspaceState.maskedRoot` 経由で MountStage のバインドソースを差し替える。

**Tech Stack:** Zig + libfuse3 (デーモン)、Bun/TypeScript + Effect (パイプライン)、Pkl (設定)、Nix flake (パッケージング)。

**Spec:** `docs/superpowers/specs/2026-07-02-workspace-string-masking-design.md`

## Global Constraints

- **同一長マスク**: マッチした各バイトを `*` (0x2A) に置換。ファイルサイズ不変。
- **フェイルクローズ**: 秘密値の解決失敗・デーモン起動失敗・mount ready タイムアウトはセッション起動を中止。素のバインドマウントへのフォールバック禁止。
- **秘密値ソースは `env:` / `file:` / `dotenv:` / `keyring:` のみ**(リテラル禁止)。既存 `resolveSecret` (`src/hostexec/secret_store.ts`) を流用。
- **解決後の値が 4 文字 (UTF-8 バイト) 未満ならエラー**。
- **秘密値のデーモンへの受け渡しは stdin** (u32le count, その後 [u32le len + bytes] × count のフレーミング)。argv・一時ファイル禁止。
- **writePolicy**: `"readonly"` (デフォルト。秘密値含有ファイルへの書き込み系操作を EROFS で拒否) / `"passthrough"` (無加工)。
- `mask.values` が空/未設定なら maskfs は完全に不使用(既存挙動に影響ゼロ)。
- テスト: `bun test src/` は Docker 不要。FUSE 実マウントが要るテストは環境検出で skip する。
- コミットメッセージ末尾: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- 型チェック: `bun run check` が全タスク完了時に通ること。

---

### Task 1: 設定スキーマ — MaskConfig (types.ts / Schema.pkl / validate.ts)

**Files:**
- Modify: `src/config/types.ts` (Profile に `mask?` を追加、~line 200-217)
- Modify: `src/config/Schema.pkl` (Profile class ~line 52-82 と新 class 追加)
- Modify: `src/config/validate.ts` (`validateProfile` ~line 53-107 に mask 検証を追加)
- Test: `src/config/validate_mask_test.ts` (新規)

**Interfaces:**
- Consumes: 既存 `Profile`, `validateConfig` (`src/config/validate.ts:26`)
- Produces: `MaskValueConfig { source: string }`, `MaskWritePolicy = "readonly" | "passthrough"`, `MaskConfig { values: MaskValueConfig[]; writePolicy: MaskWritePolicy }`, `Profile.mask?: MaskConfig` — 後続タスクはこの型名を使う。

- [ ] **Step 1: 失敗するテストを書く**

`src/config/validate_mask_test.ts` を新規作成:

```ts
import { describe, expect, test } from "bun:test";
import type { Config, Profile } from "./types.ts";
import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_DOCKER_CONFIG,
  DEFAULT_GCLOUD_CONFIG,
  DEFAULT_AWS_CONFIG,
  DEFAULT_GPG_CONFIG,
  DEFAULT_HOOK_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_NIX_CONFIG,
  DEFAULT_OBSERVABILITY_CONFIG,
  DEFAULT_SESSION_CONFIG,
  DEFAULT_UI_CONFIG,
} from "./types.ts";
import { ConfigValidationError, validateConfig } from "./validate.ts";

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    agent: "claude",
    agentArgs: [],
    session: DEFAULT_SESSION_CONFIG,
    nix: DEFAULT_NIX_CONFIG,
    docker: DEFAULT_DOCKER_CONFIG,
    gcloud: DEFAULT_GCLOUD_CONFIG,
    aws: DEFAULT_AWS_CONFIG,
    gpg: DEFAULT_GPG_CONFIG,
    network: DEFAULT_NETWORK_CONFIG,
    dbus: DEFAULT_DBUS_CONFIG,
    display: DEFAULT_DISPLAY_CONFIG,
    extraMounts: [],
    env: [],
    hook: DEFAULT_HOOK_CONFIG,
    ...overrides,
  };
}

function makeConfig(profile: Profile): Config {
  return {
    ui: DEFAULT_UI_CONFIG,
    observability: DEFAULT_OBSERVABILITY_CONFIG,
    profiles: { main: profile },
  };
}

describe("validateConfig: mask", () => {
  test("accepts valid mask config", () => {
    const config = makeConfig(
      makeProfile({
        mask: {
          values: [{ source: "env:MY_SECRET" }, { source: "dotenv:.env#KEY" }],
          writePolicy: "readonly",
        },
      }),
    );
    expect(() => validateConfig(config)).not.toThrow();
  });

  test("rejects unsupported source scheme", () => {
    const config = makeConfig(
      makeProfile({
        mask: {
          values: [{ source: "literal:passw0rd" }],
          writePolicy: "readonly",
        },
      }),
    );
    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow(/mask\.values\[0\]\.source/);
  });

  test("rejects empty source", () => {
    const config = makeConfig(
      makeProfile({
        mask: { values: [{ source: "" }], writePolicy: "passthrough" },
      }),
    );
    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
  });

  test("mask omitted is fine", () => {
    const config = makeConfig(makeProfile());
    expect(() => validateConfig(config)).not.toThrow();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `bun test src/config/validate_mask_test.ts`
Expected: FAIL — `Profile` に `mask` が無い型エラー、または validate が source を検証せず "rejects unsupported source scheme" が落ちる。

- [ ] **Step 3: types.ts に型を追加**

`src/config/types.ts` の `/** プロファイル */` の直前 (line ~198) に追加:

```ts
/** ワークスペース文字列マスク設定 */
export interface MaskValueConfig {
  source: string;
}

export type MaskWritePolicy = "readonly" | "passthrough";

export interface MaskConfig {
  values: MaskValueConfig[];
  writePolicy: MaskWritePolicy;
}
```

`Profile` interface の `hostexec?: HostExecConfig;` の下に追加:

```ts
  mask?: MaskConfig;
```

- [ ] **Step 4: Schema.pkl にクラスを追加**

`src/config/Schema.pkl` の `class Profile` 内、`hostexec: HostExecConfig? = null` (line 81) の下に追加:

```pkl
  /// ワークスペース文字列マスク。`null` で無効。
  mask: MaskConfig? = null
```

同ファイルの `// HostExec` セクション (line ~315) の直前に新セクションを追加:

```pkl
// ---------------------------------------------------------------------------
// Mask (workspace string masking)
// ---------------------------------------------------------------------------

/// マスク対象の秘密値の取得元。
/// 対応形式: `env:VAR` / `file:/path` / `dotenv:/path#KEY` / `keyring:service/account`
/// リテラル値は意図的に非対応 (config.pkl が git にコミットされると履歴経由で漏れるため)。
class MaskValueConfig {
  source: String
}

class MaskConfig {
  /// マスク対象の秘密値のリスト。空なら maskfs は起動しない。
  values: Listing<MaskValueConfig> = new {}

  /// 秘密値を含むファイルへの書き込みの扱い。
  /// `"readonly"`: write/truncate/unlink/rename を EROFS で拒否 (ホストの実体を保護)
  /// `"passthrough"`: 無加工で通す (agent が読んだ *** をそのまま書き戻すと実体が壊れるリスクを許容)
  writePolicy: ("readonly"|"passthrough") = "readonly"
}
```

- [ ] **Step 5: validate.ts に検証を追加**

`src/config/validate.ts` の `validateProfile` 内、`// --- hostexec ---` ブロックの後 (line ~104, `return errors;` の前) に追加:

```ts
  // --- mask ---
  if (profile.mask) {
    errors.push(...validateMaskValues(name, profile.mask.values));
  }
```

ファイル末尾に追加:

```ts
// ---------------------------------------------------------------------------
// Mask values validation
// ---------------------------------------------------------------------------

const MASK_SOURCE_PREFIXES = ["env:", "file:", "dotenv:", "keyring:"];

function validateMaskValues(
  profileName: string,
  values: { source: string }[],
): string[] {
  const errors: string[] = [];
  for (const [i, value] of values.entries()) {
    const source = value.source;
    if (typeof source !== "string" || source.trim() === "") {
      errors.push(
        `profile "${profileName}": mask.values[${i}].source must be a non-empty string`,
      );
      continue;
    }
    if (!MASK_SOURCE_PREFIXES.some((p) => source.startsWith(p))) {
      errors.push(
        `profile "${profileName}": mask.values[${i}].source ("${source}") must start with one of ${MASK_SOURCE_PREFIXES.join(", ")} (literal values are not supported)`,
      );
    }
  }
  return errors;
}
```

- [ ] **Step 6: テストが通ることを確認**

Run: `bun test src/config/ && bun run check`
Expected: PASS (既存の validate_test.ts / repo_pkl_test.ts / pkl_integration_test.ts も含めすべて green)

- [ ] **Step 7: Commit**

```bash
git add src/config/types.ts src/config/Schema.pkl src/config/validate.ts src/config/validate_mask_test.ts
git commit -m "feat(config): add mask config for workspace string masking

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Zig マスキングコア (mask.zig)

**Files:**
- Create: `src/maskfs/mask.zig`
- Create: `src/maskfs/build.zig` (この時点では test ステップのみ)

**Interfaces:**
- Produces (Task 3 が利用):
  - `pub fn maskAll(buf: []u8, secrets: []const []const u8) void` — in-place 置換
  - `pub fn maxSecretLen(secrets: []const []const u8) usize`
  - `pub const Window = struct { start: u64, lead: usize, len: usize }`
  - `pub fn computeWindow(offset: u64, size: usize, max_len: usize) Window`
  - `pub fn containsAny(haystack: []const u8, secrets: []const []const u8) bool`

注意: Zig の文法・calling convention は既存 `src/hostexec/intercept/hostexec_intercept.zig` と同じ Zig バージョン (flake.nix の pkgs.zig) に合わせること。ビルドは devShell 内で `cd src/maskfs && zig build test` で確認する。

- [ ] **Step 1: mask.zig をテスト込みで書く**

`src/maskfs/mask.zig`:

```zig
//! maskfs の純粋ロジック: バイト列置換とウィンドウ計算。
//! FUSE に依存しないため zig build test で単体テストできる。

const std = @import("std");

/// buf 内の各 secret の全出現をバイトごとに '*' へ置換する (in-place)。
pub fn maskAll(buf: []u8, secrets: []const []const u8) void {
    for (secrets) |secret| {
        if (secret.len == 0) continue;
        var i: usize = 0;
        while (i + secret.len <= buf.len) {
            if (std.mem.eql(u8, buf[i .. i + secret.len], secret)) {
                @memset(buf[i .. i + secret.len], '*');
                i += secret.len;
            } else {
                i += 1;
            }
        }
    }
}

pub fn maxSecretLen(secrets: []const []const u8) usize {
    var max: usize = 0;
    for (secrets) |s| {
        if (s.len > max) max = s.len;
    }
    return max;
}

/// pread(offset, size) 要求に対し、境界を跨ぐマッチも捕捉できるよう
/// 前後 max_len-1 バイト拡張した読み取りウィンドウを返す。
/// lead = 拡張ウィンドウ先頭から要求 offset までのバイト数。
pub const Window = struct { start: u64, lead: usize, len: usize };

pub fn computeWindow(offset: u64, size: usize, max_len: usize) Window {
    const pad: u64 = if (max_len == 0) 0 else max_len - 1;
    const start = if (offset >= pad) offset - pad else 0;
    const lead: usize = @intCast(offset - start);
    return .{ .start = start, .lead = lead, .len = lead + size + @as(usize, @intCast(pad)) };
}

pub fn containsAny(haystack: []const u8, secrets: []const []const u8) bool {
    for (secrets) |secret| {
        if (secret.len == 0) continue;
        if (std.mem.indexOf(u8, haystack, secret) != null) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

test "maskAll replaces single occurrence with same length" {
    var buf = "DB_PASSWORD=hunter2secret\n".*;
    maskAll(&buf, &.{"hunter2secret"});
    try std.testing.expectEqualStrings("DB_PASSWORD=*************\n", &buf);
}

test "maskAll replaces multiple secrets and occurrences" {
    var buf = "a=tok1 b=tok22 c=tok1".*;
    maskAll(&buf, &.{ "tok1", "tok22" });
    try std.testing.expectEqualStrings("a=**** b=***** c=****", &buf);
}

test "maskAll handles overlapping candidates without panic" {
    var buf = "aaaa".*;
    maskAll(&buf, &.{"aaa"});
    // 先頭の1マッチを置換後、残り "a" はマッチしない
    try std.testing.expectEqualStrings("***a", &buf);
}

test "maskAll on binary bytes" {
    var buf = [_]u8{ 0x00, 's', 'e', 'c', 0xff };
    maskAll(&buf, &.{"sec"});
    try std.testing.expectEqualSlices(u8, &[_]u8{ 0x00, '*', '*', '*', 0xff }, &buf);
}

test "computeWindow at file head" {
    const w = computeWindow(0, 10, 5);
    try std.testing.expectEqual(@as(u64, 0), w.start);
    try std.testing.expectEqual(@as(usize, 0), w.lead);
    try std.testing.expectEqual(@as(usize, 14), w.len);
}

test "computeWindow mid-file" {
    const w = computeWindow(100, 10, 5);
    try std.testing.expectEqual(@as(u64, 96), w.start);
    try std.testing.expectEqual(@as(usize, 4), w.lead);
    try std.testing.expectEqual(@as(usize, 18), w.len);
}

test "chunk-boundary straddling match is masked" {
    // secret "SECRET" が offset 4..10 に跨る。要求は offset=6, size=4。
    const data = "abcdSECRETwxyz";
    const secrets = [_][]const u8{"SECRET"};
    const w = computeWindow(6, 4, maxSecretLen(&secrets));
    var window_buf: [64]u8 = undefined;
    const end = @min(data.len, @as(usize, @intCast(w.start)) + w.len);
    const got = data[@intCast(w.start)..end];
    @memcpy(window_buf[0..got.len], got);
    maskAll(window_buf[0..got.len], &secrets);
    // 中央スライス = 要求範囲 (offset 6..10 = "CRET" → "****")
    try std.testing.expectEqualStrings("****", window_buf[w.lead .. w.lead + 4]);
}

test "containsAny" {
    try std.testing.expect(containsAny("xx hunter2 yy", &.{"hunter2"}));
    try std.testing.expect(!containsAny("nothing here", &.{"hunter2"}));
}
```

- [ ] **Step 2: build.zig を書く (test ステップのみ)**

`src/maskfs/build.zig`:

```zig
const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const host_target = b.resolveTargetQuery(.{});

    // ── unit tests (mask.zig は FUSE 非依存) ──
    const mask_test_mod = b.createModule(.{
        .root_source_file = b.path("mask.zig"),
        .target = host_target,
        .optimize = optimize,
    });
    const mask_tests = b.addTest(.{ .root_module = mask_test_mod });
    const run_mask_tests = b.addRunArtifact(mask_tests);
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_mask_tests.step);

    _ = target; // Task 3 で executable に使用
}
```

- [ ] **Step 3: テストが通ることを確認**

Run: `cd src/maskfs && zig build test --summary all`
Expected: 全テスト PASS。コンパイルエラーが出たら flake.nix の pkgs.zig のバージョンの文法に合わせて修正 (`@intCast`/`@min` 等は 0.11+ 形式で書いてある)。

- [ ] **Step 4: Commit**

```bash
git add src/maskfs/mask.zig src/maskfs/build.zig
git commit -m "feat(maskfs): add Zig masking core (same-length replace + read window)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Zig FUSE デーモン (maskfs.zig)

**Files:**
- Create: `src/maskfs/maskfs.zig`
- Modify: `src/maskfs/build.zig` (executable 追加)

**Interfaces:**
- Produces: 実行バイナリ `nas-maskfs`。CLI 契約 (Task 6 の MaskFsService が利用):
  - `nas-maskfs <sourceDir> <mountpoint> --write-policy=readonly|passthrough [--allow-other]`
  - stdin: u32le count, その後 count 個の [u32le len + bytes]
  - foreground で動作 (`-f`)。シングルスレッド (`-s`)。終了時は外部から `fusermount3 -u <mountpoint>`。

前提: devShell に fuse3 と pkg-config が必要 (Task 4 で flake に入れるが、このタスクの動作確認にも必要なので、先に flake.nix の `devShells.default.packages` へ `pkgs.fuse3` と `pkgs.pkg-config` を追加して `nix develop` に入り直してよい)。

- [ ] **Step 1: maskfs.zig を書く**

`src/maskfs/maskfs.zig`:

```zig
//! nas-maskfs — ワークスペースのマスク済みビューを提供する FUSE パススルー FS。
//!
//! 使い方: nas-maskfs <sourceDir> <mountpoint> --write-policy=readonly|passthrough [--allow-other]
//! 秘密値は stdin から読む: u32le count, その後 count 個の [u32le len + bytes]。
//! foreground (-f) / single-thread (-s) で fuse_main を実行する。

const std = @import("std");
const mask = @import("mask.zig");

const c = @cImport({
    @cDefine("FUSE_USE_VERSION", "31");
    @cDefine("_FILE_OFFSET_BITS", "64");
    @cInclude("fuse3/fuse.h");
    @cInclude("fcntl.h");
    @cInclude("unistd.h");
    @cInclude("sys/stat.h");
    @cInclude("sys/statvfs.h");
    @cInclude("dirent.h");
    @cInclude("errno.h");
});

const WritePolicy = enum { readonly, passthrough };

// ---------------------------------------------------------------------------
// グローバル状態 (シングルスレッド前提: -s で mount する)
// ---------------------------------------------------------------------------

var gpa = std.heap.GeneralPurposeAllocator(.{}){};
const allocator = gpa.allocator();

var src_fd: c_int = -1;
var secrets: [][]u8 = &.{};
var max_len: usize = 0;
var write_policy: WritePolicy = .readonly;

// 秘密値含有判定キャッシュ (direct-mapped)
const CacheEntry = struct {
    ino: u64 = 0,
    mtime_sec: i64 = 0,
    mtime_nsec: i64 = 0,
    size: i64 = 0,
    valid: bool = false,
    contains: bool = false,
};
var scan_cache: [128]CacheEntry = [_]CacheEntry{.{}} ** 128;

fn errnoNeg() c_int {
    return -std.c._errno().*;
}

/// FUSE のパスは "/" 始まり。openat 用に相対化する。
fn relPath(path: [*c]const u8) [*c]const u8 {
    if (path[0] == '/' and path[1] != 0) return path + 1;
    if (path[0] == '/' and path[1] == 0) return ".";
    return path;
}

// ---------------------------------------------------------------------------
// 秘密値含有スキャン (write-policy=readonly 用)
// ---------------------------------------------------------------------------

fn fdContainsSecret(fd: c_int) bool {
    if (max_len == 0) return false;
    const carry = max_len - 1;
    const chunk = 64 * 1024;
    const buf = allocator.alloc(u8, carry + chunk) catch return true; // fail-closed
    defer allocator.free(buf);

    var filled: usize = 0; // buf 先頭に保持している carry バイト数
    var pos: i64 = 0;
    while (true) {
        const n = c.pread(fd, buf.ptr + filled, chunk, pos);
        if (n < 0) return true; // fail-closed
        if (n == 0) break;
        const got: usize = @intCast(n);
        if (mask.containsAny(buf[0 .. filled + got], secrets)) return true;
        pos += n;
        // 末尾 carry バイトを次のチャンクの先頭に引き継ぐ
        const total = filled + got;
        const keep = @min(carry, total);
        std.mem.copyForwards(u8, buf[0..keep], buf[total - keep .. total]);
        filled = keep;
    }
    return false;
}

/// path (source 相対) のファイルが秘密値を含むか。stat 失敗時 ENOENT は false、
/// それ以外・open 失敗は fail-closed で true。
fn pathContainsSecret(rel: [*c]const u8) bool {
    var st: c.struct_stat = undefined;
    if (c.fstatat(src_fd, rel, &st, c.AT_SYMLINK_NOFOLLOW) == -1) {
        return std.c._errno().* != c.ENOENT;
    }
    // 通常ファイル以外 (dir/symlink/fifo...) はスキャン対象外
    if ((st.st_mode & c.S_IFMT) != c.S_IFREG) return false;

    const slot = &scan_cache[@intCast(st.st_ino % scan_cache.len)];
    if (slot.valid and slot.ino == st.st_ino and
        slot.mtime_sec == st.st_mtim.tv_sec and
        slot.mtime_nsec == st.st_mtim.tv_nsec and
        slot.size == st.st_size)
    {
        return slot.contains;
    }

    const fd = c.openat(src_fd, rel, c.O_RDONLY);
    if (fd == -1) return true; // fail-closed
    defer _ = c.close(fd);
    const contains = fdContainsSecret(fd);

    slot.* = .{
        .ino = st.st_ino,
        .mtime_sec = st.st_mtim.tv_sec,
        .mtime_nsec = st.st_mtim.tv_nsec,
        .size = st.st_size,
        .valid = true,
        .contains = contains,
    };
    return contains;
}

/// readonly ポリシーで書き込み系操作を拒否すべきなら EROFS (負値) を返す。
fn denyIfProtected(rel: [*c]const u8) c_int {
    if (write_policy == .passthrough) return 0;
    if (pathContainsSecret(rel)) return -c.EROFS;
    return 0;
}

// ---------------------------------------------------------------------------
// FUSE operations
// ---------------------------------------------------------------------------

fn xGetattr(path: [*c]const u8, st: ?*c.struct_stat, fi: ?*c.fuse_file_info) callconv(.c) c_int {
    _ = fi;
    if (c.fstatat(src_fd, relPath(path), st, c.AT_SYMLINK_NOFOLLOW) == -1) return errnoNeg();
    return 0;
}

fn xReadlink(path: [*c]const u8, buf: [*c]u8, size: usize) callconv(.c) c_int {
    const n = c.readlinkat(src_fd, relPath(path), buf, size - 1);
    if (n == -1) return errnoNeg();
    buf[@intCast(n)] = 0;
    return 0;
}

fn xReaddir(
    path: [*c]const u8,
    buf: ?*anyopaque,
    filler: c.fuse_fill_dir_t,
    offset: c.off_t,
    fi: ?*c.fuse_file_info,
    flags: c.fuse_readdir_flags,
) callconv(.c) c_int {
    _ = offset;
    _ = fi;
    _ = flags;
    const dfd = c.openat(src_fd, relPath(path), c.O_RDONLY | c.O_DIRECTORY);
    if (dfd == -1) return errnoNeg();
    const dir = c.fdopendir(dfd) orelse {
        _ = c.close(dfd);
        return errnoNeg();
    };
    defer _ = c.closedir(dir);
    while (true) {
        const ent = c.readdir(dir) orelse break;
        if (filler.?(buf, &ent.*.d_name, null, 0, 0) != 0) break;
    }
    return 0;
}

fn xOpen(path: [*c]const u8, fi: ?*c.fuse_file_info) callconv(.c) c_int {
    const rel = relPath(path);
    const accmode = fi.?.flags & c.O_ACCMODE;
    const wants_write = accmode != c.O_RDONLY or (fi.?.flags & c.O_TRUNC) != 0;
    if (wants_write) {
        const deny = denyIfProtected(rel);
        if (deny != 0) return deny;
    }
    const fd = c.openat(src_fd, rel, fi.?.flags);
    if (fd == -1) return errnoNeg();
    fi.?.fh = @intCast(fd);
    return 0;
}

fn xCreate(path: [*c]const u8, mode: c.mode_t, fi: ?*c.fuse_file_info) callconv(.c) c_int {
    // 新規作成は秘密値を含み得ないので両ポリシーで許可
    const fd = c.openat(src_fd, relPath(path), fi.?.flags, mode);
    if (fd == -1) return errnoNeg();
    fi.?.fh = @intCast(fd);
    return 0;
}

fn xRead(
    path: [*c]const u8,
    buf: [*c]u8,
    size: usize,
    offset: c.off_t,
    fi: ?*c.fuse_file_info,
) callconv(.c) c_int {
    _ = path;
    const fd: c_int = @intCast(fi.?.fh);
    if (max_len == 0) {
        const n = c.pread(fd, buf, size, offset);
        if (n == -1) return errnoNeg();
        return @intCast(n);
    }
    const win = mask.computeWindow(@intCast(offset), size, max_len);
    const wbuf = allocator.alloc(u8, win.len) catch return -c.ENOMEM;
    defer allocator.free(wbuf);
    const n = c.pread(fd, wbuf.ptr, win.len, @intCast(win.start));
    if (n == -1) return errnoNeg();
    const got: usize = @intCast(n);
    mask.maskAll(wbuf[0..got], secrets);
    if (got <= win.lead) return 0;
    const out_len = @min(got - win.lead, size);
    @memcpy(buf[0..out_len], wbuf[win.lead .. win.lead + out_len]);
    return @intCast(out_len);
}

fn xWrite(
    path: [*c]const u8,
    buf: [*c]const u8,
    size: usize,
    offset: c.off_t,
    fi: ?*c.fuse_file_info,
) callconv(.c) c_int {
    _ = path; // open/create 時点でポリシー適用済み
    const fd: c_int = @intCast(fi.?.fh);
    const n = c.pwrite(fd, buf, size, offset);
    if (n == -1) return errnoNeg();
    return @intCast(n);
}

fn xTruncate(path: [*c]const u8, size: c.off_t, fi: ?*c.fuse_file_info) callconv(.c) c_int {
    const rel = relPath(path);
    const deny = denyIfProtected(rel);
    if (deny != 0) return deny;
    if (fi != null) {
        if (c.ftruncate(@intCast(fi.?.fh), size) == -1) return errnoNeg();
        return 0;
    }
    const fd = c.openat(src_fd, rel, c.O_WRONLY);
    if (fd == -1) return errnoNeg();
    defer _ = c.close(fd);
    if (c.ftruncate(fd, size) == -1) return errnoNeg();
    return 0;
}

fn xUnlink(path: [*c]const u8) callconv(.c) c_int {
    const rel = relPath(path);
    const deny = denyIfProtected(rel);
    if (deny != 0) return deny;
    if (c.unlinkat(src_fd, rel, 0) == -1) return errnoNeg();
    return 0;
}

fn xRename(from: [*c]const u8, to: [*c]const u8, flags: c_uint) callconv(.c) c_int {
    if (flags != 0) return -c.EINVAL;
    const rel_from = relPath(from);
    const rel_to = relPath(to);
    var deny = denyIfProtected(rel_from);
    if (deny != 0) return deny;
    deny = denyIfProtected(rel_to); // 上書きされる側も保護
    if (deny != 0) return deny;
    if (c.renameat(src_fd, rel_from, src_fd, rel_to) == -1) return errnoNeg();
    return 0;
}

fn xMkdir(path: [*c]const u8, mode: c.mode_t) callconv(.c) c_int {
    if (c.mkdirat(src_fd, relPath(path), mode) == -1) return errnoNeg();
    return 0;
}

fn xRmdir(path: [*c]const u8) callconv(.c) c_int {
    if (c.unlinkat(src_fd, relPath(path), c.AT_REMOVEDIR) == -1) return errnoNeg();
    return 0;
}

fn xSymlink(target: [*c]const u8, linkpath: [*c]const u8) callconv(.c) c_int {
    if (c.symlinkat(target, src_fd, relPath(linkpath)) == -1) return errnoNeg();
    return 0;
}

fn xLink(from: [*c]const u8, to: [*c]const u8) callconv(.c) c_int {
    if (c.linkat(src_fd, relPath(from), src_fd, relPath(to), 0) == -1) return errnoNeg();
    return 0;
}

fn xChmod(path: [*c]const u8, mode: c.mode_t, fi: ?*c.fuse_file_info) callconv(.c) c_int {
    _ = fi;
    if (c.fchmodat(src_fd, relPath(path), mode, 0) == -1) return errnoNeg();
    return 0;
}

fn xChown(path: [*c]const u8, uid: c.uid_t, gid: c.gid_t, fi: ?*c.fuse_file_info) callconv(.c) c_int {
    _ = fi;
    if (c.fchownat(src_fd, relPath(path), uid, gid, c.AT_SYMLINK_NOFOLLOW) == -1) return errnoNeg();
    return 0;
}

fn xUtimens(path: [*c]const u8, tv: [*c]const c.struct_timespec, fi: ?*c.fuse_file_info) callconv(.c) c_int {
    _ = fi;
    if (c.utimensat(src_fd, relPath(path), tv, c.AT_SYMLINK_NOFOLLOW) == -1) return errnoNeg();
    return 0;
}

fn xStatfs(path: [*c]const u8, st: ?*c.struct_statvfs) callconv(.c) c_int {
    _ = path;
    if (c.fstatvfs(src_fd, st) == -1) return errnoNeg();
    return 0;
}

fn xRelease(path: [*c]const u8, fi: ?*c.fuse_file_info) callconv(.c) c_int {
    _ = path;
    _ = c.close(@intCast(fi.?.fh));
    return 0;
}

fn xFsync(path: [*c]const u8, datasync: c_int, fi: ?*c.fuse_file_info) callconv(.c) c_int {
    _ = path;
    const fd: c_int = @intCast(fi.?.fh);
    const res = if (datasync != 0) c.fdatasync(fd) else c.fsync(fd);
    if (res == -1) return errnoNeg();
    return 0;
}

// ---------------------------------------------------------------------------
// stdin フレーミング: u32le count, then count × [u32le len + bytes]
// ---------------------------------------------------------------------------

fn readSecretsFromStdin() ![][]u8 {
    const stdin = std.io.getStdIn().reader();
    const count = try stdin.readInt(u32, .little);
    if (count > 1024) return error.TooManySecrets;
    const list = try allocator.alloc([]u8, count);
    var i: usize = 0;
    while (i < count) : (i += 1) {
        const len = try stdin.readInt(u32, .little);
        if (len == 0 or len > 16 * 1024 * 1024) return error.InvalidSecretLength;
        const s = try allocator.alloc(u8, len);
        try stdin.readNoEof(s);
        list[i] = s;
    }
    return list;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

pub fn main() !u8 {
    const argv = std.os.argv;
    if (argv.len < 4) {
        std.debug.print("usage: nas-maskfs <sourceDir> <mountpoint> --write-policy=readonly|passthrough [--allow-other]\n", .{});
        return 2;
    }
    const source = argv[1];
    const mountpoint = argv[2];
    var allow_other = false;
    for (argv[3..]) |arg| {
        const a = std.mem.span(arg);
        if (std.mem.eql(u8, a, "--write-policy=readonly")) {
            write_policy = .readonly;
        } else if (std.mem.eql(u8, a, "--write-policy=passthrough")) {
            write_policy = .passthrough;
        } else if (std.mem.eql(u8, a, "--allow-other")) {
            allow_other = true;
        } else {
            std.debug.print("unknown argument: {s}\n", .{a});
            return 2;
        }
    }

    secrets = try readSecretsFromStdin();
    max_len = mask.maxSecretLen(secrets);
    if (secrets.len == 0) {
        std.debug.print("nas-maskfs: refusing to start with zero secrets\n", .{});
        return 2;
    }

    src_fd = c.open(source, c.O_RDONLY | c.O_DIRECTORY);
    if (src_fd == -1) {
        std.debug.print("nas-maskfs: cannot open source dir\n", .{});
        return 1;
    }

    var ops = std.mem.zeroes(c.struct_fuse_operations);
    ops.getattr = xGetattr;
    ops.readlink = xReadlink;
    ops.mkdir = xMkdir;
    ops.unlink = xUnlink;
    ops.rmdir = xRmdir;
    ops.symlink = xSymlink;
    ops.rename = xRename;
    ops.link = xLink;
    ops.chmod = xChmod;
    ops.chown = xChown;
    ops.truncate = xTruncate;
    ops.open = xOpen;
    ops.read = xRead;
    ops.write = xWrite;
    ops.statfs = xStatfs;
    ops.release = xRelease;
    ops.fsync = xFsync;
    ops.readdir = xReaddir;
    ops.create = xCreate;
    ops.utimens = xUtimens;

    // fuse_main 引数: foreground + single-thread + permissions
    var fuse_args = std.ArrayList([*c]const u8).init(allocator);
    defer fuse_args.deinit();
    try fuse_args.append("nas-maskfs");
    try fuse_args.append(mountpoint);
    try fuse_args.append("-f");
    try fuse_args.append("-s");
    try fuse_args.append("-o");
    try fuse_args.append(if (allow_other) "default_permissions,allow_other" else "default_permissions");

    const rc = c.fuse_main_real(
        @intCast(fuse_args.items.len),
        @constCast(@ptrCast(fuse_args.items.ptr)),
        &ops,
        @sizeOf(c.struct_fuse_operations),
        null,
    );
    return @intCast(rc);
}
```

- [ ] **Step 2: build.zig に executable を追加**

`src/maskfs/build.zig` の `_ = target;` 行を削除し、test ステップの前に追加:

```zig
    // ── nas-maskfs executable ──
    const exe_mod = b.createModule(.{
        .root_source_file = b.path("maskfs.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    const exe = b.addExecutable(.{
        .name = "nas-maskfs",
        .root_module = exe_mod,
    });
    exe.linkSystemLibrary("fuse3");
    b.installArtifact(exe);
```

- [ ] **Step 3: コンパイルを通す**

Run: `cd src/maskfs && zig build --summary all`
Expected: `zig-out/bin/nas-maskfs` が生成される。translate-c の型ずれ (enum/int の cast、`fuse_fill_dir_t` の nullability、`std.io.getStdIn` の API 差分など) が出た場合はシグネチャを `zig-out` のエラーメッセージに合わせて修正する。**ロジック (window/mask/policy) は変更しないこと。**

- [ ] **Step 4: 手動スモークテスト (FUSE が使えるホストで)**

```bash
cd /tmp && mkdir -p mfs-src mfs-mnt
printf 'DB_PASSWORD=hunter2secret\n' > mfs-src/secret.env
printf 'hello world\n' > mfs-src/plain.txt
# stdin フレーム: count=1, len=13, "hunter2secret"
python3 -c "import sys,struct; sys.stdout.buffer.write(struct.pack('<I',1)+struct.pack('<I',13)+b'hunter2secret')" > /tmp/frame.bin
~/repo/nix-agent-sandbox/src/maskfs/zig-out/bin/nas-maskfs /tmp/mfs-src /tmp/mfs-mnt --write-policy=readonly < /tmp/frame.bin &
sleep 1
cat /tmp/mfs-mnt/secret.env      # → DB_PASSWORD=*************
cat /tmp/mfs-mnt/plain.txt       # → hello world
grep -c '\*\*\*' /tmp/mfs-mnt/secret.env   # → 1
sh -c 'echo x >> /tmp/mfs-mnt/secret.env' && echo WRITE_OK || echo WRITE_DENIED   # → WRITE_DENIED
sh -c 'echo x >> /tmp/mfs-mnt/plain.txt' && echo WRITE_OK                          # → WRITE_OK
cat /tmp/mfs-src/secret.env      # → 実体は無傷: DB_PASSWORD=hunter2secret
fusermount3 -u /tmp/mfs-mnt
```

Expected: 上記コメントどおりの出力。

- [ ] **Step 5: zig build test が引き続き通ることを確認**

Run: `cd src/maskfs && zig build test --summary all`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/maskfs/maskfs.zig src/maskfs/build.zig
git commit -m "feat(maskfs): add FUSE passthrough daemon with masked reads and write policy

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Nix パッケージング + バイナリパス解決 (maskfs_path.ts)

**Files:**
- Modify: `flake.nix` (maskfs derivation 追加 ~line 64-105、devShell ~line 167-177)
- Create: `src/stages/maskfs/maskfs_path.ts`
- Test: `src/stages/maskfs/maskfs_path_test.ts`

**Interfaces:**
- Consumes: `resolveAsset` (`src/lib/asset.ts`)
- Produces: `resolveMaskFsBinPath(opts?: { assetDir?: string }): Promise<string | null>` — Task 7 の stage が利用。

- [ ] **Step 1: flake.nix に maskfs derivation を追加**

`hostexecIntercept` の定義 (line 64-86) の直後に追加:

```nix
        maskfs = pkgs.stdenv.mkDerivation {
          pname = "nas-maskfs";
          version = "0.1.0";
          src = ./src/maskfs;
          nativeBuildInputs = [ pkgs.zig pkgs.pkg-config ];
          buildInputs = [ pkgs.fuse3 ];
          dontConfigure = true;
          doCheck = true;
          buildPhase = ''
            export HOME=$TMPDIR
            zig build \
              --global-cache-dir "$TMPDIR/zig-cache" \
              -Doptimize=ReleaseSafe
          '';
          checkPhase = ''
            export HOME=$TMPDIR
            zig build test --global-cache-dir "$TMPDIR/zig-cache"
          '';
          installPhase = ''
            mkdir -p $out/bin
            cp zig-out/bin/nas-maskfs $out/bin/
          '';
        };
```

`nasAssets` (line 90-105) の mkdir 行に ` $out/maskfs` を追加し、コピー行を追加:

```nix
          cp ${maskfs}/bin/nas-maskfs $out/maskfs/
```

`devShells.default` の packages (line 168-177) に `pkgs.fuse3` と `pkgs.pkg-config` を追加。

- [ ] **Step 2: Nix ビルドが通ることを確認**

Run: `nix build .#default 2>&1 | tail -5 && ls result/share/nas/assets/maskfs/`
Expected: `nas-maskfs` が assets に含まれる。zig の linkSystemLibrary が fuse3 を見つけられない場合は pkg-config が nativeBuildInputs にあるか確認。

- [ ] **Step 3: 失敗するテストを書く**

`src/stages/maskfs/maskfs_path_test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { resolveMaskFsBinPath } from "./maskfs_path.ts";

test("resolveMaskFsBinPath finds binary under assetDir", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-maskfs-path-"));
  try {
    await mkdir(path.join(dir, "maskfs"), { recursive: true });
    await writeFile(path.join(dir, "maskfs", "nas-maskfs"), "");
    const resolved = await resolveMaskFsBinPath({ assetDir: dir });
    expect(resolved).toEqual(path.join(dir, "maskfs", "nas-maskfs"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveMaskFsBinPath returns null when missing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-maskfs-path-"));
  try {
    const resolved = await resolveMaskFsBinPath({ assetDir: dir });
    expect(resolved).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

Run: `bun test src/stages/maskfs/maskfs_path_test.ts`
Expected: FAIL (module not found)

- [ ] **Step 4: maskfs_path.ts を実装**

`src/stages/maskfs/maskfs_path.ts` (`src/hostexec/intercept_path.ts` と同型):

```ts
import * as path from "node:path";
import { resolveAsset } from "../../lib/asset.ts";

/**
 * Resolve the host-side absolute path to the nas-maskfs binary.
 *
 * Returns the path if the file exists, or `null` if it cannot be found
 * (e.g. `cd src/maskfs && zig build` has not been run in dev).
 */
export async function resolveMaskFsBinPath(opts?: {
  assetDir?: string;
}): Promise<string | null> {
  const resolved = opts?.assetDir
    ? path.join(opts.assetDir, "maskfs/nas-maskfs")
    : resolveAsset(
        "maskfs/nas-maskfs",
        import.meta.url,
        "../../maskfs/zig-out/bin/nas-maskfs",
      );

  if (await Bun.file(resolved).exists()) {
    return resolved;
  }
  return null;
}
```

注: `resolveAsset` の第3引数 (dev fallback) の相対基準は `src/hostexec/intercept_path.ts:26` と同じ規約に従うこと。`src/lib/asset.ts` を読んで確認し、`src/stages/maskfs/` からの相対で `../../maskfs/zig-out/bin/nas-maskfs` が正しいか検証する。

- [ ] **Step 5: テストが通ることを確認**

Run: `bun test src/stages/maskfs/maskfs_path_test.ts && bun run check`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add flake.nix src/stages/maskfs/maskfs_path.ts src/stages/maskfs/maskfs_path_test.ts
git commit -m "feat(maskfs): package nas-maskfs via nix and add binary path resolver

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: ProcessService に stdinData を追加 + フレームエンコーダ

**Files:**
- Modify: `src/services/process.ts` (spawn opts、line 28-32 / 52-65 / 149-154)
- Create: `src/stages/maskfs/secrets_frame.ts`
- Test: `src/stages/maskfs/secrets_frame_test.ts`

**Interfaces:**
- Produces:
  - `ProcessService.spawn(command, args, opts?: { logFile?: string; env?: Record<string, string>; stdinData?: Uint8Array })` — stdinData 指定時は子プロセスの stdin にバイト列を渡して閉じる。
  - `encodeMaskSecrets(secrets: readonly string[]): Uint8Array` — Task 6/統合テストが利用。デーモンの stdin フレーミング (Task 3) と対。

- [ ] **Step 1: 失敗するテストを書く**

`src/stages/maskfs/secrets_frame_test.ts`:

```ts
import { expect, test } from "bun:test";
import { encodeMaskSecrets } from "./secrets_frame.ts";

test("encodeMaskSecrets frames count and length-prefixed values", () => {
  const frame = encodeMaskSecrets(["ab", "xyz"]);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  expect(view.getUint32(0, true)).toEqual(2);
  expect(view.getUint32(4, true)).toEqual(2);
  expect(new TextDecoder().decode(frame.slice(8, 10))).toEqual("ab");
  expect(view.getUint32(10, true)).toEqual(3);
  expect(new TextDecoder().decode(frame.slice(14, 17))).toEqual("xyz");
  expect(frame.byteLength).toEqual(4 + 4 + 2 + 4 + 3);
});

test("encodeMaskSecrets handles multibyte utf-8", () => {
  const frame = encodeMaskSecrets(["ぱす"]);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  expect(view.getUint32(0, true)).toEqual(1);
  expect(view.getUint32(4, true)).toEqual(6); // 3 bytes × 2 chars
});
```

Run: `bun test src/stages/maskfs/secrets_frame_test.ts`
Expected: FAIL (module not found)

- [ ] **Step 2: secrets_frame.ts を実装**

`src/stages/maskfs/secrets_frame.ts`:

```ts
/**
 * nas-maskfs デーモンの stdin フレーミング (maskfs.zig readSecretsFromStdin と対):
 * u32le count, その後 count 個の [u32le byteLen + utf8 bytes]。
 */
export function encodeMaskSecrets(secrets: readonly string[]): Uint8Array {
  const enc = new TextEncoder();
  const encoded = secrets.map((s) => enc.encode(s));
  let total = 4;
  for (const e of encoded) total += 4 + e.byteLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, encoded.length, true);
  let pos = 4;
  for (const e of encoded) {
    view.setUint32(pos, e.byteLength, true);
    pos += 4;
    out.set(e, pos);
    pos += e.byteLength;
  }
  return out;
}
```

- [ ] **Step 3: ProcessService に stdinData を追加**

`src/services/process.ts`:

spawn のシグネチャ (line 28-32) と FakeConfig (line 150-154) の opts 型を両方変更:

```ts
      opts?: {
        logFile?: string;
        env?: Record<string, string>;
        stdinData?: Uint8Array;
      },
```

Live 実装 (line 61-65) の `Bun.spawn` 呼び出しを変更:

```ts
        const child = Bun.spawn([command, ...args], {
          stdin: opts?.stdinData,
          stdout: logFd !== null ? logFd : "pipe",
          stderr: logFd !== null ? logFd : "pipe",
          env: opts?.env ? { ...process.env, ...opts.env } : undefined,
        });
```

(Bun.spawn は `stdin` に TypedArray を受け取り、書き込み後に閉じる。`stdinData` 未指定時は `undefined` で従来挙動。)

- [ ] **Step 4: テストが通ることを確認**

Run: `bun test src/stages/maskfs/secrets_frame_test.ts && bun test src/services/ && bun run check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/process.ts src/stages/maskfs/secrets_frame.ts src/stages/maskfs/secrets_frame_test.ts
git commit -m "feat(maskfs): add stdinData spawn option and secrets frame encoder

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: MaskFsService (デーモンライフサイクル管理)

**Files:**
- Create: `src/stages/maskfs/maskfs_service.ts`
- Test: `src/stages/maskfs/maskfs_service_test.ts`

**Interfaces:**
- Consumes: `FsService` (`src/services/fs.ts`), `ProcessService` (Task 5 の stdinData 付き)
- Produces (Task 7 の stage が利用):

```ts
export interface MaskFsStartPlan {
  readonly binaryPath: string;
  readonly sourceDir: string;
  readonly mountpoint: string;
  readonly writePolicy: "readonly" | "passthrough";
  readonly secretsFrame: Uint8Array;
  readonly logFile: string;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
}
export interface MaskFsHandle { readonly kill: () => void; }
export class MaskFsService // Context.Tag "nas/MaskFsService"
// { startMaskFs: (plan: MaskFsStartPlan) => Effect<MaskFsHandle, unknown, Scope.Scope> }
export function makeMaskFsServiceFake(overrides?): Layer.Layer<MaskFsService>
```

パターンは `src/stages/dbus_proxy/dbus_proxy_service.ts` に忠実に従う。

- [ ] **Step 1: 失敗するテストを書く**

`src/stages/maskfs/maskfs_service_test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Effect, Exit, Layer } from "effect";
import { makeFsServiceFake } from "../../services/fs.ts";
import { makeProcessServiceFake } from "../../services/process.ts";
import {
  MaskFsService,
  MaskFsServiceLive,
  type MaskFsStartPlan,
} from "./maskfs_service.ts";

function makePlan(overrides: Partial<MaskFsStartPlan> = {}): MaskFsStartPlan {
  return {
    binaryPath: "/opt/nas/maskfs/nas-maskfs",
    sourceDir: "/repo",
    mountpoint: "/run/user/1000/nas/maskfs/sessions/s1/mnt",
    writePolicy: "readonly",
    secretsFrame: new Uint8Array([1, 0, 0, 0, 4, 0, 0, 0, 116, 101, 115, 116]),
    logFile: "/run/user/1000/nas/maskfs/sessions/s1/maskfs.log",
    timeoutMs: 100,
    pollIntervalMs: 10,
  };
}

describe("MaskFsService", () => {
  test("spawns daemon with source, mountpoint, policy and stdin frame", async () => {
    const spawned: { command: string; args: string[]; stdinData?: Uint8Array }[] = [];
    const procFake = makeProcessServiceFake({
      spawn: (command, args, opts) =>
        Effect.sync(() => {
          spawned.push({ command, args, stdinData: opts?.stdinData });
          return { kill: () => {}, exited: Effect.succeed(0), pid: 1 };
        }),
    });
    const layer = MaskFsServiceLive.pipe(
      Layer.provide(Layer.merge(makeFsServiceFake(), procFake)),
    );
    const plan = makePlan();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* MaskFsService;
          yield* svc.startMaskFs(plan, { waitReady: () => Effect.void });
        }),
      ).pipe(Effect.provide(layer)),
    );

    expect(spawned.length).toEqual(1);
    expect(spawned[0].command).toEqual(plan.binaryPath);
    expect(spawned[0].args).toEqual([
      "/repo",
      plan.mountpoint,
      "--write-policy=readonly",
      "--allow-other",
    ]);
    expect(spawned[0].stdinData).toEqual(plan.secretsFrame);
  });

  test("fails when readiness never arrives (fail-closed)", async () => {
    const layer = MaskFsServiceLive.pipe(
      Layer.provide(
        Layer.merge(makeFsServiceFake(), makeProcessServiceFake()),
      ),
    );
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* MaskFsService;
          yield* svc.startMaskFs(makePlan(), {
            waitReady: () => Effect.fail(new Error("timeout")),
          });
        }),
      ).pipe(Effect.provide(layer)),
    );
    expect(Exit.isFailure(exit)).toEqual(true);
  });
});
```

注: `makeFsServiceFake` の正確な名前・シグネチャは `src/services/fs.ts` を読んで合わせること (mkdir を持つ fake があるはず)。無ければ dbus_proxy のテスト (`src/stages/dbus_proxy/stage_test.ts`) が使っている fake 構成をそのまま流用する。

Run: `bun test src/stages/maskfs/maskfs_service_test.ts`
Expected: FAIL (module not found)

- [ ] **Step 2: maskfs_service.ts を実装**

`src/stages/maskfs/maskfs_service.ts`:

```ts
/**
 * MaskFsService — nas-maskfs デーモンのライフサイクル管理。
 *
 * 責務: マウントポイント作成 → preflight (fusermount3 / user_allow_other) →
 * デーモン spawn (秘密値は stdin) → mount ready 待機 → Scope 終了時に
 * fusermount3 -u + SIGTERM。
 *
 * Live は FsService + ProcessService に委譲する (dbus_proxy_service.ts と同型)。
 */

import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { Context, Effect, Layer, type Scope } from "effect";
import { FsService } from "../../services/fs.ts";
import { ProcessService } from "../../services/process.ts";

export interface MaskFsStartPlan {
  readonly binaryPath: string;
  readonly sourceDir: string;
  readonly mountpoint: string;
  readonly writePolicy: "readonly" | "passthrough";
  readonly secretsFrame: Uint8Array;
  readonly logFile: string;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
}

export interface MaskFsHandle {
  readonly kill: () => void;
}

/** テストから readiness 判定を差し替えるためのオプション */
export interface MaskFsStartOptions {
  readonly waitReady?: (plan: MaskFsStartPlan) => Effect.Effect<void, unknown>;
}

export class MaskFsService extends Context.Tag("nas/MaskFsService")<
  MaskFsService,
  {
    readonly startMaskFs: (
      plan: MaskFsStartPlan,
      options?: MaskFsStartOptions,
    ) => Effect.Effect<MaskFsHandle, unknown, Scope.Scope>;
  }
>() {}

// ---------------------------------------------------------------------------
// Preflight helpers
// ---------------------------------------------------------------------------

async function assertFusermountAvailable(): Promise<string> {
  const found = Bun.which("fusermount3");
  if (!found) {
    throw new Error(
      "[nas] mask: fusermount3 not found on PATH. Install fuse3 (NixOS: environment.systemPackages = [ pkgs.fuse3 ])",
    );
  }
  return found;
}

async function assertAllowOtherPermitted(): Promise<void> {
  if (typeof process.getuid === "function" && process.getuid() === 0) return;
  let text = "";
  try {
    text = await readFile("/etc/fuse.conf", "utf8");
  } catch {
    // missing fuse.conf → user_allow_other 無効扱い
  }
  const ok = text
    .split("\n")
    .some((line) => line.trim() === "user_allow_other");
  if (!ok) {
    throw new Error(
      "[nas] mask: FUSE allow_other requires 'user_allow_other' in /etc/fuse.conf " +
        "(NixOS: programs.fuse.userAllowOther = true)",
    );
  }
}

/** mountpoint の st_dev が親ディレクトリと異なれば FUSE マウント完了 */
async function isMounted(mountpoint: string): Promise<boolean> {
  try {
    const [self, parent] = await Promise.all([
      stat(mountpoint),
      stat(path.dirname(mountpoint)),
    ]);
    return self.dev !== parent.dev;
  } catch {
    return false;
  }
}

function defaultWaitReady(
  plan: MaskFsStartPlan,
): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: async () => {
      const deadline = Date.now() + plan.timeoutMs;
      while (Date.now() < deadline) {
        if (await isMounted(plan.mountpoint)) return;
        await new Promise((r) => setTimeout(r, plan.pollIntervalMs));
      }
      let logTail = "";
      try {
        logTail = (await readFile(plan.logFile, "utf8")).slice(-2000);
      } catch {
        // no log
      }
      throw new Error(
        `[nas] mask: maskfs mount did not become ready within ${plan.timeoutMs}ms at ${plan.mountpoint}\n${logTail}`,
      );
    },
    catch: (e) => e,
  });
}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const MaskFsServiceLive: Layer.Layer<
  MaskFsService,
  never,
  FsService | ProcessService
> = Layer.effect(
  MaskFsService,
  Effect.gen(function* () {
    const fs = yield* FsService;
    const proc = yield* ProcessService;

    return MaskFsService.of({
      startMaskFs: (plan, options) =>
        Effect.gen(function* () {
          yield* fs.mkdir(path.dirname(plan.mountpoint), {
            recursive: true,
            mode: 0o700,
          });
          yield* fs.mkdir(plan.mountpoint, { recursive: true, mode: 0o700 });

          yield* Effect.tryPromise({
            try: async () => {
              await assertFusermountAvailable();
              await assertAllowOtherPermitted();
            },
            catch: (e) => e,
          });

          const spawnHandle = yield* Effect.acquireRelease(
            proc.spawn(
              plan.binaryPath,
              [
                plan.sourceDir,
                plan.mountpoint,
                `--write-policy=${plan.writePolicy}`,
                "--allow-other",
              ],
              {
                logFile: plan.logFile,
                stdinData: plan.secretsFrame,
              },
            ),
            (handle) =>
              proc
                .exec(["fusermount3", "-u", plan.mountpoint])
                .pipe(
                  Effect.catchAll(() => Effect.void),
                  Effect.andThen(Effect.sync(() => handle.kill())),
                ),
          );

          const waitReady = options?.waitReady ?? defaultWaitReady;
          yield* waitReady(plan);

          return {
            kill: () => spawnHandle.kill(),
          } satisfies MaskFsHandle;
        }),
    });
  }),
);

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface MaskFsServiceFakeConfig {
  readonly startMaskFs?: (
    plan: MaskFsStartPlan,
    options?: MaskFsStartOptions,
  ) => Effect.Effect<MaskFsHandle, unknown, Scope.Scope>;
}

const defaultHandle: MaskFsHandle = { kill: () => {} };

export function makeMaskFsServiceFake(
  overrides: MaskFsServiceFakeConfig = {},
): Layer.Layer<MaskFsService> {
  return Layer.succeed(
    MaskFsService,
    MaskFsService.of({
      startMaskFs:
        overrides.startMaskFs ?? (() => Effect.succeed(defaultHandle)),
    }),
  );
}
```

注: preflight (fusermount3 / fuse.conf) は Live の spawn 前に走るため、fake の ProcessService を使う単体テストでも実行される。テスト環境に fusermount3 が無いと 1 つ目のテストが落ちる — その場合は preflight を `plan` に `skipPreflight?: boolean` を足すのではなく、**テスト側で** `startMaskFs` に渡す前に `Bun.which("fusermount3")` を確認して `test.skipIf` でガードするか、preflight を `MaskFsStartOptions.preflight?: () => Promise<void>` として注入可能にする (推奨: options に `preflight` を追加し、テストでは `async () => {}` を渡す)。実装時にテストが通る方を選び、選んだ方に合わせてテストを更新すること。

- [ ] **Step 3: テストが通ることを確認**

Run: `bun test src/stages/maskfs/maskfs_service_test.ts && bun run check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/stages/maskfs/maskfs_service.ts src/stages/maskfs/maskfs_service_test.ts
git commit -m "feat(maskfs): add MaskFsService for daemon lifecycle with scoped cleanup

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: MaskFsStage + WorkspaceState.maskedRoot + StageServices 登録

**Files:**
- Modify: `src/pipeline/state.ts` (`WorkspaceState` line 16-20)
- Modify: `src/pipeline/types.ts` (`StageServices` union line 77-97)
- Create: `src/stages/maskfs/stage.ts`
- Create: `src/stages/maskfs.ts` (barrel、`src/stages/dbus_proxy.ts` と同型)
- Test: `src/stages/maskfs/stage_test.ts`

**Interfaces:**
- Consumes: `MaskFsService` (Task 6)、`resolveSecret`/`SecretStore` (`src/hostexec/secret_store.ts:63`)、`encodeMaskSecrets` (Task 5)、`resolveMaskFsBinPath` (Task 4)、`MountProbes` (`src/stages/mount/mount_probes.ts`)
- Produces:
  - `WorkspaceState.maskedRoot?: string` (Task 8 の MountStage が利用)
  - `createMaskFsStage(shared: StageInput, mountProbes: MountProbes): Stage<"workspace", { workspace: WorkspaceState }, MaskFsService, unknown>`
  - `resolveMaskFsRuntimeDir(host: HostEnv): string`

- [ ] **Step 1: WorkspaceState に maskedRoot を追加**

`src/pipeline/state.ts` line 16-20:

```ts
/** Workspace paths resolved by the worktree stage. */
export interface WorkspaceState {
  readonly workDir: string;
  readonly mountDir?: string;
  readonly imageName: string;
  /** maskfs 有効時のみ: Docker バインドソースに使うマスク済みビューのルート */
  readonly maskedRoot?: string;
}
```

- [ ] **Step 2: StageServices union に MaskFsService を追加**

`src/pipeline/types.ts`: import を追加し union に足す:

```ts
import type { MaskFsService } from "../stages/maskfs.ts";
```

`StageServices` union (line 77-97) のアルファベット順の位置に `| MaskFsService` を追加。

- [ ] **Step 3: 失敗するテストを書く**

`src/stages/maskfs/stage_test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import type { MountProbes } from "../mount/mount_probes.ts";
import type { StageInput } from "../../pipeline/types.ts";
import type { WorkspaceState } from "../../pipeline/state.ts";
import { makeMaskFsServiceFake, type MaskFsStartPlan } from "./maskfs_service.ts";
import { createMaskFsStage, resolveMaskFsRuntimeDir } from "./stage.ts";

const HOST = {
  home: "/home/u",
  user: "u",
  uid: 1000,
  gid: 1000,
  isWSL: false,
  env: new Map([["XDG_RUNTIME_DIR", "/run/user/1000"]]),
} as const;

function makeStageInput(overrides: Partial<StageInput> = {}): StageInput {
  return {
    config: { ui: { enable: false, port: 0, idleTimeout: 0 }, observability: { enable: false, retention: null }, profiles: {} },
    profile: {
      agent: "claude",
      agentArgs: [],
      session: { multiplex: false, detachKey: "^\\" },
      nix: { enable: false, mountSocket: false, extraPackages: [] },
      docker: { enable: false, shared: false },
      gcloud: { mountConfig: false },
      aws: { mountConfig: false },
      gpg: { forwardAgent: false },
      network: { reviewRules: [], credentials: [], proxy: { forwardPorts: [] }, pendingTimeoutSeconds: 300, pendingDefaultScope: "host-port", pendingNotify: "off" },
      dbus: { session: { enable: false, see: [], talk: [], own: [], calls: [], broadcasts: [] } },
      display: { sandbox: "none", size: "1920x1080" },
      extraMounts: [],
      env: [],
      hook: { notify: "off" },
    },
    profileName: "test",
    sessionId: "sess_test1",
    host: HOST,
    probes: { hasHostNix: false, xdgDbusProxyPath: null, dbusSessionAddress: null, gpgAgentSocket: null, auditDir: "/tmp/audit" },
    ...overrides,
  } as StageInput;
}

const WORKSPACE: WorkspaceState = {
  workDir: "/repo/sub",
  mountDir: "/repo",
  imageName: "nas-img",
};

const MOUNT_PROBES = { gitWorktreeMainRoot: null } as unknown as MountProbes;

describe("resolveMaskFsRuntimeDir", () => {
  test("uses XDG_RUNTIME_DIR when set", () => {
    expect(resolveMaskFsRuntimeDir(HOST)).toEqual("/run/user/1000/nas/maskfs");
  });
});

describe("createMaskFsStage", () => {
  test("no mask config → workspace passthrough, no daemon start", async () => {
    let started = 0;
    const layer = makeMaskFsServiceFake({
      startMaskFs: () =>
        Effect.sync(() => {
          started += 1;
          return { kill: () => {} };
        }),
    });
    const stage = createMaskFsStage(makeStageInput(), MOUNT_PROBES);
    const result = await Effect.runPromise(
      Effect.scoped(stage.run({ workspace: WORKSPACE })).pipe(
        Effect.provide(layer),
      ),
    );
    expect(result.workspace.maskedRoot).toBeUndefined();
    expect(started).toEqual(0);
  });

  test("mask config → resolves secrets, starts daemon, sets maskedRoot", async () => {
    const plans: MaskFsStartPlan[] = [];
    const layer = makeMaskFsServiceFake({
      startMaskFs: (plan) =>
        Effect.sync(() => {
          plans.push(plan);
          return { kill: () => {} };
        }),
    });
    const input = makeStageInput();
    input.profile.mask = {
      values: [{ source: "env:NAS_TEST_MASK_SECRET" }],
      writePolicy: "readonly",
    };
    const hostEnv = new Map(HOST.env);
    hostEnv.set("NAS_TEST_MASK_SECRET", "hunter2secret");
    (input as { host: unknown }).host = { ...HOST, env: hostEnv };

    const stage = createMaskFsStage(input, MOUNT_PROBES, {
      resolveBinPath: async () => "/fake/nas-maskfs",
    });
    const result = await Effect.runPromise(
      Effect.scoped(stage.run({ workspace: WORKSPACE })).pipe(
        Effect.provide(layer),
      ),
    );

    expect(plans.length).toEqual(1);
    expect(plans[0].sourceDir).toEqual("/repo"); // mountDir が優先される
    expect(plans[0].writePolicy).toEqual("readonly");
    expect(result.workspace.maskedRoot).toEqual(
      "/run/user/1000/nas/maskfs/sessions/sess_test1/mnt",
    );
    // フレームに秘密値が入っている (先頭 count=1, len=13)
    const view = new DataView(plans[0].secretsFrame.buffer);
    expect(view.getUint32(0, true)).toEqual(1);
    expect(view.getUint32(4, true)).toEqual(13);
  });

  test("secret shorter than 4 bytes → fails (fail-closed)", async () => {
    const input = makeStageInput();
    input.profile.mask = {
      values: [{ source: "env:NAS_TEST_SHORT" }],
      writePolicy: "readonly",
    };
    const hostEnv = new Map(HOST.env);
    hostEnv.set("NAS_TEST_SHORT", "abc");
    (input as { host: unknown }).host = { ...HOST, env: hostEnv };

    const stage = createMaskFsStage(input, MOUNT_PROBES, {
      resolveBinPath: async () => "/fake/nas-maskfs",
    });
    await expect(
      Effect.runPromise(
        Effect.scoped(stage.run({ workspace: WORKSPACE })).pipe(
          Effect.provide(makeMaskFsServiceFake()),
        ),
      ),
    ).rejects.toThrow(/at least 4 bytes/);
  });

  test("unresolvable secret source → fails (fail-closed)", async () => {
    const input = makeStageInput();
    input.profile.mask = {
      values: [{ source: "env:NAS_TEST_DOES_NOT_EXIST" }],
      writePolicy: "readonly",
    };
    const stage = createMaskFsStage(input, MOUNT_PROBES, {
      resolveBinPath: async () => "/fake/nas-maskfs",
    });
    await expect(
      Effect.runPromise(
        Effect.scoped(stage.run({ workspace: WORKSPACE })).pipe(
          Effect.provide(makeMaskFsServiceFake()),
        ),
      ),
    ).rejects.toThrow();
  });
});
```

Run: `bun test src/stages/maskfs/stage_test.ts`
Expected: FAIL (module not found)

- [ ] **Step 4: stage.ts を実装**

`src/stages/maskfs/stage.ts`:

```ts
/**
 * MaskFs ステージ — mask 設定があるとき nas-maskfs デーモンを起動し、
 * WorkspaceState.maskedRoot にマスク済みビューのルートを記録する。
 * MountStage はこの値をバインドソースとして優先する。
 *
 * フェイルクローズ: 秘密値の解決失敗・値が短すぎる・バイナリ欠如・
 * mount ready タイムアウトはすべてステージ失敗 = セッション起動中止。
 */

import { Effect } from "effect";
import { SecretStore } from "../../hostexec/secret_store.ts";
import type { Stage } from "../../pipeline/stage_builder.ts";
import type { WorkspaceState } from "../../pipeline/state.ts";
import type { HostEnv, StageInput } from "../../pipeline/types.ts";
import type { MountProbes } from "../mount/mount_probes.ts";
import { resolveWorkspaceMountSource } from "../mount/stage.ts";
import { resolveMaskFsBinPath } from "./maskfs_path.ts";
import { MaskFsService } from "./maskfs_service.ts";
import { encodeMaskSecrets } from "./secrets_frame.ts";

const MOUNT_READY_TIMEOUT_MS = 10_000;
const MOUNT_READY_POLL_MS = 50;
const MIN_SECRET_BYTES = 4;

/** テスト用フック */
export interface MaskFsStageOptions {
  readonly resolveBinPath?: () => Promise<string | null>;
}

export function resolveMaskFsRuntimeDir(host: HostEnv): string {
  const xdg = host.env.get("XDG_RUNTIME_DIR");
  if (xdg && xdg.trim().length > 0) {
    return `${xdg}/nas/maskfs`;
  }
  const uid = host.uid ?? "unknown";
  return `/tmp/nas-${uid}/maskfs`;
}

export function createMaskFsStage(
  shared: StageInput,
  mountProbes: MountProbes,
  options: MaskFsStageOptions = {},
): Stage<"workspace", { workspace: WorkspaceState }, MaskFsService, unknown> {
  return {
    name: "MaskFsStage",
    needs: ["workspace"],

    run(input) {
      const mask = shared.profile.mask;
      if (!mask || mask.values.length === 0) {
        return Effect.succeed({ workspace: input.workspace });
      }

      return Effect.gen(function* () {
        const maskFs = yield* MaskFsService;

        // --- 秘密値の解決 (fail-closed: 全値 required) ---
        const secrets = yield* Effect.tryPromise({
          try: () => resolveMaskSecrets(mask.values, shared.host),
          catch: (e) => e,
        });

        // --- バイナリパス ---
        const resolveBin = options.resolveBinPath ?? resolveMaskFsBinPath;
        const binaryPath = yield* Effect.tryPromise({
          try: () => resolveBin(),
          catch: (e) => e,
        });
        if (!binaryPath) {
          return yield* Effect.fail(
            new Error(
              "[nas] mask: nas-maskfs binary not found. Build it with `cd src/maskfs && zig build` (dev) or reinstall nas (nix).",
            ),
          );
        }

        const sourceDir = resolveWorkspaceMountSource(
          input.workspace,
          mountProbes,
        );
        const runtimeDir = resolveMaskFsRuntimeDir(shared.host);
        const sessionDir = `${runtimeDir}/sessions/${shared.sessionId}`;
        const mountpoint = `${sessionDir}/mnt`;

        yield* maskFs.startMaskFs({
          binaryPath,
          sourceDir,
          mountpoint,
          writePolicy: mask.writePolicy,
          secretsFrame: encodeMaskSecrets(secrets),
          logFile: `${sessionDir}/maskfs.log`,
          timeoutMs: MOUNT_READY_TIMEOUT_MS,
          pollIntervalMs: MOUNT_READY_POLL_MS,
        });

        return {
          workspace: { ...input.workspace, maskedRoot: mountpoint },
        };
      });
    },
  };
}

async function resolveMaskSecrets(
  values: { source: string }[],
  host: HostEnv,
): Promise<string[]> {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of host.env) env[k] = v;

  const store = new SecretStore(
    Object.fromEntries(
      values.map((v, i) => [String(i), { from: v.source, required: true }]),
    ),
    { env },
  );

  const secrets: string[] = [];
  for (const [i, value] of values.entries()) {
    let resolved: string;
    try {
      resolved = await store.require(String(i));
    } catch (e) {
      throw new Error(
        `[nas] mask: failed to resolve mask.values[${i}].source ("${value.source}"): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const bytes = new TextEncoder().encode(resolved);
    if (bytes.byteLength < MIN_SECRET_BYTES) {
      throw new Error(
        `[nas] mask: mask.values[${i}] resolved value must be at least 4 bytes (got ${bytes.byteLength}); short values would mass-mask unrelated content`,
      );
    }
    secrets.push(resolved);
  }
  return secrets;
}
```

- [ ] **Step 5: barrel を作る**

`src/stages/maskfs.ts` (既存 `src/stages/dbus_proxy.ts` の形式に合わせる):

```ts
export {
  createMaskFsStage,
  resolveMaskFsRuntimeDir,
  type MaskFsStageOptions,
} from "./maskfs/stage.ts";
export {
  makeMaskFsServiceFake,
  MaskFsService,
  MaskFsServiceLive,
  type MaskFsHandle,
  type MaskFsServiceFakeConfig,
  type MaskFsStartPlan,
} from "./maskfs/maskfs_service.ts";
```

- [ ] **Step 6: mount/stage.ts に resolveWorkspaceMountSource を export (先行して最小追加)**

このタスクのコンパイルを通すため、`src/stages/mount/stage.ts` に以下を追加 (planMount の書き換えは Task 8 で行う):

```ts
/**
 * MountStage がワークスペースのバインドソース/ターゲットに使う実パスを解決する。
 * MaskFsStage も同じパスをマスク対象のソースディレクトリとして使う。
 */
export function resolveWorkspaceMountSource(
  workspace: WorkspaceState,
  probes: MountProbes,
): string {
  const base = path.resolve(workspace.mountDir ?? workspace.workDir);
  return probes.gitWorktreeMainRoot ?? base;
}
```

- [ ] **Step 7: テストが通ることを確認**

Run: `bun test src/stages/maskfs/ && bun run check`
Expected: PASS。stage_test の `makeStageInput` の Profile/Config リテラルが型エラーになる場合は `src/config/types.ts` の実際の型に合わせて調整する (ロジックは変えない)。

- [ ] **Step 8: Commit**

```bash
git add src/pipeline/state.ts src/pipeline/types.ts src/stages/maskfs.ts src/stages/maskfs/stage.ts src/stages/maskfs/stage_test.ts src/stages/mount/stage.ts
git commit -m "feat(maskfs): add MaskFsStage resolving secrets and starting the daemon

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: MountStage のバインドソース差し替え

**Files:**
- Modify: `src/stages/mount/stage.ts` (`planMount` line 135-142)
- Test: `src/stages/mount/` 配下の既存 stage テストファイル (`stage_test.ts` があればそこへ追記、無ければ `src/stages/mount/mask_bind_test.ts` を新規作成)

**Interfaces:**
- Consumes: `WorkspaceState.maskedRoot` (Task 7)
- Produces: maskedRoot 設定時、workspace バインドマウントの source = maskedRoot / target = 実パス。

- [ ] **Step 1: 失敗するテストを書く**

既存の mount stage テスト (`ls src/stages/mount/*_test.ts` で確認) に `planMount` を直接呼ぶテストがあるはずなので、そのフィクスチャ(`MountStageInput` の組み立てヘルパ)を再利用して追加する。無い場合は以下を新規ファイルで書き、必要な input は既存テストからコピーして組み立てる:

```ts
test("planMount uses maskedRoot as bind source but real path as target", () => {
  const input = makeMountStageInput({
    workspace: {
      workDir: "/repo",
      imageName: "img",
      maskedRoot: "/run/user/1000/nas/maskfs/sessions/s1/mnt",
    },
  });
  const plan = planMount(input, makeMountProbes());
  const workspaceMount = plan.containerPatch.mounts?.find(
    (m) => m.target === "/repo",
  );
  expect(workspaceMount?.source).toEqual(
    "/run/user/1000/nas/maskfs/sessions/s1/mnt",
  );
  // docker -v 引数にも反映される
  expect(plan.dockerArgs.join(" ")).toContain(
    "-v /run/user/1000/nas/maskfs/sessions/s1/mnt:/repo",
  );
});

test("planMount without maskedRoot keeps source == target", () => {
  const input = makeMountStageInput({
    workspace: { workDir: "/repo", imageName: "img" },
  });
  const plan = planMount(input, makeMountProbes());
  const workspaceMount = plan.containerPatch.mounts?.find(
    (m) => m.target === "/repo",
  );
  expect(workspaceMount?.source).toEqual("/repo");
});
```

Run: `bun test src/stages/mount/`
Expected: 新テストが FAIL (source が実パスのまま)

- [ ] **Step 2: planMount を修正**

`src/stages/mount/stage.ts` line 135-142 を変更:

```ts
  // ワークスペースマウント
  // git worktree 内の場合は本体リポジトリルートをマウントソースに広げる
  // maskfs 有効時はバインドソースだけマスク済みビューに差し替える
  // (コンテナ内パスは実パスのまま維持する)
  const mountSource = resolveWorkspaceMountSource(workspace, probes);
  const bindSource = workspace.maskedRoot ?? mountSource;
  const containerWorkDir = path.resolve(workspace.workDir);
  addMount(args, mounts, bindSource, mountSource);
  args.push("-w", containerWorkDir);
  envVars.WORKSPACE = containerWorkDir;
```

(`baseMountSource` 変数は `resolveWorkspaceMountSource` に吸収されるので削除。)

続く `.nas/config.pkl` RO 保護ループ (line 150-154) は**変更しない**。ソースはホスト実パスのままで良い: mask.values はリテラル非対応のため config.pkl 自体に秘密値は含まれず、RO bind mount の改ざん防止機能を維持する方が重要。この判断をコメントで残す:

```ts
  // maskfs 有効時もソースは実パスのまま: config.pkl は mask.values に
  // リテラルを書けない設計のため秘密値を含まず、trust 済み実体を RO で
  // 見せることが改ざん防止として優先される。
```

- [ ] **Step 3: テストが通ることを確認**

Run: `bun test src/stages/mount/ && bun test src/ && bun run check`
Expected: PASS (mount の既存テストも green)

- [ ] **Step 4: Commit**

```bash
git add src/stages/mount/
git commit -m "feat(maskfs): bind masked workspace view when maskedRoot is set

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: cli.ts 配線 (パイプライン挿入 + Layer 提供)

**Files:**
- Modify: `src/cli.ts` (import 群 ~line 49-71、liveLayer ~line 309-334、pipeline ~line 409-434)

**Interfaces:**
- Consumes: `createMaskFsStage`, `MaskFsServiceLive` (Task 7 barrel)
- Produces: 実際のセッション起動で maskfs が動く。

- [ ] **Step 1: import を追加**

`src/cli.ts` の stages import 群に追加:

```ts
import { createMaskFsStage, MaskFsServiceLive } from "./stages/maskfs.ts";
```

- [ ] **Step 2: liveLayer に追加**

`liveLayer = Layer.mergeAll(...)` (line 309-334) 内、アルファベット順の位置に追加:

```ts
      MaskFsServiceLive.pipe(Layer.provide(primitiveLayer)),
```

- [ ] **Step 3: パイプラインに挿入**

`createCliPipelineBuilder` (line 409-434) の `.add(createMountStage(input, mountProbes))` の**直前**に追加:

```ts
      // MaskFsStage は MountStage が読む workspace.maskedRoot を確定させるため
      // 必ず MountStage の直前に置く。
      .add(createMaskFsStage(input, mountProbes))
```

- [ ] **Step 4: 型チェックと全体ユニットテスト**

Run: `bun run check && bun test src/`
Expected: PASS。`PipelineBuilder.add` の型制約 (`workspace` slice は Initial で供給済み) によりコンパイルが通ることが配線の静的検証になる。

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts
git commit -m "feat(maskfs): wire MaskFsStage and MaskFsServiceLive into the CLI pipeline

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: ホスト統合テスト (実 FUSE、Docker 不要)

**Files:**
- Test: `src/stages/maskfs/integration_test.ts`

**Interfaces:**
- Consumes: `nas-maskfs` バイナリ (Task 3/4)、`encodeMaskSecrets` (Task 5)

デーモンを直接 spawn する (allow_other を渡さないので `/etc/fuse.conf` 非依存)。FUSE 不可の環境 (CI コンテナ等) では skip。

- [ ] **Step 1: 統合テストを書く**

`src/stages/maskfs/integration_test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { resolveMaskFsBinPath } from "./maskfs_path.ts";
import { encodeMaskSecrets } from "./secrets_frame.ts";

const SECRET = "hunter2secret"; // 13 bytes
const MASKED = "*".repeat(13);

async function fuseUsable(): Promise<boolean> {
  try {
    await stat("/dev/fuse");
  } catch {
    return false;
  }
  if (!Bun.which("fusermount3")) return false;
  return (await resolveMaskFsBinPath()) !== null;
}

const usable = await fuseUsable();

describe.skipIf(!usable)("maskfs integration (real FUSE)", () => {
  let root: string;
  let src: string;
  let mnt: string;
  let daemon: ReturnType<typeof Bun.spawn> | null = null;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "nas-maskfs-it-"));
    src = path.join(root, "src");
    mnt = path.join(root, "mnt");
    await mkdir(src, { recursive: true });
    await mkdir(mnt, { recursive: true });
    await writeFile(path.join(src, "secret.env"), `DB_PASSWORD=${SECRET}\n`);
    await writeFile(path.join(src, "plain.txt"), "hello world\n");
    await mkdir(path.join(src, "sub"), { recursive: true });
    await writeFile(path.join(src, "sub", "nested.txt"), `token=${SECRET};\n`);

    const bin = (await resolveMaskFsBinPath()) as string;
    daemon = Bun.spawn([bin, src, mnt, "--write-policy=readonly"], {
      stdin: encodeMaskSecrets([SECRET]),
      stdout: "pipe",
      stderr: "pipe",
    });
    // mount ready 待ち: mnt の st_dev が root と変わるまで
    const rootDev = (await stat(root)).dev;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if ((await stat(mnt)).dev !== rootDev) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("maskfs mount did not become ready");
  });

  afterAll(async () => {
    await Bun.spawn(["fusermount3", "-u", mnt], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited;
    daemon?.kill();
    await rm(root, { recursive: true, force: true });
  });

  test("read masks the secret with same length", async () => {
    const content = await readFile(path.join(mnt, "secret.env"), "utf8");
    expect(content).toEqual(`DB_PASSWORD=${MASKED}\n`);
    expect(content).not.toContain(SECRET);
  });

  test("file size is unchanged", async () => {
    const [real, masked] = await Promise.all([
      stat(path.join(src, "secret.env")),
      stat(path.join(mnt, "secret.env")),
    ]);
    expect(masked.size).toEqual(real.size);
  });

  test("nested dirs are traversed and masked", async () => {
    const content = await readFile(path.join(mnt, "sub", "nested.txt"), "utf8");
    expect(content).toEqual(`token=${MASKED};\n`);
  });

  test("non-secret file reads through untouched", async () => {
    const content = await readFile(path.join(mnt, "plain.txt"), "utf8");
    expect(content).toEqual("hello world\n");
  });

  test("readonly policy denies write to secret-containing file", async () => {
    await expect(
      appendFile(path.join(mnt, "secret.env"), "x"),
    ).rejects.toThrow();
    // 実体は無傷
    const real = await readFile(path.join(src, "secret.env"), "utf8");
    expect(real).toEqual(`DB_PASSWORD=${SECRET}\n`);
  });

  test("readonly policy denies unlink of secret-containing file", async () => {
    await expect(rm(path.join(mnt, "secret.env"))).rejects.toThrow();
  });

  test("non-secret file is writable and reaches the real workspace", async () => {
    await appendFile(path.join(mnt, "plain.txt"), "more\n");
    const real = await readFile(path.join(src, "plain.txt"), "utf8");
    expect(real).toEqual("hello world\nmore\n");
  });

  test("new file creation works", async () => {
    await writeFile(path.join(mnt, "created.txt"), "fresh\n");
    const real = await readFile(path.join(src, "created.txt"), "utf8");
    expect(real).toEqual("fresh\n");
  });

  test("grep-style scan does not find the secret", async () => {
    const proc = Bun.spawn(["grep", "-r", SECRET, mnt], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const code = await proc.exited;
    expect(code).toEqual(1); // grep: not found
  });
});

test.skipIf(usable)("maskfs integration skipped (no FUSE available)", () => {
  expect(true).toEqual(true);
});
```

- [ ] **Step 2: テストを実行**

Run: `cd src/maskfs && zig build && cd ../.. && bun test src/stages/maskfs/integration_test.ts`
Expected: FUSE ホストで全 PASS。失敗した場合、maskfs.zig のバグ修正 → `zig build` → 再実行のループ。特に write-denial 系は open フラグの判定 (O_ACCMODE) を確認。

- [ ] **Step 3: Commit**

```bash
git add src/stages/maskfs/integration_test.ts
git commit -m "test(maskfs): add host-side FUSE integration test

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Docker E2E テスト + ドキュメント

**Files:**
- Create: `tests/maskfs_e2e_test.ts`
- Modify: `README.md` (機能ドキュメント追記)
- Modify: `src/config/templates/config.pkl` (コメント例)

**Interfaces:**
- Consumes: 全部つながった状態のパイプライン (Task 9)。フィクスチャ規約は `tests/cli_e2e_test.ts` の `withFakeCodexProject` (line 896-973) / `runNas` (line 81-113) を踏襲。

- [ ] **Step 1: E2E テストを書く**

`tests/maskfs_e2e_test.ts`:

```ts
import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { initConfig } from "../src/config/init.ts";
import { resolveMaskFsBinPath } from "../src/stages/maskfs/maskfs_path.ts";

const MAIN_TS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "main.ts",
);

const SECRET = "hunter2secret";
const MASKED = "*".repeat(13);

async function isDockerAvailable(): Promise<boolean> {
  try {
    const exitCode = await Bun.spawn(["docker", "info"], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

async function isFuseUsable(): Promise<boolean> {
  try {
    await stat("/dev/fuse");
  } catch {
    return false;
  }
  if (!Bun.which("fusermount3")) return false;
  // docker からアクセスされるため allow_other が必要
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    try {
      const conf = await readFile("/etc/fuse.conf", "utf8");
      if (!conf.split("\n").some((l) => l.trim() === "user_allow_other")) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return (await resolveMaskFsBinPath()) !== null;
}

const dockerAvailable = await isDockerAvailable();
const fuseUsable = await isFuseUsable();

async function runNas(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cleanedParent: Record<string, string | undefined> = { ...process.env };
  for (const key of [
    "NAS_SESSION_ID",
    "NAS_HOSTEXEC_SESSION_ID",
    "NAS_HOSTEXEC_SESSION_TMP",
  ]) {
    delete cleanedParent[key];
  }
  const proc = Bun.spawn(["bun", "run", MAIN_TS, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: options.cwd,
    env: options.env ? { ...cleanedParent, ...options.env } : cleanedParent,
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test.skipIf(!dockerAvailable || !fuseUsable)(
  "E2E: agent sees masked workspace and cannot corrupt the secret file",
  async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "nas-maskfs-e2e-"));
    try {
      const projectDir = path.join(rootDir, "project");
      const homeDir = path.join(rootDir, "home");
      const binDir = path.join(rootDir, "bin");
      await mkdir(projectDir, { recursive: true });
      await mkdir(path.join(homeDir, ".codex"), { recursive: true });
      await mkdir(binDir, { recursive: true });

      // ワークスペース: 秘密値入りファイル
      await writeFile(
        path.join(projectDir, "secret.env"),
        `DB_PASSWORD=${SECRET}\n`,
      );

      // fake agent: cat と書き込み試行の結果を出力する
      const fakeCodexPath = path.join(binDir, "codex");
      await writeFile(
        fakeCodexPath,
        [
          "#!/bin/sh",
          'printf "CAT=%s\\n" "$(cat ./secret.env)"',
          'if echo overwrite >> ./secret.env 2>/dev/null; then printf "WRITE=ok\\n"; else printf "WRITE=denied\\n"; fi',
        ].join("\n"),
      );
      await chmod(fakeCodexPath, 0o755);

      await initConfig({ projectDir });
      await writeFile(
        path.join(projectDir, ".nas", "config.pkl"),
        [
          'amends "Schema.pkl"',
          "",
          'default = "test"',
          "profiles {",
          '  ["test"] {',
          '    agent = "codex"',
          "    nix { enable = false }",
          "    docker { enable = false; shared = false }",
          "    gcloud { mountConfig = false }",
          "    aws { mountConfig = false }",
          "    gpg { forwardAgent = false }",
          "    mask {",
          "      values {",
          '        new { source = "dotenv:secret.env#DB_PASSWORD" }',
          "      }",
          '      writePolicy = "readonly"',
          "    }",
          "  }",
          "}",
        ].join("\n"),
      );

      const result = await runNas(["test"], {
        cwd: projectDir,
        env: { HOME: homeDir, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      });

      expect(result.code).toEqual(0);
      expect(result.stdout).toContain(`CAT=DB_PASSWORD=${MASKED}`);
      expect(result.stdout).not.toContain(SECRET);
      expect(result.stdout).toContain("WRITE=denied");

      // ホスト実体は無傷
      const real = await readFile(path.join(projectDir, "secret.env"), "utf8");
      expect(real).toEqual(`DB_PASSWORD=${SECRET}\n`);
    } finally {
      await rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  },
);
```

注: `tests/cli_e2e_test.ts` に `makeWritableForDind` / `canBindMount` の考慮がある (line 62-64, 906-909)。DinD 環境で走らせる場合は同じガード・chmod を足す。まず素の Docker ホストで通してから調整すること。

- [ ] **Step 2: E2E を実行**

Run: `bun test tests/maskfs_e2e_test.ts`
Expected: Docker + FUSE + user_allow_other が揃ったホストで PASS。揃っていなければ skip される (それ自体は成功)。

- [ ] **Step 3: README とテンプレートにドキュメントを追加**

`README.md` の機能一覧セクション (network / hostexec の説明がある並び) に追加:

```markdown
### Workspace string masking (maskfs)

ワークスペース内の秘密文字列 (パスワード・API キー等) を、コンテナ内の agent からは
同一長の `*` として見せる FUSE フィルタ。Read/Grep/`cat`/ビルドなどあらゆる
ファイル読み取り経路でマスクされ、秘密のバイト列はコンテナ内に存在しない。

```pkl
mask {
  values {
    new { source = "dotenv:.env#DB_PASSWORD" }
    new { source = "env:MY_API_KEY" }
    new { source = "keyring:myapp/token" }
  }
  writePolicy = "readonly"  // 秘密値含有ファイルへの書き込みを拒否 (default)
}
```

要件と制限:

- ホストに fuse3 (`fusermount3`) が必要。さらに `/etc/fuse.conf` に
  `user_allow_other` (NixOS: `programs.fuse.userAllowOther = true`)。
- 値の取得元は `env:` / `file:` / `dotenv:` / `keyring:` のみ (リテラル不可)。
  解決後 4 バイト未満はエラー。
- コンテナ内での実行時に本物の値は使えない (完全置換)。
- `.git/objects` 等の圧縮・エンコード済みデータはマスクできない。秘密値を
  コミット履歴に含めないこと。
- デーモン起動失敗時はセッション起動を中止する (フェイルクローズ)。
```

`src/config/templates/config.pkl` の `profiles` ブロックの上にコメント例を追加:

```pkl
// Mask secrets from the agent (any file-read path shows same-length "*"):
//   ["default"] {
//     mask {
//       values { new { source = "dotenv:.env#DB_PASSWORD" } }
//     }
//   }
```

- [ ] **Step 4: 全テスト + 型チェック**

Run: `bun run check && bun test src/ && bun test tests/`
Expected: PASS (環境不足のものは skip)

- [ ] **Step 5: Commit**

```bash
git add tests/maskfs_e2e_test.ts README.md src/config/templates/config.pkl
git commit -m "test(maskfs): add docker e2e test and document the mask feature

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 実装順序と依存関係

```
Task 1 (config) ──────────────┐
Task 2 (mask.zig) → Task 3 (daemon) → Task 4 (nix + path) ┐
Task 5 (stdinData + frame) ───┤                            │
                              └→ Task 6 (service) → Task 7 (stage) → Task 8 (mount) → Task 9 (cli)
                                                                     → Task 10 (host IT) → Task 11 (e2e + docs)
```

Task 1 と Task 2-5 は独立して進められる。Task 7 は 1/4/5/6 に依存。

## 検証チェックリスト (全タスク後)

- `bun run check` — 型エラーなし
- `bun test src/` — Docker 不要テスト全 green
- `cd src/maskfs && zig build test` — Zig ユニットテスト green
- `nix build .#default` — maskfs 込みでビルド成功
- FUSE ホストで `bun test src/stages/maskfs/integration_test.ts` — 実マウント green
- Docker + FUSE ホストで `bun test tests/maskfs_e2e_test.ts` — E2E green
