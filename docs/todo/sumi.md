sumi の未解決の課題です。

**1. secrets ファイル自体が、sandbox 内の Bash から加工して読み出せる**

`xxd ~/.claude/sumi/secrets.txt` のように加工して出力すると、sumi のマスクをすり抜けて値が読めます。sumi の出力マスクが止めるのは、平文、URL エンコード版、base64 版だけです。2 重 base64、`xxd -p`、逆順、`gzip | base64`、`od -An -c` は止まりません（[scan mask の実験記録](../superpowers/probes/2026-09-15-sumi-credential-mask-results.md) の G2）。

Claude Code の設定では防げません。

- `permissions.deny` の `Read(~/.claude/sumi/secrets.txt)`
  - sandbox を有効にしている場合、Read の deny ルールは sandbox の読み取り禁止にも取り込まれる（[sandboxing › Permission rules](https://code.claude.com/docs/en/sandboxing): "Paths and domains from both sandbox settings and permission rules are merged into the final sandbox configuration."）。
  - `CLAUDE_CODE_SHELL_PREFIX` から起動する `sumi run` は sandbox の内側で動く。Claude Code 2.1.268 で、偽の bwrap に渡された引数を記録して確認した。bwrap の `--` の後ろで `sumi run --secrets-file …` が実行されていた。
  - この 2 つを合わせると、`sumi run` が secrets ファイルを読めなくなり、Bash の出力がすべて抑止される（終了コード 121）。この組み合わせそのものは未実験。
  - sandbox を無効にしている場合、Read の deny ルールは Bash に効かない。Bash の引数に Read の deny ルールを適用する変更は、2.1.259 で入った後に取り消されている（Claude Code の changelog）。
- `sandbox.filesystem.denyRead`、`sandbox.credentials.files` の `deny`
  - どちらも `sumi run` が読めなくなる点で同じ。
- `sandbox.credentials.files` の `mask`
  - `sumi run` が身代わりの値を読み、存在しない値でマスクする。本物は何もマスクされず、漏れる側に倒れる。

根本の問題は、`sumi run` が読めるものは、同じ sandbox の中の他のコマンドも読めることです。

案: secrets ファイルに平文を置かず、`sumi run` はハッシュだけで照合する。

- 登録された値と展開したエンコード版を、鍵付きハッシュと長さの組にして保存する。
- `sumi run` は、出力の中の各長さの区間ごとにハッシュを計算して、集合と照合する。
- sandbox 内から読めるのはハッシュだけになる。ランダムなトークンのように推測されにくい値は実質的に守れる。
- 短いパスワードや辞書にある値は、読まれたハッシュから総当たりで逆算される。鍵も同じファイルに置くしかないため。
- 照合の計算量は「値の長さの種類 × 出力のバイト数」になる。2 の速度改善と一緒に設計する。
- 平文を扱う `init`、hook（sandbox の外で動く）、`scan` と、ハッシュ版の secrets ファイルをどう分けて持つかも決める必要がある。

**2. `sumi scan` が遅い**

展開した全パターンを、パターンごとに `std.mem.indexOf` で探し直している（[mask.zig](/home/hogeyama/repo/nix-agent-sandbox/lib/masking/mask.zig) の `containsAny`）。計算量は「パターン数 × 読むバイト数」になる。

実測（64 MiB のランダムなファイル、sumi 0.1.0）:

| 値の数 | 展開後のパターン数 | 時間 |
|---|---|---|
| 1 | 38 | 13 秒 |
| 20 | 約 760 | 260 秒 |

このリポジトリを走査すると、`.git` を除いて約 11.7 万ファイル、12.8 GiB ある（大半は `.zig-cache` と `.worktrees`）。

案:

- 複数パターンを 1 回の走査で照合する（Aho-Corasick など）。
- ファイルを並列に読む。

ビルドの成果物などのディレクトリを既定で飛ばす案は採らない。ビルドの出力に秘密が入ることがあるため。

`mask.zig` は nas と共有しているので、nas 側の検証も含めて別の設計で扱う。
