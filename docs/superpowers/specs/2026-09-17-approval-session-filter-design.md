# 承認一覧のセッション絞り込み

## 目的と合意

`nas network pending|review` と `nas hostexec pending|review` を、1 セッション分だけに絞って実行できるようにする。

複数の nas セッションを同時に開いていると、承認キューには別プロジェクトのリクエストが混ざる。`review` は fzf に全セッション分を流し込むため、承認したい 1 件を選ぶのに関係のない行を読み分けることになる。`pending` も同様に、目的のセッションの状況を確認するのに全体を眺めることになる。

`watch` は既に `--session <id>` を受け付ける。同じ絞り込みを `pending` と `review` にも広げ、承認フローの 3 コマンドで語彙を揃える。

フラグ名は既存の `nas <domain> watch --session` および `nas audit --session` に合わせて `--session` とする。`--session-id` は採らない。同一 CLI 内に 2 つの綴りが並ぶ状態を作らないためである。

## 公開インターフェイス

```
nas network  pending [--session <id>] [--format json] [--runtime-dir DIR]
nas network  review  [--session <id>] [--runtime-dir DIR]
nas hostexec pending [--session <id>] [--format json] [--runtime-dir DIR]
nas hostexec review  [--session <id>] [--runtime-dir DIR]
```

`--session` を省略した場合の挙動は現在と同じで、全セッションが対象になる。

## 動作の契約

1. `--session <id>` を指定すると、`sessionId` が完全一致する pending だけを対象にする。前方一致や部分一致は行わない。セッション id は `nas session list` や `--write-session-id` で正確な値を取得できるため、曖昧一致を入れる理由がない。

2. `--session` に値が無い場合、および次の要素がフラグの場合はエラーで終了する。`watch` に既にある防御をそのまま共有する。値を黙って無視すると、絞ったつもりの全件表示や、一致するものが無いままの無音待機になる。

3. 絞り込みは `--format json` にも効く。JSON 出力と人間向け出力で対象集合が食い違わないようにする。

4. 絞り込んだ結果が 0 件のとき、メッセージにセッション id を含める。

   ```
   [nas] No pending network approvals for session sess_a1b2.
   ```

   `--session` を指定していない場合の文言は現行のまま変えない。

   ```
   [nas] No pending network approvals.
   ```

   id をタイプミスしたときに「0 件」とだけ表示されると、承認待ちが無いのか綴りが違うのかを区別できない。指定した id をそのまま出すことで、利用者が自分の入力と突き合わせられる。

5. 指定されたセッションが既に終了していても、それ自体をエラーにはしない。0 件として扱う。`watch` は `sessionAlive` を見て購読を終了させるが、これは「待ち続ける」コマンド固有の必要性であり、一度読んで終わる `pending` / `review` には当てはまらない。

6. `review` で絞り込んだ結果が 0 件のとき、fzf は起動しない。現在の空リスト時の挙動と同じである。

## アーキテクチャと変更範囲

絞り込みは `handleApprovalSubcommand`（`src/cli/approval_command.ts`）の内部に閉じる。`ApprovalAdapter` の形は変えない。network と hostexec の双方に同一の実装で効き、ドメインごとの分岐を増やさない。

```
src/cli/approval_command.ts       watchSessionFilter を sessionFilterArg へ改名し、
                                  pending / review 分岐で listPending の結果を絞る
src/cli/approval_command_test.ts  unit テストを追加
src/cli/usage.ts                  --session の説明と Examples を更新
```

`watchSessionFilter` は `watch` 専用ではなくなるため `sessionFilterArg` に改名する。関数本体の防御（値の欠落と次フラグの誤読）は変えない。関数コメントに書かれている理由は `watch` の無音待機を根拠にしているため、`pending` / `review` にも通じる記述に書き直す。

`findFirstNonFlagArg`（`src/cli/helpers.ts`）は既に `--session` を値取りフラグとして飛ばすため、`nas network review --session sess_x` のサブコマンド判定は変更なしで正しく動く。

## スコープ外

`approve` / `deny` の引数解釈は触らない。これらは `positionalArgsAfterSubcommand` で位置引数を拾うため、`nas network approve --session s1 r1` が偶然 `sessionId=s1 requestId=r1` として通る。`--session` を除外リストに加えれば弾けるが、`approve` / `deny` は元からセッション id を位置引数で受け取っており、絞り込みの対象ではない。引数パース全体の整理として別途扱う。

## セキュリティ

境界は変わらない。読む対象はホスト側の pending ファイルのままで、control socket にも exec socket にも触れない。表示する内容も既存の `pending` / `review` と同一で、絞り込みによって新たな情報が出ることはない。

## 検証

unit レーンに収める。Docker に触れないため、既存の `src/cli/approval_command_test.ts` にケースを追加する。

- `pending --session` が一致する行だけを出力する
- `pending --session --format json` が絞り込み後の構造化データを出力する
- `pending --session` の空振りがセッション id 付きのメッセージを出す
- `--session` 無しの空振りが従来どおりのメッセージを出す
- `review --session` の空振りがセッション id 付きのメッセージを出し、fzf を起動しない
- `sessionFilterArg` の改名に伴う既存ケースの追随

fzf を経由する `review` の選択パスは TTY を要するため、従来どおり unit では扱わない。

最後に fmt → lint → typecheck → unit を実行する。

## Why — なぜこのアプローチを選んだか

絞り込みを `handleApprovalSubcommand` の内部に置くと、フィルタの定義が 1 箇所に収まる。network と hostexec は `ApprovalAdapter` で差分を吸収する構造になっており、共通層に入れた振る舞いは構造的に両ドメインで揃う。片方にだけ入って忘れられる、という劣化が起きない。

`listPending()` を呼んでから捨てる形になるが、両ドメインとも承認キューのディレクトリを走査して JSON を読むだけで、pending は人間が承認できる程度の件数しか溜まらない。取得元で絞っても走査自体は変わらず、実質的な差は出ない。

`--session` という綴りを選んだのは、この機能が `watch` の絞り込みの拡張だからである。同じ意味の引数に 2 つの綴りがあると、利用者は毎回 help を引くことになる。

## Why Not — なぜ他の案を選ばなかったか

- **案 B: `ApprovalAdapter.listPending(sessionId?)` にして取得元で絞る** — インタフェース変更が network と hostexec の双方に波及し、実装が 2 つに分かれる。両方が同じ意味で絞っていることを保証するのは型ではなくレビューになる。取得元で絞っても走査するディレクトリは同じで、性能上の利点も無い。

- **案 C: `review` の fzf 入力だけをローカルに絞る** — `pending` にも入れる合意を満たさない。仮に後から `pending` にも入れれば、絞り込みロジックが 2 箇所に分かれる。

- **案 D: フラグ名を `--session-id` にする** — 依頼時の綴りではあるが、既存の `watch --session` と `audit --session` と混在する。同じリポジトリ内で同じ概念に 2 つの綴りが並ぶコストは、依頼時の綴りをそのまま採る利点を上回る。

- **案 E: `--session` と `--session-id` の両方を受け付ける** — 移行期でもないのに別名を作ることになる。既存の綴りが `--session` であり、`--session-id` を使ってきた利用者は存在しないため、互換のために背負う理由がない。

- **案 F: 終了済みセッションの id を指定したらエラーにする** — タイプミスの検知としては強いが、`sessionAlive` の呼び出しを `pending` / `review` にも持ち込むことになる。終了直後のセッションに残った pending を確認できなくなる副作用もある。0 件メッセージに id を含めるだけで、タイプミスは十分に見える。
