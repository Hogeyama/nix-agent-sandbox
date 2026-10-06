# DinD のネットワーク認可を agent から分離する

DinD 内の privileged コンテナは、dockerd の環境変数からプロキシトークンを取得できる。このトークンを盗まれても agent のネットワーク権限と認証情報に届かないようにする。

同じセッションに agent と dind の独立したトークンを発行する。プロキシは検証したトークンから principal を選び、対応する認可ドキュメントで宛先・メソッド・本文を判定する。承認キャッシュ、資格情報の自動注入、監査も principal を区別する。

利用者は `docker.networkScopes: Mapping<String, Scope>` にイメージ取得先を指定する。既定は空で、未一致は deny。agent の `network.scopes` は引き継がない。DinD で review は設定できない。既存 Scope の明示的な secret 注入は使えるが、agent の OAuth は自動注入しない。

Docker Hub の pull 用 preset を提供する。push、apt、npm などの一般通信は対象外。必要な registry を増やす場合は設定で明示する。dockerd と registry mirror に dind トークンを渡し、終了時に両トークンと認可ドキュメントを失効・削除する。
