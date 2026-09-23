# Bundled nas license compliance Implementation Plan

**Goal:** Linux x86_64 / aarch64 の bundled nas に dtach と必要な告知・対応材料を同梱し、配布物と義務の対応を検査してから公開する。

**Architecture:** Nix の build 入力と Bun の build graph から source・patch・notice・出自を集める。component 一覧は LICENSE → 要求 → 選択の参照と材料の配置を持ち、理由は spec に集約する。release scripts は生成物を照合し、両 architecture の材料と binary が揃ってから公開する。

## Constraints

- 正本は [design](../specs/2026-09-23-bundled-nas-license-compliance-design.md)。ライセンス要求と、それを満たすために選んだ運用を区別する。
- 対象は Linux bundled nas。独立 maskfs / sumi / VS Code release の変更は含めない。
- JavaScriptCore / TinyCC は source 経路、glibc / FUSE は展開後の共有 library 交換を選ぶ。ソース取得用 URL だけでは材料提供を代替しない。
- 上流と nas の既存 build scripts を提供する。専用の全再構築ツール・offline installer・手書きの検証済み JSON は維持しない。
- 開発依存の全件を binary の component として扱わない。材料として配る source の元の表示は保持する。
- `AGENTS.md`、test-policy、post-change-checks、git-commit の各スキルに従う。domain / services / stages を触る場合は effect-separation を読む。
- `nix-bundle-elf/` への変更は許可済み。独立 repository に commit し、nas は固定 revision に対する patch を保持する。生成 shell と cleanup code の MIT 許諾はユーザー確認済み。
- 計画・実装はユーザーから自律実行を依頼済み。公開操作は行わない。

## 1. 配布物と材料の対応

- [x] `components.json` に component の版・出自・license・要求 ID・採用方法・notice/source の配置を記録する。
- [x] 安全な相対パス、必要材料の存在、空ファイル、重複 ID、source 提供対象の欠落を検査する。
- [x] 実際の payload の ELF と bundler の出自記録を照合し、未登録の ELF は失敗させる。
- [x] binary / source archives と component inventory を生成し、全ファイルの hash、archive 内容、内外の notice の一致を確認する。
- [x] 手入力の証明 JSON を廃止し、生成物と通常の CI 結果を使用する。

## 2. 必要材料とライセンス評価

- [x] Bun / JSC / TinyCC、dtach、glibc、Pkl と内蔵 GraalVM / OpenJDK、FUSE、その他 native component の source と原文表示を収集する。
- [x] JavaScript / font は実際の build 入力とコピー対象から notice を収集する。
- [x] nas source、依存 cache、lockfiles、上流 build scripts、patch、Nix recipes を保存する。
- [x] LICENSE → 要求 → 候補 → 選択と理由を spec に保持する。許諾や版を変える場合はこの評価を見直す。
- [x] ELF 後加工の内容を変更表示と recipes に保持する。
- [x] Bun の依存入力と Pkl の内蔵 runtime を Nix build 内で upstream から導出し、生成 JSON を repository に置かない。特殊な取得方法とライセンスの選択は明示的に管理する。
- [x] 改訂後の collector を実際に build し、材料・告知・出自が新しい manifest と整合することを確認する。

## 3. 利用者の改変経路

- [x] `scripts/compile.ts --runtime` で変更 Bun を指定できるようにする。
- [x] 変更 Bun で生成した nas に、通常の bundle recipe を適用できるようにする。
- [x] 展開した glibc / FUSE を交換して起動する方法と、upstream build scripts から nas の compile に進む方法を [利用者向け文書](../../release-materials.md) に記す。
- [x] 専用再構築・Cargo vendoring・cache priming・npm installer を削除する。元の source と既存 build scripts は保持する。
- [x] 改訂後の bundle で通常起動、cleanup、共有 library 交換、ELF 変更表示を確認する。

## 4. 公開処理と最終検証

- [x] CI は各 architecture で bundle と材料を build し、bundle 動作と archive 整合性を検査する。
- [x] 両 architecture の asset を draft Release に揃えてから公開する。欠落・upload 失敗では公開しない。
- [x] fake gh と実ファイルによる release tests で、材料欠落・改変・部分 upload を検査する。
- [x] 改訂全体の fmt、lint、check、release tests、最終 test aggregate を実行する。
- [x] 実際に確認した範囲と未確認の範囲を記録し、local Forgejo の差分を更新する。

## 検証の範囲

固定 source と build 定義の照合、上流の原文確認、x86_64 bundle の起動・展開・library 交換は実施済み。JavaScriptCore を変更した試験では JSC のコンパイルまで進んだが、Bun 全体から nas までの再生成は完走していない。この試験を成功とは記録しない。専用の再構築ツールやその完走を一律の公開条件にする代わりに、必要材料と既存 build 手順の対応を確認する。

aarch64 の Nix 評価は実施済みだが、この作業環境では実機での bundle 動作を確認していない。両 architecture の実行検査は release CI が担う。テスト結果は archive の整合性や試した動作の証拠であり、それだけでライセンス全条件を満たしたという宣言にはしない。

### 簡素化後の検査結果

- fmt / lint / check: 成功。release tests: 19 passed、0 failed。
- `bun run test`: 13 suites passed、0 failed。Bun の nas unit では 10 skip、nas integration では 61 skip。Dev Containers CLI、fixture image、FUSE 等の不足による skip は未検証として扱う。Zig suite は成功し、一部 compile step は cache を利用した。
- Bun / Pkl の入力一覧は固定 source から build 時に生成し、個々の revision や checksum の転記を不要にする。
- collector / release CLI / 利用者向け手順の差分レビューで具体的な不整合は見つからなかった。
- x86_64 の Nix `release-inputs` / `bundled` が成功。59 components・31 ELF origins・1,030 material files の収集対象を維持した。
- 生成 bundle の通常起動・cleanup・glibc/FUSE 交換・mask-filter・ELF 変更表示が成功。実際の binary/source archives の prepare / verify も成功した。
