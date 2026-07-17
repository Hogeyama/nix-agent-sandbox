# stdout/stderr シークレットマスクフィルタ設計

日付: 2026-07-17
ステータス: 設計中

## 目的

コンテナ内で実行されるコマンドの stdout/stderr に含まれるシークレット値をマスクし、AI agent の LLM コンテキストへシークレットが流入する経路を塞ぐ。既存の maskfs(ファイル読み取り時マスク)と proxy(HTTP リクエストマスク)に加え、コマンド出力という第 3 の経路をカバーする。

### 要件

- コンテナ内のほぼ全てのコマンド出力(stdout/stderr)からシークレット値をマスクする
- 全コマンド出力を経由するため、十分な性能が必要(Zig 実装)
- 既存の mask.values 設定でシークレットを指定する(新しい設定項目は `filter: boolean` のみ)
- maskfs/proxy と独立して有効/無効を切り替えられる
- static executable の出力もマスクできる(bash wrapper の process substitution で fd を pipe 化)

### スコープ外

- LD_PRELOAD による write() フック(将来の拡張として残す)
- hostexec 出力のマスク復活(別タスク)
- bash 以外のシェル(zsh, fish 等)のラッパー

## アーキテクチャ

```
コンテナ内:

  コマンド ──(stdout)──> pipe ──> nas-mask-filter ──> 本来の stdout
  コマンド ──(stderr)──> pipe ──> nas-mask-filter ──> 本来の stderr

  bash wrapper (PATH 上の bash) が process substitution で pipe を設定:
    exec > >(nas-mask-filter) 2> >(nas-mask-filter >&2)
    exec /bin/bash "$@"
```

ホスト側でシークレットを resolve し、secrets_frame 形式のバイナリファイルとしてコンテナに bind-mount する。コンテナ内の filter binary はこのファイルからシークレットを読む。

## コンポーネント

### 1. nas-mask-filter (Zig binary)

stdin から読んだバイトストリームのシークレットをマスクして stdout に書くフィルタプログラム。

**シークレット読み込み**: 環境変数 `NAS_MASK_SECRETS_FILE` で指定されたファイルパスから secrets_frame 形式(u32le count + length-prefixed UTF-8)で読む。maskfs の `readSecretsFromStdin` と同じフォーマット。

**ストリーミングマスクアルゴリズム**:

```
overlap = []  // 初回は空

loop:
    chunk = read(stdin, 64KB)
    if EOF and overlap is empty: break
    if EOF:
        maskAll(overlap, secrets)
        write(stdout, overlap)
        break
    combined = overlap ++ chunk
    maskAll(combined, secrets)
    safe_end = combined.len - (maxSecretLen - 1)
    write(stdout, combined[0..safe_end])
    overlap = combined[safe_end..]
```

- バッファサイズ 64KB(パイプのデフォルトバッファサイズと同等)
- overlap は最大 `maxSecretLen - 1` バイト(通常数十〜数百バイト)
- `maskAll` は既存の `mask.zig` を共有モジュールとして使用
- アロケーション失敗時は fail-closed(mask.zig の既存挙動: バッファ全体を `*` に)

### 2. Bash wrapper script

`/tmp/nas-bash-override/bash` に配置(既存のシンボリックリンクを置き換え)。

```bash
#!/bin/bash
if [ -n "$NAS_MASK_SECRETS_FILE" ] && [ -f "$NAS_MASK_FILTER" ]; then
  exec > >("$NAS_MASK_FILTER") 2> >("$NAS_MASK_FILTER" >&2)
fi
exec /bin/bash "$@"
```

- `NAS_MASK_SECRETS_FILE` 未設定時はマスクなしで素通し
- `NAS_MASK_FILTER` で filter binary のコンテナ内パスを指定(`/opt/nas/mask-filter/nas-mask-filter`)
- `/bin/bash` を直接 exec することで再帰呼出しを回避
- inner bash がインタラクティブモードで起動すれば readline は正常動作

**カバー範囲**:
- bash 経由で起動される全コマンド(dynamic/static 問わず): fd 1/2 が既に pipe なのでマスクされる
- `bash -c 'cmd'`, `bash -l`, `bash script.sh`: 全て正常動作
- inner bash が `exec static_binary` した場合: fd はそのまま pipe を指すのでマスクされる
- filter プロセスの終了: inner bash 終了 → pipe close → filter が EOF で終了

### 3. 共有 mask.zig モジュール

`src/maskfs/mask.zig` を `src/zig/mask.zig` に移動し、maskfs と mask-filter の両方から `@import` する。

```
src/zig/
└── mask.zig              # maskAll, computeWindow, containsAny, maxSecretLen

src/maskfs/
├── build.zig             # addModule("mask", "../zig/mask.zig")
└── maskfs.zig

src/mask-filter/
├── build.zig             # addModule("mask", "../zig/mask.zig")
└── mask_filter.zig
```

