---
name: moonbit_syntax_pitfalls
description: MoonBit language syntax pitfalls discovered through compile errors - reserved words, FFI patterns, deprecated syntax, API differences
type: feedback
---

MoonBitのコンパイルエラーから学んだ構文・APIの注意点（2026-03-20時点、moon 0.1.20260320）。

## 予約語
- `readonly` はフィールド名に使えない（パースエラー）。`read_only` などにリネームすること。

## エラーハンドリング構文
- `!Error` は deprecated。`raise Error` を使う。
  - NG: `fn foo() -> Int!Error`
  - OK: `fn foo() -> Int raise Error`
- `f(x)!` も deprecated。普通に `f(x)` と書く（raise付き関数は自動伝播）。

## C FFI パターン
- `#borrow` はパラメータ内ではなく、関数宣言の前にアトリビュートとして書く:
  ```moonbit
  ///|
  #borrow(path, mode)
  extern "C" fn fopen_ffi(path : Bytes, mode : Bytes) -> Handler = "c_func_name"
  ```
- `#external` アトリビュートは外部ハンドル型に使う: `#external` + `priv type Handler`
- C側の関数名は `MOONBIT_FFI_EXPORT` マクロで宣言
- `moonbit_bytes_t` = `Bytes`, `moonbit_make_bytes(len, 0)` でバイト列確保
- String → Bytes(C文字列)変換: `@ffi.mbt_string_to_utf8_bytes(s, true)` (trueはnull終端追加)
- Bytes → String変換: `@ffi.utf8_bytes_to_mbt_string(bytes)`
- これらは `moonbitlang/x` の `@ffi` パッケージにある（`moonbitlang/x/ffi`）

## Bytes型
- `Bytes` への `op_set` (`bytes[i] = x`) は使えない（immutable）
- `Bytes::make(size, init_byte)` で作成
- 手動バイト操作よりも `@ffi.mbt_string_to_utf8_bytes` を使うべき

## String型
- `s.to_bytes()` は deprecated → `@encoding.utf8.encode` 系を使う（ただしcore直接のencodingパッケージは要import確認）
- `s.substring(start=, end=)` は deprecated → スライス `s[start:end].to_string()` を使う
- `s.charcode_at(i)` は存在しない

## println
- `println(x)` は builtin にある（`pub fn[T : Show] println(T) -> Unit`）
- ただし core library の bundle が壊れていると "unbound" エラーになる
- moonbit-overlay (Nix) の core bundle は 32byte = 空で壊れていた（2026-03-20時点）

## for ループ
- `for i = 0; i < n; i = i + 1 { ... }` の形式（C風ではない）
- `for item in array { ... }` も使える

## Map リテラル
- `{}` で空Map、`{ "key": value }` でMap初期化

**Why:** MoonBitは pre-1.0 で API が頻繁に変わる。公式ドキュメントより実際のコンパイラエラーメッセージのほうが正確。

## suberror (カスタムエラー型)
- `suberror` に `derive(Show)` を付けないと `.to_string()` が使えない
- `Show::to_string(e)` でも `impl Show` が無いとエラー
- クロージャ内で `raise` する関数は使えない → `raise` しない代替関数を用意すること（例: `parse_profile_safe` が `Profile?` を返す）

## Json パターンマッチ
- `@json.JsonValue` ではなく `Json` 型を使う（builtinに移動済み）
- constructors は `Json::String(s)`, `Json::Object(obj)`, `Json::Array(arr)`, `Json::True`, `Json::False`, `Json::Null`
- `@json.parse(str)` でパース（`moonbitlang/core/json` をimportすること）
- `Json::Object` の中身は `Map[String, Json]` で `.get(key)` で `Json?` を返す

## Option
- `.or()` は deprecated → `.unwrap_or()` を使う

## 単一フィールドのstruct リテラル
- `{ enable }` は ambiguous block warning → `{ enable, }` とカンマ付きにする

## moon.pkg.json (パッケージ設定)
- C stub ファイルは `"native-stub": ["file.c"]` で指定（これがないとリンクエラー）
- ターゲット固有の .mbt ファイルは `"targets": { "file.mbt": ["native", "llvm"] }` で指定
- import は完全パス: `"moonbitlang/x/fs"` のように
- `moonbitlang/x/internal/ffi` は internal なので外部パッケージからimport不可 → string変換は自前で書くこと
- 参考: `moonbitlang/x/fs/moon.pkg` の `options` セクション

## moon.pkg.json の形式
- `.mooncakes` 内のパッケージは `moon.pkg` (拡張子なし JSON) を使うが、自分のプロジェクトでは `moon.pkg.json` でもOK

## テスト
- `_test.mbt` はブラックボックステスト（pub のみアクセス可）
- `_wbtest.mbt` はホワイトボックステスト（パッケージ内部の関数にアクセス可）
- `inspect(value, content="")` + `moon test -u` でインラインスナップショット自動生成
- `f()!` は deprecated → テスト内でも `f()` と書く（raise は自動伝播）
- `#|` 複数行文字列は関数引数に直接渡せない → `let json = #|...` で束縛してから渡す
- `Map.size()` は deprecated → `Map.length()` を使う

**How to apply:** MoonBitコードを書くとき、上記のパターンに注意。特にFFIは `moonbitlang/x/fs/fs_native.mbt` を参考実装として見ること。
