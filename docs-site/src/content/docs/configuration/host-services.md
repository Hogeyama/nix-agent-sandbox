---
title: ホストの DB・API への接続
description: ホストの localhost サービスをコンテナから使うための Remote 転送
---

ホストで動いている DB や API をエージェントから使う場合は、Remote 転送を追加します。ホストのサービスは `127.0.0.1` で待ち受けたまま利用できます。

エージェントが作ったサーバーをホストのブラウザで見たい場合は方向が逆です。[開発サーバーの確認](/nix-agent-sandbox/work/preview/)で Local 転送を追加します。

## 転送するサービスを確認する

**この転送に HTTP の通信ルールや承認は適用されません。** 転送先が認証のない DB や管理 API なら、エージェントもそのまま操作できます。必要なサービスだけを選び、サービス側の認証・権限も設定してください。

nas UI 自身のポートを転送すると、エージェントが承認 API に到達できるようになります。転送しないでください。

ホスト側のサービスが `127.0.0.1:5432` で待ち受けている例では、コンテナ側で待ち受ける番号を 15432 にすると、接続先は `localhost:15432` になります。

## 作業中のセッションに追加する

UI の **Sessions** で作業を選び、右の **Pending** にある **Ports** を確認します。**Direction** で **Remote (container → host)** を選び、**Host port** に `5432`、**Container port** に `15432` を入力して **Add forward** を押します。

一覧に **Remote** と `container localhost:15432 → host localhost:5432` が表示されれば、コンテナ内から `localhost:15432` へ接続できます。Remote の行はホストのブラウザで開くリンクにはなりません。

コンテナ内のサービス用クライアントを `localhost:15432` へ接続し、DB や API から期待する応答が返ることを確認します。

CLI では、左にコンテナ側の待受番号、右にホスト側の接続先番号を指定します。

```bash
nas network bind <session-id> -R 15432:5432
```

ホスト側のサービスがまだ起動していなくても転送は残ります。一覧は active のまま、UI には `Target probe: no answer from host 127.0.0.1:5432 yet` と表示されます。サービスを起動してからコンテナ内で接続し直してください。

不要になったら一覧の **Remove**、または次のコマンドでコンテナ側の待受番号を指定します。

```bash
nas network unbind <session-id> -R 15432
```

設定由来の転送も現在のセッションから解除できます。内部用途と共有する行では **Remove user** と表示され、内部用途の転送だけが残ります。

## 新しいセッションにも設定する

毎回使う場合は、[対象プロファイル](/nix-agent-sandbox/configuration/profiles/#プロファイルの編集)に起動時の Remote 転送を追加します。

```pkl
network {
  remoteForwards {
    new PortForwardConfig { hostPort = 5432; containerPort = 15432 }
  }
}
```

設定を確認して `nas config trust` を実行し、変更したプロファイルで新しいセッションを起動します。一覧の Origin に `config` が表示され、エージェントの最初の接続から利用できます。

実行中に Remove してもプロファイルは変わらず、そのセッションではリレーが再接続しても転送は戻りません。次の新しいセッションでは設定が再び適用されます。次回以降も不要なら、プロファイルからも削除してください。

旧 `network.proxy.forwardPorts` から移す場合は、リポジトリの `docs/migration/port-forwarding.md` を参照してください。
