---
name: release
description: nas 本体、maskfs、sumi、vscode-nas-approval のリリースを準備・検証し、依頼された範囲でタグを公開して GitHub Actions と配布物を確認する。このリポジトリのリリース作業時に使う。
---

# Release

このリポジトリは製品ごとに独立したバージョンとタグを持つ。対象・バージョン・公開範囲を依頼から特定し、対象の workflow を読んでから進める。手順の記述やリリース準備だけの依頼ではタグを push しない。すでに公開まで依頼されている場合は重複して確認を求めない。

コマンドはリポジトリルートで実行する。

## 対象を選ぶ

| 対象 | バージョンの更新先 | CHANGELOG | タグ | workflow（`.github/workflows/` 配下） |
| --- | --- | --- | --- | --- |
| nas | `package.json` の `version` | `CHANGELOG.md` | `vX.Y.Z` | `release.yml` |
| maskfs | `contrib/maskfs/VERSION` | `contrib/maskfs/CHANGELOG.md` | `maskfs-vX.Y.Z` | `release-maskfs.yml` |
| sumi | `contrib/sumi/VERSION` | `contrib/sumi/CHANGELOG.md` | `sumi-vX.Y.Z` | `release-sumi.yml` |
| vscode-nas-approval | `contrib/vscode-nas-approval/VERSION` と同ディレクトリの `package.json` の `version` | `contrib/vscode-nas-approval/CHANGELOG.md` | `vscode-nas-approval-vX.Y.Z` | `release-vscode-nas-approval.yml` |

現行の workflow が受け付けるのは表の数値 3 要素のタグ。プレリリースの依頼は、そのタグで workflow が起動するか先に確認する。

maskfs のバージョンは `flake.nix` が VERSION から読み、Zig に `-Dversion` で渡す。flake 内に別のバージョン定数を追加しない。開発時の `zig build` は指定なしだと `dev` を表示するため、配布バージョンの検証には Nix の成果物を使う。nas は maskfs エンジンを引き続き内包するが、nas のリリースには単体 maskfs の配布物を添付しない。

## リリースを準備する

1. `git status --short`、対象の直前のバージョンタグ、そこからの差分を確認する。他製品のタグや rolling タグを比較元にしない。公開先 remote と同名タグの有無も確認する。
2. `git log --format=fuller <前回の対象製品のタグ>..HEAD` でコミット本文まで読み、差分と照合して今回の変更を洗い出す。共有コードやビルド設定の変更も対象製品に影響するため、最初から製品ディレクトリだけに絞らない。初回リリースで比較元のタグがない場合は、対象の導入・移動前を含む履歴を確認する。`Unreleased` と突き合わせ、未記載の利用者向け変更を補って `## [X.Y.Z] - YYYY-MM-DD` にまとめ、対象のバージョンを更新する。`Unreleased` が空でも変更なしとは判断しない。初回リリースの項目がすでにある場合は内容を確認し、重複して追加しない。contrib の workflow はタグ・VERSION・CHANGELOG の一致を検証し、拡張機能では package.json も検証する。nas は同等の一致検証がないため準備時に確認する。
3. 変更に応じて [post-change-checks](../post-change-checks/SKILL.md) の検証を行う。maskfs の Nix ビルドは共有マスク処理の Zig unit test を実行するが、FUSE マウントの動作検証とは別。FUSE や Docker の制約でスキップした検証は明記する。
4. 対象をビルドし、以下の成果物を確認する。ローカルビルドで確認できるのは実行ホストのアーキテクチャだけなので、両アーキテクチャの成否は公開時の CI でも確認する。

| 対象 | ビルド | 成果物・確認 |
| --- | --- | --- |
| nas | `nix build .#bundled --out-link result-nas --print-build-logs` | `./result-nas --version` の製品バージョンが一致すること（リビジョン接尾辞あり） |
| maskfs | `nix build .#maskfs-bundled --out-link result-maskfs --print-build-logs` | `./result-maskfs --version` が `nas-maskfs X.Y.Z` と完全一致すること |
| sumi | `nix build .#sumi --out-link result-sumi --print-build-logs` | `./result-sumi/bin/sumi --version` が `sumi X.Y.Z` と完全一致すること |
| vscode-nas-approval | `nix build .#vscode-nas-approval --out-link result-vsix --print-build-logs` | `result-vsix/nas-approval-X.Y.Z.vsix` が存在し、内包する拡張機能のバージョンが一致すること |

`result-maskfs` と `result-nas` は実行ファイルへのリンク。カレントディレクトリは通常 PATH にないので、実行には `./` を付ける。maskfs の FUSE 動作確認には `/dev/fuse` とホストの setuid 付き `fusermount3` が必要。配布バンドルは `fusermount3` を同梱しない。

## タグを公開する

公開まで依頼されている場合は [git-commit](../git-commit/SKILL.md) に従って対象の変更をコミットし、検証したコミット SHA を記録する。準備だけの場合は変更内容と検証結果を提示して終了する。

公開先・タグ名・コミットを確定し、次の形でそのタグだけを push する。変数には確認済みの値を設定する。既存タグがある場合は同じリリースの続きか衝突かを調べ、無条件に付け替えない。

```bash
git tag "$tag" "$release_sha"
git push "$remote" "refs/tags/$tag"
```

タグの push で対象の workflow が起動し、GitHub Release が作成される。手作業の `gh release create` を重ねて実行しない。ブランチの push が必要なら依頼の公開範囲に従う。

## 公開結果を確認する

`gh run list --workflow "$workflow"` で対象タグ・SHA の run を特定し、`gh run watch "$run_id" --exit-status` で完了を確認する。失敗したら `gh run view "$run_id" --log-failed` で原因と失敗段階を確認する。

`gh release view "$tag"` で本文と以下の配布物を確認する。contrib はバージョン固定の Release に加えて rolling Release も更新する。rolling 側のタイトル・配布物・タグの参照先が今回のバージョン・コミットに一致することも確認する。

| 対象 | バージョン固定 Release の配布物 | rolling Release / 配布物 |
| --- | --- | --- |
| nas | `nas-vX.Y.Z_x86_64-linux.tar.gz`、`nas-vX.Y.Z_aarch64-linux.tar.gz` | なし（GitHub の latest は nas 用） |
| maskfs | `maskfs-x86_64-linux`、`maskfs-aarch64-linux` | `maskfs-latest` / 同じファイル名 |
| sumi | `sumi-x86_64-linux`、`sumi-aarch64-linux` | `sumi-latest` / 同じファイル名 |
| vscode-nas-approval | `nas-approval-X.Y.Z.vsix` | `vscode-nas-approval-latest` / `nas-approval.vsix` |

contrib の Release は `--latest=false` で作成し、nas 用の `/releases/latest` を奪わない。README の rolling ダウンロード URL はバージョン更新のたびに書き換えない。

同じ製品の公開を重ねると、最後に完了した run が rolling 配布物を上書きする。先行する公開の完了を確認してから次を開始する。古いタグの再実行も rolling を巻き戻し得る。

途中で失敗した場合は、固定 Release と rolling Release の作成・更新状況を調べてから復旧方針を決める。固定 Release 作成後の全ジョブ再実行は `gh release create` の重複で失敗し得る。公開済みのバージョンタグの付け替えや Release の削除を通常の再試行に含めない。追加の外部変更が依頼範囲に入らない場合は、状態と具体的な復旧案を示して確認する。

完了時は対象、バージョン、コミット、Release URL、CI と配布物の確認結果、未検証事項を報告する。
