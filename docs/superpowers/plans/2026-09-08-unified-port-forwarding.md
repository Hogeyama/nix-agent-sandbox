# Unified Port Forwarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development with the patched-superpowers review gates. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 両方向の転送を config と実行中の CLI/UI 操作で管理し、SSH の L/R 名称と旧設定の互換性・移行 warn を提供する。

**Architecture:** 既存の双方向 port broker と relay を使い、config・dynamic・internal の転送を共通の所有状態へ正規化する。固定転送のポート別 UDS を廃止し、entrypoint の初期同期を通じて agent 起動前に必要な転送を準備する。CLI/UI は一つの domain service を通る。

**Tech Stack:** Bun、TypeScript strict、Effect、Pkl、node:net、SolidJS、Docker。

**Spec:** `docs/superpowers/specs/2026-09-08-unified-port-forwarding-design.md`（承認済み）。

## Global Constraints

- Local = host、Remote = container。CLI を起動した場所によって意味を変えない。
- `network.localForwards` / `network.remoteForwards` の要素は `hostPort` と `containerPort`、両方必須、1–65535。
- `-L` / `--local-forward` と `-R` / `--remote-forward` は `listenPort:targetPort`。1 操作 1 件。
- `ProxyConfig` と旧 `network.proxy.forwardPorts` を残す。旧非空設定には profile ごとに stderr の移行 warn。自動書換えをしない。
- config は新規セッションの初期値。実行中の削除を relay の再接続で復活させない。
- TCP、loopback のみ。ホスト専用の管理 socket をコンテナへ公開しない。ホスト接続先はホストの許可表から解決する。
- `skills/security-constraints/SKILL.md`、`skills/effect-separation/SKILL.md` と `references/domain-service.md` を実装者・レビュアーとも読む。
- stage は計画と service 呼出しのみ。合成 Effect と I/O primitive を分離し、L2 は Error 型を plain-async adapter まで維持する。
- `skills/test-policy/SKILL.md`、`skills/post-change-checks/SKILL.md` を読む。Docker 依存は `*integration_test.ts`、一時資源は finally で掃除する。
- テスト実行はユーザー提示の AGENTS.md を優先する。反復は `bun run test:unit`、全 suite の `bun run test` は最終確認に一度だけ。この指定は post-change-checks の NAS unit-only 既定より優先する。ネットワークが必要な Docker build の skip を成功と混同しない。
- `skills/reader-decision-writing/SKILL.md` に従って操作ガイドを書く。`skills/git-commit/SKILL.md` に従ってコミットする。
- 実装開始時の HEAD を progress ledger の `implementation-base` に記録。履歴が動いているため、設計時の hash を実装 base に固定しない。
- 各 task は独立した実装者と patched-superpowers の code-reviewer でレビューする。計画の承認後に実装を開始する。
- ユーザーの未追跡ファイル `docs/todo/playwright-cli-visible-browser.md` を変更・コミットしない。

## 現在の実装と分割

計画の調査時点の HEAD は `6f6b08c4`。`23c364c7` で逆方向の動的転送が追加されている。
`RelayGateway.forward/unforward`、broker の `forwards`、`PortForwardsPanel`、
CLI の `forward/unforward` を再利用する。新しい別 broker を作らない。

| 所有箇所 | 変更する責務 |
| --- | --- |
| `src/network/port_forward_model.ts`（新規） | 共通の純粋型、転送キー、所有理由、競合判定 |
| `src/config/port_forwards.ts`（新規） | 新旧設定の正規化と診断。I/O なし |
| `src/network/port_bind_broker.ts` | 全転送の望ましい状態、所有、直列化、永続化 |
| `src/network/port_bind_relay.ts` / `src/docker/embed/port-relay.mjs` | 許可識別子、listen 応答、stream、復旧 |
| `src/stages/port_bind/` | 初期 config/internal 転送と entrypoint readiness のライフサイクル |
| `src/domain/port_bind/` | CLI/UI 共通 API と旧 broker への互換 adapter |
| `src/cli/port_bind_args.ts` / `src/cli/network.ts` | L/R と旧 CLI の翻訳、共通一覧 |
| `src/ui/frontend/src/components/ports/` | 共通フォーム・一覧・方向と由来の表示 |

