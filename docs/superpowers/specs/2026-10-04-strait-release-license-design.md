# strait の単体配布と第三者ライセンス対応

Status: Accepted; release verification pending

Date: 2026-10-04

## 目的と対象

strait を nas とは別に、Linux x86_64 / aarch64 向けの単体の配布物として GitHub Release で公開する。配布物は Bun runtime と glibc を同梱するので、[bundled nas のライセンス対応](2026-09-23-bundled-nas-license-compliance-design.md)（以下「nas の設計」）と同じ水準の対応が必要になる。

この文書は nas の設計との差分だけを記載する。要求 ID（BUN-1、JSC-2 など）は nas の設計のものをそのまま使う。Nix package（`nix profile install .#strait`）としての配布は扱わない。

## 配布物の形

### 決定: 自己展開スクリプトを配り、展開して使う

配布物は nix-bundle-elf の `bundle-script` で作る自己展開スクリプトである。Bun の実行ファイル、glibc、strait の launcher・ソース・npm パッケージを含む。利用者は `strait --extract <dir>` で展開し、`<dir>/bin/strait` を使う。

**理由:**

- strait は `bun build --compile` の単一実行ファイルにできない。`STRAIT_ROOT` を `import.meta.dir` から求め、srt は自分のディレクトリから `vendor/seccomp` の補助プログラムを探し、`selfcheck.ts` は srt の `dist` を読む。statusline は `strait-statusline` をファイルとして実行する。
- 展開せずに実行すると、`$TMPDIR` に一時的に展開して起動する。既定の `denyRead` は `/tmp` を含むので、サンドボックス内から `strait hostexec` と statusline に届かない。そのため、展開していない場合は `--version` 以外を拒否する（`straitBundledEntry`）。
- 展開時に nix-bundle-elf は interpreter と wrapper に絶対パスを書き込むので、展開済みのツリーは移動できない。CI で展開したツリーを tar にして配る案は採らない。

### 決定: strait のファイルを bundle のルートに置く

`STRAIT_ROOT` が bundle 全体になる。strait はこのディレクトリ全体を `denyWrite` に加えるので、同梱した Bun（`orig/bun`、`libexec/bun`）と共有ライブラリ（`lib-bun/`）もサンドボックスから書き換えられない。launcher は `libexec/bun` があればそれを使い、なければ PATH の `bun` を使う。

### 決定: npm パッケージを hoisted レイアウトに並べ直す

bun の isolated レイアウトはシンボリックリンクで構成される。`bundle-script` の include はこれをコピーする際に、一部のリンクを store への絶対パスに変える。Nix のないホストでは、srt が `@pondwader/socks5-server` を解決できなくなる。各パッケージは 1 バージョンしかないので、リンクのない hoisted レイアウトに並べ直して同梱する（`straitBundleTree`）。`prepare` は展開先から外に出るリンクを拒否するので、同じ問題が戻れば公開前に止まる。

### 決定: shebang を store のパスから戻す

Nix の fixup は launcher と `strait-statusline` の `#!/bin/sh` を store の `sh` に、bun2nix は srt の `cli.js` の shebang を store の `node` に書き換える。Nix のないホストでは interpreter が見つからず、`bin/strait --version` も起動できない。`straitBundleTree` が `#!/bin/sh` と `#!/usr/bin/env node` に戻し、store を指す shebang が残ればビルドを失敗させる。CI は Nix のある環境で動くので、起動の成否ではこの問題を検出できない。`check_strait_bundle.sh` が、展開したツリーに store を指す shebang がないことを確認する。

## Bun・JavaScriptCore・glibc

nas の設計の BUN-1〜BUN-8、JSC-1〜JSC-4、TCC-1〜TCC-3、MPL-1、GLIBC-1〜GLIBC-3、BUNDLE-1 をそのまま適用する。notice・Bun の固定 upstream revision・TinyCC・MPL crate・glibc の source は、nas と同じ Nix の入力から作る（`nix/release/default.nix` の共通部分）。

