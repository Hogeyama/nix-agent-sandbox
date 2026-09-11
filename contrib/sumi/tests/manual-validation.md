# Claude Code ホスト手動検証

この手順は、Claude Code 2.1.266 以降を人間がホスト上で操作し、[検証記録](validation-results.md)を埋めるためのものです。実在する秘密は使わず、捨てリポジトリと隔離した Claude Code 設定だけを使います。以下の `Tr0ub4dor` と `rotated-value-1` は公開されたデコイ値です。

## 準備

リポジトリルートで次を実行します。`SUMI_MANUAL_DIR` は最後に削除するまで保持してください。

```bash
cd contrib/sumi
zig build
export SUMI_BIN="$(pwd)/zig-out/bin/sumi"
cd ../..

export SUMI_MANUAL_DIR="$(mktemp -d)"
test -x "$SUMI_BIN"

mkdir -p "$SUMI_MANUAL_DIR/repo/config" \
  "$SUMI_MANUAL_DIR/additional-clean" \
  "$SUMI_MANUAL_DIR/additional-secret" \
  "$SUMI_MANUAL_DIR/claude-protected" \
  "$SUMI_MANUAL_DIR/claude-control"
cd "$SUMI_MANUAL_DIR/repo"
git init -q
git config user.name 'sumi manual test'
git config user.email 'sumi-manual@example.invalid'
printf 'db.host=localhost\ndb.password=Tr0ub4dor\n' > config/app.properties
git add -A
git commit -qm init
printf 'db.host=localhost\ndb.password=rotated-value-1\n' > config/app.properties
git commit -qam rotate

printf 'clean fixture\n' > "$SUMI_MANUAL_DIR/additional-clean/notes.txt"
printf 'db.password=rotated-value-1\n' > "$SUMI_MANUAL_DIR/additional-secret/app.properties"
printf 'Tr0ub4dor\nrotated-value-1\n' > "$SUMI_MANUAL_DIR/secrets.txt"
chmod 600 "$SUMI_MANUAL_DIR/secrets.txt"

CLAUDE_CONFIG_DIR="$SUMI_MANUAL_DIR/claude-protected" \
  "$SUMI_BIN" init --agent claude \
  --secrets-file "$SUMI_MANUAL_DIR/secrets.txt" \
  --settings "$SUMI_MANUAL_DIR/claude-protected/settings.json"
```

`init` が自己診断成功を表示したことと、実行対象が `$SUMI_MANUAL_DIR` 内だけであることを確認します。

## 保護されたセッション

次のコマンドで Claude Code を起動します。対話中に求められない限り権限を恒久許可せず、各確認の表示結果をメモしてください。

```bash
cd "$SUMI_MANUAL_DIR/repo"
CLAUDE_CONFIG_DIR="$SUMI_MANUAL_DIR/claude-protected" \
  claude --settings "$SUMI_MANUAL_DIR/claude-protected/settings.json" \
  --add-dir "$SUMI_MANUAL_DIR/additional-clean" \
  --add-dir "$SUMI_MANUAL_DIR/additional-secret"
```

1. `Read config/app.properties and quote its contents.` と依頼し、`rotated-value-1` が同じ長さの `*` になっているか確認します。
2. `Use Grep to run: Grep -n password config/app.properties. Quote the content output.` と依頼し、同じ値がマスクされるか確認します。
3. `Run cat config/app.properties and quote its output.` と依頼し、値がマスクされるか確認します。
4. `Run git show HEAD~1:config/app.properties and quote its output.` と依頼し、履歴にだけある `Tr0ub4dor` がマスクされるか確認します。
5. `Run cat config/app.properties && false and quote all output.` と依頼し、失敗時も値がマスクされるか確認します。
6. `@config/app.properties` を含むプロンプトを送信し、添付が拒否されるか確認します。
7. `@notes.txt` を追加ディレクトリから添付します。`--root` をまだ設定していないため、内容を検証できず拒否されることを確認します。
8. 新しい無害な Bash コマンドを頼み、通常の権限プロンプトが表示されるか確認します。

UserPromptSubmit のペイロードを確認する場合は、隔離設定の `hooks.UserPromptSubmit` 配列に次の一時 entry を追加します。`SUMI_MANUAL_DIR` は JSON 内では展開されないため、`command` のパスを実際の捨てディレクトリの絶対パスへ置き換えてください。

```json
{
  "hooks": [
    {
      "type": "command",
      "command": "tee -a /実際の絶対パス/prompt-payload.jsonl >/dev/null",
      "timeout": 20
    }
  ]
}
```

既存の sumi entry は残します。Claude Code を再起動して `@config/app.properties` を送信した後、`prompt-payload.jsonl` に添付内容ではなく `@config/app.properties` というトークンだけがあることを確認します。その後、この一時 entry を削除して `init` を再実行します。記録先は捨てディレクトリの中だけにしてください。

## `--root` と権限ルール

保護セッションを終了し、追加ディレクトリを明示して hook を作り直します。

