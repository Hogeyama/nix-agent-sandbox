# HostExec argv0 Integrity Verification Design

Date: 2026-08-12
Status: Proposed

## Context

hostexec ルールの `match.argv0` に絶対パス・相対パスを指定すると、その対象は
LD_PRELOAD による `execve` インターセプトでホスト側に委譲され、ブローカーが
`Bun.spawn([argv0, ...])`（`src/hostexec/broker.ts:718`）でホスト上のそのパスを
実行する。ブローカーはパス文字列を exec 時にその場で解決するだけで、対象ファイルの
inode も内容も検証しない。

このため、コンテナ内のエージェントが**そのパスの中身を差し替えてから hostexec を
呼ぶ**と、ホスト上でエージェント制御のコードが実行される。ホスト任意コード実行に
直結する。

### 差し替えは実際に成立する（実証済み）

ファイル単体を ro bind-mount しても、親ディレクトリがコンテナから書き込み可能なら
保護にならない。ファイル自身は EBUSY で触れなくても、親ディレクトリを rename して
同名の別ツリーに差し替えれば、ホストが解決するパスの中身はエージェント制御になる。

コンテナ内（uid=1000）から以下が成立することを確認した:

```
mv nas nas.orig          # ro サブマウントを内包したまま親ごと退避（exit=0）
mkdir nas                # 同じパスに攻撃者制御の新ディレクトリを再構築
echo evil > nas/tmp.sh   # 追記も自由
```

同一ファイルシステム上の rename なのでホストからも swap 後が見える。ブローカーが
`~/.local/share/nas/tmp.sh` を exec した瞬間、攻撃者のスクリプトがホストユーザー
権限で走る。

ro マウントが守るのは inode だけで、パス解決を守らない。全祖先がマウント境界で
途切れず rename 不能である必要があるが、`~/.local/share` などは素の rw ディレクトリで
一般に成立しない。

### 既存の allowlist は問題の解決になっていない

`validateAbsoluteArgv0`（`src/stages/hostexec/stage.ts:74`）は絶対パス argv0 を
`/usr/bin/*`, `/usr/local/bin/*`, `/opt/*/bin/*`, `/home/<user>/.local/bin/*` に
制限する。これは commit `c5123479` が「悪意ある repo config が `/etc/passwd` を
指定してコンテナ側パスを shadow する」ことを防ぐために入れた。

しかし:

- repo config は config-trust gate（`src/config/trust.ts`）で人間が明示的に信頼した
  内容しか評価されない。「悪意ある repo config」は評価の手前で止まるので脅威モデルに
  入っていない。
- allowlist が守っていたのはコンテナ側 shadow（後述のフォールバック経路）であって、
  今回のホスト側 exec 差し替えは守っていない。
- `~/.local/share/...` や `~/.claude/...` 配下を argv0 にする正当なユースケースを
  ブロックしてしまう。

## Goal

LD_PRELOAD 型 argv0（絶対パス・相対パス）のホスト exec を、対象ファイルの
**実行時 content 検証**で守る。ブローカー起動時にファイルの baseline を記録し、
execute 要求ごとに再検証する。baseline と食い違えば、ルールが `allow` でも承認
prompt に回す。人間が差し替えを認識・承認できるようにする。

あわせて、存在理由を失った allowlist と、コンテナ側 shadow の原因であるフォールバック
bind-mount 経路を削除する。

### Non-Goals

- bare name argv0（ホスト PATH 経由で解決されるバイナリ）の content 検証。これは
  README:844 が示すとおり「ホスト PATH 上のディレクトリを rw マウントしない」ことに
  依存する。今回の対象外。
- 検証（hash 読み）と `Bun.spawn` の間の TOCTOU レースを厳密に閉じること。fd 固定
  （`fexecve`）は採用しない（Why Not 参照）。残留レースは受容する。
- config-trust 時点での baseline 永続化。セッション間の変更検出は行わない
  （Why Not 参照）。

## Threat Model

- **攻撃者**: コンテナ内で動くエージェント。`security-constraints` の C1/C2 が想定する
  攻撃者そのもの。
- **信頼する主体**: repo config を書いて `nas trust` する人間。config の内容は信頼する
  （config-trust gate の前提）。
- **守る不変条件**: ブローカーがホスト上で exec するファイルは、ブローカー起動時点
  （＝コンテナ起動前）の状態から改変されていないこと。改変されていれば人間の承認を
  要求する。

## Design

### 1. フォールバック bind-mount 経路の削除

