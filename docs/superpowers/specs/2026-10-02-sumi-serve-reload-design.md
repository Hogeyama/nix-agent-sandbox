# sumi serve: secrets ファイルの変更を検出して読み直す

## 目的

`sumi serve` は起動時に secrets ファイルを 1 回だけ読み、その一覧を kill されるまで使い続ける。
利用者が値を追加しても、再起動するまでその値は伏せられない。
エラーも警告も出ないので、利用者は伏せられていないことに気づけない。

`--secrets-file` を hook と `sumi run` に直接渡す構成では、呼び出しのたびにファイルを読むので、変更はすぐに反映される。
serve を挟むとこの性質が失われる。

serve がファイルの変更を検出し、以後の接続で新しい一覧を使うようにする。
対象は Linux だけである。

## 挙動

### 変更の検出

listener が readable になった周回で、accept のループに入る前に secrets ファイルを `stat` する。
`(st_dev, st_ino, st_size, st_mtim, st_ctim)` を前回の値と比べ、どれかが違えば読み直す。

- `stat` は symlink の先を見るので、`--secrets-file` が symlink でも、リンク先の変更を検出できる。
- エディタが一時ファイルへ書いて rename で置き換えると inode が変わるので、そのたびに検出できる。
- 1 周回の accept は何本でも 1 回の `stat` で済む。

### 読み直しの結果

- 成功した場合、その周回以降に accept した接続は新しい一覧を使う。stderr に `sumi: reloaded the secrets file` を書く。
- 失敗した場合 (読めない、空、形式エラー、ファイルが無い)、古い一覧を使い続ける。stderr に `sumi: kept the previous secrets: <secrets.describe の文言>` を書く。

失敗した場合も、`stat` の値は「前回の値」として記録する。
ファイルが壊れたままでも警告は変更 1 回につき 1 回だけになり、次に変更されたときに読み直しを再び試す。
`stat` 自体が失敗した場合 (ファイルが消えた) も 1 回だけ警告し、ファイルが現れたら読み直す。

診断は定数の文言と、利用者が渡したパスから導いた値だけにする。
一覧の値は stderr に書かない。

### 既存の接続

各接続は accept した時点の一覧を使い続ける。
`MaskStream` は一覧のスライスを参照し続けるため、途中で差し替えると、保持中の overlap と新しい一覧の最長値が合わなくなるからである。

したがって、読み直しより前に始まったシェル (`sumi run` の接続) には、追加した値が反映されない。
README にこのことを書く。

### 一覧の寿命

一覧は世代ごとに確保し、参照カウントを持たせる。

- serve が現在の世代として 1 つ参照する。
- 接続は accept 時に現在の世代を 1 つ参照する。
- 読み直しに成功したら、現在の世代を差し替えて古い世代の参照を 1 つ外す。
- 接続を閉じたら参照を 1 つ外す。0 になった世代は、その世代を作った側が解放する。

poll ループは単一スレッドなので、参照カウントに atomic は要らない。

## インターフェース

`serve.zig` はファイル形式も一覧の確保の仕方も知らないままにする。
既存の `run(gpa, secrets, listen)` は引数も挙動も変えず、新しく `runWithSource` を足す。

```zig
pub const Generation = struct {
    values: []const []const u8,
    /// serve だけが触る。
    refs: usize = 0,
    /// refs が 0 になったときに serve が呼ぶ。null なら呼び出し元が寿命を持つ。
    destroyFn: ?*const fn (gen: *Generation) void = null,
};

pub const Source = struct {
    ctx: *anyopaque,
    /// listener が readable になった周回で、accept の前に呼ぶ。
    /// 新しい世代があれば返し、無ければ null を返す。返した世代は serve が参照する。
    refreshFn: *const fn (ctx: *anyopaque) ?*Generation,
};

pub fn run(gpa: std.mem.Allocator, secrets: []const []const u8, listen: address.Address) !u8
pub fn runWithSource(gpa: std.mem.Allocator, initial: *Generation, source: ?Source, listen: address.Address) !u8
```

- `Generation` は呼び出し元が確保し、`destroyFn` で解放する。差し替えのときに serve が確保しないので、差し替えに失敗する経路が無い。sumi は世代を arena と一緒に 1 つの構造体へ入れ、`@fieldParentPtr` で arena を取り出して解放する。
- `run` は、`destroyFn = null` の世代を 1 つ作って `runWithSource(gpa, &gen, null, listen)` を呼ぶ。nas-mask-filter は `run` を使い続けるので、`src/mask-filter/` は変わらない。
- sumi は `contrib/sumi/serve_source.zig` に `Source` を実装する。`stat` の比較、`secrets.load` の呼び出し、stderr への診断を受け持つ。
- `serve.zig` の「ストリーム由来のバイトを stdout/stderr に書かない」という不変条件は変わらない。診断を書くのは `serve.zig` の外である。