依存順は Task 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8。
実装段階では task 単位の検証とコミットを行い、途中の未接続 API を完成機能として案内しない。

## Task 1: 新旧設定の正規化と移行案内

**Files:**
- Create: `src/network/port_forward_model.ts`, `src/config/port_forwards.ts`, `src/config/port_forwards_test.ts`。
- Modify: `src/config/Schema.pkl`, `src/config/types.ts`, `src/config/validate.ts`, `src/config/load.ts`。
- Test: `src/config/validate_test.ts`, `src/config/pkl_integration_test.ts`, `src/config/load_integration_test.ts`。

**Interfaces:** 以下を純粋型・関数として追加する。legacy の正規化を済ませた配列を pipeline へ渡し、実行時に再び旧リストを加算しない。

```ts
export type ForwardDirection = "local" | "remote";
export type ForwardOwner = "config" | "dynamic" | "internal";
export interface PortPair {
  hostPort: number;
  containerPort: number;
}
export interface ForwardSpec extends PortPair {
  direction: ForwardDirection;
}
export interface InitialForward extends ForwardSpec {
  owners: ForwardOwner[];
}
export interface ForwardConfigInput {
  localForwards?: readonly PortPair[];
  remoteForwards?: readonly PortPair[];
  proxy?: { forwardPorts?: readonly number[] };
}
export interface ForwardConfigResult {
  entries: ForwardSpec[];
  errors: string[];
  warnings: string[];
}
export function forwardKey(spec: Pick<ForwardSpec, "direction" | "containerPort">): string {
  return `${spec.direction}:${spec.containerPort}`;
}
```

`normalizePortForwards(profileName: string, input: ForwardConfigInput, reservedPorts: readonly number[]): ForwardConfigResult` を `src/config/port_forwards.ts` で export する。

- [ ] 新旧併記の振舞いを示す unit test を追加する。最小例:

```ts
import { expect, test } from "bun:test";
import { normalizePortForwards } from "./port_forwards.ts";

test("legacy and remote config share one mapping and emit migration guidance", () => {
  const result = normalizePortForwards("dev", {
    localForwards: [{ hostPort: 8080, containerPort: 3000 }],
    remoteForwards: [{ hostPort: 5432, containerPort: 5432 }],
    proxy: { forwardPorts: [5432] },
  }, [18080]);
  expect(result.errors).toEqual([]);
  expect(result.entries).toEqual([
    { direction: "local", hostPort: 8080, containerPort: 3000 },
    { direction: "remote", hostPort: 5432, containerPort: 5432 },
  ]);
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings[0]).toContain("dev");
  expect(result.warnings[0]).toContain("network.remoteForwards");
});
```

- [ ] Pkl に `class PortForwardConfig { hostPort: Int; containerPort: Int }` と二つの `Listing<PortForwardConfig> = new {}` を追加。旧型・旧フィールドは保持する。TS defaults に空配列を追加する。
- [ ] 正規化は local、新 remote、旧 remote の順で走査し、方向付きキーで完全重複を吸収する。同じキーの異なる hostPort、local の同じ host listen、範囲外、remote の予約 listen は profile と項目を含む error にする。
- [ ] `validateConfig` のポート検証を正規化結果に切り替える。正常な profile に新配列を確定し、旧リストは互換入力として保持する。warn の表示は `loadConfig` の一回の評価結果から行い、validation の反復や UI poll では出さない。
- [ ] warn に全旧ポートの `remoteForwards { new PortForwardConfig { hostPort = N; containerPort = N } }` の置換例と `docs/migration/port-forwarding.md` を含める。新旧の重複後も旧リストが非空なら warn、空の旧デフォルトには warn なし。
- [ ] Pkl テストに旧 `new ProxyConfig`、新 `new PortForwardConfig`、型注釈なしの要素構築、global profile 継承を追加する。stderr の warn と JSON stdout の非混入は loader の subprocess 境界で検証する。
- [ ] `bun test src/config/port_forwards_test.ts src/config/validate_test.ts` → PASS。実 Pkl テストは最終 integration lane で実行。git-commit でこの task のファイルだけをコミットする。