### JSC-2 の経路だけが nas と異なる

nas は `bun build --compile` で Bun と nas を 1 つの実行ファイルにするので、変更した Bun で nas を再生成する手順が必要だった。strait は Bun の実行ファイルを**そのまま**別ファイルとして同梱し、その Bun で strait のソースを実行する。

したがって、変更した JavaScriptCore を使う手順は「Bun を upstream の手順で再ビルドし、展開したツリーの `orig/bun` を置き換える」である。strait 側の再生成は不要になる。`libexec/bun` は同梱の glibc を `LD_LIBRARY_PATH` で読み込ませて `orig/bun` を起動するので、置き換える実行ファイルの interpreter を、展開時に `orig/bun` に設定された同梱の loader に合わせる（`patchelf --set-interpreter`）。手順は [RELEASE-MATERIALS.md](../../../contrib/strait/RELEASE-MATERIALS.md) に記載する。`check_strait_bundle.sh` は、interpreter を書き換えていない Bun の実行ファイル（開発環境の `bun`）をこの手順で置き換え、strait が起動することを CI で確認する。JavaScriptCore を実際に変更した再ビルドは確認しない。

### GLIBC-2: 展開した library を交換する

nas と同じく、`--extract` で展開した `lib-bun/` の library を交換できる。`scripts/release/check_strait_bundle.sh` が、`lib-bun/libc.so.6` を変更したうえで、そのファイルが読み込まれることを CI で確認する。

### Pkl・dtach・libfuse・JavaScript の UI

strait はこれらを含まない。`collect_native.py` は `pklVersion` がない構成では Pkl を扱わない。

## srt（sandbox-runtime）— Apache-2.0

### SRT-1: LICENSE を渡す

