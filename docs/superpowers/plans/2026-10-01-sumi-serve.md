# sumi serve Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `sumi serve --secrets-file FILE --listen SOCK` を追加し、sumi のテキスト形式の secrets ファイルを読むマスクブローカーをホストで起動できるようにする。

**Architecture:** nas-mask-filter のブローカー実装 `src/mask-filter/serve.zig` を `lib/process-supervisor/serve.zig` に移し、`supervise` モジュールから `supervise.serve` として公開する。nas-mask-filter と sumi はそれぞれ自分の形式で値の一覧を読み、`supervise.serve.run` を呼ぶ。

**Tech Stack:** Zig 0.15.2, bash (black-box テスト), jq, Python 3

**Spec:** `docs/superpowers/specs/2026-10-01-sumi-serve-design.md`

## Global Constraints

- 実装者・レビュアーは、着手前に次を読む: spec、`.claude/skills/security-constraints/SKILL.md`、`.claude/skills/test-policy/SKILL.md`、`lib/process-supervisor/serve.zig` (移動前は `src/mask-filter/serve.zig`) の冒頭コメント。
- serve.zig の中身は変えない。移動は `git mv` で行う。
- どの `build.zig` も変えない。Zig 0.15 では 1 ファイルは 1 モジュールにしか属せないので、serve.zig は supervise.zig から import して `supervise` モジュールに含める。
- `sumi serve` の診断は定数の文言、利用者が渡したパス、`secrets.describe` の理由、`@errorName` だけにする。ストリーム由来のバイトを stdout/stderr に書かない。
- 終了コード: 引数とパスの誤りは 2 (`EXIT_USAGE`)、secrets ファイルを読めないときと `serve.run` がエラーで返ったときは 1。
- `serve.run` には arena ではなく `std.heap.page_allocator` を渡す。接続ごとに確保と解放を繰り返すためである。
- コメントは、ファイルを半年後に読む人に向けて書く。変更の経緯 (「移した」「以前は」) はコードに書かず、コミットメッセージに書く。
- コミットは `git-commit` スキルに従う。ブランチは作らない (main で作業する)。
- Zig のコマンドはリポジトリルートの `package.json` のスクリプト経由で実行する。black-box テストには bash, jq, python3 が要る。

## File Structure

| ファイル | 責務 |
|---|---|
| `lib/process-supervisor/serve.zig` | ブローカーのサーバー (移動のみ) |
| `lib/process-supervisor/supervise.zig` | `pub const serve` の公開と、テストルートへの組み込み |
| `src/mask-filter/mask_filter.zig` | `supervise.serve` を使うように import を替える |
| `lib/README.md` | ライブラリの所有表 |
| `contrib/sumi/main.zig` | `serve` サブコマンドの引数解釈と起動 |
| `contrib/sumi/tests/run-tests.sh` | `sumi serve` の black-box テスト |
| `contrib/sumi/README.md` | `sumi serve` と Dev Container の手順 |
| `contrib/sumi/CHANGELOG.md` | Unreleased の追記 |

---

### Task 1: serve.zig を lib/process-supervisor へ移す

**Files:**
- Move: `src/mask-filter/serve.zig` → `lib/process-supervisor/serve.zig`
- Modify: `lib/process-supervisor/supervise.zig` (import 群は 61-64 行、`test {}` は 834-836 行)
- Modify: `src/mask-filter/mask_filter.zig` (34 行の import、213 行の `serve.run`、236-238 行の `test {}`)
- Modify: `lib/README.md`

**Interfaces:**
- Produces: `supervise.serve.run(gpa: std.mem.Allocator, secrets: []const []const u8, sock_path: []const u8) !u8`、`supervise.serve.validateSocketPath(path: []const u8) error{EmptySocketPath, SocketPathTooLong}!void`、`supervise.serve.MAX_SOCKET_PATH: usize = 107`。Task 2 がこれを使う。

- [ ] **Step 1: 移動前のテスト数を記録する**

Run: `bun run test:process-supervisor-unit 2>&1 | grep -E 'tests? passed|passed;'` と `bun run test:mask-filter-unit 2>&1 | grep -E 'tests? passed|passed;'`
Expected: 両方成功する。表示されたテスト数 (例: `N/N tests passed`) を控える。

- [ ] **Step 2: ファイルを移す**

```bash
git mv src/mask-filter/serve.zig lib/process-supervisor/serve.zig
```

