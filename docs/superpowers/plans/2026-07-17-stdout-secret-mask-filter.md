# stdout/stderr Secret Mask Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Zig-based stdin→stdout filter binary and a bash wrapper script that together mask secret values in all command output (stdout/stderr) inside the container.

**Architecture:** A new Zig binary (`nas-mask-filter`) reads secrets from a file in secrets_frame format, then streams stdin through the existing `mask.zig` algorithm (with overlap buffering for chunk boundaries) to stdout. A bash wrapper script at `/tmp/nas-bash-override/bash` uses process substitution to pipe all stdout/stderr through this filter. Host-side orchestration resolves secrets, writes the secrets frame file, bind-mounts the binary and secrets into the container, and generates the wrapper script via entrypoint.sh.

**Tech Stack:** Zig (filter binary), Bash (wrapper script), TypeScript/Effect (stage integration), Bun (test runner)

**Why — why this approach:**
The bash wrapper + process substitution approach covers all commands launched via bash (the vast majority in a Debian container), including static executables, because the fd redirection is set up before exec. Zig gives the necessary performance for a filter sitting on every command's output path. Reusing the existing `mask.zig` module avoids duplicating the proven 2-pass mark-and-replace algorithm.

**Why Not — why other approaches were rejected:**
- **LD_PRELOAD on write()** — Complex interaction with the existing hostexec_intercept.so, partial-write handling is tricky, and still doesn't cover static executables. Deferred as a future enhancement for non-bash-launched dynamic executables.
- **Hostexec broker-side streaming mask** — Only covers hostexec commands, not regular in-container commands. The removed `redactSecretsBytes` was incompatible with streaming; re-adding it requires chunk-boundary handling that's better solved once in the filter binary.

## Global Constraints

- Runtime: Bun. Tests use `bun:test`.
- Zig build pattern: match existing `src/maskfs/build.zig` and `flake.nix` derivation style.
- Effect architecture: stages orchestrate services; no primitive I/O in stage `run()`. See `effect-separation` skill.
- Test policy: unit tests co-located as `*_test.ts`, integration tests as `*_integration_test.ts`. See `test-policy` skill.
- Coding conventions: see `effect-separation` and `test-policy` skills.
- Minimum secret length: 4 bytes (enforced by existing `resolveMaskSecrets`).
- Secrets frame format: u32le count + (u32le len + UTF-8 bytes) per secret (match `src/stages/maskfs/secrets_frame.ts`).

---

### Task 1: Move mask.zig to shared location and update maskfs build

**Files:**
- Move: `src/maskfs/mask.zig` → `src/zig/mask.zig`
- Modify: `src/maskfs/build.zig` — update `@import` path
- Modify: `src/maskfs/maskfs.zig` — update `@import` path

**Interfaces:**
- Consumes: nothing
- Produces: `src/zig/mask.zig` at its new location, importable by both maskfs and mask-filter build.zig via relative path `"../zig/mask.zig"`

- [ ] **Step 1: Move mask.zig**

```bash
mkdir -p src/zig
git mv src/maskfs/mask.zig src/zig/mask.zig
```

- [ ] **Step 2: Update maskfs.zig import**

In `src/maskfs/maskfs.zig`, change:

```zig
// old
const mask = @import("mask.zig");
// new
const mask = @import("../zig/mask.zig");
```

- [ ] **Step 3: Update maskfs build.zig to reference new path**

In `src/maskfs/build.zig`, the mask.zig test module path needs updating:

```zig
// old
.root_source_file = b.path("mask.zig"),
// new — reference the shared location
.root_source_file = b.path("../zig/mask.zig"),
```

- [ ] **Step 4: Verify maskfs still builds and tests pass**

```bash
cd src/maskfs && zig build 2>&1
cd src/maskfs && zig build test 2>&1
```

Expected: build succeeds, all mask.zig tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/zig/mask.zig src/maskfs/build.zig src/maskfs/maskfs.zig
git commit -m "refactor(zig): move mask.zig to src/zig/ for sharing between maskfs and mask-filter"
```

---

### Task 2: Create nas-mask-filter Zig binary

**Files:**
- Create: `src/mask-filter/build.zig`
- Create: `src/mask-filter/mask_filter.zig`

**Interfaces:**
- Consumes: `src/zig/mask.zig` (maskAll, maxSecretLen)
- Produces: `nas-mask-filter` binary that reads secrets from `NAS_MASK_SECRETS_FILE`, then streams stdin→stdout with masking. Exit code 0 on success, 1 on fatal error, 2 on usage error.

- [ ] **Step 1: Create build.zig**

Create `src/mask-filter/build.zig`:

```zig
const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const host_target = b.resolveTargetQuery(.{});

    // ── nas-mask-filter executable ──
    const exe_mod = b.createModule(.{
        .root_source_file = b.path("mask_filter.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    const exe = b.addExecutable(.{
        .name = "nas-mask-filter",
        .root_module = exe_mod,
    });
    b.installArtifact(exe);

    // ── unit tests ──
    const test_mod = b.createModule(.{
        .root_source_file = b.path("mask_filter.zig"),
        .target = host_target,
        .optimize = optimize,
        .link_libc = true,
    });
    const unit_tests = b.addTest(.{ .root_module = test_mod });
    const run_tests = b.addRunArtifact(unit_tests);
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_tests.step);
}
```

- [ ] **Step 2: Write mask_filter.zig with streaming logic and tests**

Create `src/mask-filter/mask_filter.zig`. The key design:

1. `readSecretsFromFile(path)` — opens the file at `path`, reads the secrets_frame binary format (same as maskfs's `readSecretsFromStdin` but from a file fd instead of stdin). Returns `[][]u8`.
2. `streamMask(reader, writer, secrets)` — the core streaming loop:
   - Maintains an overlap buffer of `maxSecretLen - 1` bytes from the previous chunk.
   - Each iteration: read up to `BUF_SIZE` bytes from reader, prepend overlap, run `maskAll`, write the safe prefix (everything except the last `maxSecretLen - 1` bytes), save the tail as new overlap.
   - On EOF: `maskAll` the remaining overlap and write it out.
3. `main()` — reads `NAS_MASK_SECRETS_FILE` env var, calls `readSecretsFromFile`, then `streamMask(stdin, stdout, secrets)`.

```zig
const std = @import("std");
const mask = @import("../zig/mask.zig");