## Task 2: broker の共通状態と所有理由

**Files:**
- Modify: `src/network/port_forward_model.ts`, `src/network/port_bind_protocol.ts`, `src/network/port_bind_broker.ts`, `src/network/port_bind_registry.ts`。
- Test: `src/network/port_forward_model_test.ts`（新規）, `src/network/port_bind_broker_test.ts`, `src/network/port_bind_registry_test.ts`。

**Interfaces:** 新 registry は `portForwards` を正本とし、旧 `bindings` / `forwards` は互換 projection とする。旧 registry は direction と dynamic owner を補って読む。

```ts
export type ForwardState = "pending" | "active" | "unavailable" | "failed";
export interface ManagedForward extends ForwardSpec {
  owners: ForwardOwner[];
  createdAt: string;
  state: ForwardState;
  error?: string;
}
export interface RemoveForwardResult {
  removed: boolean;
  retainedInternal: boolean;
  listenerClosed: boolean;
}
export interface AddForwardResult {
  entry: ManagedForward;
  probe: "ok" | "no-answer" | "container-not-running" | "relay-unreachable";
}
export function removeUserOwners(entry: ManagedForward): ManagedForward | null {
  const owners = entry.owners.filter((owner) => owner === "internal");
  return owners.length === 0 ? null : { ...entry, owners };
}
```

broker に `listPortForwards(): ManagedForward[]`、
`addPortForward(spec: ForwardSpec, owner: ForwardOwner): Promise<AddForwardResult>`、
`removePortForward(key: Pick<ForwardSpec, "direction" | "containerPort">): Promise<RemoveForwardResult>` を追加。
local の hostPort 自動選択は既存 `bind` adapter 内で解決し、確定した番号を共通処理へ渡す。
番号選択と実際の listener 確保は同じ直列化処理内で行い、空き確認後の bind に競合窓を作らない。
probe は転送先の一回の疎通結果で、listener の稼働状態とは独立させる。

- [ ] `removeUserOwners` の config/dynamic/internal の全組合せと、方向付きキーで逆方向を誤削除しない例を unit test にする。
- [ ] broker の既存 `mutationTail` に全変更を集める。gateway の `forwardTable` を別の望ましい状態として扱わず、broker の状態を通信側に反映する構造にする。
- [ ] 同じ対応への再追加は所有理由を追加するだけ。別 hostPort なら conflict。内部だけの対応のユーザー削除は `retainedInternal: true` とする。
- [ ] 追加時の永続化失敗は listener・許可表を巻き戻す。削除は許可を先に失効させる。保存失敗時は接続許可を復活させず error を返し、registry 再保存を試みる。registry だけを復旧の入力にしない。
- [ ] `sessionPortForwards(entry): ManagedForward[]` を protocol に追加し、新配列を優先、旧二配列を fallback とする。内部許可 token は registry に出力しない。
- [ ] candidate から active/pending remote listen と内部予約ポートを除外する。local/remote の転送グラフ内に閉路を作る追加は conflict にする。接続先サービスへの probe failure は conflict と混同しない。
- [ ] broker テストで同時追加、二重削除、保存失敗、config の一時削除、内部所有の保持を実 gateway fake で検証する。既存 socket/echo fixture の cleanup を保持する。
- [ ] `bun test src/network/port_forward_model_test.ts src/network/port_bind_broker_test.ts src/network/port_bind_registry_test.ts` → PASS、task commit。

## Task 3: relay の許可識別子と状態同期

