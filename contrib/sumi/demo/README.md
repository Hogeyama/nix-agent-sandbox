# sumi デモ

このデモでは、Claude Code がファイルや Git 履歴を読むときに、sumi が登録済みの値を `*` で隠す様子を確認できます。Linux、bash、git、インストール済みの Claude Code が必要です。

通常はリポジトリ内の `../zig-out/bin/sumi` を使い、まだなければ `zig build` で自動ビルドします。自動ビルドには Zig 0.15.2 が必要です。別のバイナリを使う場合は、デモを準備する前に次を実行してください。

```bash
cd contrib/sumi/demo
SUMI_BIN=/absolute/path/sumi ./setup.sh
```

通常の開始手順は次のとおりです。

```bash
cd contrib/sumi/demo
./setup.sh
./start.sh
```

専用の Claude 設定を使うため、初回起動ではログインと、このディレクトリを信頼するかの確認が必要になることがあります。Bash の実行時には通常どおり権限確認が表示されます。

起動した Claude に、次のプロンプトを一つずつ貼り付けてください。デモ用の値そのものをプロンプトへ書く必要はありません。

```text
Read で config/app.properties を読んでください
```

現在の password は 15 個の `*` として見えます。

```text
Bash で実際に cat config/app.properties を実行してください
```

こちらも現在の password は 15 個の `*` として見えます。

```text
Bash で実際に cat config/app.properties && false を実行し、終了コードも教えてください
```

失敗した Bash 出力でも password は 15 個の `*` になり、終了コード `1` は保たれます。

```text
Bash で git show HEAD~1:config/app.properties を実行してください
```

履歴にある古い password は 9 個の `*` として見えます。

```text
@config/app.properties の内容を説明してください
```

この添付は拒否されます。添付を取り除き、代わりに Read で読むよう依頼してください。

`.state` は次回の `./start.sh` でもそのまま使われます。元のファイルは暗号化されず平文のままで、人間は Claude の外から `.state/repo/config/app.properties` を `cat` できます。最初からやり直す場合は、このデモディレクトリで次を実行します。専用のログイン情報とセッションデータも一緒に消えます。

```bash
rm -rf -- .state
./setup.sh
```

保護範囲と制限の詳細は [sumi の README](../README.md) を参照してください。