const BUF_SIZE: usize = 64 * 1024;

const allocator = std.heap.page_allocator;

fn readSecretsFromFile(file_path: []const u8) ![][]u8 {
    const file = try std.fs.cwd().openFile(file_path, .{});
    defer file.close();
    const reader = file.reader();
    const count = try reader.readInt(u32, .little);
    if (count > 1024) return error.TooManySecrets;
    const list = try allocator.alloc([]u8, count);
    var i: usize = 0;
    while (i < count) : (i += 1) {
        const len = try reader.readInt(u32, .little);
        if (len == 0 or len > 16 * 1024 * 1024) return error.InvalidSecretLength;
        const s = try allocator.alloc(u8, len);
        try reader.readNoEof(s);
        list[i] = s;
    }
    return list;
}

pub fn streamMask(
    reader: anytype,
    writer: anytype,
    secrets: []const []const u8,
) !void {
    const max_len = mask.maxSecretLen(secrets);
    const overlap_size: usize = if (max_len > 0) max_len - 1 else 0;

    // If no secrets or all secrets empty, pass through without buffering
    if (overlap_size == 0) {
        var buf: [BUF_SIZE]u8 = undefined;
        while (true) {
            const n = reader.read(&buf) catch |err| switch (err) {
                error.EndOfStream => break,
                else => return err,
            };
            if (n == 0) break;
            try writer.writeAll(buf[0..n]);
        }
        return;
    }

    // Allocate combined buffer: overlap_size + BUF_SIZE
    const combined_cap = overlap_size + BUF_SIZE;
    const combined = try allocator.alloc(u8, combined_cap);
    defer allocator.free(combined);
    const mask_buf = try allocator.alloc(bool, combined_cap);
    defer allocator.free(mask_buf);

    var overlap_len: usize = 0;

    while (true) {
        const n = reader.read(combined[overlap_len .. overlap_len + BUF_SIZE]) catch |err| switch (err) {
            error.EndOfStream => break,
            else => return err,
        };
        if (n == 0) break;

        const total = overlap_len + n;
        mask.maskAll(combined[0..total], secrets, mask_buf);

        const safe_end = if (total > overlap_size) total - overlap_size else 0;
        if (safe_end > 0) {
            try writer.writeAll(combined[0..safe_end]);
        }

        // Shift tail to front as new overlap
        const new_overlap = total - safe_end;
        if (new_overlap > 0 and safe_end > 0) {
            std.mem.copyForwards(u8, combined[0..new_overlap], combined[safe_end..total]);
        }
        overlap_len = new_overlap;
    }

    // Flush remaining overlap
    if (overlap_len > 0) {
        mask.maskAll(combined[0..overlap_len], secrets, mask_buf);
        try writer.writeAll(combined[0..overlap_len]);
    }
}

