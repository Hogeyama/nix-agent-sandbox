# authz ドキュメントのキャッシュが mtime だけを見ている

## 症状

nas サンドボックス内で `bun run test:unit` を実行すると、
`src/docker/mitmproxy/nas_addon_mask_test.py` の
`test_accepts_optional_websocket_policies_and_rejects_invalid_values` が 1 件失敗する。

```
AssertionError: {...'fallbackRuleId': 'anthropic.$fallback'...}
             != {...'webSocket': 'allow', 'fallbackRuleId': ...}
```

`_load()` が返す文書に `webSocket` が無く、書き込んだ文書には有る、という不一致になる。

ホスト側のファイルシステムでは再現しない。タイムスタンプの粒度に依存するためである。

## 原因

`_load_authz_document`（`src/docker/mitmproxy/nas_addon.py:674-695`）は
`os.stat(path).st_mtime_ns` だけをキャッシュキーにする。

```python
cached = _authz_cache.get(session_id)
if cached and cached[0] == mtime:
    return cached[1]
```

このテストの正常系ループは、書き込みごとに `nas_addon._authz_cache` を消さない。
同ファイルの `assert_invalid`（`nas_addon_mask_test.py:614`）は消しているので、
正常系だけが消し忘れている形になる。

nas コンテナのファイルシステムは連続する書き込みに同一の `st_mtime_ns` を返す。
実測した結果が次のとおりである。

```
6 回連続で書き込んだときの st_mtime_ns: すべて 1789611475477904932
distinct: 1 of 6
```

したがって 2 回目以降の `_load()` は 1 回目の文書を返す。
ループの 1 周目が `webSocket` を除いた文書を載せ、2 周目の `webSocket: "allow"` が
そのキャッシュに当たって失敗する。

## 欠陥は 2 つある

テスト側では、キャッシュを消さずに連続書き込みしている。
`assert_invalid` と同じく `nas_addon._authz_cache.clear()` を挟めば直る。

本番コード側では、同じファイル内で扱いが非対称になっている。
`_load_registry`（`nas_addon.py:336-348`）は `CACHE_TTL = 5.0` で古さを 5 秒に抑えるのに、
`_load_authz_document` は TTL を持たず mtime の一致だけで返す。
タイムスタンプ粒度が粗いファイルシステム上で authz ドキュメントが同一 tick 内に
書き換わると、addon は古い認可ポリシーを次に mtime が動くまで返し続ける。

本番で同一 tick 内の二重書き込みが実際に起きるかは未確認である。
粒度が粗い環境が実在することだけを確認した。

## blame

| 対象 | コミット | 日付 |
|---|---|---|
| mtime 単独のキャッシュキー | `deccf5eb0` | 2026-08-05 |
| 検証を追加しつつ同じ形を継承 | `d9f87bfe5` | 2026-08-11 |
| 失敗するテスト関数の追加 | `6baca8cd` | 2026-08-18 |

## 対応の選択肢

テストだけを直す場合は、正常系ループに `nas_addon._authz_cache.clear()` を追加する。
最小で済むが、本番側の非対称は残る。

本番側を直す場合は、キャッシュキーを `(st_mtime_ns, st_size)` にしたうえで
`_load_registry` と同じ `CACHE_TTL` を付ける。`os.stat` の戻り値を使うだけなので
I/O は増えない。テストも自動的に通る。認可系のコードに手を入れるため、
`.claude/skills/security-constraints/SKILL.md` の確認を通すこと。

両方を直す場合は、本番側を直したうえでテストにも明示的な `clear()` を残す。
テストがキャッシュの実装契約に依存しなくなる。