**Files:**
- Modify: `src/network/port_bind_relay.ts`, `src/docker/embed/port-relay.mjs`, `src/network/port_bind_supervisor.ts`, `src/network/port_bind_broker.ts`。
- Test: `src/network/port_bind_relay_test.ts`, `src/docker/port_relay_test.ts`, `src/network/port_bind_supervisor_test.ts`。

**Interfaces:** 既存の port-only `client <port>` を新 relay では受理しない。
mapping token は 16 random bytes の hex、操作 request ID は既存の 8 random bytes の hex。
両者を混同しない。128 byte frame 上限は維持する。

```text
container -> host: control-v2
host -> container: forward <request-id> <mapping-token> <container-port>
host -> container: unforward <request-id> <mapping-token>
container -> host: ok <request-id>
container -> host: fail <request-id> <reason>
container -> host (new stream socket): client <mapping-token>
host -> container: initial-ready
host -> container: initial-failed <reason>
```

gateway の `forward(containerPort, hostPort)` は token を内部発行し、
`unforward(containerPort)` は許可と既存接続を先に失効させたうえで
`Promise<{ listenerClosed: boolean }>` を返す。
`startRelayGateway` に `onForwardState(containerPort, state, error?)` を追加。
`state` は Task 2 の `ForwardState`。broker は同じ直列化経路で registry を更新する。
callback は更新を queue に積んで戻り、gateway の ACK 処理内で broker mutation の完了を待たない。

- [ ] 既存実 relay fixture を拡張し、削除前の token を保持して、同じ port を再追加した後に古い token の stream が host echo に届かないテストを追加する。
- [ ] `forwardTable` を通信資源・現在の token の表に限定する。hostPort は表からだけ引き、コンテナ入力の数字を host dial に用いない。初期 listen ACK 前や削除中の token は拒否する。
- [ ] container relay の listener ごとに token を保持し、stream header に載せる。再接続・再作成時は古い token を廃棄する。host 側も token ごとに接続を追跡して削除時に両端を閉じる。
- [ ] 接続ごとの早期 bytes、half-close、失敗時の socket cleanup は既存実装を維持する。ACK timeout 時は対応を unavailable にし、遅れた ACK が active を復活させないよう request の世代を確認する。
- [ ] relay reconnect は broker から渡された現在の対応だけを再同期する。listen 失敗を log だけにせず `failed` と理由で通知する。失効済み対応は再送しない。
- [ ] supervisor の単一起動・cool-off を維持し、entrypoint の初期 relay が接続済みなら docker exec しない。初期起動中は readiness を待ち、同時に二つ起動しない。
- [ ] old control handshake は capability 不足として判別する。新 API を旧 broker へ送る場合の fallback は Task 5。新 host gateway が port-only remote client を受け付ける fallback は設けない。
- [ ] `bun test src/network/port_bind_relay_test.ts src/docker/port_relay_test.ts src/network/port_bind_supervisor_test.ts` → PASS。悪意ある header、別 gateway の token、保存失敗後の token、relay lost 後の削除も確認して commit。

## Task 4: config と内部転送を同じ起動ライフサイクルへ移す

**Files:**
- Modify: `src/stages/port_bind/stage.ts`, `src/stages/port_bind/port_bind_service.ts`, `src/stages/port_bind.ts`, `src/network/port_bind_broker.ts`。
- Modify: `src/stages/proxy/stage.ts`, `src/stages/proxy.ts`, `src/stages/dind/stage.ts`, `src/cli.ts`, `src/pipeline/types.ts`, `src/docker/embed/entrypoint.sh`, `src/docker/embed/local-proxy.mjs`。
- Modify: `src/stages/guide/facts.ts`, `src/stages/guide/content.ts`。
- Remove after callers migrate: `src/network/forward_port_relay.ts`, `src/stages/proxy/forward_port_relay_service.ts` と各専用テスト。
- Test: `src/stages/port_bind/stage_test.ts`, `src/stages/port_bind/port_bind_service_test.ts`（新規）, `src/stages/proxy/stage_test.ts`, `src/stages/dind/stage_test.ts`, `src/stages/observability/stage_test.ts`, `src/stages/guide/facts_test.ts`, `src/stages/guide/content_test.ts`。