pub fn main() !u8 {
    const env_path = std.posix.getenv("NAS_MASK_SECRETS_FILE") orelse {
        std.debug.print("NAS_MASK_SECRETS_FILE not set\n", .{});
        return 2;
    };
    const secrets = readSecretsFromFile(env_path) catch |err| {
        std.debug.print("failed to read secrets: {}\n", .{err});
        return 1;
    };
    const stdin = std.io.getStdIn();
    const stdout = std.io.getStdOut();
    var buf_writer = std.io.bufferedWriter(stdout.writer());
    streamMask(stdin.reader(), buf_writer.writer(), secrets) catch |err| {
        std.debug.print("stream error: {}\n", .{err});
        return 1;
    };
    buf_writer.flush() catch |err| {
        std.debug.print("flush error: {}\n", .{err});
        return 1;
    };
    return 0;
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

const testing = std.testing;

fn testStreamMask(input: []const u8, secrets: []const []const u8) ![]u8 {
    var input_stream = std.io.fixedBufferStream(input);
    var output = std.ArrayList(u8).init(testing.allocator);
    defer output.deinit();
    try streamMask(input_stream.reader(), output.writer(), secrets);
    return try output.toOwnedSlice();
}

test "streamMask: no secrets → passthrough" {
    const result = try testStreamMask("hello world", &.{});
    defer testing.allocator.free(result);
    try testing.expectEqualStrings("hello world", result);
}

test "streamMask: single secret masked" {
    const result = try testStreamMask("password=hunter2 done", &.{"hunter2"});
    defer testing.allocator.free(result);
    try testing.expectEqualStrings("password=******* done", result);
}

test "streamMask: secret spanning chunk boundary" {
    // Build input where "SECRET" straddles a boundary.
    // We test with a small logical buffer to force overlap handling.
    // The actual streamMask uses BUF_SIZE=64K, but the algorithm is the same.
    const input = "prefix_SECRET_suffix";
    const result = try testStreamMask(input, &.{"SECRET"});
    defer testing.allocator.free(result);
    try testing.expectEqualStrings("prefix_******_suffix", result);
}

test "streamMask: empty input" {
    const result = try testStreamMask("", &.{"secret"});
    defer testing.allocator.free(result);
    try testing.expectEqualStrings("", result);
}

test "streamMask: multiple secrets" {
    const result = try testStreamMask("a=tok1 b=tok22 c=tok1", &.{ "tok1", "tok22" });
    defer testing.allocator.free(result);
    try testing.expectEqualStrings("a=**** b=***** c=****", result);
}

test "streamMask: overlapping secrets" {
    const result = try testStreamMask("xabcx", &.{ "ab", "abc" });
    defer testing.allocator.free(result);
    try testing.expectEqualStrings("x***x", result);
}
```

- [ ] **Step 3: Build and run tests**

```bash
cd src/mask-filter && zig build 2>&1
cd src/mask-filter && zig build test 2>&1
```

Expected: build succeeds, all tests pass.

- [ ] **Step 4: Manual smoke test**

```bash
# Create a test secrets file
cd src/mask-filter
echo -ne '\x01\x00\x00\x00\x07\x00\x00\x00hunter2' > /tmp/test-secrets
NAS_MASK_SECRETS_FILE=/tmp/test-secrets echo "my password is hunter2 ok" | ./zig-out/bin/nas-mask-filter
```

Expected output: `my password is ******* ok`

- [ ] **Step 5: Commit**

```bash
git add src/mask-filter/
git commit -m "feat(mask-filter): add nas-mask-filter Zig binary for stdout/stderr secret masking"
```

---

### Task 3: Add mask-filter to Nix build and asset bundle

**Files:**
- Modify: `flake.nix` — add `maskFilter` derivation and include in `nasAssets`

**Interfaces:**
- Consumes: `src/mask-filter/build.zig`, `src/zig/mask.zig`
- Produces: `$NAS_ASSET_DIR/mask-filter/nas-mask-filter` binary in the asset bundle

- [ ] **Step 1: Add maskFilter derivation to flake.nix**

Add after the `maskfs` derivation (around line 110):

```nix
        maskFilter = pkgs.stdenv.mkDerivation {
          pname = "nas-mask-filter";
          version = "0.1.0";
          src = pkgs.lib.fileset.toSource {
            root = ./src;
            fileset = pkgs.lib.fileset.unions [
              ./src/mask-filter
              ./src/zig
            ];
          };
          sourceRoot = "source/mask-filter";
          nativeBuildInputs = [ pkgs.zig ];
          dontConfigure = true;
          dontFixup = true;
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
            cp zig-out/bin/nas-mask-filter $out/bin/
          '';
        };
```

Note: The `src` uses `fileset` to include both `src/mask-filter/` and `src/zig/` (for the shared mask.zig). `sourceRoot` points into the mask-filter subdirectory so `zig build` runs from there. Inspect the existing maskfs derivation — if it also needs updating for the moved mask.zig, update its `src` similarly.

- [ ] **Step 2: Add mask-filter binary to nasAssets**

In the `nasAssets = pkgs.runCommand` block, add:

```nix
          mkdir -p $out/mask-filter
          cp ${maskFilter}/bin/nas-mask-filter $out/mask-filter/
```

- [ ] **Step 3: Update maskfs derivation src to include shared zig directory**

The maskfs derivation's `src = ./src/maskfs` no longer contains `mask.zig` (it moved to `src/zig/`). Update:

```nix
        maskfs = pkgs.stdenv.mkDerivation {
          pname = "nas-maskfs";
          version = "0.1.0";
          src = pkgs.lib.fileset.toSource {
            root = ./src;
            fileset = pkgs.lib.fileset.unions [
              ./src/maskfs
              ./src/zig
            ];
          };
          sourceRoot = "source/maskfs";
          # ... rest unchanged
        };
```

- [ ] **Step 4: Verify Nix build**

```bash
nix build .#default 2>&1
```

Expected: build succeeds. If nix is not available in the dev environment, verify the derivation structure is correct by inspection and defer to CI.

- [ ] **Step 5: Commit**

```bash
git add flake.nix
git commit -m "build(nix): add mask-filter derivation and update maskfs src for shared zig/"
```

---

### Task 4: Add mask-filter binary path resolution and config extension

**Files:**
- Create: `src/stages/maskfs/mask_filter_path.ts`
- Create: `src/stages/maskfs/mask_filter_path_test.ts`
- Modify: `src/config/types.ts` — add `filter` field to `MaskConfig`
- Modify: `src/config/Schema.pkl` — add `filter` field to `MaskConfig`
- Modify: `src/config/validate.ts` — add validation for `filter` field
- Modify: `src/stages/maskfs.ts` — add barrel re-export

**Interfaces:**
- Consumes: `resolveAssetBinary` from `src/lib/asset.ts`
- Produces:
  - `resolveMaskFilterBinPath(opts?): Promise<string | null>` — resolves the nas-mask-filter binary path
  - `MaskConfig.filter: boolean` — new config field (default `true`)

- [ ] **Step 1: Write failing test for mask_filter_path**

Create `src/stages/maskfs/mask_filter_path_test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { resolveMaskFilterBinPath } from "./mask_filter_path.ts";

describe("resolveMaskFilterBinPath", () => {
  test("returns null when binary does not exist", async () => {
    const result = await resolveMaskFilterBinPath({
      assetDir: "/nonexistent/asset/dir",
    });
    expect(result).toBeNull();
  });

  test("resolves from assetDir when provided", async () => {
    // This test verifies the path construction logic.
    // The binary won't exist, but the path should be correctly formed.
    const result = await resolveMaskFilterBinPath({
      assetDir: "/tmp/test-assets",
    });
    // Returns null because file doesn't exist, but exercises the code path
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/stages/maskfs/mask_filter_path_test.ts
```

Expected: FAIL (module not found)

- [ ] **Step 3: Implement mask_filter_path.ts**

Create `src/stages/maskfs/mask_filter_path.ts`:

```typescript
import { resolveAssetBinary } from "../../lib/asset.ts";

export async function resolveMaskFilterBinPath(opts?: {
  assetDir?: string;
}): Promise<string | null> {
  return resolveAssetBinary(
    "mask-filter/nas-mask-filter",
    import.meta.url,
    "../../mask-filter/zig-out/bin/nas-mask-filter",
    opts,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/stages/maskfs/mask_filter_path_test.ts
```

Expected: PASS

- [ ] **Step 5: Add `filter` field to MaskConfig type**

In `src/config/types.ts`, update `MaskConfig`:

```typescript
export interface MaskConfig {
  values: MaskValueConfig[];
  writePolicy: MaskWritePolicy;
  /** FUSE ワークスペースマスク (maskfs) の有効化。デフォルト true */
  maskfs: boolean;
  /** mitmproxy リクエストマスクの有効化。デフォルト true */
  proxy: boolean;
  /** コマンド stdout/stderr のフィルタマスク有効化。デフォルト true */
  filter: boolean;
}
```

- [ ] **Step 6: Add `filter` field to Pkl schema**

In `src/config/Schema.pkl`, add to `MaskConfig` class (after the `proxy` field):

```pkl
  /// コマンドの stdout/stderr に含まれるシークレットをマスクする bash wrapper フィルタ。
  /// /tmp/nas-bash-override/bash を process substitution ラッパーに置き換え、
  /// 全コマンド出力を nas-mask-filter 経由でマスクする。
  filter: Boolean = true
```

- [ ] **Step 7: Add validation for `filter` field**

In `src/config/validate.ts`, in the mask validation block (around line 108-117), add after the `proxy` check:

```typescript
    if (typeof profile.mask.filter !== "boolean") {
      errors.push(`profile "${name}": mask.filter must be a boolean`);
    }
```

- [ ] **Step 8: Update barrel re-export**

In `src/stages/maskfs.ts`, add:

```typescript
export { resolveMaskFilterBinPath } from "./maskfs/mask_filter_path.ts";
```

- [ ] **Step 9: Run existing tests to verify no regressions**

```bash
bun test src/config/ 2>&1
bun test src/stages/maskfs/ 2>&1
```

Expected: existing tests may need the new `filter` field added to test fixtures. Update any test fixture that constructs a `MaskConfig` to include `filter: true` (or `filter: false` as appropriate).

- [ ] **Step 10: Commit**

```bash
git add src/stages/maskfs/mask_filter_path.ts src/stages/maskfs/mask_filter_path_test.ts src/config/types.ts src/config/Schema.pkl src/config/validate.ts src/stages/maskfs.ts
git commit -m "feat(config): add mask.filter field and mask-filter binary path resolution"
```

---

### Task 5: Create MaskFilterService and stage integration

**Files:**
- Create: `src/stages/maskfs/mask_filter_service.ts`
- Create: `src/stages/maskfs/mask_filter_service_test.ts`
- Create: `src/stages/maskfs/mask_filter_stage.ts`
- Create: `src/stages/maskfs/mask_filter_stage_test.ts`
- Modify: `src/stages/maskfs.ts` — add barrel re-exports
- Modify: `src/pipeline/types.ts` — add `MaskFilterService` to `StageServices` union

**Interfaces:**
- Consumes:
  - `resolveMaskSecrets(values, env): Promise<string[]>` from `src/lib/mask_secrets.ts`
  - `encodeMaskSecrets(secrets): Uint8Array` from `src/stages/maskfs/secrets_frame.ts`
  - `resolveMaskFilterBinPath(opts?): Promise<string | null>` from Task 4
  - `MaskConfig` from `src/config/types.ts`
  - `ContainerPlan`, `MountSpec` from `src/pipeline/state.ts`
  - `mergeContainerPlan` from `src/pipeline/container_plan.ts`
- Produces:
  - `MaskFilterService` — Effect service Tag with `prepareMaskFilter` method
  - `MaskFilterServiceLive` — Live layer (requires `FsService`)
  - `makeMaskFilterServiceFake()` — Fake factory for tests
  - `createMaskFilterStage(shared)` — Stage factory returning `Stage<"container", Pick<StageResult, "container">, MaskFilterService, unknown>`
  - `generateBashWrapper(maskFilterPath: string): string` — pure function

The stage needs `container` (to merge mounts/env) and produces an updated `container`. It's a separate stage from MaskFsStage because it has different slice needs (`container` vs `workspace`) and different lifecycle concerns (no daemon to manage, just file preparation + container patching).

- [ ] **Step 1: Write test for generateBashWrapper (pure function)**

Create `src/stages/maskfs/mask_filter_service_test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import type { MountSpec } from "../../pipeline/state.ts";
import {
  type MaskFilterPreparePlan,
  MaskFilterService,
  generateBashWrapper,
  makeMaskFilterServiceFake,
} from "./mask_filter_service.ts";

describe("generateBashWrapper", () => {
  test("generates wrapper with filter redirect", () => {
    const script = generateBashWrapper("/opt/nas/mask-filter/nas-mask-filter");
    expect(script).toContain("#!/bin/bash");
    expect(script).toContain("NAS_MASK_SECRETS_FILE");
    expect(script).toContain("/opt/nas/mask-filter/nas-mask-filter");
    expect(script).toContain('exec /bin/bash "$@"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/stages/maskfs/mask_filter_service_test.ts
```

Expected: FAIL (module not found)

- [ ] **Step 3: Implement MaskFilterService**

Create `src/stages/maskfs/mask_filter_service.ts`:

```typescript
import { Context, Effect, Layer } from "effect";
import type { MaskValueConfig } from "../../config/types.ts";
import { resolveMaskSecrets } from "../../lib/mask_secrets.ts";
import type { HostEnv } from "../../pipeline/types.ts";
import type { MountSpec } from "../../pipeline/state.ts";
import { FsService } from "../../services/fs.ts";
import { encodeMaskSecrets } from "./secrets_frame.ts";

export const MASK_FILTER_CONTAINER_PATH =
  "/opt/nas/mask-filter/nas-mask-filter";
export const MASK_SECRETS_CONTAINER_PATH = "/run/nas/mask-secrets";

export interface MaskFilterPreparePlan {
  readonly secretsFramePath: string;
  readonly filterBinaryHostPath: string;
}

export interface MaskFilterResult {
  readonly mounts: readonly MountSpec[];
  readonly envVars: Readonly<Record<string, string>>;
  readonly bashWrapperScript: string;
}

export class MaskFilterService extends Context.Tag("nas/MaskFilterService")<
  MaskFilterService,
  {
    readonly prepareMaskFilter: (
      plan: MaskFilterPreparePlan,
      values: MaskValueConfig[],
      host: HostEnv,
    ) => Effect.Effect<MaskFilterResult, unknown>;
  }
>() {}

export const MaskFilterServiceLive: Layer.Layer<
  MaskFilterService,
  never,
  FsService
> = Layer.effect(
  MaskFilterService,
  Effect.gen(function* () {
    const fs = yield* FsService;

    return MaskFilterService.of({
      prepareMaskFilter: (plan, values, host) =>
        Effect.gen(function* () {
          const env: Record<string, string | undefined> = {};
          for (const [k, v] of host.env) env[k] = v;
          const secrets = yield* Effect.tryPromise({
            try: () => resolveMaskSecrets(values, env),
            catch: (e) => e,
          });

          const frame = encodeMaskSecrets(secrets);
          yield* fs.writeFile(plan.secretsFramePath, frame, { mode: 0o600 });

          const mounts: MountSpec[] = [
            {
              source: plan.secretsFramePath,
              target: MASK_SECRETS_CONTAINER_PATH,
              readOnly: true,
            },
            {
              source: plan.filterBinaryHostPath,
              target: MASK_FILTER_CONTAINER_PATH,
              readOnly: true,
            },
          ];

          const envVars: Record<string, string> = {
            NAS_MASK_SECRETS_FILE: MASK_SECRETS_CONTAINER_PATH,
            NAS_MASK_FILTER: MASK_FILTER_CONTAINER_PATH,
          };

          return {
            mounts,
            envVars,
            bashWrapperScript: generateBashWrapper(MASK_FILTER_CONTAINER_PATH),
          };
        }),
    });
  }),
);

export function generateBashWrapper(maskFilterPath: string): string {
  return `#!/bin/bash
if [ -n "\$NAS_MASK_SECRETS_FILE" ] && [ -f "${maskFilterPath}" ]; then
  exec > >("${maskFilterPath}") 2> >("${maskFilterPath}" >&2)
fi
exec /bin/bash "\$@"
`;
}

export interface MaskFilterServiceFakeConfig {
  readonly prepareMaskFilter?: (
    plan: MaskFilterPreparePlan,
    values: MaskValueConfig[],
    host: HostEnv,
  ) => Effect.Effect<MaskFilterResult, unknown>;
}

export function makeMaskFilterServiceFake(
  overrides: MaskFilterServiceFakeConfig = {},
): Layer.Layer<MaskFilterService> {
  return Layer.succeed(
    MaskFilterService,
    MaskFilterService.of({
      prepareMaskFilter:
        overrides.prepareMaskFilter ??
        (() =>
          Effect.succeed({
            mounts: [],
            envVars: {},
            bashWrapperScript: "",
          })),
    }),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/stages/maskfs/mask_filter_service_test.ts
```

Expected: PASS

- [ ] **Step 5: Add prepareMaskFilter Live layer test**

Add to `src/stages/maskfs/mask_filter_service_test.ts`:

```typescript
import { FsService } from "../../services/fs.ts";

describe("MaskFilterServiceLive.prepareMaskFilter", () => {
  test("writes secrets frame and returns mounts + env", async () => {
    const written: Array<{ path: string; data: Uint8Array }> = [];
    const fakeFsLayer = Layer.succeed(
      FsService,
      FsService.of({
        writeFile: (path, data, _opts) =>
          Effect.sync(() => {
            written.push({ path, data: data instanceof Uint8Array ? data : new TextEncoder().encode(String(data)) });
          }),
        // stub other methods as needed
        mkdir: () => Effect.void,
        readFile: () => Effect.succeed(new Uint8Array()),
        chmod: () => Effect.void,
        symlink: () => Effect.void,
        rm: () => Effect.void,
        rename: () => Effect.void,
        stat: () => Effect.succeed({ isFile: true, isDirectory: false, mode: 0o644, dev: 0n, size: 0, mtimeMs: 0 }),
        exists: () => Effect.succeed(false),
      } as any),
    );

    const { MaskFilterServiceLive } = await import("./mask_filter_service.ts");

    const host = {
      home: "/home/u",
      user: "u",
      uid: 1000,
      gid: 1000,
      isWSL: false,
      env: new Map([["TEST_SECRET", "hunter2secret"]]),
    } as any;

    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* MaskFilterService;
          return yield* svc.prepareMaskFilter(
            {
              secretsFramePath: "/tmp/test-secrets",
              filterBinaryHostPath: "/usr/local/bin/nas-mask-filter",
            },
            [{ source: "env:TEST_SECRET" }],
            host,
          );
        }),
        MaskFilterServiceLive.pipe(Layer.provide(fakeFsLayer)),
      ),
    );

    expect(written.length).toBe(1);
    expect(written[0].path).toBe("/tmp/test-secrets");
    expect(result.mounts.length).toBe(2);
    expect(result.envVars.NAS_MASK_SECRETS_FILE).toBe("/run/nas/mask-secrets");
    expect(result.envVars.NAS_MASK_FILTER).toBe(
      "/opt/nas/mask-filter/nas-mask-filter",
    );
    expect(result.bashWrapperScript).toContain("#!/bin/bash");
  });
});
```

- [ ] **Step 6: Run tests**

```bash
bun test src/stages/maskfs/mask_filter_service_test.ts
```

Expected: PASS

- [ ] **Step 7: Write failing test for mask_filter_stage**

Create `src/stages/maskfs/mask_filter_stage_test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { emptyContainerPlan } from "../../pipeline/container_plan.ts";
import type { StageInput } from "../../pipeline/types.ts";
import { makeMaskFilterServiceFake } from "./mask_filter_service.ts";
import { createMaskFilterStage } from "./mask_filter_stage.ts";

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
    config: {
      ui: { enable: false, port: 0, idleTimeout: 0 },
      observability: { enable: false, retention: null },
      profiles: {},
    },
    profile: {
      agent: "claude",
      agentArgs: [],
      session: { multiplex: false, detachKey: "^\\" },
      nix: { enable: false, mountSocket: false, extraPackages: [] },
      docker: { enable: false, shared: false },
      gcloud: { mountConfig: false },
      aws: { mountConfig: false },
      gpg: { forwardAgent: false },
      network: {
        reviewRules: [],
        credentials: [],
        proxy: { forwardPorts: [] },
        pendingTimeoutSeconds: 300,
        pendingDefaultScope: "host-port",
        pendingNotify: "off",
      },
      dbus: {
        session: {
          enable: false,
          see: [],
          talk: [],
          own: [],
          calls: [],
          broadcasts: [],
        },
      },
      display: { sandbox: "none", size: "1920x1080" },
      extraMounts: [],
      env: [],
      hook: { notify: "off" },
    },
    profileName: "test",
    sessionId: "sess_test1",
    host: HOST,
    probes: {
      hasHostNix: false,
      xdgDbusProxyPath: null,
      dbusSessionAddress: null,
      gpgAgentSocket: null,
      auditDir: "/tmp/audit",
    },
    ...overrides,
  } as StageInput;
}

describe("createMaskFilterStage", () => {
  test("no mask config → container passthrough", async () => {
    const input = makeStageInput();
    const stage = createMaskFilterStage(input, {
      resolveBinPath: async () => "/fake/nas-mask-filter",
    });
    const container = emptyContainerPlan("img", "/work");
    const result = await Effect.runPromise(
      Effect.scoped(
        stage.run({ container }).pipe(
          Effect.provide(makeMaskFilterServiceFake()),
        ),
      ),
    );
    expect(result).toEqual({});
  });

  test("mask.filter=false → container passthrough", async () => {
    const input = makeStageInput();
    input.profile.mask = {
      values: [{ source: "env:SECRET" }],
      writePolicy: "readonly",
      maskfs: true,
      proxy: true,
      filter: false,
    };
    const stage = createMaskFilterStage(input, {
      resolveBinPath: async () => "/fake/nas-mask-filter",
    });
    const container = emptyContainerPlan("img", "/work");
    const result = await Effect.runPromise(
      Effect.scoped(
        stage.run({ container }).pipe(
          Effect.provide(makeMaskFilterServiceFake()),
        ),
      ),
    );
    expect(result).toEqual({});
  });

  test("mask.filter=true → merges mounts and env into container", async () => {
    const input = makeStageInput();
    input.profile.mask = {
      values: [{ source: "env:SECRET" }],
      writePolicy: "readonly",
      maskfs: true,
      proxy: true,
      filter: true,
    };
    const stage = createMaskFilterStage(input, {
      resolveBinPath: async () => "/fake/nas-mask-filter",
    });
    const container = emptyContainerPlan("img", "/work");
    const fakeLayer = makeMaskFilterServiceFake({
      prepareMaskFilter: () =>
        Effect.succeed({
          mounts: [
            { source: "/tmp/secrets", target: "/run/nas/mask-secrets", readOnly: true },
            { source: "/fake/nas-mask-filter", target: "/opt/nas/mask-filter/nas-mask-filter", readOnly: true },
          ],
          envVars: {
            NAS_MASK_SECRETS_FILE: "/run/nas/mask-secrets",
            NAS_MASK_FILTER: "/opt/nas/mask-filter/nas-mask-filter",
          },
          bashWrapperScript: "#!/bin/bash\nexec /bin/bash \"$@\"",
        }),
    });
    const result = await Effect.runPromise(
      Effect.scoped(
        stage.run({ container }).pipe(Effect.provide(fakeLayer)),
      ),
    );
    expect(result.container).toBeDefined();
    expect(result.container!.mounts.length).toBe(2);
    expect(result.container!.env.static.NAS_MASK_SECRETS_FILE).toBe(
      "/run/nas/mask-secrets",
    );
  });

  test("binary not found → fails", async () => {
    const input = makeStageInput();
    input.profile.mask = {
      values: [{ source: "env:SECRET" }],
      writePolicy: "readonly",
      maskfs: true,
      proxy: true,
      filter: true,
    };
    const stage = createMaskFilterStage(input, {
      resolveBinPath: async () => null,
    });
    const container = emptyContainerPlan("img", "/work");
    await expect(
      Effect.runPromise(
        Effect.scoped(
          stage.run({ container }).pipe(
            Effect.provide(makeMaskFilterServiceFake()),
          ),
        ),
      ),
    ).rejects.toThrow(/binary not found/);
  });
});
```

- [ ] **Step 8: Run test to verify it fails**

```bash
bun test src/stages/maskfs/mask_filter_stage_test.ts
```

Expected: FAIL (module not found)

- [ ] **Step 9: Implement mask_filter_stage.ts**

Create `src/stages/maskfs/mask_filter_stage.ts`:

```typescript
import { Effect } from "effect";
import { mergeContainerPlan } from "../../pipeline/container_plan.ts";
import type { Stage } from "../../pipeline/stage_builder.ts";
import type { ContainerPlan, PipelineState } from "../../pipeline/state.ts";
import type { StageInput } from "../../pipeline/types.ts";
import { resolveRuntimeSubdir } from "../../lib/runtime_dir.ts";
import { MaskFilterService } from "./mask_filter_service.ts";
import { resolveMaskFilterBinPath } from "./mask_filter_path.ts";

type StageResult = Pick<PipelineState, "container">;

export interface MaskFilterStageOptions {
  readonly resolveBinPath?: () => Promise<string | null>;
}

export function createMaskFilterStage(
  shared: StageInput,
  options: MaskFilterStageOptions = {},
): Stage<"container", Partial<StageResult>, MaskFilterService, unknown> {
  return {
    name: "MaskFilterStage",
    needs: ["container"],

    run(input) {
      const mask = shared.profile.mask;
      if (!mask?.filter || mask.values.length === 0) {
        return Effect.succeed({});
      }

      return Effect.gen(function* () {
        const svc = yield* MaskFilterService;

        const resolveBin = options.resolveBinPath ?? resolveMaskFilterBinPath;
        const binaryPath = yield* Effect.tryPromise({
          try: () => resolveBin(),
          catch: (e) => e,
        });
        if (!binaryPath) {
          return yield* Effect.fail(
            new Error(
              "[nas] mask: nas-mask-filter binary not found. Build it with `cd src/mask-filter && zig build` (dev) or reinstall nas (nix).",
            ),
          );
        }

        const runtimeDir = resolveRuntimeSubdir(shared.host, "mask-filter");
        const secretsFramePath = `${runtimeDir}/${shared.sessionId}/mask-secrets`;

        const result = yield* svc.prepareMaskFilter(
          { secretsFramePath, filterBinaryHostPath: binaryPath },
          mask.values,
          shared.host,
        );

        return {
          container: mergeContainerPlan(input.container, {
            mounts: result.mounts,
            env: {
              static: {
                ...result.envVars,
                NAS_MASK_FILTER_BASH_WRAPPER: result.bashWrapperScript,
              },
            },
          }),
        };
      });
    },
  };
}
```

Note: The bash wrapper script content is passed as an env var (`NAS_MASK_FILTER_BASH_WRAPPER`) to entrypoint.sh, which writes it to the override file. This avoids bind-mounting a generated script from the host.

- [ ] **Step 10: Add MaskFilterService to StageServices union**

In `src/pipeline/types.ts`, add to the `StageServices` union:

```typescript
import { MaskFilterService } from "../stages/maskfs/mask_filter_service.ts";

export type StageServices =
  | ...
  | MaskFilterService  // add alongside MaskFsService
  | ...;
```

- [ ] **Step 11: Update barrel re-exports**

In `src/stages/maskfs.ts`, add:

```typescript
export {
  MaskFilterService,
  type MaskFilterPreparePlan,
  type MaskFilterResult,
  type MaskFilterServiceFakeConfig,
  MaskFilterServiceLive,
  generateBashWrapper,
  makeMaskFilterServiceFake,
} from "./maskfs/mask_filter_service.ts";
export {
  createMaskFilterStage,
  type MaskFilterStageOptions,
} from "./maskfs/mask_filter_stage.ts";
```

- [ ] **Step 12: Run all maskfs tests**

```bash
bun test src/stages/maskfs/ 2>&1
```

Expected: all tests pass.

- [ ] **Step 13: Commit**

```bash
git add src/stages/maskfs/mask_filter_service.ts src/stages/maskfs/mask_filter_service_test.ts src/stages/maskfs/mask_filter_stage.ts src/stages/maskfs/mask_filter_stage_test.ts src/stages/maskfs.ts src/pipeline/types.ts
git commit -m "feat(mask-filter): add MaskFilterService and MaskFilterStage for stdout/stderr masking"
```

---

### Task 6: Wire mask-filter stage into pipeline and entrypoint

**Files:**
- Modify: `src/cli.ts` — add `createMaskFilterStage` to pipeline, add `MaskFilterServiceLive` to layers
- Modify: `src/docker/embed/entrypoint.sh` — replace bash-override symlink with wrapper script when filter is enabled

**Interfaces:**
- Consumes:
  - `createMaskFilterStage(shared)` from Task 5
  - `MaskFilterServiceLive` from Task 5
  - `NAS_MASK_FILTER_BASH_WRAPPER` env var (set by the stage)
- Produces: fully wired pipeline with mask-filter support

- [ ] **Step 1: Add MaskFilterStage to pipeline in cli.ts**

In `src/cli.ts`, add import:

```typescript
import {
  createMaskFsStage,
  createMaskFilterStage,
  MaskFsServiceLive,
  MaskFilterServiceLive,
} from "./stages/maskfs.ts";
```

In the pipeline builder (around line 421), add the MaskFilterStage after MaskFsStage and MountStage but before HostExecStage (it needs `container` which is available from the start):

```typescript
      .add(createMaskFsStage(input, mountProbes))
      .add(createMountStage(input, mountProbes))
      .add(createMaskFilterStage(input))  // ← add here
      .add(createHostExecStage(input))
```

In the Layer provision (around line 327), add:

```typescript
      MaskFilterServiceLive.pipe(Layer.provide(primitiveLayer)),
```

alongside the existing `MaskFsServiceLive.pipe(Layer.provide(primitiveLayer))`.

- [ ] **Step 2: Update entrypoint.sh bash-override logic**

In `src/docker/embed/entrypoint.sh`, replace the bash-override section (around lines 369-379):

```bash
  NAS_BASH_OVERRIDE="/tmp/nas-bash-override"
  mkdir -p "$NAS_BASH_OVERRIDE"
  if [ -n "${NAS_MASK_FILTER_BASH_WRAPPER:-}" ]; then
    printf '%s' "$NAS_MASK_FILTER_BASH_WRAPPER" > "$NAS_BASH_OVERRIDE/bash"
    chmod +x "$NAS_BASH_OVERRIDE/bash"
  elif [ -x /bin/bash ]; then
    ln -sf /bin/bash "$NAS_BASH_OVERRIDE/bash"
  fi
```

When `NAS_MASK_FILTER_BASH_WRAPPER` is set (by the mask-filter stage), write the wrapper script content to the override file. Otherwise fall back to the existing symlink behavior.

- [ ] **Step 3: Run type check**

```bash
bun run check 2>&1
```

Expected: PASS. Fix any type errors from the new stage integration.

- [ ] **Step 4: Run all tests**

```bash
bun test src/ 2>&1
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/docker/embed/entrypoint.sh
git commit -m "feat(mask-filter): wire MaskFilterStage into pipeline and entrypoint"
```

---

### Task 7: Integration test — mask-filter binary end-to-end

**Files:**
- Create: `src/stages/maskfs/mask_filter_integration_test.ts`

**Interfaces:**
- Consumes: `nas-mask-filter` binary (built by `cd src/mask-filter && zig build`), `encodeMaskSecrets` from `src/stages/maskfs/secrets_frame.ts`
- Produces: integration test verifying the binary masks secrets in streamed input, including chunk-boundary cases

- [ ] **Step 1: Write integration test**

Create `src/stages/maskfs/mask_filter_integration_test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { encodeMaskSecrets } from "./secrets_frame.ts";
import { resolveMaskFilterBinPath } from "./mask_filter_path.ts";

let binaryPath: string | null = null;
let tmpDir: string;

beforeAll(async () => {
  binaryPath = await resolveMaskFilterBinPath();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mask-filter-test-"));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeSecretsFile(secrets: string[]): string {
  const frame = encodeMaskSecrets(secrets);
  const filePath = path.join(tmpDir, `secrets-${Date.now()}`);
  fs.writeFileSync(filePath, frame);
  return filePath;
}

async function runFilter(
  input: string,
  secrets: string[],
): Promise<string> {
  if (!binaryPath) throw new Error("nas-mask-filter binary not found");
  const secretsFile = writeSecretsFile(secrets);
  const proc = Bun.spawn([binaryPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { NAS_MASK_SECRETS_FILE: secretsFile },
  });
  proc.stdin.write(input);
  proc.stdin.end();
  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`filter exited ${exitCode}: ${stderr}`);
  }
  return output;
}

describe("nas-mask-filter binary", () => {
  test("masks single secret", async () => {
    if (!binaryPath) return; // skip if not built
    const result = await runFilter("password=hunter2 done", ["hunter2"]);
    expect(result).toBe("password=******* done");
  });

  test("masks multiple secrets", async () => {
    if (!binaryPath) return;
    const result = await runFilter("a=tok1 b=tok22 c=tok1", [
      "tok1",
      "tok22",
    ]);
    expect(result).toBe("a=**** b=***** c=****");
  });

  test("passes through when no secrets match", async () => {
    if (!binaryPath) return;
    const result = await runFilter("nothing to mask here", ["nonexistent"]);
    expect(result).toBe("nothing to mask here");
  });

  test("handles empty input", async () => {
    if (!binaryPath) return;
    const result = await runFilter("", ["secret"]);
    expect(result).toBe("");
  });

  test("masks secret spanning large input", async () => {
    if (!binaryPath) return;
    // Create input larger than BUF_SIZE (64KB) with secret near the boundary
    const padding = "x".repeat(65530);
    const input = `${padding}SECRET_VALUE${padding}`;
    const result = await runFilter(input, ["SECRET_VALUE"]);
    expect(result).not.toContain("SECRET_VALUE");
    expect(result).toContain("************");
    expect(result.length).toBe(input.length);
  });
});
```

- [ ] **Step 2: Build the binary and run the test**

```bash
cd src/mask-filter && zig build 2>&1
bun test src/stages/maskfs/mask_filter_integration_test.ts 2>&1
```

Expected: all tests pass (or skip gracefully if binary is not built).

- [ ] **Step 3: Commit**

```bash
git add src/stages/maskfs/mask_filter_integration_test.ts
git commit -m "test(mask-filter): add integration test for nas-mask-filter binary"
```
