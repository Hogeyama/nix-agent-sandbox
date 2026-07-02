# maskfs スタンドアロン CLI

日付: 2026-07-03
ステータス: ドラフト

## 目的

nas-maskfs を nas に依存しない汎用ツールとして公開する。AI コーディングツール (Cursor, Windsurf, Aider 等)、デモ、CI/CD 等でワークスペース内のシークレットを透過的にマスクできるようにする。

## CLI インターフェース

```bash
maskfs <sourceDir> <mountpoint> --secrets-file <path> [--write-policy readonly|passthrough]
```

- `<sourceDir>`: マスク対象のディレクトリ
- `<mountpoint>`: マスク済みビューのマウント先（存在しなければ作成）
- `--secrets-file <path>`: シークレットが改行区切りで入ったファイル。空行は無視。各値は 4 バイト以上。nas config では `lines:<path>` source として同じ形式を利用可能
- `--write-policy`: `readonly`(デフォルト) / `passthrough`

フォアグラウンドで動作し、Ctrl-C (SIGINT) / SIGTERM で `fusermount3 -u` してから終了する。

## 実装方針

### CLI ラッパー (シェルスクリプト)

`src/maskfs/maskfs` (シェルスクリプト) を新規作成。責務:

1. 引数パース (`sourceDir`, `mountpoint`, `--secrets-file`, `--write-policy`)
2. `--secrets-file` を読み、空行を除去、各行が 4 バイト以上か検証
3. stdin バイナリフレーム (u32le count + [u32le len + bytes] × count) を生成
4. `mountpoint` が存在しなければ `mkdir -p`
5. フレームを stdin に渡して `nas-maskfs` を exec
6. SIGINT/SIGTERM トラップで `fusermount3 -u <mountpoint>` を実行

バイナリフレーム生成は `printf` + `od` か Python ワンライナーで十分（外部依存なし）。

### flake.nix

```nix
# packages output に追加
packages.${system}.maskfs = pkgs.symlinkJoin {
  name = "maskfs";
  paths = [ maskfs ];  # 既存の nas-maskfs derivation
  postBuild = ''
    cp ${./src/maskfs/maskfs} $out/bin/maskfs
    chmod +x $out/bin/maskfs
  '';
};
```

`nix run .#maskfs` / `nix profile install .#maskfs` で使えるようにする。

### 既存 nas-maskfs バイナリ

変更なし。stdin フレーミングプロトコルはそのまま。CLI ラッパーがプロトコルを吸収する。

## テスト

- シェルスクリプトの引数パース: 不正な引数でエラー終了することを確認
- 統合テスト (`src/stages/maskfs/maskfs_standalone_test.ts`): FUSE 環境ありの場合のみ実行。secrets file → maskfs CLI → マウント → `cat` でマスク確認 → Ctrl-C シミュレート → アンマウント確認
- `nix build .#maskfs` が成功すること

## スコープ外

- `--secrets-from .env --keys` 形式の dotenv パース (将来拡張)
- `--daemon` バックグラウンドモード (将来拡張)
- nas パイプラインへの影響: なし (nas は引き続き stdin フレーミングで直接 nas-maskfs を呼ぶ)