**Interfaces:** `PortBindPlan` に `initialForwards: InitialForward[]` を追加する。
純粋関数 `buildInitialForwards(configured: readonly ForwardSpec[], receiverPort: number | null): InitialForward[]` を新規 `src/stages/port_bind/initial_forwards.ts` に置く。
同じキー・同じ port の config/internal を一つに結合し、異なる対応は例外。

```ts
test("the receiver retains internal ownership when also configured", () => {
  expect(buildInitialForwards([
    { direction: "remote", hostPort: 4318, containerPort: 4318 },
  ], 4318)).toEqual([
    {
      direction: "remote", hostPort: 4318, containerPort: 4318,
      owners: ["config", "internal"],
    },
  ]);
});
```

上の test は新規 `src/stages/port_bind/initial_forwards_test.ts` に置き、`bun:test` と隣接関数を import する。

- [ ] port stage が observability slice を受け、正規化済み config と receiverPort を initialForwards にする。pipeline builder は Observability → Proxy → DinD → PortBind → Launch を維持する。
- [ ] broker に `prepareInitial(entries: readonly InitialForward[]): Promise<void>` を追加。host listener は launch 前に確保し、remote は pending として保持する。この処理は docker exec を呼ばず、コンテナ起動を待たない。
- [ ] `PortBindService.start` で gateway、broker、初期状態を準備してから launch へ返す。初期化失敗は Effect の expected Error として戻し、`.orDie` で隠さない。stage cleanup は acquireRelease、内部 I/O は Ops seam へ分ける。
- [ ] 初期対応がある場合だけ `NAS_PORT_RELAY_STARTUP=1` と relay socket env を container plan に付ける。entrypoint は通常起動で relay を一度起動し、`--shell` では起動しない。
- [ ] relay に `--wait-initial` 起動モードを追加する。entrypoint はプロセスの専用 stdout pipe の一行 `ready` を、10 秒の上限付きで待つ。relay はホストから `initial-ready` を受けて初めて出力する。失敗・EOF・timeout は agent を実行せず非ゼロで終了する。成功後も relay を background で維持する。
- [ ] host は initial remote の ACK と永続化が全て成功してから `initial-ready` を送る。一件失敗なら初期資源を解放して `initial-failed` を返す。初期化中の UI mutation は明示的に拒否し、deadlock を作らない。
- [ ] proxy stage から port relay 起動・port 別 mount・旧 env を外す。local-proxy の固定 TCP listener ループを削除する。HTTP proxy 自体の挙動は変えない。
- [ ] DinD の予約ポート計算は新 remote の containerPort と内部 receiverPort に切り替える。プロセスが実際に使う予約と、ユーザー転送で確保するポートを区別し、初期 remote が自分自身を予約競合として拒否されないようにする。
- [ ] guide facts は新 remote の異番号対応を説明できる形にする。旧 NAS_FORWARD_PORTS に依存する stage tests と observability/proxy の integration assertion を、新しい port stage の初期対応へ移す。
- [ ] `rg -n 'ForwardPortRelayService|forwardPortSocketPath|NAS_FORWARD_PORTS|NAS_FORWARD_PORT_SOCKET_DIR' src` で廃止経路の参照を確認し、移行済み専用ファイル・barrel・Layer 登録を削除する。旧 config の `forwardPorts` は削除しない。
- [ ] `bun test src/stages/port_bind/initial_forwards_test.ts src/stages/port_bind/stage_test.ts src/stages/port_bind/port_bind_service_test.ts src/stages/proxy/stage_test.ts src/stages/dind/stage_test.ts src/stages/observability/stage_test.ts src/stages/guide/facts_test.ts src/stages/guide/content_test.ts` → PASS、`bun run check` → PASS、commit。

## Task 5: CLI/UI 共通 service と旧 API の互換