- [ ] **Step 3: supervise.zig から公開する**

`lib/process-supervisor/supervise.zig` の `const relay_mod = @import("relay.zig");` の直後に追加する:

```zig
/// ホスト側のブローカー。relay はこのサーバーのクライアントにあたる。
pub const serve = @import("serve.zig");
```

末尾の `test {}` を次に替える:

```zig
test {
    _ = relay_mod;
    _ = serve;
}
```

- [ ] **Step 4: mask_filter.zig を supervise.serve に替える**

`src/mask-filter/mask_filter.zig` の 34 行 `const serve = @import("serve.zig");` を削除し、35 行の `const supervise = @import("supervise");` の直後に追加する:

```zig
const serve = supervise.serve;
```

236-238 行の次のブロックを削除する (serve のテストは lib/process-supervisor のテストルートで走る):

```zig
test {
    _ = @import("serve.zig");
}
```

冒頭コメント 18 行の `詳細は serve.zig の冒頭コメントを参照。` を `詳細は lib/process-supervisor/serve.zig の冒頭コメントを参照。` に替える。212 行のコメント `(serve.zig の「出力の不変条件」を参照)` も同様に `(lib/process-supervisor/serve.zig の「出力の不変条件」を参照)` に替える。

- [ ] **Step 5: テストを走らせ、テスト数の移動を確かめる**

Run: `bun run test:process-supervisor-unit 2>&1 | grep -E 'tests? passed|passed;'` と `bun run test:mask-filter-unit 2>&1 | grep -E 'tests? passed|passed;'`
Expected: 両方成功する。process-supervisor は Step 1 より 4 件多く、mask-filter は 4 件少ない (serve.zig の `validateSocketPath` の 4 件)。

- [ ] **Step 6: nas-mask-filter と sumi がビルドできることを確かめる**

Run: `(cd src/mask-filter && zig build) && (cd contrib/sumi && zig build)`
Expected: エラーなく終わる。

- [ ] **Step 7: lib/README.md を更新する**

所有表の `process-supervisor/` の行を次に替える:

```markdown
| `process-supervisor/` | Child-process supervision, output draining, the masking-broker relay client, and the broker server | mask-filter, sumi |
```

`` `masking/root.zig` exposes `mask` and `stream`. `` で始まる段落の 2 文目を次に替える:

```markdown
`process-supervisor/supervise.zig` is the `supervise` module and depends
on `masking`; it exposes the broker server as `supervise.serve`.
```

その次の段落の最終文 `` The mask-filter broker server stays in `src/mask-filter/serve.zig`; the shared relay is its client. `` を次に替える:

```markdown
The broker server (`serve.zig`) and its client (`relay.zig`) both live in
`process-supervisor/`; each product reads its own secrets format and passes
the values to `supervise.serve.run`.
```

- [ ] **Step 8: Commit**

```bash
git add lib/process-supervisor/serve.zig lib/process-supervisor/supervise.zig src/mask-filter/mask_filter.zig lib/README.md
git commit  # git-commit スキルで refactor(mask-filter) / refactor(process-supervisor) のメッセージを作る
```

---

### Task 2: sumi serve サブコマンド

**Files:**
- Modify: `contrib/sumi/main.zig` (冒頭コメント 1-20 行、`usage_text` 41-55 行、`runFilter` の後に関数追加、`dispatch` 226-227 行付近、テスト末尾)
- Modify: `contrib/sumi/tests/run-tests.sh` (12-13 行の trap、`# --- filter and run` の節の後に新しい節)
- Modify: `contrib/sumi/README.md` (70-81 行の `--socket` の節)
- Modify: `contrib/sumi/CHANGELOG.md` (`## Unreleased`)

**Interfaces:**
- Consumes: `supervise.serve.run`, `supervise.serve.validateSocketPath` (Task 1)、`secrets.load`, `secrets.describe`, `usage`, `isOptionValue` (main.zig 既存)
- Produces: `parseServeArgs(args: []const []const u8) error{InvalidArguments}!ServeArgs`、`ServeArgs = struct { secrets_file: []const u8, listen: []const u8 }`

- [ ] **Step 1: 引数解釈の失敗するテストを書く**

`contrib/sumi/main.zig` の末尾 (`test "filter arguments have one fixed form"` の後) に追加する:

