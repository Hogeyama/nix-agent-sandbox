# ポート転送設定の移行

`network.proxy.forwardPorts` は引き続き使えますが、読み込み時に移行の警告が出ます。同じ接続を新しい書き方へ移すには、対象プロファイルの `network.remoteForwards` にホスト側とコンテナ側の番号を指定します。nas が設定ファイルを自動で書き換えることはありません。

## ホストの 5432 番への接続を維持する

変更前:

```pkl
network {
  proxy {
    forwardPorts { 5432 }
  }
}
```

変更後:

```pkl
network {
  remoteForwards {
    new PortForwardConfig { hostPort = 5432; containerPort = 5432 }
  }
}
```

警告に表示される置き換え例と同じ形です。既存のプロファイル内で置き換え、ほかの `proxy` 設定を使っている場合は残してください。生成される `Schema.pkl` を編集する必要はありません。

変更内容を確認して `nas config trust` を実行し、変更したプロファイルで新しいセッションを起動します。コンテナ内の接続先は引き続き `localhost:5432` です。設定の編集は、すでに動いているセッションには反映されません。

## 両側の番号を変える

Remote はコンテナで待ち受け、ホストへ接続する転送です。コンテナ内の `localhost:15432` からホストの `127.0.0.1:5432` を使う場合は、次の設定にします。

```pkl
network {
  remoteForwards {
    new PortForwardConfig { hostPort = 5432; containerPort = 15432 }
  }
}
```

Local はホストで待ち受け、コンテナへ接続する転送です。ホストのブラウザで `http://localhost:8080` を開き、コンテナの 3000 番へ接続する場合は、次の設定にします。

```pkl
network {
  localForwards {
    new PortForwardConfig { hostPort = 8080; containerPort = 3000 }
  }
}
```

どちらも両方の番号を指定します。Local と Remote の意味は、CLI を実行する場所によって変わりません。

## 実行中のセッションで追加・解除する

`<session-id>` は対象のセッション ID へ置き換えます。`-L` と `-R` の値は、待ち受ける番号から接続先の番号への順です。

```bash
nas network bind <session-id> -L 8080:3000
nas network bind <session-id> -R 15432:5432
nas network unbind <session-id> -L 8080
nas network unbind <session-id> -R 15432
```

`--local-forward` と `--remote-forward` も使えます。一度の操作で指定する転送は 1 件です。

設定から作られた転送も、実行中のセッションでは UI または CLI で解除できます。解除しても設定ファイルは変わりません。リレーの接続が切れて復旧しても転送は復活せず、新しいセッションを起動したときに設定が再び適用されます。次回以降も不要なら、プロファイルの設定も削除してください。

履歴記録など nas 内部の機能と共有する転送では、設定・手動追加分を解除しても内部用途の転送が残ります。UI の Origin と削除後のメッセージで確認できます。

従来の `bind <session-id>:<port>`、`unbind`、`forward`、`unforward` も引き続き利用できます。古いバージョンで起動したセッションが新しい操作に対応していない場合は、案内に従ってセッションを起動し直してください。