**要求（LICENSE）:** [Apache-2.0 §4(a)](https://www.apache.org/licenses/LICENSE-2.0) により、ライセンスのコピーを渡す。§4(d) の NOTICE ファイルは、srt 0.0.77 の配布物にも上流の repository にもない（テスト用の fixture を除く）。

**選択と理由（POLICY）:** npm パッケージの `LICENSE` を notice tree に収録する。再ビルドした `apply-seccomp` にも、上流の同じタグの `LICENSE` を収録する。

### SRT-2: 変更したファイルに変更の旨を記載する

**要求（LICENSE）:** Apache-2.0 §4(b) により、変更したファイルには、変更した旨の目立つ表示が必要になる。

**選択と理由（POLICY）:** strait は `contrib/strait/patches/` のパッチで srt の `dist/sandbox/*.js` を 5 ファイル変更する。Nix のビルドでパッチを当てた直後に、パッチの対象ファイルの末尾に `// Modified for strait (nix-agent-sandbox) on <日付>: see <パッチ>` を追記する（`flake.nix` の `overrides`）。

パッチ自体に表示を加える案は採らない。パッチは信頼すべきコードであり、`bun.lock` のパッチのハッシュと `bun.nix` の再生成も必要になる。末尾への追記なら行番号と source map がずれず、パッチの検証（ビルド時の目印、起動時の selfcheck）にも影響しない。パッチ自体は strait の source archive に含まれる。

### SRT-3: `apply-seccomp` をソースから作り直す

**問題:** npm の srt は `vendor/seccomp/{x64,arm64}/apply-seccomp` をビルド済みで同梱している。どちらも glibc を静的リンクしており、そのソース（`vendor/seccomp-src`）は npm パッケージに含まれない。静的リンクした glibc を再配布すると、LGPL 2.1 §6 により、再リンクできる object などを渡す必要がある。他者の CI で作った実行ファイルについて、その材料は用意できない。

**候補:**

- **A: 同梱しない。** srt は補助プログラムがなくても動作する。しかし、サンドボックス内の `AF_UNIX` の遮断は、承認用ソケットを守る 3 つの対策の 1 つである（[SECURITY.md](../../../contrib/strait/SECURITY.md#承認経路の保護)）。採らない。
- **B: 上流の同じタグのソースから、glibc を静的リンクして作り直す。** 再リンク用の材料を自分で用意すれば足りるが、材料の保守が増える。
- **C: 上流の同じタグのソースから、musl で作り直す。** musl は MIT なので、再リンクの義務がない。

**C を選ぶ。** `vendor/seccomp/build.ts` と同じ手順で作る。ビルド時だけ libseccomp で両アーキテクチャの BPF を生成してヘッダーに埋め込み、`apply-seccomp.c` を Zig 0.15 の `zig cc -target <arch>-linux-musl -static` でリンクする（`srtApplySeccomp`）。生成器は配布しない。BPF のバイト列は libseccomp の出力データであり、libseccomp のコードは含まない。musl の表示は nas と同じ MUSL-1（`zig-runtime` component）で渡す。

Nix package と配布物は、どちらも作り直した `apply-seccomp` を使う。他のアーキテクチャの `apply-seccomp` と Windows 用の `srt-win` は削除する。`vendor/java-proxy-agent/srt-proxy-agent.jar` は Linux でも JVM のプロキシ設定に使われる。中身は srt 自身のクラス（`com/anthropic/srt/`）だけなので、SRT-1 の表示で足りる。

## npm パッケージ — PKG-1 と FORGE-1

strait は npm パッケージを bundle せず、そのまま同梱する。ソースがそのまま配布物に入っているので、nas の CLI のように `sources/javascript/` を別に作らない。

`nix/release/strait-packages.json` に、同梱する `名前@バージョン` ごとに、確認済みのライセンスと要求を記載する。`collect_native.py` は、同梱するパッケージとこの一覧が完全に一致しなければ失敗する。依存を更新すると、一覧を見直すまで release inputs を作れない。

### FORGE-1: node-forge のライセンスを選ぶ

node-forge は `(BSD-3-Clause OR GPL-2.0)` である。BSD-3-Clause を選び、その本文と著作権表示を含む `LICENSE` を収録する。GPL-2.0 を選ぶ理由はない。

## 共通の梱包と公開

nas の設計の「共通の梱包と公開」に従う。違いは次のとおり。

| 項目 | nas | strait |
| --- | --- | --- |
| タグ | `vX.Y.Z` | `strait-vX.Y.Z` |
| 配布物の名前 | `nas-vX.Y.Z_<system>…` | `strait-vX.Y.Z_<system>…` |
| bundle 内の notice | `share/nas/assets/licenses/` | `licenses/`（ルート） |
| bundle の検査 | `check_bundle.sh` | `check_strait_bundle.sh` |
| `/releases/latest` | nas を指す | `--latest=false` で奪わない |
| rolling Release | なし | `strait-latest`（バージョンを含まない名前で同じ一式） |

`scripts/release/` の `prepare`・`verify`・`publish` は `--product strait` で strait を扱う。nas の release inputs の内容は、この変更の前後で変わらないことを確認した（リポジトリの source archive を除いて一致）。nas の inventory の形も変えない。

## 依存更新と検証

- srt を更新する場合は、`flake.nix` の `srtVersion` と `srtSource` のハッシュ、`package.json`、パッチ、`strait-packages.json` を揃えて更新する。`apply-seccomp` の作り方が `vendor/seccomp/build.ts` と一致しているかを確認する。
- npm の依存を更新する場合は、`strait-packages.json` を見直す。
- Bun を更新する場合は、nas の設計の手順に従う。strait の release inputs も同じ入力を使う。
- 配布物を変更したら、展開したツリーに対して `STRAIT_DIR=<dir> contrib/strait/tests/probe.sh` をホストで実行する。同梱の Bun、`apply-seccomp`、書き込み禁止の範囲を確認できる。