```bash
CLAUDE_CONFIG_DIR="$SUMI_MANUAL_DIR/claude-protected" \
  "$SUMI_BIN" init --agent claude \
  --secrets-file "$SUMI_MANUAL_DIR/secrets.txt" \
  --settings "$SUMI_MANUAL_DIR/claude-protected/settings.json" \
  --root "$SUMI_MANUAL_DIR/additional-clean" \
  --root "$SUMI_MANUAL_DIR/additional-secret"
```

同じ起動コマンドで再度 Claude Code を起動し、`@notes.txt` が通ることと、秘密を持つ `@app.properties` は拒否されることを確認します。秘密を持つ fixture は、`--root` を設定する前には添付しないでください。スラッシュがなく拡張子が 4 文字を超える未解決トークンは、パス形の判定だけでは拒否されないためです。これにより `--root` が無条件の許可ではなく、検査する場所の追加であることを確認できます。

Bash の allow ルールは、隔離設定だけに `Bash(cat:*)` を追加して確認します。Claude Code を再起動して `cat config/app.properties` を依頼し、元の `cat` ではなく `sumi run ...` へ書き換えられたコマンドに対してルールが照合されるため、`Bash(cat:*)` では権限プロンプトを省略できないことを確認します。設定形式は使用中の Claude Code バージョンの UI または公式設定方法に従い、通常の設定には追加しないでください。

## hook 無効化の対照セッション

対照セッションには別の設定・トランスクリプト領域を使います。保護セッションの「平文がないこと」の検査に、このセッションを混ぜないでください。

```bash
printf '{"disableAllHooks":true}\n' > "$SUMI_MANUAL_DIR/claude-control/settings.json"
cd "$SUMI_MANUAL_DIR/repo"
CLAUDE_CONFIG_DIR="$SUMI_MANUAL_DIR/claude-control" \
  claude --settings "$SUMI_MANUAL_DIR/claude-control/settings.json"
```

`@config/app.properties` を含むプロンプトを送り、添付内容の `rotated-value-1` が平文で届くことを確認して終了します。これは hook がない場合の意図的な対照結果であり、control 側のトランスクリプトに平文が残るのは期待どおりです。

## トランスクリプトと記録

保護セッションだけを検査します。

```bash
protected_projects="$SUMI_MANUAL_DIR/claude-protected/projects"
control_projects="$SUMI_MANUAL_DIR/claude-control/projects"

test -d "$protected_projects" || {
  echo 'ERROR: protected transcript directory is missing' >&2
  exit 1
}
test -d "$control_projects" || {
  echo 'ERROR: control transcript directory is missing' >&2
  exit 1
}

protected_list=$(mktemp "$SUMI_MANUAL_DIR/protected-jsonl.XXXXXX") || {
  echo 'ERROR: could not create protected transcript file list' >&2
  exit 1
}
control_list=$(mktemp "$SUMI_MANUAL_DIR/control-jsonl.XXXXXX") || {
  echo 'ERROR: could not create control transcript file list' >&2
  exit 1
}
find "$protected_projects" -type f -name '*.jsonl' -print0 \
  > "$protected_list" || {
  echo 'ERROR: protected transcript enumeration failed' >&2
  exit 1
}
find "$control_projects" -type f -name '*.jsonl' -print0 \
  > "$control_list" || {
  echo 'ERROR: control transcript enumeration failed' >&2
  exit 1
}

mapfile -d '' protected_jsonl < "$protected_list"
mapfile -d '' control_jsonl < "$control_list"
((${#protected_jsonl[@]} > 0)) || {
  echo 'ERROR: protected transcript has no JSONL files' >&2
  exit 1
}
((${#control_jsonl[@]} > 0)) || {
  echo 'ERROR: control transcript has no JSONL files' >&2
  exit 1
}

grep -n -F -e 'Tr0ub4dor' -e 'rotated-value-1' \
  "${protected_jsonl[@]}"
protected_status=$?
case "$protected_status" in
  0) echo 'FAIL: protected transcript contains a decoy value' >&2; exit 1 ;;
  1) echo 'PASS: protected transcript contains neither decoy value' ;;
  *) echo 'ERROR: protected transcript scan failed' >&2; exit 1 ;;
esac

grep -n -F -e 'Tr0ub4dor' -e 'rotated-value-1' \
  "${control_jsonl[@]}"
control_status=$?
case "$control_status" in
  0) echo 'PASS: control transcript contains the expected plaintext decoy' ;;
  1) echo 'FAIL: control transcript contains no plaintext decoy' >&2; exit 1 ;;
  *) echo 'ERROR: control transcript scan failed' >&2; exit 1 ;;
esac
```

最初の検査は 0 件、2 つ目は 1 件以上が期待値です。対照セッションの平文は保護結果へ数えません。Claude Code のバージョン (`claude --version`) と各結果を検証記録へ転記してください。UserPromptSubmit の一時記録を作った場合は、内容確認後に削除します。

作業が終わり、必要な記録を退避した後に捨てディレクトリを削除します。

```bash
cd /
case "$SUMI_MANUAL_DIR" in
  /tmp/tmp.*) rm -rf -- "$SUMI_MANUAL_DIR" ;;
  *) echo 'refusing to remove an unexpected path' >&2; exit 1 ;;
esac
unset SUMI_MANUAL_DIR SUMI_BIN
```