```zig
test "serve arguments need both options once, in either order" {
    const got = try parseServeArgs(&.{ "--secrets-file", "/s", "--listen", "/sock" });
    try testing.expectEqualStrings("/s", got.secrets_file);
    try testing.expectEqualStrings("/sock", got.listen);
    const swapped = try parseServeArgs(&.{ "--listen", "/sock", "--secrets-file", "/s" });
    try testing.expectEqualStrings("/s", swapped.secrets_file);
    try testing.expectEqualStrings("/sock", swapped.listen);
}

test "serve arguments reject missing, repeated and unknown options" {
    try testing.expectError(error.InvalidArguments, parseServeArgs(&.{}));
    try testing.expectError(error.InvalidArguments, parseServeArgs(&.{ "--secrets-file", "/s" }));
    try testing.expectError(error.InvalidArguments, parseServeArgs(&.{ "--listen", "/sock" }));
    try testing.expectError(error.InvalidArguments, parseServeArgs(&.{ "--secrets-file", "/s", "--listen" }));
    try testing.expectError(error.InvalidArguments, parseServeArgs(&.{ "--secrets-file", "--listen", "/sock" }));
    try testing.expectError(error.InvalidArguments, parseServeArgs(&.{ "--secrets-file", "/s", "--secrets-file", "/t", "--listen", "/sock" }));
    try testing.expectError(error.InvalidArguments, parseServeArgs(&.{ "--socket", "/b", "--listen", "/sock" }));
    try testing.expectError(error.InvalidArguments, parseServeArgs(&.{ "--secrets-file", "/s", "--listen", "/sock", "stray" }));
}

test "serve rejects a socket path that cannot be bound before reading the list" {
    const too_long = "/" ** (supervise.serve.MAX_SOCKET_PATH + 1);
    try testing.expectEqual(@as(u8, EXIT_USAGE), try dispatch(testing.allocator, &.{ "sumi", "serve", "--secrets-file", "/nonexistent/sumi-secrets", "--listen", too_long }, unavailableSelfPath));
}
```

- [ ] **Step 2: テストが失敗することを確かめる**

Run: `bun run test:sumi-unit`
Expected: FAIL。`use of undeclared identifier 'parseServeArgs'` でコンパイルに失敗する。

- [ ] **Step 3: parseServeArgs と runServe を実装する**

`contrib/sumi/main.zig` の `runFilter` の直後に追加する:

```zig
const ServeArgs = struct { secrets_file: []const u8, listen: []const u8 };

fn parseServeArgs(args: []const []const u8) error{InvalidArguments}!ServeArgs {
    var secrets_file: ?[]const u8 = null;
    var listen: ?[]const u8 = null;
    var i: usize = 0;
    while (i < args.len) : (i += 2) {
        if (i + 1 >= args.len or !isOptionValue(args[i + 1])) return error.InvalidArguments;
        const slot = if (std.mem.eql(u8, args[i], "--secrets-file"))
            &secrets_file
        else if (std.mem.eql(u8, args[i], "--listen"))
            &listen
        else
            return error.InvalidArguments;
        if (slot.* != null) return error.InvalidArguments;
        slot.* = args[i + 1];
    }
    return .{
        .secrets_file = secrets_file orelse return error.InvalidArguments,
        .listen = listen orelse return error.InvalidArguments,
    };
}

/// serve は一覧をこのプロセスに持ち、`--socket` で接続してくる hook と run の
/// 問い合わせに答える。診断は定数の文言と利用者が渡した値だけにし、
/// 接続から届いたバイトは混ぜない (supervise.serve の「出力の不変条件」)。
fn runServe(allocator: std.mem.Allocator, args: []const []const u8) u8 {
    const parsed = parseServeArgs(args) catch return usage("serve takes --secrets-file F --listen SOCKET");
    supervise.serve.validateSocketPath(parsed.listen) catch return usage("the --listen path must be 1 to 107 bytes");
    const list = secrets.load(allocator, parsed.secrets_file) catch |err| {
        std.debug.print("sumi: {s}\n", .{secrets.describe(err)});
        return 1;
    };
    // 接続ごとに確保と解放を繰り返すので、arena ではなく解放できるアロケータを渡す。
    return supervise.serve.run(std.heap.page_allocator, list, parsed.listen) catch |err| {
        std.debug.print("sumi: serve failed: {s}\n", .{@errorName(err)});
        return 1;
    };
}
```