**Files:**
- Modify: `src/domain/port_bind/service.ts`, `src/domain/port_bind/types.ts`, `src/domain/port_bind.ts`, `src/network/port_bind_protocol.ts`, `src/network/port_bind_broker.ts`, `src/ui/data.ts`, `src/ui/routes/api.ts`, `src/ui/routes/with_error_handling.ts`。
- Test: `src/domain/port_bind/service_test.ts`, `src/ui/routes/api_integration_test.ts`, `src/ui/routes/with_error_handling_test.ts`。

**Interfaces:** 共通 request 型を `port_forward_model.ts` に追加し、wire で owner を入力させない。

```ts
export type AddForwardRequest =
  | { direction: "local"; containerPort: number; hostPort: number | null }
  | { direction: "remote"; containerPort: number; hostPort: number };
export type ForwardSelector =
  | { direction: "local"; hostPort: number }
  | { direction: "local"; containerPort: number }
  | { direction: "remote"; containerPort: number };
```

domain client に `add(paths, sessionId, request): Promise<AddForwardResult>` と
`remove(paths, sessionId, selector): Promise<RemoveForwardResult>` を追加。
Tag 側も同じ引数で、それぞれ `Effect.Effect<AddForwardResult, Error>` と
`Effect.Effect<RemoveForwardResult, Error>` を返す。
既存 `bind/forward/unbindByKey/unforward` は互換 adapter として維持する。

- [ ] host 専用 control request に `add-forward` / `remove-forward` を追加し、strict な request shape 検査を行う。origin/internal owner の入力は拒否する。
- [ ] API `POST /api/network/port-forwards` を追加（body は sessionId + AddForwardRequest）、`POST /api/network/port-forwards/remove` は sessionId + ForwardSelector。旧 endpoints は残して同じ domain service へ渡す。
- [ ] registry の protocol version を新規書込みに付ける。旧 entry は既存 bind/forward wire へ翻訳する。旧 broker が持たない操作は session restart が必要と明示し、単に成功扱いしない。
- [ ] 旧 `unbind <hostPort>` の全 session 検索は local だけを見る。新 `remove` の local hostPort selector は必ず session 内に限定する。
- [ ] L2 の I/O は現行 socket helpers または注入可能な Ops に委ね、CLI/UI に直接 socket・Docker 呼出しを足さない。Error unwrap と typed HTTP mapping を維持する。
- [ ] fake service 経由で retainedInternal/listenerClosed を落とさず返す test、invalid body、legacy fallback、remote port conflict、JSON の direction/owners/state を検証する。
- [ ] `bun test src/domain/port_bind/service_test.ts src/ui/routes/with_error_handling_test.ts` → PASS。API integration は最終 suite で実行する。`bun run check` → PASS、commit。

## Task 6: SSH と同じ L/R の CLI

**Files:**
- Modify: `src/cli/port_bind_args.ts`, `src/cli/network.ts`, `src/cli/usage.ts`。
- Test: `src/cli/port_bind_args_test.ts`, `src/cli/network_test.ts`。

**Interfaces:** `parseSshForwardArgs(args: string[], operation: "bind" | "unbind")` を追加する。
L/R がなければ null、新構文なら下記の union を返し、壊れた L/R 入力は例外とする。

```ts
export type ParsedSshForward =
  | { operation: "bind"; sessionId: string; request: AddForwardRequest }
  | { operation: "unbind"; sessionId: string; selector: ForwardSelector };
```

- [ ] 異番号の parser test を追加する。

```ts
test("L and R map listen:target to opposite endpoint fields", () => {
  expect(parseSshForwardArgs(["session", "-L", "8080:3000"], "bind"))
    .toEqual({ operation: "bind", sessionId: "session",
      request: { direction: "local", hostPort: 8080, containerPort: 3000 } });
  expect(parseSshForwardArgs(["session", "-R", "15432:5432"], "bind"))
    .toEqual({ operation: "bind", sessionId: "session",
      request: { direction: "remote", hostPort: 5432, containerPort: 15432 } });
  expect(parseSshForwardArgs(["session", "-L", "8080"], "unbind"))
    .toEqual({ operation: "unbind", sessionId: "session",
      selector: { direction: "local", hostPort: 8080 } });
});
```

