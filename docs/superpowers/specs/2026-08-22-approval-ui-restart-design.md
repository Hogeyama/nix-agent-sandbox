# Approval UI restart design

## Goal

承認者が、どのセッションの何を、どの範囲まで許可または拒否するのかをカードだけで判断できるようにする。`onIndeterminate` では抽象的な理由ではなく実際の判定不能原因と request body を確認でき、保存を明示的に有効化した利用者は同じ exact bytes を audit から retention 期間中に再確認できる。

## Requirement trace

| ID | Required outcome | Observable acceptance |
|---|---|---|
| R1 | 現行表示の整理 | `docs/todo/ui.md` に現行 UI、実際の意味、優先順位、対象外が記録されている |
| R2 | session の識別 | network と hostexec の各カードに session name と short ID が常時表示される。name が無ければ short ID を表示する |
| R3 | network approval の単位と lifetime | `once` は押した requestId 1 件だけを解決する。選択中 scope の効果が tooltip ではなく本文に表示され、将来の再利用が session 終了までか否かを区別する |
| R4 | `onIndeterminate` の実原因 | 選択された rule が判定不能になった closed diagnostic code と安全な構造情報をカードと audit に表示する |
| R5 | exact raw body の保存と再確認 | opt-in 時だけ、policy が評価した masking 前の bytes を host SQLite BLOB に exact 保存する。pending card と audit row から遅延取得でき、retention と総容量上限が効く |

## Frozen scope

この実施で変更するのは network/hostexec pending card、network addon→broker request、network audit body store、body detail API、audit row detail だけである。

次は対象外とする。

- pending pane 全体の session group 化、deep link、キーボード操作の再設計
- hostexec scope semantic の変更
- CLI 表示の統一
- network/hostexec 共通の汎用 approval-effect model
- container から audit DB または別 host file への直接書き込み
- binary framing、複数 frame、half-close を伴う新しい socket lifecycle
- raw body 保存失敗時に Approve を禁止する認可 semantic の変更

## UI behavior

### Session identity

`App` が既に持つ session rows を `sessionId` で引き、pending card へ表示名を渡す。network/hostexec pending payload や pending store に session name の複製を持たせない。

表示は `name · shortId`、name が無い場合は `shortId` とする。同名 session を short ID で識別できることを優先する。

### Approval effect

network と hostexec の `once` は、押した card の `requestId` 1 件だけを解決する。同じ内部 group の他 request は pending のまま残す。現状の group 全件解決は compatibility として保存せず、`once` の語義と既存 UI tooltip に反する bug として修正する。

選択中 scope の本文は次を正確に述べる。

- `once`: この request 1 件だけに答える。将来の request には記憶しない。
- `rule`: 現在の group 全件に答え、同じ session の間、同じ rule と固定 target に再利用する。
- `host-port`: 現在の group 全件に答え、同じ session の間、同じ rule・host・port に再利用する。
- `host`: 現在の group 全件に答え、同じ session の間、同じ rule・host の全 port に再利用する。
- `violation`: 現在同じ rule と violation identity で待つ group 全件に答え、同じ session の間、同じ violation identity に再利用する。

Network の Allow と明示 scope 付き Deny は同じ単位を使う。scope を持たない legacy/CLI deny の 30 秒 negative cache は今回の UI から呼ばれないため表示対象にしない。hostexec の `capability` と Deny semantic の再設計は対象外だが、hostexec `once` だけは request 単位に修正する。

### Indeterminate diagnostic

addon は rule ごとの truth と同時に、truth が `indeterminate` のときだけ次の closed diagnostic を作る。

```ts
type BodyDiagnostic =
  | { code: "body-unreadable" }
  | { code: "body-too-large"; byteLength: number; maxBodyBytes: number }
  | { code: "invalid-json" }
  | { code: "empty-json-body" }
  | { code: "non-scalar-at-pointer"; pointer: string };
```

例外文、body の断片、解析器メッセージは diagnostic に入れない。broker は自分が選択した `ruleId` の diagnostic だけを pending と authorization audit に残す。fallback や通常の `rule` review には diagnostic を付けない。

## Raw request body audit

### Configuration

profile の `network` に次を追加する。

```pkl
requestBodyAudit {
  enable = false
  retentionSeconds = 604800
  maxBodyBytes = 8388608
  maxTotalBytes = 268435456
}
```