`dispatch` の `if (std.mem.eql(u8, sub, "run")) return runSupervised(allocator, args);` の直後に追加する:

```zig
    if (std.mem.eql(u8, sub, "serve")) return runServe(allocator, args);
```

- [ ] **Step 4: usage と冒頭コメントを更新する**

冒頭コメントの `//!   sumi filter --secrets-file F` の直後に追加する:

```zig
//!   sumi serve  --secrets-file F --listen SOCKET
```

冒頭コメントの SOURCE の段落 (`//! SOURCE は ...` から `//! (masker.zig)。`) を次に替える:

```zig
//! SOURCE は `--secrets-file F` か `--socket SOCKET` のどちらか 1 つ。後者は値の一覧を
//! 読まず、ブローカーへバイト列を送ってマスクさせる (masker.zig)。ブローカーは
//! `sumi serve` か nas の `nas-mask-filter --serve` で、どちらも一覧をホスト側に持つ。
```

`usage_text` の `\\       sumi filter --secrets-file F` の直後に追加する:

```zig
    \\       sumi serve  --secrets-file F --listen SOCKET
```

- [ ] **Step 5: unit テストが通ることを確かめる**

Run: `bun run test:sumi-unit`
Expected: PASS。追加した 3 件を含めて全件成功する。

- [ ] **Step 6: black-box テストの cleanup を serve に対応させる**

`contrib/sumi/tests/run-tests.sh` の 12-13 行

```bash
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
```

を次に替える:

```bash
work="$(mktemp -d)"
serve_pid=""
serve_dir=""
cleanup() {
  [ -n "$serve_pid" ] && kill "$serve_pid" 2>/dev/null
  rm -rf "$work"
  [ -n "$serve_dir" ] && rm -rf "$serve_dir"
}
trap cleanup EXIT
```

- [ ] **Step 7: black-box テストを書く**

`contrib/sumi/tests/run-tests.sh` の `# --- filter and run` の節の最後 (`"$sumi" run --secrets-file "$work/empty.txt"` の検査群の後、次の `# ---` 見出しの前) に、次の節を追加する。ソケットのパスは 107 バイト以内に収める必要があり、`$TMPDIR` が長い環境もあるので `/tmp` 直下に作る。

```bash
# --- serve -------------------------------------------------------------------

serve_dir="$(mktemp -d /tmp/sumi-serve.XXXXXX)"
serve_sock="$serve_dir/mask.sock"
decoded="s3rv3-d3c0y"
printf '%s\n%s\n' "$current" "$(printf %s "$decoded" | base64)" > "$work/serve-secrets.txt"

"$sumi" serve --secrets-file "$work/serve-secrets.txt" --listen "$serve_sock" 2>"$work/serve.err" &
serve_pid=$!
for _ in $(seq 50); do
  [ -S "$serve_sock" ] && break
  sleep 0.1
done
check "serve creates its socket" "yes" "$([ -S "$serve_sock" ] && echo yes || echo no)"
check "serve socket is private to its owner" "600" "$(stat -c %a "$serve_sock" 2>/dev/null)"

out="$("$sumi" run --socket "$serve_sock" --shell /bin/bash 'printf "a=%s b=%s\n" "Tr0ub4dor" "s3rv3-d3c0y"')"
record_success_status "run over serve" "$?"
check "run over serve masks a listed value and a decoded base64 line" 'a=********* b=***********' "$out"

out="$(printf '%s' "$(jq -nc --arg v "$current" '{tool_name:"Bash",tool_input:{command:"cat .env"},tool_response:{stdout:("pw=" + $v),stderr:""}}')" \
  | "$sumi" hook --agent claude post-tool --socket "$serve_sock" | delivered)"
check "post-tool over serve masks the output" 'pw=*********' "$(jq -nr --arg o "$out" '$o | fromjson | .stdout')"

kill "$serve_pid" 2>/dev/null
wait "$serve_pid" 2>/dev/null
serve_pid=""

"$sumi" serve --secrets-file "$work/missing.txt" --listen "$serve_dir/missing.sock" >/dev/null 2>"$work/serve-missing.err"
status=$?
check "serve with a missing list exits 1" "1" "$status"
check "serve with a missing list creates no socket" "no" "$([ -e "$serve_dir/missing.sock" ] && echo yes || echo no)"
check "serve with a missing list says why" "yes" "$(grep -q 'missing or unreadable' "$work/serve-missing.err" && echo yes || echo no)"

"$sumi" serve --secrets-file "$work/secrets.txt" </dev/null >/dev/null 2>&1
check "serve without --listen exits 2" "2" "$?"
```

