# 構想: nas のサンドボックスを Dev Container として開く

優先度: 未設定（構想段階。実装計画は未着手）

状態: 構想のみ。コードは何も変えていない。2026-09-15 の調査に基づく。

---

## 目的

別プロジェクトに `.devcontainer/` を置き、`code .` で開いて Claude Code 拡張を起動すると、
拡張が起動する `claude` が `nas claude` と同じサンドボックス（プロキシ経由の通信、hostexec、
出力マスク、ホスト UID での実行、同一パスへのワークスペースマウント）の中で動くようにしたい。

VS Code の Dev Container は「コンテナを作成・起動し、VS Code Server を `docker exec` で
注入し、接続を切ってもコンテナを残す」前提で動く。nas は `--rm` 固定のフォアグラウンド
`docker run` で、エージェント終了と同時にコンテナを捨てる（`src/docker/client.ts:138`）。
この差を埋めるのが本構想の中心になる。

## 現状で使えないもの、使えるもの

使えないもの:

- `devcontainer.json` を読む経路（リポジトリ全体で devcontainer という語は 0 件）
- 長寿命コンテナを作る経路（`docker create` / `docker start` を呼ぶコードが無い）
- CLI からコンテナ内で任意コマンドを実行する経路（UI 限定の
  `docker exec -it -u 0:0 <container> /entrypoint.sh --shell` のみ。`src/domain/launch/service.ts:171`）
- `-p` によるポート公開（UDS リレー方式に統一している。`src/stages/port_bind/stage.ts`）

流用できるもの:

- ワークスペースをホストと同一の絶対パスにマウントし、ホスト UID/GID で動かす構造
  （`src/stages/mount/stage.ts:173-178`、`src/docker/embed/entrypoint.sh:176-233`）。
  VS Code から見たパスがホストと一致するので、パス変換が要らない。
- `compileLaunchOpts` が組み立てる `-v` / `--network` / `--add-host` / env / label
  （`src/stages/launch/stage.ts:84-135`）。compose 形式へ写せる。
- `entrypoint.sh --shell` の「初期化を飛ばして同じ env で bash を起こす」分岐。
  daemon モードの土台になる。
- `claude` バイナリの RO マウントと `~/.claude` の RW マウント（`src/agents/claude.ts`）。
  拡張が起動する `claude` の認証がそのまま通る。
- ubuntu:26.04 ベースのイメージ。VS Code Server の動作要件（glibc、libstdc++、tar、curl）を
  満たしている。

## Dev Container 側の前提

`containers.dev` の仕様で本構想が依存する点を書き出す。

- `initializeCommand` はホストで、コンテナ作成時だけでなくその後の起動時にも毎回走る。
- `dockerComposeFile` で compose ファイルを指定でき、`overrideCommand: false` で
  イメージの ENTRYPOINT/CMD を残せる。
- VS Code Server は `docker exec` で注入される。ENTRYPOINT が export した env は継承しない。
  代わりに `userEnvProbe`（既定 `loginInteractiveShell`）でログインシェルの env を採取し、
  拡張ホストとターミナルに適用する。
- `remoteUser` は `${localEnv:USER}` のような変数展開が使える。
- `shutdownAction: "stopCompose"` でウィンドウを閉じたときにコンテナを停止できる。

## 構想

### 利用者から見た流れ

1. 対象プロジェクトで `nas config init` と `nas config trust` を済ませる（現状と同じ）。
2. `nas devcontainer init` が `.devcontainer/devcontainer.json` を生成する。手書きでもよい程度の
   小さなファイルにする。
3. `code .` で開き、「Reopen in Container」を選ぶ。
4. Claude Code 拡張を開くと、サンドボックス内の `claude` が起動する。承認は従来どおり
   `http://localhost:3939` の UI で行う。

### devcontainer.json の形

```jsonc
{
  "name": "nas",
  "initializeCommand": "nas devcontainer up --profile claude",
  "dockerComposeFile": ["nas/compose.yml"],
  "service": "agent",
  "workspaceFolder": "${localWorkspaceFolder}",
  "overrideCommand": false,
  "remoteUser": "${localEnv:USER}",
  "updateRemoteUserUID": false,
  "shutdownAction": "stopCompose"
}
```

`nas/compose.yml` は `nas devcontainer up` が毎回書き出す生成物で、`.devcontainer/nas/` を
`.gitignore` に入れる。

### nas 側に追加するもの

`nas devcontainer up`（新規サブコマンド）

- 既存パイプライン（`src/cli.ts:434-477`）を LaunchStage の直前まで実行し、サイドカー
  （プロキシ、hostexec broker、mask-filter、port relay、DinD）を起こす。
- `docker run` の代わりに compose ファイルを書き出す。内容は `compileLaunchOpts` の出力の写しで、
  `command: sleep infinity`、既存のセッションネットワークは `external: true`、
  DinD 有効時は `network_mode: "container:<dind>"` にする。
- パイプラインは `Effect.scoped` の release でサイドカーを畳むため、この処理は
  dtach 配下の常駐 supervisor として切り離す（`runInsideDtach` と同じ構成。`src/cli.ts:495-538`）。
  `initializeCommand` として呼ばれた本体は compose を書き終えたら 0 で返す。
- supervisor はコンテナの出現を待って `docker wait` し、停止を検知したら `docker rm` して
  スコープを閉じる。
