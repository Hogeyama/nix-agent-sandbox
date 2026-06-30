# Proxy Credential Injection

mitmproxy ベースのプロキシが allow 判定したリクエストに、ホスト別の認証ヘッダーを自動注入する機構を追加する。

## 背景

nas のプロキシは mitmproxy addon + session broker で全リクエストを制御している。review rules で allow/deny/review を判定するが、ターゲットサーバーへの認証ヘッダー注入の仕組みはない。コンテナ内のエージェントは sandbox 内で動くため、ホスト側の credential に直接アクセスできない。

mitmproxy が MITM でリクエストを復号・再暗号化する位置にいるため、ここでヘッダーを注入するのが自然なアプローチ。

## 設計判断

| 判断 | 決定 | 理由 |
|---|---|---|
| スコープ | 汎用的なホスト別トークン注入 | GitHub 専用ではなく任意のホストに対応 |
| 値の供給 | `val` / `valCmd` パターン | 静的値とコマンド実行の両方に対応。`EnvValSpec` とは別の型 |
| トークン保管 | broker インメモリ（ファイルに残さない） | セキュリティ上、平文ファイルを避ける |
| 条件粒度 | host + pathPrefix + method | review rules と同じ粒度で一貫性がある |
| review rules との関係 | 独立 | credential はヘッダー付与のみ。アクセス許可は review rules が別途必要 |
| マッチング方式 | all-match | 条件に合う credential を全て適用。1リクエストに複数ヘッダー注入可能 |
| ヘッダー名制限 | hop-by-hop ヘッダー禁止 | `Host`, `Content-Length`, `Transfer-Encoding`, `Connection` 等の注入を禁止 |
| 値の解決タイミング | 起動時に1回 | valCmd は nas 起動時に実行し、セッション中は固定値 |
| 監査ログ | 注入ヘッダー名を記録 | 既存の audit log に credential 注入の事実（ヘッダー名のみ、値は除く）を記録 |

## 型定義

### CredentialRule (設定)

```typescript
// src/config/types.ts

export type CredentialValSpec = { val: string } | { valCmd: string };

export interface CredentialRule {
  host: string;            // "github.com", "*.example.com"
  pathPrefix?: string;
  method?: string;
  header: string;          // "Authorization" 等
  value: CredentialValSpec;
}

export interface NetworkConfig {
  reviewRules: ReviewRule[];
  credentials: CredentialRule[];  // 追加
  proxy: ProxyConfig;
  pendingTimeoutSeconds: number;
  pendingDefaultScope: ApprovalScope;
  pendingNotify: NetworkPromptNotify;
}
```

### ResolvedCredential (実行時)

```typescript
export interface ResolvedCredential {
  host: string;
  pathPrefix?: string;
  method?: string;
  header: string;
  value: string;  // valCmd 実行済みの値
}
```

### InjectHeader (プロトコル)

```typescript
// src/network/protocol.ts

export interface InjectHeader {
  name: string;
  value: string;
}

export interface DecisionResponse {
  version: 1;
  type: "decision";
  requestId: string;
  decision: Decision;
  scope?: ApprovalScope;
  reason: string;
  message?: string;
  injectHeaders?: InjectHeader[];  // 追加
}
```

## データフロー

```
nas 起動
  │
  ├─[1] runProxy() 冒頭で NetworkRuntimeService.resolveCredentials() 呼び出し
  │     → CredentialRule[] の valCmd を sh -c で実行、ResolvedCredential[] を得る
  │
  ├─[2] SessionBroker コンストラクタに ResolvedCredential[] を渡す
  │     → broker がインメモリで保持
  │
  ├─[3] addon → broker: AuthorizeRequest を送信
  │     broker が allow 判定時に host/path/method で credential を all-match
  │     → マッチした全 credential の injectHeaders を DecisionResponse に含めて返す
  │
  └─[4] addon が injectHeaders を受け取り、リクエストヘッダーに付与して転送
```

## valCmd 解決

`NetworkRuntimeService` に `resolveCredentials` メソッドを追加する。

- `val` → そのまま値を返す
- `valCmd` → `Bun.spawn(["sh", "-c", cmd])` で実行、stdout をトリムして返す
- 空出力、非ゼロ終了はエラー