## 変わるファイル

| ファイル | 内容 |
|---|---|
| `lib/process-supervisor/serve.zig` | `Generation`、`Source`、`runWithSource`。`run` は `runWithSource` を呼ぶだけになる |
| `lib/README.md` | 製品が `serve.run` か `serve.runWithSource` を呼ぶことを書く |
| `contrib/sumi/serve_source.zig` | 新規。secrets ファイルの `Source` |
| `contrib/sumi/main.zig` | `runServe` を `serve_source` と `runWithSource` に替える。テストルートに `serve_source.zig` を加える |
| `contrib/sumi/README.md` | 「変更したら再起動」の注意を、自動で読み直すことと既存の接続の扱いに書き換える |
| `contrib/sumi/CHANGELOG.md` | Unreleased の `sumi serve` の項目に追記する |

## テスト

- unit (`lib/process-supervisor/serve.zig`):
  - 最後の参照が外れたときにだけ `destroyFn` が呼ばれる。
  - 差し替えの前に accept した接続は古い一覧で、後に accept した接続は新しい一覧で伏せる。
  - 古い世代は、それを使う接続が閉じるまで解放されず、閉じたら解放される。
- unit (`contrib/sumi`): `Source` の実装。
  - `stat` の値が変わらなければ読み直さない。
  - 読み直しに失敗したら null を返し、同じ `stat` の値では再び試さない。
  - ファイルが消えてから現れたら読み直す。
  - rename で置き換えると、サイズが同じでも読み直す。
  - 解放した世代のメモリが残らない (`testing.allocator` のリーク検査で確かめる)。
- black-box (`contrib/sumi/tests/run-tests.sh` の serve の節):
  - 値を追記すると、次の `sumi run --server` でその値が伏せられる。
  - rename で置き換えたファイルの値が伏せられる。
  - ファイルを空にすると、古い値が伏せられ続け、stderr に警告が 1 回だけ出る。
- `src/mask-filter/` に差分が無く、`bun run test:mask-filter-unit` と `src/stages/maskfs/mask_filter_integration_test.ts` が変わらず通る。

## 制限

`st_mtim` の精度はカーネルの時刻の刻み (数ミリ秒) である。
同じ刻みの中で同じサイズのまま in-place で 2 回書き換えると、2 回目を検出できない。
rename による置き換えや、サイズの変わる書き換えでは起きない。
次に何か変更されれば、その時点の内容を読み直す。

## 範囲外

- macOS。
- 既存の接続への新しい一覧の反映。
- SIGHUP などによる明示的な読み直し。

## Why — なぜこのアプローチを選んだか

一覧が使われるのは、新しい接続を受け付けたときだけである。
accept の直前に確認すれば、次の hook と `sumi run` の呼び出しには必ず新しい一覧が使われる。
ファイルの変更を即座に知っても、マスクの結果は変わらない。

`stat` は 1 回のシステムコールで、symlink の先と rename による置き換えを特別な扱いなしに検出できる。
エージェントは接続を開くだけで accept を起こせるので、accept ごとの処理はホストで安く済む必要がある。
`stat` ならこの条件を満たす。

読み直しに失敗したときに古い一覧を残すのは、エディタの保存の途中 (空や書きかけ) で、hook と `sumi run` が全部失敗するのを避けるためである。
その間、壊れた編集で追加しようとした値は伏せられない。
これは読み直しの無い今の serve と同じ状態で、今と違って stderr に警告が出る。

## Why Not — なぜ他の案を選ばなかったか

- inotify で検出する: ファイルを直接 watch すると、rename で置き換えたときに watch が外れる。親ディレクトリを watch すると、symlink の先の変更を検出できない。poll ループに fd が増え、`IN_Q_OVERFLOW` の扱いも要る。利点は保存の直後に形式エラーを警告できることだけで、`stat` でも次の接続で同じ警告が出る。
- accept ごとにファイルを読んで内容を比べる: 時刻の精度に左右されない。しかしファイルは最大 16 MiB で、エージェントが接続を開くたびにホストでその読み込みが起きる。
- 読み直しに失敗したら接続を拒否する: 追加しようとした値も含めて何も出力されないので、伏せ漏れは起きない。しかし、エディタの保存の途中や、形式エラーを直すまでの間、hook と `sumi run` がすべて失敗し、エージェントの作業が止まる。
- SIGHUP で読み直す: 利用者がシグナルを送り忘れれば、今と同じく黙って伏せられない。自動で検出すれば不要で、テストすべき経路が増えるだけになる。
