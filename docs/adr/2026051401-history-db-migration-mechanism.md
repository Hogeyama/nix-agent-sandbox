---
Status: Draft
Date: 2026-05-14
---

# ADR (Draft): history.db schema migration mechanism

## Context

ADR 2026042901 §"Storage" は `PRAGMA user_version` 不一致時に「migration を
試みず refuse、運用は手動 `rm`」を採った。ADR 2026051301 §"Schema rebuild
policy" もこの方針を引き継ぎ、v2 → v3 (log_records 追加) の際にも `rm`
運用を要請した。

この方針は単一 schema 変更まではコストが低かったが、以下の問題が顕在化した:

- `CREATE TABLE IF NOT EXISTS` で吸収できない変更 (`ALTER TABLE ADD COLUMN`、
  index 構造変更、データ移行を伴う変更) が来た瞬間に、`rm history.db` を
  operator に強いる以外の道がない
- history.db には conversations / traces / spans / log_records が継続的に
  蓄積される。`rm` のコストは時間と共に上がる (横断ビューや自律走行履歴を
  失う)
- v1 → v2 (`spans.events_json` 列追加) と v2 → v3 (log_records 追加) は
  どちらも `rm` 運用を要請しており、schema 進化のたびに同じ強制が再演する
- writer が refuse すると catch サイト (cli_lifecycle, hook_writer ×2,
  observability stage) の警告は「`rm` してくれ」という case-by-case の
  運用案内になり、コードと運用の結合が緩い

## Decision

### writer-side auto migration

writer-mode open (`openHistoryDb({mode: "readwrite"})`) は順序付き
migration step 配列 (`src/history/migrations.ts` の `HISTORY_DB_MIGRATIONS`)
を持ち、open 時に on-disk の `user_version` を読んで分岐する:

- `user_version === HISTORY_DB_USER_VERSION` (= 最終 step の `target`):
  no-op
- `user_version < HISTORY_DB_USER_VERSION`: `m.target > current` の step
  を順次適用。各 step は単一の
  `db.transaction(() => { m.apply(db); db.run('PRAGMA user_version = ' + m.target) })`
  で apply + version stamp を同一 tx 内で発行する。失敗時は rollback で
  `user_version` も巻き戻り、次回 open で同じ step を再試行できる
- `user_version > HISTORY_DB_USER_VERSION`: `HistoryDbVersionMismatchError`
  を throw。新しい binary で書かれた DB を古い binary で開こうとしている
  ケースに限定される

### per-version migration step は immutable

`HISTORY_DB_MIGRATIONS` の各 step (現状 `MIGRATION_V1` / `MIGRATION_V2` /
`MIGRATION_V3`) は **その user_version 時点の DDL を凍結したスナップショット**
として扱う。後続 schema 変更があっても既存 step を書き換えない。新しい
schema 変更は新規 step (`MIGRATION_V4` 以降) として末尾に追加する。

理由: 過去 user_version からの再現性を保つため。`MIGRATION_V1` を後から
書き換えると、長期保管した v1 stamp DB を持つ operator が migration を
回したときに当時と異なる DDL を踏むことになり、現実のスキーマと migration
履歴が乖離する。

### reader は据え置きで refuse のみ

reader-mode open (`openHistoryDb({mode: "readonly"})`) は migration を
試みない。`user_version` がいかなる値でも `HISTORY_DB_USER_VERSION` と
一致しなければ `HistoryDbVersionMismatchError` を throw する。

理由:

- reader が古い DB を踏むのは「writer がまだ起動していない」ケースで、
  writer の初回起動を待たせれば自動収束する
- reader 側でも migration を持つと、reader と writer が同時に migration
  を試みる race と FK enforcement の整合確認が増える
- reader 経路は UI daemon (常駐) と CLI inspection の 2 系統のみで、
  writer よりも頻度が低い

### 警告メッセージ

writer 側の catch サイト (cli_lifecycle, hook_writer ×2, observability
stage) の警告は、残る refuse ケース (= 未来 version) 専用の表現を採る:

> nas: history db at <path> was written by a newer nas build
> (user_version=N). Upgrade the binary or remove the file. ...

`rm` 案内文言は除去。auto-migration が writer に閉じていることを示す
comment を catch サイト隣接に置く。

## Alternatives considered

- **`rm` 運用継続**: 過去の自律走行ログを失う運用コストが時間と共に
  累積する。却下。
- **writer / reader 両方が migration を試みる**: race と FK enforcement
  の整合確認が増える。reader 側のテストコストも倍化。reader 経路は
  writer のあとを追えば良いので不要。却下。
- **down-migration (新 binary → 古い binary のロールバック)**: 各 step
  が逆方向の DDL を持つ必要があり保守コストが上がる。手元 single-user
  運用で binary ロールバックの頻度は低く、必要になった時点で別 ADR で
  扱う。今は採用しない。

## Consequences

### Schema rebuild policy の改訂

- ADR 2026042901 §"Storage" の「`PRAGMA user_version` で schema 版を管理。
  open 時に不一致なら migration を試みず refuse する」のバレットは、writer
  については本 ADR の auto-migration に置き換わる。reader についてはこの
  バレットの「refuse する」記述がそのまま生きる。当該 ADR にはこの旨を
  section-level の inline note で記録した。
- ADR 2026051301 §"Schema rebuild policy" の「migration は実装せず、
  `rm` を運用手順とする」記述は本 ADR で改められる。v2 → v3 移行は
  `MIGRATION_V3` step として実装され、v1 / v2 stamp の DB は次回 writer
  open で自動的に v3 まで上がる。当該 ADR にも同様の inline note を
  記録した。

### 影響範囲

- 操作者は history.db を世代を跨いで保持できる。conversations / traces /
  spans / log_records が過去 schema 世代から維持される
- writer 起動時に migration が走るため、起動オーバーヘッドは v0/v1/v2
  stamp の DB の場合だけ M1/M2/M3 の DDL 実行コストぶん増える (現実の
  ファイル size 数 MB レベルでは無視できる範囲)
- `MIGRATION_V*` step を追加する開発者は、(1) 既存 step を書き換えない、
  (2) `ALTER TABLE` のような non-idempotent な DDL は事前 `PRAGMA
  table_info` 等で idempotent 化する、(3) `bun test src/history/` の
  migration テスト (`migrations_test.ts`, `store_integration_test.ts`)
  を pass させる、の 3 点を守る
