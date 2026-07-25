# patched-superpowers

[Superpowers](https://github.com/obra/Superpowers) に自分なりの変更を当てたもの。変更点は

1. 開始時に規約を探させる
2. plan / spec のレビューに [diffity](https://github.com/nilbuild/diffity) を使わせる
3. タスク単位のレビューに独自のレビュアーを使う
    * Superpowersのものはかなり軽量で、バグを見逃すことが多かったため
4. 全体レビューにClaude Codeの `/code-review` を使う
    * 同上
    * というか `/code-review` が強い

## Install

### apm (recommended)

```bash
# diffity CLI（apm のスコープ外なので別途必要）
npm install -g diffity

# スキル一式
apm install asahi-net/cq2n-iwym-agent-skills/skills/patched-superpowers
```

### gh skill

```bash
# Superpowers
claude plugin install superpowers@claude-plugins-official

# diffity
npm install -g diffity
gh skill install nilbuild/diffity

# このスキル
gh skill install asahi-net/cq2n-iwym-agent-skills patched-superpowers
```
