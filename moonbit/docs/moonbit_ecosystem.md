---
name: moonbit_ecosystem
description: MoonBit ecosystem status - available packages, missing capabilities, FFI requirements
type: project
---

## MoonBit エコシステム状況 (2026-03-20)

### 標準ライブラリ (moonbitlang/core)
- 基本型、コレクション (Array, Map, Set等)、文字列操作、JSON パース (`@json`)
- `@env.args()` でCLI引数取得、`@env.current_dir()` でcwd
- `println()` は builtin (Show trait 経由)
- **プロセス実行は無い**

### moonbitlang/x (v0.4.41)
- `@fs` : ファイルI/O (`read_file_to_string`, `write_string_to_file`, `path_exists`, `read_dir`, `is_dir`, `is_file`)
- `@ffi` : String⇔Bytes変換ヘルパー (`mbt_string_to_utf8_bytes`, `utf8_bytes_to_mbt_string`)
- `@sys` : `get_cli_args`, `get_env_var`, `get_env_vars`, `set_env_var`, `exit`
- **サブプロセス実行は無い** → C FFI で自作が必要

### 無いもの（自作が必要）
1. **サブプロセス実行** - `popen()` / `system()` の C FFI ラッパーが必要
2. **YAML パーサー** - 外部コマンド (`nix eval --json`) で回避
3. **HTTP クライアント** - 不要（nas では docker CLI を呼ぶだけ）
4. **シグナルハンドリング** - C FFI が必要（今回はスキップ）

### C FFI 参考実装
- `moonbitlang/x/fs/fs_native.c` + `fs_native.mbt` が最良のリファレンス
- moon.pkg.json に `"native": {}` セクションが必要（cc-flags, cc-link-flags）

### moon.pkg.json の import
- `"import": ["moonbitlang/x/fs", "moonbitlang/x/sys"]` のように完全パスで指定
- パッケージ内では `@fs.read_file_to_string()` のようにエイリアスで参照

**Why:** MoonBit はエコシステムが小さく、CLIツール開発に必要な基本機能がいくつか欠けている。

**How to apply:** 新しいMoonBitコードを書く前に、必要な機能がcore/xにあるか確認。無ければ C FFI を計画に含める。
