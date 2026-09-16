# resolved-document.json

addon (Python) と broker (TS) のテストが共有する、解決済み認可ドキュメント 1 本。

Python から `resolveAuthzConfig` は呼べないので、両言語が同じ入力を見る手段が
ディスク上のファイルしかない。それがこのファイルの存在理由であり、役割はそれ
だけである。

- `src/docker/mitmproxy/nas_addon_mask_test.py`: addon の判定とバリデータを回す
- `src/docker/mitmproxy/message_parity.py`: `anthropic.messages` ルールを取り出す
- `src/docker/mitmproxy/nas_addon_integration_test.ts`: 既定のドキュメント
- `src/docker/mitmproxy/message_parity_test.ts`: broker 側の検証に渡す
- `src/network/authz/examples_fixture.ts`: content block の許容タグを引く

**出荷される preset のスナップショットではない。** 元は `Schema.pkl` の
`presets.anthropic.v1` を解決したものを生成器で書き出しており、コミット済みの
内容が pkl の出力と一致することをテストで固定していた。あの一致が縛っていたの
は `segments` や `trailingDoubleStar` といったパスマッチャの内部表現であって
preset の約束ではなく、preset にパスを 1 本足すたびに巨大な差分が出るだけだっ
たので、テストごと落とした。上記のテストが見ているのは addon と broker が同じ
ドキュメントに対して**同じ判断をするか**であり、そのドキュメントが今日出荷され
ている preset である必要はない。

したがって pkl を変えてもここを追随する必要はない。ここを変えるのは、テストが
新しい形のルールや `expect` を必要としたときだけである。
