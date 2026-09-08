# 開発環境の読み込みを direnv に委ねる

状態: レビュー用設計案。

## この設計で決めること

読者は、nas の自動 devShell 読み込みと `nix.extraPackages` を廃止し、
プロジェクトの `.envrc` で開発環境を定義したい利用者・実装者。
設定、許可、起動失敗からの復旧を確認し、この置き換えの実装範囲を承認できることを目的とする。
実行環境の一時的な Bun 障害は本機能の変更に含めない。

## 利用者の操作

プロファイルに次を設定する。`direnv.enable` の既定値は `false` とする。

```pkl
direnv = new DirenvConfig {
  enable = true
}
```

プロジェクトの `.envrc` に環境定義を書き、**ホストで**そのファイルを確認して
`direnv allow /absolute/path/to/project/.envrc` を実行する。その後 nas を起動する。
flake の devShell を使う場合は `.envrc` に `use flake` と書く。
追加パッケージは devShell や `.envrc` 側で定義する。

nas は `direnv allow` を自動実行しない。nas 設定の信頼確認とも別の許可であり、
プロファイルを信頼しても `.envrc` の実行許可にはならない。
許可後に `.envrc` を変更した場合も、利用者が再度 `direnv allow` する。

## 起動時の振る舞い

| 条件 | 結果 |
| --- | --- |
| `direnv.enable = false` | 開発環境を自動評価せず起動する |
| 有効で、探索範囲に `.envrc` がない | 環境追加なしで起動する |
| 有効で、見つかった `.envrc` が許可済み | コンテナ内のエージェントユーザーで評価し、その環境で起動する |
| 未許可・変更により許可失効・明示的に deny 済み | エラーで起動を止める |
| direnv の実行・状態取得・環境評価が失敗 | エラーで起動を止める。環境なしで続行しない |

エージェントの初回起動と `--shell` による追加シェルの起動は同じ判定を通す。
既存プロセスへの再接続だけでは再評価しない。起動後の対話シェルへの
自動 hook 導入は今回の範囲に含めず、開始時に読み込んだ環境を継承する。

未許可エラーには対象ファイルの絶対パスと、ホストで実行すべき
`direnv allow <対象ファイル>` を表示する。パスはシェル引数として引用する。
評価失敗時は direnv の診断を stderr に残す。

## 許可情報と worktree

ホストの `${XDG_DATA_HOME:-$HOME/.local/share}/direnv` が存在すれば、
コンテナの direnv 用データディレクトリへ読み取り専用で共有する。
allow と deny の両方を含め、nas 独自の許可ファイルやハッシュ形式を導入しない。
ホスト側ディレクトリがなければ作成せず、コンテナの空の状態で判定する。
ホストの HOME 全体、direnvrc、direnv.toml は自動共有しない。
利用者が必要とする追加の direnv 拡張は `.envrc` または既存の明示マウントで用意する。
標準の `use flake` は direnv 本体で利用できる。

評価対象は、WorktreeStage が確定した実際のワークスペースから direnv が探索する
`.envrc` とする。ホストとコンテナのワークスペースの絶対パスを保ち、
元リポジトリの許可を別パスの worktree に転用しない。
コンテナにマウントしていない親ディレクトリの `.envrc` は追加で持ち込まない。

新規の nas worktree で未許可エラーになった場合は、終了処理で worktree を保持し、
ホストで表示されたパスを allow してから同じ worktree を再利用する。
この手順をエラー案内とドキュメントに示す。既存の worktree 保持・再利用操作を使う。

## Nix の扱いと移行

`nix.enable` と `nix.mountSocket` は残す。役割を Nix store・daemon・バイナリ・
設定と Nix 自身のキャッシュの共有に限定する。`direnv.enable` と独立であり、
Nix を使わない `.envrc` も利用できる。

nas が行っていた flake の自動検出、devShell の probe、`nix print-dev-env`、
`nix develop` へのフォールバック、`nix shell` による追加パッケージ適用を削除する。
nas 独自の `nix-dev-env` キャッシュと、そのための `~/.cache/nas` マウントも削除する。
既存のホストキャッシュファイルを自動削除することはしない。