- `enable = false` が既定であり、既存利用者は raw body を送信も保存もしない。
- `maxBodyBytes` は一 request の exact 保存上限。超過時は truncate せず `unavailable/body-too-large` とする。
- `maxTotalBytes` は未期限切れ body の総 BLOB 上限。超過時は既存の未期限切れ body を追い出さず、新規 body を `unavailable/capacity` とする。
- `retentionSeconds` 後は detail query と次回 insert の前に削除する。
- 数値は正の整数とし、`maxBodyBytes <= 33554432`、`maxTotalBytes >= maxBodyBytes` を検証する。32 MiB は既存 network body policy の固定 ceiling と同じである。

### Capture and transport

addon は masking、rewriting、credential injection より前に得た `flow.request.content` を使う。

- disabled: message は body bytes を含めず `{state:"disabled"}` を送る。
- request が body を宣言せず bytes も空: `{state:"not-applicable"}`。
- unreadable、per-request limit 超過、encode failure: data を含めず `{state:"unavailable", code}`。
- otherwise: SHA-256 と base64 data を含む `{state:"attached", byteLength, sha256, contentType, contentEncoding, data}`。

capture は全 request-policy 処理より先に必ず行われる既存 version 1 の `authorize` に一度だけ載せる。後続の `request_policy_review` / `request_policy_outcome` は同じ `(sessionId, requestId)` を参照できるため、raw bytes や evidence ID を再送しない。

transport は既存 one-line JSON のままとする。`readJsonLine(socket, maxBytes)` を byte-counted にして broker request を 48 MiB で拒否する。32 MiB raw body の base64 と固定 metadata を収めつつ無制限蓄積を止める。reply framing と hostexec の既定上限は変えない。

### Persistence

既存 `audit.db` に通常一覧から分離した table を一つ追加する。

```sql
CREATE TABLE request_body (
  session_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  content_type TEXT,
  content_encoding TEXT,
  byte_length INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  body BLOB NOT NULL,
  PRIMARY KEY (session_id, request_id)
);
```

通常の audit/pending list query は BLOB 列を SELECT しない。insert は transaction 内で期限切れ削除、現在総量確認、insert を行う。DB directory/file の既存 host-only boundary と permission を維持する。

capture status は raw bytes を含まない次の metadata として pending と audit に残す。

```ts
type RequestBodyAuditStatus =
  | { state: "disabled" | "not-applicable" }
  | { state: "attached"; byteLength: number; sha256: string }
  | { state: "unavailable"; code: "body-unreadable" | "body-too-large" | "capacity" | "invalid-capture" | "store-failed" };
```

保存失敗は request の allow/deny を変更しない。カードには `raw audit: unavailable (<code>)` を表示し、保存されていないことを隠さない。

### Retrieval

host UI API に `GET /api/network/body/:sessionId/:requestId` を追加する。ID を既存の safe-ID validator で検証し、期限切れ/未保存は 404、保存済みは metadata と base64 data を返す。body は SSE、pending JSON、audit list JSON、log、notification に含めない。

pending card と Settings/Audit row は status を常時表示し、`View raw body` を押したときだけ取得する。UTF-8 として lossless decode できる bytes は raw text、できない bytes は base64 と明記して表示する。UI は内容を console に出さない。

## Failure semantics

- malformed/oversized broker request は closed error で fail closed し、raw parser error や request text を log しない。
- invalid base64、byteLength mismatch、SHA-256 mismatch は `invalid-capture`。BLOB は保存しない。
- SQLite body write failure は `store-failed`。authorization の既存 audit/decision pathは継続する。
- audit body detail failure は card/row 内の error として表示し、他の pending action や audit pagination を壊さない。

## Why this design

既存の request lifecycle を保ちながら `once` の request 単位を修正し、raw bytes は既存の host audit boundary にだけ追加する。session name は frontend join、scope effect は既存 `approvalScopes`、cause は closed diagnostic、body は一つの独立 BLOB table と一つの lazy endpoint で完結する。

## Why not the previous direction

前回は frontend の要求より前に汎用 effect contract、binary framing、pending evidence lifecycle、atomic group attachment、close/disconnect race machineryへ展開した。これは R2–R5 の画面上の成果を長く出さず、spec/plan 自体も実装都合で変更した。今回は既存 protocol/version/group lifecycle を保ち、各 task が UI で観測できる要求に直接終端する。