Live 実装は `ProcessService` 経由。Fake はテスト用に静的値を返す。

## Broker の credential マッチング

`SessionBroker.authorize()` が `allow` を返す時点で、リクエストの host / path / method を `ResolvedCredential[]` に対して **all-match** で照合する。条件に合う credential を全て収集し、それぞれの header/value を `injectHeaders` に含める。

- マッチあり → `DecisionResponse.injectHeaders` にマッチした全 credential の `{ name: cred.header, value: cred.value }` を含める
- マッチなし → `injectHeaders` なし（従来通り）
- `deny` 判定 → `injectHeaders` なし

マッチングロジックは review rules と同じ `matchesHostPattern` / pathPrefix / method 照合を再利用する。

## ヘッダー名の制限

以下の hop-by-hop ヘッダーおよびプロキシ制御ヘッダーの注入を禁止する。バリデーション時（`validate.ts`）にエラーとする。

- `Host`
- `Content-Length`
- `Transfer-Encoding`
- `Connection`
- `Proxy-Authorization`
- `Proxy-Connection`
- `Keep-Alive`
- `TE`
- `Trailer`
- `Upgrade`

## 監査ログ

broker が credential を注入した場合、既存の audit log に記録する。セキュリティのためヘッダー名のみ記録し、値は含めない。

```typescript
// audit log entry に追加するフィールド
injectedHeaders?: string[];  // e.g. ["Authorization", "X-API-Key"]
```

## Addon の変更

`nas_addon.py` の `request()` メソッドで、allow 判定後・proxy-authorization 削除前に `injectHeaders` を処理する。

```python
if decision.get("decision") == "allow":
    for h in decision.get("injectHeaders", []):
        flow.request.headers[h["name"]] = h["value"]
```

## 変更対象ファイル

| ファイル | 変更内容 |
|---|---|
| `src/config/Schema.pkl` | `CredentialRule` クラス追加、`NetworkConfig.credentials` 追加 |
| `src/config/types.ts` | `CredentialValSpec`, `CredentialRule` 追加、`NetworkConfig.credentials` 追加、デフォルト値 |
| `src/config/validate.ts` | credential バリデーション追加（禁止ヘッダー名チェック含む） |
| `src/network/protocol.ts` | `InjectHeader` 追加、`DecisionResponse.injectHeaders?` 追加 |
| `src/network/broker.ts` | `BrokerOptions` に `resolvedCredentials` 追加、authorize で credential マッチング |
| `src/stages/proxy/network_runtime_service.ts` | `resolveCredentials` メソッド追加 |
| `src/stages/proxy/session_broker_service.ts` | `SessionBrokerConfig` に `resolvedCredentials` 追加 |
| `src/stages/proxy/stage.ts` | `runProxy` で resolveCredentials 呼び出し、broker に渡す |
| `src/docker/mitmproxy/nas_addon.py` | allow 時 injectHeaders からヘッダー付与 |

## 変更しないもの

- review rules の評価ロジック
- local-proxy (`local-proxy.mjs`)
- CA 証明書周り
- pending / approval フロー

## テスト

- broker の credential マッチング — unit test
- `NetworkRuntimeService.resolveCredentials` — unit test（fake ProcessService）
- addon の `injectHeaders` 処理 — addon テストがあれば追加
- proxy stage 結合 — 既存 stage test に credential 設定追加

## 設定例

```yaml
network:
  credentials:
    - host: "github.com"
      header: "Authorization"
      value:
        valCmd: "echo token $(gh auth token)"
      # valCmd は起動時に1回だけ実行
    - host: "api.github.com"
      header: "Authorization"
      value:
        valCmd: "echo token $(gh auth token)"
    - host: "registry.npmjs.org"
      header: "Authorization"
      value:
        valCmd: "echo Bearer $(npm token list --json | jq -r '.[0].token')"
  reviewRules:
    - host: "github.com"
      action: allow
    - host: "api.github.com"
      action: allow
    - host: "registry.npmjs.org"
      action: allow
```

## コーディング規約

実装時に以下のスキルに従う:
- `effect-separation` — stage は orchestration のみ、I/O はサービス経由
- `test-policy` — unit test は `*_test.ts` で src/ 隣接配置、Docker 不要