`src/stages/hostexec/stage.ts` の LD_PRELOAD フォールバック（intercept .so が
見つからないときに、ラッパースクリプトをコンテナ側の argv0 パスへ bind-mount する
経路、現状 `353-362` 付近）を削除する。

削除後の挙動: LD_PRELOAD 型ルール（相対・絶対 argv0）が存在し、かつ intercept
ライブラリが解決できない場合は、黙ってフォールバックせず**明確なエラーで停止**する。
エラーは intercept ライブラリのビルドが必要である旨を示す。

この経路が唯一「コンテナ内の argv0 パスにラッパーを被せる（shadow）」動作だった。
削除により、`argv0 = /etc/passwd` のような指定がコンテナの system ファイルを破壊する
リスクが消滅する。intercept .so は本番（Nix ビルド）では常に存在するため、通常運用は
影響を受けない。

### 2. allowlist の撤廃

`validateAbsoluteArgv0` のプレフィックス allowlist
（`ABSOLUTE_ARGV0_ALLOWED_PREFIXES`, `ABSOLUTE_ARGV0_ALLOWED_OPT_PATTERN`,
`CONTAINER_HOME_LOCAL_BIN_SUFFIX` による判定）を撤廃する。フォールバック削除で
コンテナ側 shadow が不可能になり、allowlist の存在理由がなくなる。

入力健全性チェックは最小限だけ残す: 絶対 argv0 が `/` 単体または末尾スラッシュ
（＝ファイルでないパス）の場合は拒否する。プレフィックス突破を防ぐための
`.`/`..` セグメント拒否は、突破対象の allowlist が消えるため不要になるが、
ファイルパスとして異常なので健全性チェックとして残してよい（実装時に確定）。

### 3. integrity 検証

#### baseline スナップショット

ブローカー起動時（`HostExecBrokerService.start`、パイプライン上で LaunchStage の
コンテナ起動より前）に、LD_PRELOAD 型ルールの argv0 が指すホストパスを解決し、
各ファイルを stat + hash して baseline を記録する。

- baseline は `{ inode, mtime, size, hash }` を保持する。
- ファイルが存在しない場合は「baseline なし（absent）」として記録する。
- baseline はブローカーのメモリ内に保持する。永続化しない。
- 相対 argv0 のホストパスは、既存のパス解決規則（workspace root 基準）に従って
  解決する。

#### execute 時の再検証

`executeStreaming`（`src/hostexec/broker.ts`）の allow 速攻経路
（`resolved.rule.approval === "allow" || this.approvedKeys.has(approvalKey)`、
現状 `377` 付近）に入る**手前**で、対象ルールが LD_PRELOAD 型 argv0 を持つ場合に
integrity を判定する。

判定手順（fast-path 付き）:

1. 対象パスを stat する。inode + mtime + size が baseline と一致 → 変化なしとみなし、
   hash 再計算を省略して **pass**。
2. 食い違う場合、hash を再計算する。hash が baseline と一致 → **pass**
   （inode/mtime/size キャッシュを更新）。
3. hash が baseline と不一致 → **prompt**。
4. baseline が absent だったのに execute 時にファイルが出現 → 差し替えとみなし
   **prompt**。

判定は純粋関数 `decideIntegrity(baseline, current): "pass" | "prompt"` として分離し、
unit テストする。ファイルの stat+hash 読み取りは D1 ヘルパ
`readFileIntegrity(path)` に分離する。

#### prompt 分岐の統合

判定が **prompt** の場合、`approval === "allow"` と `approvedKeys` キャッシュ命中の
**両方の速攻経路をバイパス**して、既存の pending 承認フローに乗せる。

- `approvedKeys` は capability（argv0/args/cwd/env）でキーされ content を含まない。
  したがって content が変わった対象は、過去に承認済みでもキャッシュ命中で素通り
  させてはならない。integrity 判定がこのキャッシュより優先される。
- `config.prompt.enable` が false（prompt 不能）の場合、integrity 不一致は
  approve できないので **deny** する。audit reason に integrity 由来である旨を残す。
- 監査ログの reason に integrity-mismatch を識別できる値を追加する。

#### prompt UI

承認画面（pending entry）に、対象が baseline から**変化したという事実**を表示する。
hash 値そのものは提示しない（承認判断には「差分がある」事実で足りる）。人間が承認
すれば通常の承認フローで実行する。

### 4. コード配置（effect-separation 準拠）