mask.zig の内容は変更なし。ビルド定義のみ変更。

## 設定

`MaskConfig` に `filter` フィールドを追加する。

```typescript
interface MaskConfig {
  values: MaskValueConfig[];
  writePolicy: MaskWritePolicy;
  maskfs: boolean;
  proxy: boolean;
  filter: boolean;  // 新規: stdout/stderr フィルタマスク
}
```

- デフォルト: `true`(`mask.values` が存在する場合)
- `mask.values` が空/未設定の場合は filter も起動しない(既存ユーザーへの影響ゼロ)
- Pkl スキーマ(`src/config/Schema.pkl`)に `filter: Boolean = true` を追加
- バリデーション(`src/config/validate.ts`): `filter: true` かつ `values` が空の場合は警告

## Stage 統合

既存の `src/stages/maskfs/` stage を拡張する。maskfs と mask-filter は同じ secrets 供給元を使い、同じ `profile.mask` で制御されるため同居が自然。

### MaskFilterService (新規)

`src/stages/maskfs/mask_filter_service.ts` に Tag + Live + Fake を定義する。

**メソッド**:
- `prepareMaskFilter(plan)`: secrets_frame ファイル書き出し、bind-mount 設定の生成、環境変数の生成、bash wrapper スクリプト内容の生成を行い、stage result に必要な情報を返す

**effect-separation 準拠**:
- stage の `run()` は `maskFilterService.prepareMaskFilter(plan)` を呼ぶだけ
- D1(ファイル書き出し等の IO)と D2(orchestration)を分離
- bash wrapper スクリプトの内容生成は pure function(テスト可能)

### 処理フロー

1. `resolveMaskSecrets()` でシークレット値を解決(既存、maskfs と共用)
2. `encodeMaskSecrets()` で secrets_frame バイナリを生成(既存)
3. MaskFilterService が secrets_frame を一時ファイルに書き出し
4. Stage result に追加:
   - bind-mount: secrets_frame ファイル → `/run/nas/mask-secrets`(read-only)
   - bind-mount: `nas-mask-filter` binary → `/opt/nas/mask-filter/nas-mask-filter`(read-only)
   - 環境変数: `NAS_MASK_SECRETS_FILE=/run/nas/mask-secrets`, `NAS_MASK_FILTER=/opt/nas/mask-filter/nas-mask-filter`
5. bash wrapper スクリプトを生成し、entrypoint.sh の既存 bash-override ロジックに統合

### entrypoint.sh の変更

現在の bash-override ロジック(シンボリックリンク作成)を、mask filter 有効時は wrapper スクリプト生成に変更する。

```bash
# 現在: ln -sf /bin/bash "$NAS_BASH_OVERRIDE/bash"
# 変更後:
if [ -n "$NAS_MASK_SECRETS_FILE" ] && [ -f "$NAS_MASK_FILTER" ]; then
  cat > "$NAS_BASH_OVERRIDE/bash" << 'WRAPPER'
#!/bin/bash
exec > >(..."$NAS_MASK_FILTER"...) 2> >(..."$NAS_MASK_FILTER"... >&2)
exec /bin/bash "$@"
WRAPPER
  chmod +x "$NAS_BASH_OVERRIDE/bash"
else
  ln -sf /bin/bash "$NAS_BASH_OVERRIDE/bash"
fi
```

## Nix ビルド統合

`flake.nix` に `maskFilter` derivation を追加する。maskfs/hostexecIntercept と同じパターン。

```nix
maskFilter = pkgs.stdenv.mkDerivation {
  name = "nas-mask-filter";
  src = ./src/mask-filter;
  # ... zig build, ReleaseSafe, mask.zig を ../zig/ から参照
};
```

`nasAssets` に `mask-filter/nas-mask-filter` として含める。

dev mode は `src/mask-filter/zig-out/bin/nas-mask-filter` にフォールバック(resolveAssetBinary の既存パターン)。

## テスト戦略

### Zig

| テスト | 内容 |
|---|---|
| `mask.zig` 既存テスト | 移動後もそのまま動作(`zig build test`) |
| `mask_filter.zig` ユニットテスト | ストリーミングバッファリングロジック: overlap 処理、チャンク境界跨ぎ、EOF フラッシュ、空入力 |

### TypeScript

| テスト | カテゴリ | 内容 |
|---|---|---|
| `mask_filter_service_test.ts` | Unit | Fake FsService/ProcessService で D2 ロジックをテスト |
| `stage_test.ts` 拡張 | Unit | filter 有効/無効時の plan 分岐、環境変数・bind-mount 出力 |
| bash wrapper 生成 | Unit | pure function: 条件分岐、エスケープ |
| mask-filter 結合テスト | Integration | 実 binary を spawn、stdin にシークレット含むデータを流して stdout 検証。チャンク境界テスト含む |