- [ ] **Step 8: black-box テストが通ることを確かめる**

Run: `bun run test:sumi-integration`
Expected: 最後の行が `passed N, failed 0`。`serve` の節の 8 件がすべて `ok` で表示される。
`ls -d /tmp/sumi-serve.* 2>/dev/null` が何も出さないこと (cleanup が働いていること) も確かめる。

- [ ] **Step 9: README に sumi serve と Dev Container の手順を書く**

`contrib/sumi/README.md` の `### 秘密一覧を手元に置かない（`--socket`）` の節 (70-81 行) を次に替える:

````markdown
### 秘密一覧を手元に置かない（`--socket`）

`--secrets-file F` の代わりに `--socket SOCKET` を渡すと、sumi は秘密一覧を読みません。値の判定と置き換えは、`SOCKET` で待ち受けるブローカーに問い合わせます。エージェントと同じ環境に一覧を置けない場合（コンテナ内の hook など）に使います。

ブローカーは `sumi serve` で起動します。秘密ファイルを読み、`--listen` のパスで待ち受けます。kill するまで動き続けます。ソケットを置くディレクトリは自動では作らないので、先に作ってください。

```
mkdir -p -m 700 "$XDG_RUNTIME_DIR/sumi"
sumi serve --secrets-file ~/.claude/sumi/secrets.txt --listen "$XDG_RUNTIME_DIR/sumi/mask.sock"
```

nas は `mask.filter` が有効なとき、自前のブローカー（`nas-mask-filter --serve`）を起動し、この形で sumi を設定します。

#### Dev Container で使う

ホストで `sumi serve` を起動し、ソケットのあるディレクトリをコンテナに mount します。秘密ファイルのあるディレクトリは mount しません。

```jsonc
// devcontainer.json
{
  "mounts": [
    "source=${localEnv:XDG_RUNTIME_DIR}/sumi,target=/run/sumi,type=bind"
  ]
}
```

コンテナ内で次を実行します。

```
sumi init --agent claude --socket /run/sumi/mask.sock
```

* ソケットファイルではなく、ディレクトリを mount してください。`sumi serve` を再起動するとソケットが作り直され、ファイル単体の mount は古いソケットを指したままになります。
* ソケットの権限は 0600 です。コンテナのユーザーの UID を、`sumi serve` を起動したホストのユーザーと合わせてください。
* `sumi serve` は起動時に、同じパスにある古いソケットを消します。同じパスで 2 つ起動すると、後から起動した方だけが応答します。
* 秘密ファイルを変更したら `sumi serve` を再起動してください。起動後に読み直すことはしません。

#### 注意

* 2 つのオプションを同時には指定できません。
* socket に接続できない場合、hook は出力を差し替えて伏せ、プロンプトを止めます。`run` は出力を捨てて終了コード 121 で終わります。
* socket へ届く値を推測して送れば、伏せられるかどうかで答え合わせができます。socket はエージェントから到達できる前提で、接続数などの上限はサーバー側で持ちます。
* 伏せた結果が元と同じになる値（`*` だけから成る値）は「含まない」と判定します。
````

- [ ] **Step 10: CHANGELOG に追記する**

`contrib/sumi/CHANGELOG.md` の `## Unreleased` の直後に追加する:

```markdown

### Added

- `sumi serve --secrets-file FILE --listen SOCKET` runs a mask broker on the host, so hooks and `run` inside a Dev Container can use `--socket` without the secrets file being mounted.
```

- [ ] **Step 11: Commit**

```bash
git add contrib/sumi/main.zig contrib/sumi/tests/run-tests.sh contrib/sumi/README.md contrib/sumi/CHANGELOG.md
git commit  # git-commit スキルで feat(sumi) のメッセージを作る
```

---

## 完了時の確認

リポジトリルートで、`bun run test` と `hostexec bun run test` をこの順に 1 回ずつ実行する (片方が失敗しても両方実行する)。環境ごとに結果とスキップを報告する。`src/stages/maskfs/mask_filter_integration_test.ts` (`nas-mask-filter --serve` を起動する) がスキップされずに通ったかも確かめる。