- ブローカー（`src/hostexec/broker.ts`）は既に primitive 層（`Bun.spawn` 直呼び）。
  stat+hash I/O は D1 ヘルパに、判定ロジックは純粋関数に分離する。
- baseline スナップショットに必要な「対象パス集合」は、ブローカー config
  （`HostExecPlan.broker` 経由）にデータとして渡す。stage 側では純粋にパスを列挙し、
  実際の stat+hash はブローカー起動時に行う。
- レース窓を最小化するため、execute 時の stat+hash は `Bun.spawn` の直前で実行する。

## Testing

- `decideIntegrity`（純粋）: unit。pass/prompt の各分岐（inode 一致で省略、hash 一致、
  hash 不一致、absent→出現）を網羅する。
- `readFileIntegrity`（D1）: temp ファイルを使った unit（test-policy が temp dir を
  許可）。
- ブローカーの prompt 分岐: 既存ブローカーテストの様式に合わせ、integrity 不一致で
  allow ルールが pending に回ること、prompt 無効時に deny されることを検証する。
- `validateAbsoluteArgv0`: allowlist 撤廃を反映して更新する（従来 reject していた
  パスが通ること、`/`・末尾スラッシュは依然 reject されること）。
- stage テスト: フォールバック削除を反映（intercept .so 不在かつ LD_PRELOAD 型
  ルール存在でエラー）。

## Why — なぜこのアプローチを選んだか

**パスではなく content に実行を束縛する**方針を採った。ブローカーが信じているのは
パス文字列であり、コンテナはそのパスの解決先を差し替えられる。差し替えを検出する
唯一の確実な方法は、実行時にファイルの content を実測して、既知の良品と比較すること。

baseline を**ブローカー起動時（コンテナ起動前）**に取るのは、その時点でコンテナ
プロセスが存在せず差し替えが不可能だから。パイプライン上 HostExecStage は
LaunchStage より前に走ることを確認済み。これにより「実証したセッション中の
差し替え」を、追加の永続化やユーザー操作なしに完全にカバーできる。

allowlist をマウント境界の動的検証に置き換える案も検討したが、その検証は
「全祖先が rename 不能まで守られているか」の判定に等しく、bind propagation や
symlink 解決を正しく扱う必要があり壊れやすい。content 検証はユーザーのマウント
設定の正しさに依存せず、ブローカー側で実測して閉じるので堅牢。

## Why Not — なぜ他の案を選ばなかったか

- **案 B: ro 入れ子マウントで argv0 を保護する** — ファイル単体の ro bind-mount は、
  親ディレクトリが書き込み可能なら rename 差し替えで突破される（実証済み）。ユーザーが
  全祖先のマウント境界を正しく張らない限り安全にならず、その正しさを nas 側で保証
  するのは全祖先マウント境界検証に等しく壊れやすい。
- **案 C: allowlist を維持したままフルパスを部分許可** — allowlist が守るのは
  コンテナ側 shadow であってホスト側 exec 差し替えではない。今回の脅威には無力な上、
  正当なフルパス用途をブロックし続ける。
- **案 D: baseline を初回 execute 時に記録（TOFU）** — コンテナは既に起動済みなので、
  エージェントが初回リクエスト前に差し替えると悪性ファイルが baseline になる。防御に
  ならない。
- **案 E: baseline を config-trust 時に永続化** — セッション間のホスト側変更も検出
  できるが、trust.ts 拡張・ストレージスキーマ変更・baseline をブローカーまで渡す配線が
  必要。argv0 が trust 時に存在しない／開発中に頻繁に変わるケースの扱いも要る。
  実証した脅威（セッション中の差し替え）はブローカー起動時スナップショットで完全に
  カバーでき、「trust 後～セッション開始前のホスト側変更」はホストを操作できる人間の
  領分であり既存 config-trust モデルと同じ粒度。追加複雑度に見合わない。
- **案 F: fd 固定で TOCTOU を厳密に閉じる（open→fstat→fexecve）** — `Bun.spawn` は
  `fexecve` を出さない。`/proc/self/fd` 経由 exec は子プロセスの fd table 問題で
  成立せず、FFI で `fexecve` を自作すると `Bun.spawn` の stream 統合（mask-filter に
  よる stdout/stderr ラップ・stdin 処理）を全面再実装することになる。セキュリティ
  critical な exec 経路への大改修で、得られるのは既に攻撃難易度の高いレースの封じのみ。
  費用対効果が見合わないため採用しない。残留レース窓は stat+hash を `Bun.spawn` 直前に
  置いて最小化する。
