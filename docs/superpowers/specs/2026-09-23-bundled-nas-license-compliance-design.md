# bundled nas の第三者ライセンス対応と dtach 同梱

Status: Accepted; release verification pending

Date: 2026-09-23

## 目的と対象

このプロジェクトが利用・再配布する第三者ソフトウェアについて、適用されるライセンス条件を満たし、依存更新後もその状態を維持する。併せて dtach を nas に同梱し、利用者による別途インストールを不要にする。

対象は Linux x86_64 / aarch64 向けの bundled nas である。Bun の `--compile` 成果物、Pkl、dtach、自己展開部分、同梱 helper、native library、npm/frontend/font、vendored Python を含む。単独の maskfs / sumi / VS Code 拡張の Release、Nix package としての配布、実行時に別途取得するソフトウェアの配布方法は、この設計では扱わない。

## dtach — GPLv2 に従って executable を同梱する

[dtach の許諾](https://raw.githubusercontent.com/crigler/dtach/master/dtach.h)は GPL-2.0-or-later である。この配布では GPLv2 の条件を採用する。nas は dtach を別 executable として同梱し、起動して利用する。GPLv2 の条件を満たす対象として、まず dtach 自体の binary・source・変更を扱う。

### DT-1: 著作権表示と GPL 本文を渡す

**要求（LICENSE）:** [GPLv2 §1・§3](https://raw.githubusercontent.com/crigler/dtach/master/COPYING) に従い、著作権・許諾・無保証の表示を保持し、GPL のコピーを渡す。

**候補:** 必要な本文と表示を保持した上で、binary archive 内の添付文書にする方法と、自己展開後のファイルにする方法がある。両方に置くこともできる。

**選択と理由（POLICY）:** dtach の `COPYING` と著作権表示を notice tree に収録し、archive 内で `nas` と並べ、自己展開後にも残す。取得直後と実際に使う場所の両方から読めるためである。同じ tree をコピーして配置するので、二種類の文書を保守する必要はない。

### DT-2: 配布した executable に対応する source を提供する

**要求（LICENSE）:** GPLv2 §3 により、配布する binary の完全な対応ソースを提供する。適用した変更と、コンパイル・インストールを制御する scripts も対象になる。

#### 提供方法の候補

- **A: source を binary に伴わせる。** §3(a)。オンライン配布では、同節末尾が認める同じ配布場所からの取得を使える。
- **B: written offer を付ける。** §3(b)。少なくとも3年間有効な申し出と、その条件に従った請求対応が必要になる。
- **C: 上流から受けた offer の情報を渡す。** §3(c)。非商用で、所定の offer を伴う binary を受け取った場合などの条件がある。

#### 選択と理由

**A を採用し、binary と同じ GitHub Release に対応 source の追加 asset を置く。** binary archive 自体に全 source を入れる方法より通常のダウンロードを小さくでき、B の請求対応を継続する運用も不要になる。

C は、非商用であることに加え、§3(b) の offer を伴う binary を受け取っていることが必要である。[dtach の build 定義](https://github.com/NixOS/nixpkgs/blob/20b1ddd1aa5ace70c9468305030aa4f9ef79671b/pkgs/by-name/dt/dtach/package.nix)は source から executable を生成する経路であり、そのような offer の受領を配布の前提にしていない。このため C を採用しない。「非商用の条件を満たせない」と判断したわけではなく、上流の offer の有無に依存せず、配布した binary に対応する source を自ら渡せる A を選ぶ。

source asset には使用した source、Nixpkgs などによる patch、適用順序と build 定義を含める。上流 URL や `flake.lock` の掲載だけでは、材料を実際に提供したことにはならない。notice から対応する asset を案内する。

### DT-3: 変更版の表示と許諾を維持する

**要求（LICENSE）:** GPLv2 §2(a) は変更ファイルへの変更表示と日付、§2(b) は該当する変更版の GPL による許諾を要求する。§6 に従い、利用者の権利に追加の制限を課さない。

**選択と理由（POLICY）:** dtach の source と変更版を GPL のまま提供し、変更ファイルの表示・日付を保持または補完する。表示を省略する案や、nas の許諾で dtach の許諾を置き換える案は採らない。別途作る変更一覧は追跡用であり、ファイルへの表示の代用にはしない。

Nixpkgs の patch と配布時の ELF 加工も確認対象にする。dtach の ELF には、`scripts/release/mark_elf.sh` で `.nas.changes` section を追加する。変更した旨、日付、interpreter / library search path の加工、source と表示の取得先をファイル自身に保持する。`readelf -p .nas.changes` で読める、実行時にはロードしない section を選ぶ。別ファイルの provenance 一覧だけに頼らず、executable 単体にも変更表示を残すためである。bundle の展開後に表示の保持と起動を確認する。

これは通常の ELF executable である dtach / Pkl のための方法であり、末尾に payload を付ける Bun executable に `objcopy` を適用する方法には一般化しない。dtach との連携方法を変える場合は、別 executable としての配布という前提も見直す。

## Bun と JavaScriptCore — MIT の表示に加えて再リンクに対応する

nas の `bun build --compile` 成果物には Bun runtime が入る。[Bun のライセンス説明](https://raw.githubusercontent.com/oven-sh/bun/bun-v1.4.2/LICENSE.md)は、Bun 自体が MIT であることと、JavaScriptCore / WebKit を静的にリンクしていることを明記している。したがって Bun の MIT 本文を入れるだけでは、この runtime のライセンス対応は完了しない。

### BUN-1: Bun 自体の著作権表示と MIT の本文を保持する

**要求（LICENSE）:** [MIT の notice 保持条件](https://opensource.org/license/mit)に従い、著作権表示と許諾表示をコピーに含める。

**候補と選択（POLICY）:** upstream の本文・表示を収録する方法と、必要な表示を独自に集約する方法がある。配布版に対応する upstream の本文・表示を収録する方法を選ぶ。独自の要約で著作権者や許諾表示を落とすことを避けるためである。一般的な MIT テンプレートだけを配って済ませない。

### JavaScriptCore に対して満たす四つの要求

以下の **JSC-1〜JSC-4** が、JavaScriptCore の LGPL 部分に対する対応である。再リンク材料だけでなく、使用告知・本文の提供、利用者の改変を許す条件、変更箇所の表示を含む。

条文の根拠は、Bun が使用する WebKit fork の [JavaScriptCore `COPYING.LIB`](https://raw.githubusercontent.com/oven-sh/WebKit/2e2aa2290fac856d6f451ceacb58f7f5b44dd057/Source/JavaScriptCore/COPYING.LIB) に収録された Library GPL v2 とする。配布版の個別ファイルの許諾・例外も確認し、異なる条件がある部分には別途対応する。glibc の LGPL 2.1 と同じ版として扱わない。

#### JSC-1: 使用を告知し、ライセンス本文と著作権表示を渡す

**要求（LICENSE）:** Library GPL v2 §6 により、JavaScriptCore を使用していることと、その library および使用が同ライセンスの対象であることを告知し、本文を渡す。実行中に著作権表示を出す場合は、library の著作権表示と本文への案内も必要になる。

**候補:** notice ファイルとして添付する方法、アプリのライセンス表示機能に組み込む方法、その両方がある。ただし実行時の著作権表示に関する条件が適用される場合、その表示は別途満たす必要がある。

**選択と理由（POLICY）:** JavaScriptCore の使用告知、配布版の本文、著作権表示を notice tree に収録する。archive 内と自己展開後の両方に配置する。本文を読むための専用 CLI を増やさず、他の第三者情報と一緒に取得できるためである。nas / Bun の実行時に著作権表示を出す箇所があれば、そこでの要求も確認して満たす。

#### JSC-2: JavaScriptCore を変更して Bun / nas を再リンクできる材料を渡す

**要求（LICENSE）:** Library GPL v2 §6(a) の方法では、変更を含む library source と、リンクする work の source または object など、利用者が library を変更して executable を再生成できる材料が必要になる。

##### 再リンク材料の候補

- **A: source から再生成する。** JavaScriptCore の source と変更に加え、Bun と nas の source、必要な依存入力・build scripts・データを提供する。
- **B: リンクする work の object を提供する。** JavaScriptCore の source と変更に加え、Bun 等の再リンクに必要な object とリンク用の材料を提供する。
- **C: source と object を併せて提供する。** 両方の経路を利用者に提供する。

**A を選ぶ。** Bun upstream が案内する、変更した WebKit から Bun を作る経路につなげられるためである。B は配布する binary に対応した中間 object 一式の確保が必要になり、C は二つの経路を維持する負担が増える。

この配布方式では、nas 自身の再生成に必要な source・データ・scripts を受領者に提供することを受け入れる。

この選択で示すのは上流の手順へのリンクだけではない。配布した runtime に対応する WebKit fork と Bun の固定 revision、再ビルドに必要な入力の pin、nas の source と build/lock 情報を揃える。手順は「変更した JavaScriptCore → Bun の再ビルド → その runtime を選んだ nas の再生成 → assets / native helper を含む bundle の作成」までを扱う。

##### 材料の提供方法の候補

Library GPL v2 §6 では、材料を伴わせる方法、written offer、同じ配布場所から材料を取得可能にする方法などがある。

**Bun 自身と同じ方法を選ぶ。notice は nas とともに配り、Bun・WebKit fork・Bun の依存の source は、固定した公開 upstream revision を `recipes/upstream-sources.json` に記録して案内する。** 材料の範囲は §6(a) に対応させる。

候補には、材料を binary と同じ GitHub Release の追加 asset として複製する方法もある。試算では、この部分だけで asset が数百 MB になった。build に使わない部分を除けば縮められるが、除外対象の一覧は依存を更新するたびに見直しと再検証が必要になる。複製しても、実際に取得されることはほとんどない。

Bun は、JavaScriptCore を静的にリンクした自身の binary を、source を複製せずに配布している。source は、Bun の作者が管理する oven-sh/bun と oven-sh/WebKit の公開 repository にある。nas はこの runtime を変更せずに再配布するので、同じ取得経路を案内する。

この選択では、上流が repository を削除した場合や、固定 commit が参照できなくなった場合に、材料を取得できなくなるリスクを受け入れる。そうなった場合は、nas 側で fork・tag を作って提供先を切り替えるか、複製の方法に戻る。

##### この選択を成立させる確認

source からの経路に必要な材料が揃うことを確認する。Bun に同梱される MIT 等の依存でも、この経路に必要なら材料に含める。OS の通常の compiler 等まで無条件で保存することや、bit-for-bit の一致は求めない。

nas が指定した別の Bun runtime から再生成できることを確認する。ただし、runtime 選択だけの試験を JavaScriptCore の再ビルドや材料一式の充足の証拠にはしない。

[Library GPL v2 §0・§6](https://www.gnu.org/licenses/old-licenses/lgpl-2.0.html) に基づき、実際に使用するコンパイル・インストール用 scripts と、再生成に必要なデータ・utility programs を材料に含める。これを、新しい専用の再構築ツールを開発する義務とは解釈しない。Bun upstream の build scripts と nas の通常の build 定義を利用し、それらの接続方法と外部 toolchain の前提を案内する。

材料は固定版の build 定義・lockfile と照合する。全依存をオフラインで再構築する専用環境や、初回の隔離環境での全ビルドを公開の一律条件にはしない。材料の不足や再リンクを妨げる具体的な問題が見つかった場合は、その問題に絞って調査・検証し、公開前に解消する。ファイルの存在確認だけで再リンク可能性を証明したとは扱わない。

##### 材料の収録範囲

Release に複製するのは、Bun の runtime のうち小さく条件の厳しい TinyCC fork・`libtcc1.c`・MPL の crate だけとする。Bun・WebKit fork・その他の依存・Node headers・Rust 標準 library の source は、`recipes/upstream-sources.json` の revision・hash で案内する。

build は notice を得るために、これらの source を固定 hash で取得し、Bun の lockfile と照合する。WebKit fork は、Bun が compile する `Source/JavaScriptCore`・`Source/WTF`・`Source/bmalloc` だけを sparse checkout で取得する（fork 全体 6.5 GB に対して約 113 MB）。

A の経路に不足する非公開・取得不能の材料などが判明した場合は、B/C を含めて選び直す。その場合は不足した材料と、選択を変更した理由をここに記録する。

#### JSC-3: 利用者による変更と、そのデバッグを許す

**要求（LICENSE）:** Library GPL v2 §6 冒頭は、利用者自身のための変更と、その変更をデバッグするための reverse engineering を許す配布条件を求める。

**選択と理由（POLICY）:** nas とともに渡す利用条件がこれらを禁止していないことを確認する。変更した runtime を使う経路にも、利用を妨げる制限を加えない。必要な許可を維持する条件であり、source を多く配る代わりに禁止できるという選択肢はない。

JSC-2 の材料提供と、この許可の確認は別に行う。材料が存在しても、その利用を禁止していれば要求を満たせないためである。

#### JSC-4: 配布する JavaScriptCore の変更と許諾を保持する

**要求（LICENSE）:** Library GPL v2 §2 と §6(a) に従い、実際に使用した変更を含む source を提供し、該当する変更ファイルの変更表示・日付と許諾を保持する。

**候補:** 変更を含む source tree を提供する方法と、元の source に patch と適用手順を組み合わせて提供する方法がある。いずれでも、変更内容と必要な表示が再構成できなければならない。

**選択と理由（POLICY）:** Bun が使用する WebKit fork の固定 revision を起点にし、追加変更があれば patch と適用順序を添える。Bun 側の変更を含まない別の upstream WebKit tarball では、配布した runtime の source と一致しないためである。source 内の著作権・変更表示を保持し、追加の変更に必要な表示は補う。

### BUN-2: TinyCC — LGPL 2.1 の再リンクと、埋め込む GPL source を扱う

Bun 1.4.2 の [TinyCC build 定義](https://github.com/oven-sh/bun/blob/bun-v1.4.2/scripts/build/deps/tinycc.ts)は、fork の `05f0fafaa3be31e31d7b4b5c17dc60f62c991171` と patch を使い、Linux x86_64 / aarch64 の両方で compiler 本体を組み込む。nas が FFI を呼ばないことを、配布対象から外す理由にはしない。fork の [COPYING](https://raw.githubusercontent.com/oven-sh/tinycc/05f0fafaa3be31e31d7b4b5c17dc60f62c991171/COPYING) と、後の版を選べる各ファイルの許諾に基づき、LGPL 2.1 を採用する。

#### TCC-1: 使用告知・本文・変更表示・利用者の改変許可

**要求（LICENSE）:** LGPL 2.1 §1・§2・§6 に従い、著作権と許諾、変更ファイルの表示・日付を保持し、使用を告知する。§6 が求める利用者自身の変更と、そのデバッグのための reverse engineering も許す。

**選択と理由（POLICY）:** TinyCC の本文・著作権・使用告知を notice tree に置き、fork の source と Bun の `patches/tinycc/tcc.h.patch` を含める。変更表示と利用条件も確認する。告知だけを CLI に置く案より、他の内蔵 component と同じ場所で読める方法を選ぶ。必要な変更表示と改変許可を、source 提供で代替する選択肢はない。

#### TCC-2: TinyCC を変更して Bun / nas を再生成できる材料

**要求（LICENSE）:** LGPL 2.1 §6(a) の library source とリンクする work の source/object 等を提供する。library 自体の再配布についても §4 を満たす。

**候補:** source から再生成する方法、対応する object を渡す方法、§6(c) の written offer がある。§6(b) の shared library 機構は、Bun に組み込む TinyCC の提供方法には選べない。

**選択と理由（POLICY）:** source の経路を選び、§6(d) と §4 の同じ場所からの取得を使う。TinyCC fork を同じ Release に置き、patch・build 定義・Bun / nas を再生成するその他の材料は JSC-2 と同じく固定した上流 revision で案内する。JSC-2 と Bun の再ビルド材料を共有でき、中間 object の保管や offer の請求対応を増やさずに済む。条文番号は JavaScriptCore の Library GPL v2 §6(c) と区別する。TinyCC の変更に必要な source・patch・build 定義を固定版と照合する。再生成には Bun upstream の build scripts を用い、別の再構築ツールは維持しない。

#### TCC-3: `libtcc1.c` の source とリンク例外

Bun は別に [src/runtime/ffi/libtcc1.c](https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/runtime/ffi/libtcc1.c) を [include_bytes! で埋め込む](https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/runtime/ffi/ffi_body.rs)。このファイルは GPLv2-or-later と、コンパイル済みコードを他のプログラムとリンクして配る場合の例外を持つ。TinyCC 本体の LGPL とも、例外の対象となるコンパイル済みの組合せとも区別する。

**要求（LICENSE）:** source の再配布・変更には GPLv2 §1・§2 が適用され、著作権・許諾・無保証・例外の表示と、変更表示・日付を保持する。コンパイル済みコードのリンク例外を理由に、埋め込む source の表示条件まで省略しない。

**選択と理由（POLICY）:** 配布した Bun に含まれる同ファイルを、表示を保持して source asset に収録し、GPLv2 本文と例外を notice tree にも置く。Bun による変更を含むファイルを起点にすることで、別の TinyCC tarball に入る同名ファイルとの取り違えを避ける。

### BUN-3: lol-html と Rust の MPL component — 対象 source を MPL のまま渡す

[lol-html fork の Cargo.toml](https://github.com/oven-sh/lol-html/blob/725ce499aa9b71e38b7a2d0a9fbb6d7294a4079e/Cargo.toml)と [Bun 1.4.2 の Cargo.lock](https://github.com/oven-sh/bun/blob/bun-v1.4.2/Cargo.lock)から、HTMLRewriter の依存に `cssparser 0.36.0`、`selectors 0.33.0`、さらに `dtoa-short 0.3.5` が入る。`cssparser-macros 0.6.1` は proc-macro の build 入力である。これらの crate の許諾は MPL-2.0 であり、lol-html 自体の BSD-3-Clause だけでは扱えない。

#### MPL-1: source・取得案内・許諾表示

**要求（LICENSE）:** [MPL 2.0 §3.1–§3.4](https://www.mozilla.org/en-US/MPL/2.0/) により、対象 source と変更を MPL の下で提供し、binary の受領者に source の取得方法を知らせる。source 内の許諾・著作権等の表示を保持し、binary の利用条件で source に対する権利を狭めない。MPL の対象は covered files であり、この要求だけで nas 全体の source を MPL にする必要はない。

**候補:** covered source を binary と同梱する方法、別の取得先から合理的な方法・期間・費用で提供する方法がある。

**選択と理由（POLICY）:** 対応する crate の source と変更を同じ Release の source asset に収録し、notice に MPL 本文と取得先を記す。JSC / TinyCC の再生成にも必要なため、上流の package registry へのリンクだけに頼るより、配布 binary との対応を一緒に管理できる。proc-macro の実行コードと生成コードは区別して記録するが、再ビルド入力として `cssparser-macros` の source と MPL 表示も保持する。

### BUN-4: BoringSSL・uSockets / uWebSockets — Apache-2.0 の表示と変更を保持する

BoringSSL fork `41bf9b59c2ebf277a7aa427e1ecad5cc80dd4d4f` の [LICENSE](https://github.com/oven-sh/boringssl/blob/41bf9b59c2ebf277a7aa427e1ecad5cc80dd4d4f/LICENSE)は Apache-2.0 であり、使用する fiat-crypto の表示も別に保持する。Bun 内の [uSockets](https://github.com/oven-sh/bun/blob/bun-v1.4.2/packages/bun-usockets/LICENSE) と [uWebSockets](https://github.com/oven-sh/bun/blob/bun-v1.4.2/packages/bun-uws/LICENSE) も Apache-2.0 である。

**要求（LICENSE）:** §4(a) の本文、§4(b) の変更表示、source を渡す場合の §4(c) の表示保持、該当する §4(d) の NOTICE に対応する。§6 は第三者の商標利用を一般に許すものではない。

**候補と選択（POLICY）:** NOTICE の添付文書または画面表示のうち、本文・著作権・該当 NOTICE を component ごとに notice tree へ収録する方法を選ぶ。既にある原文を保持でき、専用画面を増やさずに済む。fork / patch の変更表示は source に保持・補完し、宣伝上の許諾まで得たとは扱わない。BoringSSL の LICENSE に入る Go 由来の test code は、同文書が compiled library に入らないと区別しているため、source に付随する表示と binary の収録対象を分ける。

### BUN-5: MIT / BSD の native component — 本文と個別の著作権を渡す

[Bun の依存 build 定義](https://github.com/oven-sh/bun/tree/bun-v1.4.2/scripts/build/deps)から、次を対象にする。表示義務だけで足りることと、JSC / TinyCC の再生成用 source が必要なことは別である。

- **brotli、c-ares、libdeflate、ls-hpack、ls-qpack、mimalloc:** 固定 source の MIT 本文と著作権表示を保持する。c-ares の AUTHORS、ls-hpack に入る xxHash の表示も落とさない。
- **picohttpparser:** MIT と Perl license の候補から MIT を選ぶ。ファイル冒頭の著作権・許諾を notice に保持する方法で満たせ、追加の許諾体系を運用に持ち込まずに済む。
- **lol-html、libwebp は BSD-3-Clause、libspng は BSD-2-Clause:** binary の添付文書に著作権・条件・免責を再掲し、source でも保持する。3-Clause の対象の名前を無断の推奨・宣伝に使わない。libwebp は build 定義が指す [固定 source archive](https://codeload.github.com/webmproject/libwebp/tar.gz/b7e29b9d75bd31422b00c2a446d49d7af06c328d)内の COPYING を根拠にする。
- **lsquic:** MIT 本文に加え、Chromium 由来部分の `LICENSE.chrome`（BSD-3-Clause）を保持する。二つの許諾の選択制ではない。
- **zstd:** BSD と GPLv2 の候補から BSD を選ぶ。表示保持で配布条件を満たせる経路があり、この component に GPL の対応を追加する必要がないためである。
- **Highway:** [固定版の LICENSE](https://github.com/google/highway/blob/2607d3b5b0113992fe84d3848859eae13b3b52c1/LICENSE)の Apache-2.0 / BSD-3-Clause から BSD を選び、本文・著作権・免責と非推奨条件に対応する。通常の表示収集と揃うためである。別条件の `random-inl.h` は CC0 のまま記録する。
- **HdrHistogram_c:** [CC0 と BSD-2-Clause の許諾](https://github.com/HdrHistogram/HdrHistogram_c/blob/be60a9987ee48d0abf0d7b6a175bad8d6c1585d1/LICENSE.txt)から BSD を選び、著作権・条件・免責を保持する。他の BSD component と同じ明示的な許諾・表示の方法を使えるためである。Bun に組み込む計測コードであり、用途が test/benchmark というだけでは配布対象から外さない。

**表示方法の候補と選択（POLICY）:** 一つの集約文書を独自に再構成する方法より、固定した各 source の本文・表示を component ごとの notice として保持する方法を選ぶ。個々の著作権者や複数許諾の片方を落としにくいためである。全文が source header にしかない場合も収録する。WebKit fork（JavaScriptCore・WTF・bmalloc）と Bun の `src/` では、BSD・MIT の表示が個別ファイルの header にしかない。これらは `scripts/release/source_notices.ts` で header から機械的に抽出し、条文ごとに著作権表示を重複なくまとめて `SOURCE-HEADERS.txt` に収録する。2026-09-24 の固定版では、該当するソースファイルのうち、既に個別に収録している LICENSE ファイルと compile されない文書を除く全件から抽出できた。

### BUN-6: libarchive・libjpeg-turbo・zlib-ng — 個別の追加条件

#### libarchive

[固定版の COPYING](https://github.com/libarchive/libarchive/blob/ded82291ab41d5e355831b96b0e1ff49e24d8939/COPYING)は BSD-2-Clause を基本とし、compress 処理の一部には BSD-3-Clause、日付 parser には public domain、BLAKE2 部分には CC0 / OpenSSL / Apache-2.0 の選択があると説明している。個別 source の表示が判断根拠になる。

**要求・選択と理由:** BSD 部分は binary 側にも著作権・条件・免責を載せ、3-Clause の非推奨条件も守る。COPYING だけを配る案では個別著作権を落とすため、収録 source の表示も notice に集める。BLAKE2 部分は Apache-2.0 を選び、BUN-4 と同じ本文・表示・変更の方法に揃える。別の OpenSSL 条件を運用に増やさず、明示的な許諾で扱えるためである。配布する build scripts 自体の表示も保持する。

#### libjpeg-turbo

[固定版の LICENSE.md](https://github.com/libjpeg-turbo/libjpeg-turbo/blob/e352b02f794f701407b39af08576035ba3360d60/LICENSE.md) と `README.ijg` により、IJG、BSD-3-Clause、zlib の条件を扱う。これらは一つ選べば全体を覆える許諾ではない。

**要求・選択と理由:** IJG の要求する Independent JPEG Group への謝辞を binary に付随する notice に記し、README.ijg と本文・著作権・免責も収録する。source の変更表示を保持・補完し、無断の推奨・宣伝をしない。本文だけで謝辞を済ませる案は採らず、upstream が指定する謝辞を明記する。各 API の細かな利用有無で notice を削るより、配布版の原文一式を保持する方法を選ぶ。

#### zlib-ng

[固定版の zlib license](https://github.com/zlib-ng/zlib-ng/blob/12731092979c6d07f42da27da673a9f6c7b13586/LICENSE.md) は、出自を偽らないこと、変更 source を明示すること、source の notice を削除・変更しないことを要求する。

**選択と理由:** source と変更表示を保持し、binary 側にも同じ本文を notice tree に置く。binary の文書で謝辞を書くこと自体は条文上の必須条件にしない。binary にも本文を入れるのは、component の許諾を同じ場所で読めるようにする配布上の選択である。

### BUN-7: ICU・WebKit 内の第三者コード・Rust runtime

#### ICU と Unicode data

Bun の [WebKit build 定義](https://github.com/oven-sh/bun/blob/bun-v1.4.2/scripts/build/deps/webkit.ts)では、Linux の prebuilt runtime に ICU の static library も入る。ICU 自体の Unicode 許諾に加え、辞書等には BSD/MIT 等の追加表示がある。WebKit tree 内の ICU header の [LICENSE](https://github.com/oven-sh/WebKit/blob/2e2aa2290fac856d6f451ceacb58f7f5b44dd057/Source/WTF/icu/LICENSE)と、リンクした ICU library の版の本文は区別する。

**要求（LICENSE）:** Unicode の本文が認めるコピーへの添付または関連文書への記載によって、著作権・許諾を渡し、無許可の権利者名による宣伝をしない。辞書等に付く個別表示も保持する。

**選択と理由（POLICY）:** ICU library、WebKit の ICU headers、Unicode data のそれぞれに対応した原文を notice tree に収録する。Bun が示す ICU 78 系の [本文の例](https://github.com/unicode-org/icu/blob/release-78.1/LICENSE)には同梱第三者の表示もあるため、Unicode の一般的なテンプレートだけに置き換えない。ICU の source / data は source asset に収録しない。Unicode の許諾は source 提供を求めず、JSC-2 の再生成経路でも、Bun の [WebKit build 定義](https://github.com/oven-sh/bun/blob/bun-v1.4.2/scripts/build/deps/webkit.ts)は Linux で system ICU（libicu-dev）を使うためである。

#### WebKit の MIT / BSD / Apache 部分

WebKit fork に含まれる表示から、simdutf・SIMDe・Zydis/zycore・temporal_rs は MIT、dtoa/double-conversion は BSD-3-Clause、ARM64 disassembler の binja は Apache-2.0、ICU4X は Unicode の対応に分ける。WTF / bmalloc の個別ファイルの BSD 等の表示も保持する。特に [同梱 simdutf の本文](https://github.com/oven-sh/WebKit/blob/2e2aa2290fac856d6f451ceacb58f7f5b44dd057/Source/WTF/wtf/simdutf/LICENSE-simdutf.txt)は MIT であり、Bun の概要表にある Apache という分類だけで決めない。

**要求・候補・選択と理由:** MIT/BSD の著作権・条件・免責、Apache の本文・変更表示・該当 NOTICE を、各 component 名で notice tree に残す。LLVM/libc++ 由来部分は、該当ファイルが与える MIT または Apache-2.0 WITH LLVM-exception の許諾に対応する。MIT を選べる部分は MIT を選び、Apache だけの部分は本文と例外を併記する。例外で表示を省略できるかを全体へ一般化する案より、適用本文を保持する方法を選ぶ。Dragonbox の Apache/Boost の選択は Apache に、fast_float の配布本文も Apache の対応に揃え、独立した表示方式を増やさない。

#### Rust crates と標準 library

Bun 1.4.2 の Cargo.lock にある registry package 181 件の archive を checksum と照合し、Cargo.toml の許諾欄と本文の有無を調べた。これは build/test/他 OS 向けも含む入力の集合であり、181 件すべてを Linux binary の内蔵 component とするものではない。MPL の4件は BUN-3 で扱い、それ以外は次の選択を適用する。

- MIT / Apache 等の **OR** で MIT を選べるものは MIT を選び、著作権・許諾を保持する。`r-efi` の候補に LGPL があっても、MIT を選ぶので LGPL 対応を追加しない。`constant_time_eq` の CC0 / MIT-0 / Apache は MIT-0 を選び、追跡用に本文を残す。
- `encoding_rs` は **MIT または Apache に加えて BSD-3-Clause**、`unicode-ident` は **MIT または Apache に加えて Unicode-3.0** である。MIT 側を選んでも追加条件は消えないため、`LICENSE-WHATWG` や `LICENSE-UNICODE` と著作権表示も保持する。
- `const_format`、`foldhash`、`konst` と関連 macro の Zlib、`arrayref` の BSD-2-Clause、`subtle` の BSD-3-Clause は、それぞれの source 表示・変更または binary 表示の条件で扱う。`ciborium` 系の Apache-2.0 も、再生成用に source を渡す範囲ではその本文・表示を保持する。
- Rust 標準 library の MIT / Apache の候補は MIT を選ぶ。標準 library に含まれる第三者の条件は `COPYRIGHT` とライセンス metadata に従って追加し、LLVM runtime 由来の Apache＋例外を MIT に置き換えない。

**収集方法の選択と理由:** crate の metadata だけから汎用テンプレートを出す方法は採らず、archive 内の本文・著作権と、足りない場合は対応 revision の upstream 原文を収録する。例えば `selectors 0.33.0` は crate に MPL 本文を含めないため、MPL 本文を補う。MIT を選ぶ場合も、一般的な MIT 本文だけでは個別著作権の代わりにならない。build graph で runtime と build/test を区別し、後者の source を再生成用に配る場合も表示を保持する。

### BUN-8: Polyfill・取り込みコード・SQLite

**Polyfill:** Bun の LICENSE が列挙する acorn / acorn-walk、assert、browserify-zlib、buffer、constants-browserify、crypto-browserify、domain-browser、events、https-browserify、os-browserify、path-browserify、process、punycode、querystring-es3、stream-browserify、stream-http、string_decoder、timers-browserify、tty-browserify、url、util、vm-browserify の MIT 表示を対象にする。さらに `src/node-fallbacks/vendor/ieee754.js` の BSD-3-Clause のような内側の表示も保持する。

**取り込みコード:** esbuild 由来の変換器等、uucode 由来の文字幅処理の MIT、Node.js 由来ファイルの MIT と追加表示、LLVM libc++abi 由来の `__cxa_thread_atexit` fallback の Apache-2.0 WITH LLVM-exception は、Bun 自体の MIT 表示に吸収せず、それぞれの本文・著作権・必要な変更表示を保持する。上流一覧にある libbase64 の BSD-2-Clause、libuv の MIT、TigerBeetle 由来 IO code の Apache-2.0 もこの方法で扱い、Linux の収録対象か、再生成用 source に含まれるだけかを build graph で区別する。

**候補と選択（POLICY）:** 内蔵 module を nas が使用するかで表示を削る方法より、配布する runtime にコードが入るかで収録を決める。実行時に import されるまで使われないコードも、binary に埋め込んであれば再配布するためである。upstream のまとめと source header を併用し、著作権と許諾を package ごとの notice に残す。MIT/BSD/Apache の要求と選択は、それぞれ BUN-4〜BUN-6 の方法で満たす。

**SQLite と Unlicense:** Linux の static SQLite は、[amalgamation の public-domain 宣言](https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/jsc/bindings/sqlite/sqlite3.c)を根拠に、追加の source 提供義務を課さない。Bun の `src/clap/LICENSE` の Unlicense も元の宣言を保持する。source は再生成材料として渡し、notice にも出自を残すが、これは表示義務を新たに作るという意味ではない。

### Bun / JavaScriptCore の配布物で確認すること

以上が Bun 1.4.2 と WebKit fork を根拠に選んだ対応である。実装では、この判断を配布する入力と成果物に結び付け、次を確認する。

- JSC-2 / TCC-2 の source からの再生成に必要な材料が揃い、手順が成立すること。
- JSC-1 / TCC-1 の実行時表示、利用条件、変更表示と、MPL source の提供・案内が揃うこと。
- ICU の実際の版、両 architecture の build graph、個別 source headers と必要 notice が収録物に対応すること。OS 向け条件で除外する対象は根拠を残す。例えば vendor libuv 本体は Windows 限定だが、Linux の libuv 互換部分に取り込まれた表示は別に扱う。

版や収録対象を変える場合は、ここに記録した条件・候補・選択との差を調べて更新する。成果物に材料や表示をまだ収録していない段階を、対応の実装完了とはしない。

## glibc と同梱する LGPL shared library

`nix-bundle-elf` が glibc の shared library と dynamic loader を payload にコピーするため、glibc 自体を再配布することになる。同時に、それらへ動的リンクする executable の配布条件も満たす必要がある。library 自体の再配布には GLIBC-1、動的リンクした executable には GLIBC-2、使用告知と利用条件には GLIBC-3 で対応する。動的リンクであることを理由に、コピーして渡す glibc の source 提供を省略できるわけではない。

以下は [LGPL 2.1 の本文](https://raw.githubusercontent.com/bminor/glibc/glibc-2.42/COPYING.LIB)を根拠にする。参照した本文のタグは条文確認用であり、配布する版を指定するものではない。他の shared library にも同じ方法を使う場合は、その component の許諾と条件を確認して対応を記録する。

### GLIBC-1: library 自体の対応ソースを提供する

**要求（LICENSE）:** LGPL 2.1 §4 は library の object code 配布に完全な対応ソースを要求する。source の範囲には §0 の build/install scripts が含まれ、変更版は §2 の条件も満たす。

**候補:** binary と一緒に source を渡す方法と、§4 が認める同じ配布場所からの equivalent access がある。

**選択と理由（POLICY）:** 同じ Release の追加 source asset を選ぶ。dtach と取得先を揃え、通常の binary download を小さくできるためである。使用した source、patch、適用順序、build 定義を収録し、変更表示・許諾も保持する。Nixpkgs の revision は provenance として記録するが、材料の実物の代わりにはしない。

### GLIBC-2: 変更した library を利用できるリンク方法を用意する

**要求（LICENSE）:** linked work は LGPL 2.1 §6 のいずれかの方法を満たす必要がある。

**候補:** §6(a)/(d) による再リンク材料の提供、§6(b) の適切な shared library 機構、§6(c) の written offer などがある。

**選択と理由（POLICY）:** §6(b) の機構を選ぶ。利用者が配置した interface-compatible な変更 library を使えるなら、executable 全体の再ビルドを要求せずに済むためである。

#### `--extract` で展開した library を交換する

交換経路には `nix-bundle-elf` の `--extract` を使う。[展開処理と wrapper の生成](https://github.com/Hogeyama/nix-bundle-elf/blob/c75837de26d6d99522f48ab19e13bc4b963d5f7f/src/lib/shell-template.ts)は、指定したディレクトリに payload を残し、各 ELF の interpreter をその展開先に向け、`bin/nas` と executable ごとの `libexec/` wrapper を作る。[script bundle の生成](https://github.com/Hogeyama/nix-bundle-elf/blob/c75837de26d6d99522f48ab19e13bc4b963d5f7f/src/commands/bundle-script.ts)では executable ごとに `lib-nas`、`lib-pkl`、`lib-dtach` を用意する。

利用者に提供する手順は次のとおり。

1. `./nas --extract /absolute/path/nas-unpacked` で、まだ存在しない、利用者が書き換えられる場所へ展開する。
2. 対象 executable の `lib-<name>/` 内の library を、同じ architecture・interface の変更版に置き換える。複数の executable で使う場合は各ディレクトリを交換する。glibc は dynamic loader と library の組合せも整合させる。
3. `/absolute/path/nas-unpacked/bin/nas` から起動する。wrapper が参照する展開先を動かさず、その場で交換する。

preload 方式の wrapper は対象の `lib-<name>/` を `LD_LIBRARY_PATH` の先頭に設定するため、外から環境変数を追加するだけの方法には頼らない。毎回一時展開する元の `./nas` を起動すると交換内容は使われないので、展開後の launcher を使う。

この経路は nas 自体の再ビルドや再梱包を必要とせず、利用者が交換したファイルを次の起動でも使えるため採用する。Release の検証では、両 architecture で展開後の launcher から起動し、変更 library が実際にロードされることを確認する。ソースコードで経路を確認したことと、この成果物の動作確認は区別する。機構が条件を満たさなければ再リンク材料の提供へ切り替える。どちらを選んでも、同梱する library 自体についての GLIBC-1 は残る。

### GLIBC-3: 使用告知・本文・改変を許す条件を揃える

**要求（LICENSE）:** LGPL 2.1 §6 冒頭と notice 条項に従い、library の使用と許諾を告知し、本文を渡す。利用者自身の変更と、そのデバッグのための reverse engineering を許す。実行時に著作権表示を出す場合は、そこでの表示条件も満たす。

**選択と理由（POLICY）:** 使用告知と本文・著作権表示は notice tree に収録し、archive 内と展開後に置く。利用条件と実行時表示も確認する。材料の提供だけでは、この告知と許可を代替できないためである。

glibc には LGPL 以外の個別許諾もある。[上流の `LICENSES`](https://raw.githubusercontent.com/bminor/glibc/glibc-2.42/LICENSES) は、そこに集めた表示を binary 配布にも伴わせるよう求めている。配布版に対応する `COPYING.LIB` と `LICENSES` 全文を notice tree に収録する。必要な表示の取りこぼしを避けるため、`LICENSES` を LGPL 本文や一部の抜粋で置き換えない。

payload に入った dynamic loader、`libc.so`、`libm` 等の各ファイルを、使用した glibc の source・patch と収録する表示に紐付ける。該当 source の個別条件も確認し、追加の表示が必要なら収録する。glibc という component 名だけから、すべてのファイルの条件を LGPL と判定しない。

## libfuse と musl — 同梱 helper の依存

nas-maskfs はホストで動くため、Nix store の loader や library に依存したまま assets にコピーしても standalone 配布にならない。nas-maskfs を bundle の executable として処理し、libfuse の shared library も同梱する。

### FUSE-1: 本文・表示・対応 source を渡す

**要求（LICENSE）:** [libfuse 3.18.2 の LICENSE](https://github.com/libfuse/libfuse/blob/fuse-3.18.2/LICENSE) は library と headers を LGPL 2.1 の対象にしている。[同梱本文](https://github.com/libfuse/libfuse/blob/fuse-3.18.2/LGPL2.txt) §1・§2・§4 に従い、表示・本文、適用した変更と build scripts を含む対応 source を提供する。

**候補・選択と理由（POLICY）:** source を binary archive に入れる方法と、同じ配布場所から取得させる方法のうち、§4 の同じ場所からの提供を選ぶ。glibc と同じ source asset に、使用した libfuse source、Nixpkgs の patch と recipe を収録できるためである。notice tree に原文の本文・著作権表示・利用告知を置く。source archive に含む GPL 対象の build 用ファイルも、上流の許諾・表示を保持する。

### FUSE-2: 変更した library を読み込めるようにする

**要求・候補・選択と理由:** LGPL 2.1 §6 の再リンク材料提供と shared library 交換の候補から、GLIBC-2 と同じ展開後の交換を選ぶ。`lib-nas-maskfs/` の libfuse を交換し、展開後の assets 側 launcher から起動する。maskfs の再コンパイルを必要とせず、同じ交換手順を使えるためである。§6 の使用告知と、利用者自身の改変・デバッグを許す条件も維持する。

### MUSL-1: 静的 helper に入る musl の表示を保持する

mask-filter はホストとコンテナで同じ executable を使うため、周囲の bundle directory に依存する wrapper に置き換えず、Zig の musl target で単一の static executable にする。使用した Zig source に含まれる musl の `COPYRIGHT` を notice tree に収録し、MIT 本文だけでなく同文書の個別表示も保持する。再生成には同じ Zig の入力を使う。この方法はコンテナへ library directory 一式を追加で渡す変更を不要にする。

## Pkl — Apache-2.0 と内蔵する第三者コード

Pkl の native executable を配る。Pkl 自体には [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0.txt) が適用され、内蔵コードの情報は [upstream の THIRD-PARTY-NOTICES](https://raw.githubusercontent.com/apple/pkl/0.31.1/THIRD-PARTY-NOTICES.txt) も起点に確認する。

### PKL-1: LICENSE と NOTICE を渡す

**要求（LICENSE）:** §4(a) の本文提供、該当する §4(d) の NOTICE 保持に対応する。source も配る場合は §4(c) の表示保持も満たす。

**候補:** §4(d) の attribution は、NOTICE ファイル、添付する source/文書、通常そのような表示を出す画面に掲載する方法がある。

**選択と理由（POLICY）:** 配布版の `LICENSE.txt`、`NOTICE.txt`、`THIRD-PARTY-NOTICES.txt` を notice tree に保持する。原文を再構成する負担と欠落を避け、表示用の画面も不要にできる。第三者 notices は、次の PKL-3 の確認にも使う。

### PKL-2: 変更したファイルに変更を表示する

**要求（LICENSE）:** Apache-2.0 §4(b) に従い、変更したファイルに変更した旨を明示する。

**選択と理由（POLICY）:** source の変更はファイル内の表示を保持・補完する。ELF の interpreter / RPATH の変更は、DT-3 と同じ `.nas.changes` section に明示する。ファイルへの表示が要求されるため、別の provenance 一覧だけで代替しない。

Pkl は上流 ELF に section を追加してから `autoPatchelf` を適用する。この順序を選ぶのは、`patchelf` 後の Pkl に `objcopy` を適用する試験では dynamic section が壊れて起動できず、逆の順序では起動と表示の保持を確認できたためである。両 architecture の配布 binary でも、展開後の起動と表示の保持を検査する。

### PKL-3: native executable 内の第三者コードを確認する

Pkl 本体の Apache-2.0 を、内蔵コード全体の許諾とは扱わない。native executable に含まれる component と notices の対応を確認し、各 component の要求・候補・選択と理由を記録する。

upstream が提供する情報を使う方法を選び、不足する本文・表示・source 等を補う。上流の収集物を利用すると追従しやすいが、それだけで内蔵コードのすべての要求に対応済みとは判断しない。

### PKL-4: 内蔵 GraalVM runtime の本文・例外・対応 source を渡す

Pkl 0.31.1 の build 定義は GraalVM Community JDK 25.0.0 を使う。配布する x86_64 native executable にも `GraalVM CE 25+37.1` の SubstrateVM runtime 情報が入っている。Pkl の `THIRD-PARTY-NOTICES.txt` にある Graal SDK / Truffle API の UPL 表示だけでは、この runtime の表示を代替できない。

**要求（LICENSE）:** [GraalVM 25.0.0 の SubstrateVM 本文](https://github.com/oracle/graal/blob/graal-25.0.0/substratevm/LICENSE)の GPLv2 と Classpath Exception を保持する。GPL 対象の runtime code の本文・表示・対応 source を渡す。Classpath Exception を、その runtime 自体の source 提供を省略する根拠にはしない。内蔵する OpenJDK code と追加の第三者表示も、対応版の原文に結び付ける。

**候補・選択と理由（POLICY）:** Pkl 自身の配布と同じ方法を選ぶ。原文の本文・例外・表示は notice tree に収録し、固定版の GraalVM / LabsJDK の source は、公開 upstream revision と archive hash を `recipes/upstream-sources.json` に記録して案内する。Pkl は、この runtime を内蔵した native executable を source の複製なしに配布している。nas はそれを変更せずに再配布するので、同じ取得経路を案内する。上流が参照できなくなるリスクの扱いは JSC-2 と同じとする。runtime の収録範囲と版を binary / build 定義で確認し、原文の LICENSE・例外・該当第三者表示を notice tree に加える。コンパイルに使った JDK 全体を binary に内蔵したと推定する方法は採らない。両 architecture の対応が確認できるまで PKL-3 の公開チェックを通さない。

## JavaScript パッケージと vendored Python

nas の executable、frontend assets、同梱 Python tree に実際に入る package を対象にする。開発用 lockfile に名前があることと、配布物に含まれることを区別する。

### PKG-1: 配布版の著作権・許諾・免責表示を保持する

[MIT](https://opensource.org/license/mit) は著作権・許諾表示の保持を求める。[BSD-3-Clause](https://opensource.org/license/bsd-3-clause) には source と binary それぞれの表示条件があり、権利者・貢献者の名前を無断で推奨・宣伝に使わない条件もある。package ごとに原文を確認し、異なる条件には個別に対応する。

**候補:** 各 package の本文を個別に収録する方法と、必要な表示を集約した文書を生成する方法がある。

**選択と理由（POLICY）:** 配布版の package から本文・表示を取得し、package ごとのファイルとして notice tree に入れる。著作権者の情報を保持しやすく、更新時に対応版も追いやすいためである。source 内にだけ表示がある場合は、その表示も保存する。BSD の対象では、配布文書等が無断の推奨・宣伝になっていないことも確認する。

MIT/BSD だからという理由だけで source asset への収録を一律に要求しない。JSC-2 の再生成に必要な package は、JSC-2 の方法で固定した upstream revision を案内する。追加の許諾・例外を持つ package は、同じ節に要求・候補・選択を追加する。

## Geist 等のフォント — OFL の条件を維持する

配布するフォントの原文を確認し、[OFL 1.1](https://openfontlicense.org/open-font-license-official-text/) の対象には次を適用する。

### FONT-1: 著作権表示と OFL を付け、フォントの許諾を維持する

**要求（LICENSE）:** §2 は著作権表示と本文の提供、§5 はフォントを OFL の下で配ることを求める。§1 の単独販売の制限にも従う。

**候補:** 表示と本文は独立したテキスト、読めるヘッダー、利用者が容易に見られる metadata に収録できる。

**選択と理由（POLICY）:** 独立したテキストを notice tree に置く。専用の metadata 閲覧手段なしに読めるためである。nas の一部として配布し、フォント単独の販売は行わず、フォントの許諾を nas の MIT に置き換えない。

### FONT-2: 変更版に関する名前の条件を守る

**要求（LICENSE）:** §3 は変更版の Reserved Font Name の使用を制限し、§4 は権利者・作者名を用いた変更版の宣伝等を制限する。

**候補:** フォントを変更せずに使う、変更版で予約名を使わない、書面の許可を得て予約名を使う、といった方法がある。format の変更も変更版の条件に関係する。

**選択と理由（POLICY）:** 取得した font ファイルを変更せずに同梱する。nas の用途のために改変や許可取得を必要としないためである。取得元が既に変更版を配っている場合は、その表示・名前の条件を満たすことも確認する。subsetting、format 変換、名前変更を導入するときは選び直す。作者等の名前を無断の推奨・宣伝には使わない。

## nix-bundle-elf の自己展開コード: MIT

自己展開 shell と `cleanup_env.c` 由来の共有 library は nas の配布物に入るため、build tool 本体とは別に再配布対象として扱う。nix-bundle-elf の MIT 許諾はこれらの生成コードも対象にする。

### BUNDLE-1: 著作権表示と許諾本文を渡す

**要求（LICENSE）:** MIT の著作権表示と許諾本文を、コピーまたは実質的な部分に添付する。

**候補と選択（POLICY）:** 生成コードごとに本文を埋め込む方法と、同梱 notice にまとめる方法がある。他 component と同じ配布手順で保持できるよう、`licenses/native/nix-bundle-elf-runtime/LICENSE` に原文を置き、外側の archive と自己展開 payload の両方に収録する。固定 revision に適用する source patch にも LICENSE を含め、許諾と配布コードの対応を辿れるようにする。

## その他の native code・同梱 helper・自己展開部分

nas の helper に含まれる runtime code、コピーされる native library、自己展開のためのコードも再配布対象にする。glibc 以外を一括して「native library」とだけ記録して終えない。

最終成果物と build 入力から実際の対象を特定し、component ごとに本文・例外を確認する。例えば compiler runtime にライセンス例外が付く場合、例外の原文と、その条件を満たす根拠も記録する。build tool 自体を配っていない場合と、tool が出力に組み込むコードを配る場合を分ける。

本文・表示の収録で足りるのか、source や再リンク材料も必要なのかを決め、その component の節に候補と選択理由を残す。共有 library の方法を流用する際も、適用条件が同じであることを確認する。この対象の列挙と個別判断は、配布前に完了させる。

- **表示だけを収録する:** zlib（Zlib）、OpenSSL（Apache-2.0）、Zig と同梱の musl（MIT）、vendored graphql-core（MIT）は、表示の保持で配布条件を満たす。これらの source は source asset に入れない。
- **payload に入るときだけ扱う:** OpenSSL・zlib・GCC runtime（`libgcc_s`）は、bundler が解決できる library であっても、payload に実際にコピーされたときだけ component にする。GCC runtime の library 自体をコピーして配る場合は GPL の object code になるので、GCC の source を収録する。runtime library exception の下で executable に組み込まれたコードには、source 提供の義務はない。

## 共通の梱包と公開

### 利用者に渡すもの

- `nas-<tag>_<system>.tar.gz`: executable と、component ごとの notice tree を含む binary archive。
- source/materials archive: dtach・glibc・libfuse・TinyCC・nas などの source・変更・build 定義と、Bun・Pkl の source を示す固定 upstream revision。
- component 一覧: 配布した版・由来・適用条文、その要求への対応、材料の配置を記録する。

同じ notice tree を自己展開後の `share/nas/assets/licenses` にも置く。配布 component の一覧と、収集した source archive に含まれるだけの component は区別する。source archive 内の第三者表示も保持する。

両 architecture の材料は同一と確認できた部分だけ共有し、差は記録する。nas revision、architecture、asset 名・hash を一覧に残す。最終 binary の hash は自己参照を避けて外側の一覧に置く。

### binary と必要材料を揃えてから公開する

生成した材料を検査し、すべて揃ってから Release を公開する。draft への upload は使ってよい。材料生成が失敗したまま binary だけを公開する処理にはしない。

これは各 component で選んだ直接提供を成立させるための運用である。binary 公開後に材料を追加する方法は、途中失敗すると必要物のない配布を残すため採らない。binary を公開している間は、対応材料も取得できる状態を維持する。asset の容量・保存先に制約が出た場合は、提供場所と取得可能性を再検討する。

配布経路を追加・変更する場合は、その経路でも各 component の告知と材料提供の条件を満たすことを公開前に確認する。

### 対応を機械可読で記録する

component ごとに、固定した原文・条項から、要求、候補、選択と理由、成果物内の配置または利用条件まで辿れるようにする。本 spec の判断を使う場合は `JSC-2` などの節を参照し、理由を二重管理しない。版・revision・hash のうち build 入力から取得できるものを手で二重入力しない。

この記録は必要材料を生成・照合するために持つ。汎用のライセンス推定基盤や、すべての build 環境を保存する仕組みは作らない。新しい条件が見つかった場合は、該当 component の要求と判断を追加する。

## 依存更新と検証

### build 入力と収集物を照合する

native は bundle が実際にコピーする対象と出自を照合する。`extraFiles` に入る helper と自己展開部分も確認する。JavaScript と font は実際の build 入力とコピー対象から収集する。ELF の走査だけでは静的に含まれるコードを拾えないため、Bun の固定版の build 定義・lockfile も使う。

Bun の依存 revision・Cargo checksum・npm integrity と、Pkl の内蔵 runtime の対応版は、材料を作る Nix build 内で upstream から導出する。生成した JSON は Nix store 内の中間成果物とし、repository には置かない。取得物と生成一覧の集合を一つの fixed-output hash で固定する。WebKit など取得方法が異なる少数の入力と、適用条項・許諾の選択は明示的に管理する。新しい component の未登録、必要材料の欠落、固定した入力と build 入力の不一致は、公開前の検査を失敗させる。

入力更新時は、差分に含まれる component のライセンスと採用方法をレビューする。評価の理由は本 spec に残し、「検証済み」の hash や承認 JSON を別途手で管理しない。生成された checksum は材料の同一性を確認するためのものであり、ライセンス評価を代替しない。成果物に関係しない開発依存の変更まで無条件に再調査させない。

### 完成時に確認すること

1. 実際の配布対象すべてに、適用条件と、要求・候補・選択理由の記録がある。
2. 両 architecture の archive 内と展開後で、各 component に必要な本文・表示が読める。
3. source/materials が配布 binary の入力に対応し、必要な patch と build 定義を含む。Release に複製する source は同じ Release から、Bun・Pkl の source は記録した固定 upstream revision から取得できる。
4. JavaScriptCore は JSC-1〜JSC-4、TinyCC は TCC-1〜TCC-3 の告知・材料・利用条件・変更表示を確認済みであり、MPL-1 の対象 source と取得案内も揃っている。再生成方法を既存の build 手順から辿れる。
5. glibc 等は、library 自体の source 提供と、linked work の交換・再リンク方法の両方を確認済みである。
6. 未登録 component、必要ファイルの欠落、固定した入力との不一致、材料生成の失敗が、公開を止めることを確認する。
7. ELF の変更表示、内蔵 component の個別条件、再生成に必要な材料などの未確定事項を解消している。

## なぜこのアプローチを選んだか

必要な対応は、配布する component の許諾と、source・binary・静的リンクなどの配布形態から決まる。そのため component ごとに条件と方法を決め、共通化できる収集・梱包・公開だけをまとめる。これにより「JavaScriptCore のために何をするのか」と「Release 全体をどう作るのか」をそれぞれ判断できる。

source を直接提供する方法は、必要時に利用者が取得でき、配布者も binary と一緒に管理できる。表示は upstream の原文を利用し、更新時に欠落しにくくする。検査は、その選択と配布物の整合性を保つために置く。

## 他のアプローチを採らない理由

notice の収集だけでは、dtach の source 提供や JavaScriptCore の再リンク材料を満たせない。一方、すべての build 依存を保存し、すべてを毎回再ビルドする方法は、各 component の条件から必要性を説明できない作業まで増やす。必要な材料と検証は、選んだ提供・再生成方法から決める。専用の offline installer や Bun 全体の再構築ツールを持つと、upstream の build system と重複する保守が発生するため採らない。

Nix 経由のインストールだけにすれば配布形態は変わるが、Nix のない環境へ自己展開 executable を届ける目的を満たさない。dtach をホスト依存にする方法も、利用者のセットアップを増やし、Bun や glibc の対応を解消しないため採らない。

判断を変更するときは、該当 component の節に、新しく分かった事実と、それによって採用・不採用の理由がどう変わったかを記録する。