`nix.extraPackages` はスキーマ・型・実行時の参照から削除する。
旧設定を黙って無視せず、設定エラーで `.envrc` / devShell への移行を案内する。
古いローカル Schema.pkl によって JSON 評価が成功する場合も検出対象とする。
同梱 Schema.pkl のバージョンを更新し、既存のスキーマ更新経路に乗せる。
旧形式からの移行コマンドも、廃止フィールドを含む実行不能な Pkl を生成しない。
非空の旧追加パッケージ設定は手動移行を案内し、空の項目は除去できる。

既存プロファイルは、Nix が有効でも `.envrc` の読み込みを始めない。
利用者は `direnv.enable = true` を追加し、必要に応じて `.envrc` を作成して許可する。
この挙動変更を設定ガイドに明記する。

## 実装の境界

- Pkl・TypeScript のプロファイルに `DirenvConfig` を追加する。
- MountStage の probe でホストの direnv データディレクトリの有無を解決し、
  純粋 planner が読み取り専用マウントと有効フラグを組み立てる。stage に直接 I/O を足さない。
- コンテナイメージに direnv を含める。ホストの direnv 実行ファイルへの依存は増やさない。
- entrypoint の Nix 開発環境分岐を、共通の direnv 起動処理に置き換える。
  非 root ユーザーへ降格してから、ワークスペースで `direnv status --json` を取得する。
  見つかった RC がある場合は、許可済みであることを確認して `direnv exec` する。
  明示 deny を成功として扱う direnv の経路があるため、exec の終了コードだけに頼らない。
- direnv に渡す環境から、ホスト由来の `DIRENV_DIFF` など読み込み済み状態を除去する。
  ホストの環境差分をコンテナの初期環境へ逆適用させない。
- `.envrc` 評価後に既存の nas 環境変数操作を適用し、hostexec と bash wrapper の
  PATH 優先順位を復元する。コマンドの引数・終了コード・端末接続を保つ。
- 環境評価はコンテナ内で行う。ホストでの `.envrc` 実行、シークレットの追加展開、
  hostexec の control socket 公開は行わない。

## 検証

設定の既定値、明示有効化、旧フィールドの移行案内を検証する。
マウント計画は Nix との独立性、XDG パス、読み取り専用共有、存在しないディレクトリを扱う。

実際の direnv と一時ディレクトリを使う integration テストで、無効・RC 不在・
許可済み・未許可・内容変更・deny・評価失敗を確認する。
未許可時には RC の副作用もエージェント起動も起きないことを検証する。
空白や引用符のあるパスと引数、エージェントと追加シェル、env prefix/suffix、
wrapper の PATH 順序、旧 nas キャッシュがあっても採用しないことを確認する。
パスの異なる worktree では許可を引き継がないことも確認する。

`test-policy` と `post-change-checks` に従い、反復中は単体テスト、最終確認で
全スイートを一度実行する。Docker ビルドのネットワークが必要な検証の skip は明記する。
設定ガイドの Pkl 例を評価し、docs ビルドと差分チェックを行う。

## なぜこのアプローチを選んだか

環境の定義を `.envrc` にまとめると、Nix 以外の環境も同じ入口で扱える。
nas が flake の出力やキャッシュの有効性を管理する必要がなくなり、
環境定義の変更はプロジェクト側で完結する。

direnv のネイティブな許可判定を使い、利用者が行った allow と deny を維持する。
起動に必要な操作が分かるよう、失敗時には実際の対象パスを案内する。

## なぜ他の案を選ばなかったか

- ホストで direnv を評価して環境を渡す案は、プロジェクトのコードをホストで実行し、
  ホスト固有の環境やパスをコンテナへ持ち込むため採用しない。
- 自動 allow は、利用者の「別途 allow が必要で、未許可ならエラー」という指定に反する。
- shell hook だけを設定する案は、非対話で起動するエージェントへ環境を適用できない。
- nas 独自キャッシュを残す案は、direnv と二重に環境の更新判定を持つため採用しない。

## 参照

- [direnv のコマンド・保存先](https://direnv.net/man/direnv.1.html)
- [標準の use flake](https://direnv.net/man/direnv-stdlib.1.html)
- [許可判定とパス・内容のハッシュ](https://github.com/direnv/direnv/blob/master/internal/cmd/rc.go)
- [status の JSON 出力](https://github.com/direnv/direnv/blob/master/internal/cmd/cmd_status.go)
- リポジトリの `security-constraints`、`effect-separation`、`test-policy`。
