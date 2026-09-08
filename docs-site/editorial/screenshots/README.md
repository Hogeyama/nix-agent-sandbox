# UI 操作例の撮影

リポジトリの UI をブラウザで描画し、7枚の操作例を撮影する。稼働中の nas UI が `http://localhost:3939` にある環境で、リポジトリのルートから実行する。

```sh
playwright-cli -s=docs-ui open http://localhost:3939
playwright-cli -s=docs-ui run-code --filename=docs-site/editorial/screenshots/setup.js
playwright-cli -s=docs-ui run-code --filename=docs-site/editorial/screenshots/capture.js
playwright-cli -s=docs-ui close
```

毎回新しいブラウザセッションを使う。`setup.js` は HTTP API をすべてブラウザ内で置換し、EventSource とターミナル WebSocket も例示用データに置き換える。実際のセッション起動・承認・ポート公開は行わない。画面の DOM やスタイルは変更しない。初回 `open` は実際の読み取り画面なので撮影せず、例示用データへの置換後だけを保存する。

`capture.js` は UI 全体、通信承認、ホスト実行承認、ポート公開、新規セッション、Audit、History を `docs-site/public/images/` に保存する。ホスト実行カードは一回限りの承認を選んだ例で、製品の既定選択を示すものではない。History のトークン数は例示用で、価格取得は無効にしている。

生成後は各画像を開き、必要な操作が見えること、実セッションの識別情報が含まれないことを確認する。公開本文には例示用データであることを明記する。UI 全体の中央ターミナルは再接続可能な構成の例であり、初回設定のままブラウザ入力ができるとは説明しない。

これらの画像は UI の見え方の説明で、バックエンドの承認・転送・エージェント実行を検証する証拠にはしない。