- 同じ作業フォルダーに生きた supervisor があれば再利用し、compose を同じ内容で書き直す
  （ウィンドウの再読み込みでも `initializeCommand` が走るため）。

`nas devcontainer init`（新規サブコマンド）

- 上記 devcontainer.json を生成する。既存ファイルがあればスキップする。

`entrypoint.sh` の daemon モード

- 現在 exec 直前に組んでいる env（`http_proxy` 系、PATH 先頭の hostexec wrapper と
  bash override、`JAVA_TOOL_OPTIONS`、`GIT_CONFIG_*`、`SHELL`）を `/etc/profile.d/nas.sh` に
  書き出す。VS Code の `userEnvProbe` がこれを拾い、拡張が起動する `claude` に届く。
- `plan.env.static`（`LD_PRELOAD`、`NAS_HOSTEXEC_*` など）は compose の `environment` に置く。
  コンテナ設定の env は `docker exec` で入るプロセスにも渡るので、profile.d を経由しなくてよい。
- ユーザー作成（`/etc/passwd` 追記）を entrypoint の先頭へ移す。VS Code は起動直後に
  `remoteUser` の解決で `id` を exec するため、passwd 追記より先に走る競合を狭める。
- 初期化後は `sleep infinity` 相当で PID 1 として残る。

devcontainer モード専用のマウント

- `~/.vscode-server` をホストのキャッシュディレクトリ（`$XDG_CACHE_HOME/nas/vscode-server/`）に
  RW でマウントする。VS Code Server と拡張の再インストールを避けるためで、
  コンテナを使い捨てにしても実用に耐える。

ネットワークプリセット

- VS Code Server の取得と拡張のインストールがプロキシを通るので、
  `update.code.visualstudio.com`、`vscode.download.prss.microsoft.com`、
  `marketplace.visualstudio.com`、`*.vsassets.io` などを許可する `presets.vscode` を
  `global.pkl` に追加する。拡張は `remote.downloadExtensionsLocally` をホスト側で有効にして、
  コンテナからの marketplace 到達を減らす。

### コンテナの寿命: 1 セッション = 1 コンテナ を採る

nas のプロキシ用ネットワーク、hostexec ソケット、mask ソケット、port relay ソケット、
guide ディレクトリは session id を鍵にしてセッションごとに作り直す。bind mount は既存コンテナで
差し替えられないので、コンテナを複数セッションにまたがって残すと、これらの識別子を
「ワークスペースごとに安定したパス」へ移す設計変更が必要になる。UI、履歴、
`nas container clean` の判定（`src/docker/nas_resources.ts`）にも波及する。

さらに mask-filter の bash ラッパーは、埋め込んだソケットが無いと終了コード 121 で落ちる
（`entrypoint.sh:379-381`）。サイドカー再起動の合間や古いソケット残留時に、コンテナ内の
bash がすべて動かなくなる窓ができる。

以上から、ウィンドウを閉じたらコンテナを削除し、次の `code .` で新セッションを立てる方式を採る。
「コンテナ内だけの変更は終了後に残らない」というユーザーガイドの保証もそのまま保てる。
コンテナ内に残したいものは `~/.vscode-server` のキャッシュマウントで賄う。

### `nas claude` から劣化する点

- 拡張が `claude` を起動するため、`agentArgs` と guide stage の `--add-dir=/opt/nas/guide` を
  渡せない。guide を使うなら `~/.claude/settings.json` 経由など、引数を使わない手段に移す。
- VS Code Server と拡張の通信先を許可する必要があり、egress の許可範囲が広がる。
- Claude Code 拡張が独自にバイナリを取得・更新する挙動を持つ場合、nas がマウントする
  RO の `claude` と競合する。実機での確認が必要。
- サンドボックスの境界がコンテナ全体になる。VS Code のターミナルで打つコマンドも
  すべてプロキシと出力マスクを通る（これは望ましい副作用でもある）。

## 最初に検証すること

1. `initializeCommand` が書いた compose ファイルを VS Code が `docker compose up` 時に
   読むこと（devcontainer.json の解析より後であること）。成立しない場合は、ワークスペースごとに
   安定した compose を置き、セッション依存のソケットだけを固定ディレクトリ配下に集める折衷に
   切り替える。
2. `userEnvProbe` で `/etc/profile.d/nas.sh` の env が拡張ホストに届き、拡張が起動した
   `claude` の通信が nas のプロキシに乗ること。
3. 起動直後の `remoteUser` 解決が entrypoint の passwd 追記と競合しないこと。
4. VS Code Server のインストールが nas のプロキシ経由で完了すること。失敗するなら
   ホスト側でダウンロードしてコピーする経路（VS Code の設定）を調べる。
5. Claude Code 拡張がマウント済みの `claude` を使い、自前で取得しないこと。

## 未決事項

- `nas devcontainer up` が使うプロファイルの指定方法（引数か、`.nas/config.pkl` の既定か）。
- supervisor の生存確認と孤児化した compose 生成物の回収を `nas container clean` に含めるか。
- `session.multiplex` との関係。devcontainer モードでは VS Code のターミナルが入力面になるので、
  dtach による再接続は supervisor の管理用途に限定してよいか。
- Copilot CLI と Codex CLI の拡張にも同じ構造で対応できるか（本構想は Claude Code 拡張だけを
  見ている）。