- [ ] long option 名と flags の前後配置を処理し、既存 runtime-dir/format/verbosity を維持する。重複 L/R、同時指定、空の値、0/65536、追加 positionals、旧 session:port と L/R の混在を拒否する。
- [ ] `network.ts` では新 parser を既存 session-only candidate parser より先に呼ぶ。新構文は Task 5 の add/remove、既存構文は互換 adapter へ渡す。
- [ ] 引数なし bind の text/JSON 一覧を両方向にし、sessionId、両ポート、direction、owners、state、age を出す。旧 forward の一覧・候補表示は remote に絞る既存動作を維持する。
- [ ] unbind の引数なし picker は方向付きの共通一覧を使い、local hostPort と remote containerPort で削除する。retainedInternal と listenerClosed=false を出力し、物理 listener が消えたと誤報しない。
- [ ] usage と examples に L/R を載せ、互換コマンドも記載する。旧 CLI に新たな非推奨 warn は追加しない（warn 対象は旧 config）。
- [ ] `bun test src/cli/port_bind_args_test.ts src/cli/network_test.ts` → PASS、commit。

## Task 7: 両方向の UI を一つのフォームと一覧へ

**Files:**
- Modify: `src/ui/frontend/src/components/ports/PortBindingsPanel.tsx`, `src/ui/frontend/src/components/ports/PortForwardsPanel.tsx`, `src/ui/frontend/src/api/client.ts`, `src/ui/frontend/src/stores/types.ts`, `src/ui/routes/sse_diff.ts`。
- Create: `src/ui/frontend/src/components/ports/portForwardView.ts`, `src/ui/frontend/src/components/ports/portForwardView_test.ts`。
- Test: `src/ui/frontend/src/api/client_test.ts`, `src/ui/routes/sse_diff_test.ts`。
- Modify: `src/ui/frontend/src/components/PendingPane.tsx`。一つの共通 Ports panel を mount し、全 caller の移行後に `PortForwardsPanel.tsx` を削除する。

**Interfaces:** `PortBindSessionLike` に Task 2 の共通 projection を加える。
view helper `forwardRow(entry: ManagedForward)` は directionLabel、listenLabel、targetLabel、href（local のみ）、ownerLabel、stateLabel を返す。origin/state を UI で再推測しない。

```ts
test("only local forwarding links to the host browser", () => {
  const base = { hostPort: 8080, containerPort: 3000,
    owners: ["config"] as ForwardOwner[], createdAt: "2026-09-08T00:00:00Z",
    state: "active" as const };
  expect(forwardRow({ ...base, direction: "local" }).href)
    .toBe("http://localhost:8080");
  expect(forwardRow({ ...base, direction: "remote" }).href).toBeNull();
});
```

- [ ] direction selector を `Local (host → container)` / `Remote (container → host)` とし、hostPort/containerPort 入力を表示する。local の hostPort 省略は既存自動割当を使い、remote は両番号を要求する。
- [ ] 共通 endpoints を呼ぶ client 関数を追加し、request body と error の test を書く。旧 client 関数は旧 component がなくなるまで互換で残す。
- [ ] 一覧に方向、両ポート、由来、状態を表示する。internal-only の削除を無効にし、複数所有の場合はユーザー所有分だけ削除できる。unavailable/failed と probe no-answer を区別する。
- [ ] listener 候補 poll は Local を選んでいる時だけ行い、remote listen の自己候補を表示しない。切替・セッション変更で古い非同期結果を無視する。
- [ ] SSE projection に state と owner の変更を含める。旧 registry を読み込んだ snapshot でも fallback 表示できることを検証する。
- [ ] `bun test src/ui/frontend/src/components/ports/portForwardView_test.ts src/ui/frontend/src/api/client_test.ts src/ui/routes/sse_diff_test.ts` と `bun run build-ui` → PASS、commit。実ブラウザで両方向の追加・削除・session 切替を Task 8 で確認する。

