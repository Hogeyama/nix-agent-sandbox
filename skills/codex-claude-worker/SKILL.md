---
name: codex-claude-worker
description: Codex が管理する実装タスクを Claude Code の claude -p に委譲する。implementation worker として指定されたときに、作業範囲・呼び出し上限・引き継ぎを管理する。
---

# Codex Claude Worker

Codex が controller、`claude -p` が implementation worker を担当する。
`patched-superpowers` など、外側のワークフローの**実装担当の起動方法**を置き換える。
設計、人間レビュー、独立したコードレビュー、最終検証の手順は外側に残す。

使用例:

```text
/patched-superpowers ○○を実装してください。
implementation worker には /codex-claude-worker を使ってください。
```

Codex のスキル選択では `$codex-claude-worker` とも指定できる。
controller から直接 CLI を起動し、CLI を起動するだけの中継エージェントは追加しない。
レビュー修正もこの worker を使う。worker 自身には、このスキルや外側のワークフローを
再実行させず、[worker-prompt.md](references/worker-prompt.md) を渡す。

## 呼び出す前に決めること

controller は承認済みの仕様と現在の差分から、今回の作業を一つの brief にまとめる。
既存の task brief が十分なら再作成しない。最低限、次を含める:

- 作業ディレクトリ、branch、base SHA、既存の未コミット変更の有無と扱い。
- 今回完了させる挙動、変更対象、既存の関数・テスト・fixture の入口。
- 最新のユーザー判断、維持すべき契約、対象外。必読の規約と仕様の該当箇所。
- 対象テストと必要な型チェック、完了条件、commit の要否・単位。
- report の保存先、今回の `max_turns`、既知の環境制約と実行済み検証。

未解決の製品仕様を「実装中に適当に決める」仕事として渡さない。
一方、通常の実装判断まで controller がコード化して二重実装する必要はない。
既に分かった入口や制約を渡し、worker にリポジトリ全体の再調査をさせない。
会話履歴、全タスクの計画、過去ログ一式は添付せず、必要な参照へ絞る。
CLAUDE.md 等の適用される規約を省くためにこの絞り込みを使わない。

一回の編集・検証で完了できる範囲へ切る。複数層にまたがる大きな機能は、
インターフェースと完了条件が明確な単位へ分ける。同種の小修正や一度のレビューで
確定した findings は一括で渡し、commit 単位は外側のルールを守る。

## 上限とセッション

`--max-turns` を付けて起動する。最初の目安は実装40、小さな修正20。
これは調整可能な開始値であり、消費トークンや料金の上限ではない。
増やす前に、探索・実装・検証のどこが収まらないかを確認して作業を切り直す。
モデルはユーザー指定を優先し、指定がなければ現在の Claude 設定を使う。
`--max-budget-usd` はユーザーが金額を指定した場合だけ追加する。

- 新しいタスク、仕様変更後、長くなったセッションからの引き継ぎは新規セッション。
- 同じ契約の小さな修正で、直前の短い文脈が役立つ場合だけ、記録済み session ID を
  `--resume` で指定する。理由と累積の呼び出し状況を ledger に残す。
- `--continue` は使わない。別タスクの履歴を誤って拾うため。
- 上限到達時は diff と checkpoint を controller が確認し、残件を限定してから
  次の呼び出しを決める。上限を上げるだけの再開や、自動の再試行ループは作らない。
- quota、認証・権限の拒否、同じ失敗の反復では呼び出しを止める。
  新規セッションや別の実行経路で制限を回避しない。実装担当の変更は、当該作業で
  既に得ているユーザーの許可に従い、未許可なら状況と選択肢を伝える。

外側の「元の implementer を resume」という指示は、ここでは**同じ担当契約へ
修正を返すこと**として扱う。長い Claude セッションの再利用までは要求しない。
外側のレビュー回数上限を、セッションの作り直しでリセットしない。

## 起動と監視

`claude --version` と使用するオプションを確認する。CLI がない、または上限指定が
使えない場合は、無制限の呼び出しへ黙って切り替えない。
`--max-turns` は help に出ない版もあるため、必要なら
[公式 CLI reference](https://code.claude.com/docs/en/cli-reference) で確認する。

呼び出しごとに一意の保存先を用意し、prompt、events、stderr、終了値を分けて残す。
外側の gitignored な作業領域を使う。prompt はテンプレートと今回の brief から作り、
実際の作業パス・report パス・上限値を入れる。本文は stdin から渡す。

```bash
# worker_cwd, worker_dir は絶対パス。worker_dir は今回専用の作成済みディレクトリ。
# worker_turns は brief に記録した正の整数。prompt.md は今回の完成済み指示。
cd -- "$worker_cwd" || exit 1
worker_exit=0
claude -p --output-format stream-json --verbose \
  --max-turns "$worker_turns" \
  < "$worker_dir/prompt.md" \
  > "$worker_dir/events.jsonl" 2> "$worker_dir/stderr.log" || worker_exit=$?
printf '%s\n' "$worker_exit" > "$worker_dir/exit-code"
exit "$worker_exit"
```

明示的なモデル指定や許可された resume は上の呼び出しへ追加する。
権限回避フラグや承認設定の変更は、このスキルを使うだけでは許可されない。
`--bare` 等でプロジェクトの規約・認証・hooks をまとめて無効化して省力化しない。

長時間実行の handle を保持する。controller は結果を待つ間に必要な別作業を進め、
ユーザーへの状況共有を続ける。短い間隔でログ全体を読み返さず、最新イベントの
種別・件数や差分の増分から、探索・編集・検証のどこにいるかを確認する。
同じファイルの再読だけが続く、対象外へ探索が広がる場合は brief を見直す。

新しい仕様は実行中の brief に上書きしない。worker の停止を確認してから更新し、
現在の diff を含む引き継ぎを作る。子プロセスも残っていないことを確認して再開する。
承認待ちの無出力を、実装の停滞と決めつけて停止・再実行しない。

## 結果の受け取り

成功判定には、CLI 終了値0、最後の `type: result` の `is_error: false` と
成功 subtype、report の完了状態、実際の git 差分・検証結果の整合が必要。
`subtype: success` だけで判定しない。result 欠如や report 欠如は成功とみなさない。
エラーの場合も、既に書かれた変更や commit を自動で破棄しない。

report は最後だけでなく、編集完了時と検証・commit 完了時にも更新させる。
中断で report が残らなければ、controller が git とログから復元し、推測を区別する。
報告を書かせるためだけに消耗したセッションを再開しない。

worker は対象を絞った検証を担当する。全体検証、ホスト検証、独立レビューは
外側で一度実施し、同じ revision の同じ検証を役割ごとに重ねない。
既存テストへ加える assertion と独立した新規ケースを区別し、fixture の丸ごと複製や
実装から期待値を組み立てるテストを増やさない。省力化のために必要な検証は削らない。

ledger に呼び出し回数、session ID、base/head、`num_turns`、結果、report/log の場所を
記録する。「何往復」は外側の呼び出し数と内部ターン数を分けて答える。
ツール数は当該ログで観測できた範囲とし、0や欠損を未実行の証拠にしない。
resume の累積値を確認せず `total_cost_usd` 等を合算しない。
最後に外側へ状態・commit・検証要約・懸念・report パスを短く返す。
