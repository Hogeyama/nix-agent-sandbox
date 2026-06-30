# patched-superpowers

[Superpowers](https://github.com/obra/Superpowers) に自分なりの変更を当てたもの。変更点は

1. 開始時に規約を探させる
2. plan / spec のレビューに [diffity](https://github.com/nichochar/diffity) を使わせる
3. タスク単位のレビューに独自のレビュアーを使う
    * Superpowersのものはかなり軽量で、バグを見逃すことが多かったため
4. 全体レビューにClaude Codeの `/code-review` を使う
    * 同上
    * というか `/code-review` が強い

## Install

コマンドは古い可能性がある。

* Suprerpowersをインストール
  ```
  claude plugin install superpowers@claude-plugins-official
  ```
* diffityをインストール
  ```
  # 本体: npm/pnpmでも
  bun install -g diffity

  # スキル: Using gh>=2.90
  gh skill install nilbuild/diffity
  ```
* このスキルをインストール
  ```
  # Using gh>=2.90
  gh skill install asahi-net/cq2n-iwym-agent-skills patched-superpowers
  ```