## Task 8: 実経路の検証と利用者向け移行ガイド

**Files:**
- Modify: `src/stages/port_bind/integration_test.ts`, `src/stages/observability/integration_test.ts`, `src/docker/local_proxy_integration_test.ts`, `src/stages/launch/integration_test.ts`。
- Create: `docs/migration/port-forwarding.md`。
- Modify: `docs-site/src/content/docs/configuration/host-services.md`, `docs-site/src/content/docs/work/preview.md`, `docs-site/src/content/docs/configuration/network.md`, `docs-site/src/content/docs/work/troubleshooting.md`。

**Interfaces:** 公開設定例と CLI は Tasks 1/6 の確定した構文だけを使用する。内部 wire 名は利用者ガイドへ載せない。

- [ ] 実 Docker fixture に両方向の echo を追加する。ホスト/コンテナそれぞれ `127.0.0.1` だけで待受し、異番号対応で bytes を往復させる。固定名資源を使わず、全 socket/process/container を finally で閉じる。
- [ ] 初期 config が空の起動後に L/R を追加し、同じ container ID のまま使えることを確認する。config ありでは agent の最初の接続が成功し、使用中の remote listen を指定した起動では agent の副作用が発生しないことを確認する。
- [ ] config の削除後に relay を再起動して転送が戻らないこと、新しいセッションでは config が再適用されることを確認する。内部 receiver の config 共有を削除しても履歴が届くケースを追加する。
- [ ] 転送先未起動、切断中の remove、初期 ACK timeout、listener 競合、stale token の拒否を既存 integration fixture に組み込む。unit と重複する parser case は増やさない。
- [ ] 移行ガイドに旧 `proxy.forwardPorts { 5432 }` → 新 `remoteForwards` の Pkl、Local の起動時設定、L/R の実行中操作、config 削除がそのセッション限りであることを載せる。warn の案内と完全に一致させる。
- [ ] ホストサービスと preview の各ガイドを更新し、旧「config 転送は UI に出ず削除できない」を削除する。新 UI の Local/Remote 表記と CLI 引数順を揃える。
- [ ] playwright-cli スキルで実ブラウザを確認する。Local の host リンク、Remote にリンクがないこと、異番号、削除、内部共有の説明、state 更新、session 切替を操作する。スクリーンショットは検証用とし、依頼のない添付ファイルは成果物へ混ぜない。
- [ ] 最終確認を順に実行: `bun run fmt` → `bun run lint` → `bun run check` → `bun run build-ui` → `bun run docs:check` → `bun run docs:build` → `bun run test`（全 suite は一度）。失敗は原因を修正して失敗対象だけ再検証する。fmt が無関係の既存差分を生んだら task の成果物に混ぜない。
- [ ] 各検証の exit code、pass/fail/skip、Docker imageBuildable 等の理由を ledger へ記録する。外部条件で未検証のケースは明示し、全経路が確認済みと表現しない。
- [ ] docs と検証追加を commit。implementation-base から全体 code review を実行し、patched-superpowers の Forgejo 人間レビューへ進む。レビュー承認前に integration 完了・タスク全体完了としない。

## Self-review / acceptance mapping

| 承認済み要件 | Task |
| --- | --- |
| 両方向 config、旧 schema、warn、Pkl 継承 | 1, 4, 8 |
| config/dynamic/internal 共通管理、一時削除 | 2, 4 |
| UDS 境界、許可 token、削除・再接続 | 3 |
| 初期 readiness、履歴 receiver、reserved ports | 4, 8 |
| 旧 broker/registry/CLI の互換 | 2, 5, 6 |
| SSH の L/R、待受:転送先、Local/Remote UI | 6, 7 |
| 失敗・競合・JSON・SSE の状態一致 | 2, 3, 5, 7 |
| Docker の実経路・browser・ガイド | 8 |

## Review status

設計: ユーザー承認済み。計画: レビュー待ち。実装: 未着手。
