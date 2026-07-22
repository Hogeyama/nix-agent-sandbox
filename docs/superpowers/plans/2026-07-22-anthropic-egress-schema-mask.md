# Anthropic egress スキーマ認識マスク Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** api.anthropic.com へのリクエストボディを JSON スキーマ認識でマスクし、理解できない構造をフェイルクローズドで遮断する。opt-in フラグ `anthropicEgress` で有効化し、非 Claude エージェントで有効化した場合は設定検証でエラーにする。

**Architecture:** マスクロジックは mitmproxy addon（`src/docker/mitmproxy/nas_addon.py`、単一ファイル）内の純粋関数に閉じる。既知の JSON エンドポイント（`/v1/messages`、`/v1/messages/count_tokens`）は、パース済み JSON を再帰走査して全文字列をパターンマスクし、base64 blob はデコードして走査、既知コンテンツコンテナ内の未知ブロック型は遮断する。有効化は config フラグ `MaskConfig.anthropicEgress` で行い、config → proxy stage → セッションレジストリ経由で addon に伝達する（`agent` と同じ経路）。既存の `_build_mask_patterns` / `_mask_bytes` と broker 供給の `maskValues` を流用する。

**Tech Stack:** Python 3（addon）、Python `unittest`（`nas_addon_mask_test.py` + mitmproxy stub）、Pkl（`Schema.pkl` 設定）、TypeScript/Effect（config 型・検証・レジストリ伝達）、Bun test（TS 単体・統合、実 mitmproxy コンテナ）。

**Why — なぜこのアプローチを選んだか:**
egress（api.anthropic.com）はエージェントが何を経由してシークレットを読んでも必ず通過する唯一の完全なチョークポイントであり、取り込み側（Read/`@file`/MCP）を個別に塞ぐより完全性が高い。宛先が構造化 JSON で秘密値も既知のため、パース → 全文字列走査 → base64 blob デコード → 未知構造は遮断、という「アローリスト＋フェイルクローズド」で、現行 proxy のバイト列総当たりが取りこぼすアプリ層エンコードを塞げる。マスクロジックを addon 内に閉じることで変更面を最小化し、config フラグは既存の `agent` 伝達経路（config → stage → registry）を流用する。この保護は Claude 専用のため、非 Claude で有効化したら「保護しているつもりで無防備」を避けるべく検証で明示エラーに倒す。

**Why Not — なぜ他の案を選ばなかったか:**
- **案 B: 取り込み側フック（Read の PreToolUse マスク）** — `@file` はツール呼び出しでなくクライアント側展開のためフックが介入できず、MCP・将来機能も取りこぼす。完全性を担保できない。
- **案 C: spec の「JSON パス単位 content/control 表」を厳密実装** — 分類表は保守面が広い。全文字列を一律マスクしてもマスクは既知シークレット値にしか作用せず非シークレットを壊さないため安全であり、既存パターン集合が url/base64 変種を含むので分類表なしでも捕捉できる。保守対象を「既知ブロック型集合」に縮約できる本案を選んだ。
- **案 D: 未知ベータを一律遮断（spec 記載）** — 制御専用ベータ（fast-mode 等）まで遮断しセッションを壊す。コンテンツ搬送面の追加はブロック型チェックが捕捉し、既存パターンが base64 変種を含むため、未知ベータは log のみとする。
- **案 E: 非 Claude で無効化して黙って通す** — 「保護しているつもりで無防備」の false security を生む。ユーザー選択により、有効化 + 非 Claude は検証エラーにする。

## Global Constraints

- 実装者・レビュアーは着手前に次のスキルを読む: `security-constraints`（S1/C1）、`test-policy`（分類・命名・cleanup）、`effect-separation`（Task 5/6 の TS/Effect 変更に適用。stage は I/O を直書きせずサービス経由）。
- ランタイムは Bun。テストは `bun test`。型チェックは `bun run check`。Python 純粋関数テストは `nas_addon_mask_test.py` に追加し、TS ラッパー `nas_addon_test.ts` 経由で `bun test` から実行される。
- addon は単一ファイル `src/docker/mitmproxy/nas_addon.py`。**Python モジュール分割をしない**（materialize 機構の変更を避ける）。
- シークレット値の解決はホスト側のみ（S1）。addon はスキーマ表（静的な既知ブロック型集合）のみをベイクインし、秘密値は broker decision の `maskValues` から受け取る。
- config フラグ `MaskConfig.anthropicEgress` はデフォルト `false`。addon は `SessionRegistryEntry.anthropicEgress` が true のときのみスキーマパスを発動する。false/未設定なら Anthropic ホストにも現行の汎用 `_apply_request_masking` を適用（現行挙動を維持）。
- 既存の非 Anthropic ホストのマスク挙動を変更・退行させない。
- **本プランの検討点（spec からの意図的な簡素化・逸脱、diffity レビューで確認済み）:** (1) 分類表を「全文字列マスク + 既知ブロック型集合 + base64 blob デコード」に簡素化。(2) 未知ベータは log のみ。(3) フェイルクローズド = 403 のみ（人間判断経路は follow-up）。(4) スキーマ対象は `/v1/messages`・`/v1/messages/count_tokens` のみ（files 他は 403、files 対応は follow-up）。

---

### Task 1: Anthropic ホスト判定とエンドポイントルーティング

**Files:**
- Modify: `src/docker/mitmproxy/nas_addon.py`（`_normalize_host` の後に新セクション）
- Test: `src/docker/mitmproxy/nas_addon_mask_test.py`

**Interfaces:**
- Consumes: 既存 `_normalize_host(host: str) -> str`
- Produces: `_is_anthropic_host(host: str) -> bool`、`_anthropic_json_endpoint(method: str, path: str) -> Optional[str]`（既知 JSON エンドポイントなら `"messages"`、他は `None`）

- [ ] **Step 1: 失敗するテストを書く**

`nas_addon_mask_test.py` の `unittest.main()` の前に追加:

```python
class TestAnthropicRouting(unittest.TestCase):
    def test_is_anthropic_host(self):
        self.assertTrue(nas_addon._is_anthropic_host("api.anthropic.com"))
        self.assertTrue(nas_addon._is_anthropic_host("API.ANTHROPIC.COM"))
        self.assertFalse(nas_addon._is_anthropic_host("example.com"))
        self.assertFalse(nas_addon._is_anthropic_host("evil-anthropic.com"))

    def test_known_json_endpoints(self):
        self.assertEqual(nas_addon._anthropic_json_endpoint("POST", "/v1/messages"), "messages")
        self.assertEqual(nas_addon._anthropic_json_endpoint("POST", "/v1/messages/count_tokens"), "messages")
        self.assertEqual(nas_addon._anthropic_json_endpoint("POST", "/v1/messages?beta=true"), "messages")
        self.assertEqual(nas_addon._anthropic_json_endpoint("POST", "/v1/messages/"), "messages")

    def test_unknown_endpoints_return_none(self):
        self.assertIsNone(nas_addon._anthropic_json_endpoint("POST", "/v1/files"))
        self.assertIsNone(nas_addon._anthropic_json_endpoint("GET", "/v1/messages"))
        self.assertIsNone(nas_addon._anthropic_json_endpoint("POST", "/v1/models"))
```

- [ ] **Step 2: テスト失敗を確認**

Run: `cd src/docker/mitmproxy && PYTHONPATH=testdata/mitmproxy_stub python3 nas_addon_mask_test.py -v`
Expected: FAIL — `AttributeError: module 'nas_addon' has no attribute '_is_anthropic_host'`

- [ ] **Step 3: 最小実装を書く**

`src/docker/mitmproxy/nas_addon.py`（`_normalize_host` 定義後）:

```python
_ANTHROPIC_HOSTS = ("api.anthropic.com",)


def _is_anthropic_host(host: str) -> bool:
    return _normalize_host(host) in _ANTHROPIC_HOSTS


def _anthropic_json_endpoint(method: str, path: str) -> Optional[str]:
    """既知の JSON リクエストエンドポイントなら schema キーを返す。他は None。"""
    if method != "POST":
        return None
    p = path.split("?", 1)[0].rstrip("/")
    if p in ("/v1/messages", "/v1/messages/count_tokens"):
        return "messages"
    return None
```

- [ ] **Step 4: テスト成功を確認**

Run: `cd src/docker/mitmproxy && PYTHONPATH=testdata/mitmproxy_stub python3 nas_addon_mask_test.py -v`
Expected: PASS（`TestAnthropicRouting`）

- [ ] **Step 5: コミット**

```bash
git add src/docker/mitmproxy/nas_addon.py src/docker/mitmproxy/nas_addon_mask_test.py
git commit -m "feat(network): add Anthropic host and JSON endpoint routing"
```

---

### Task 2: スキーマ走査（マスク + base64 デコード + 未知ブロック型検知）

**Files:**
- Modify: `src/docker/mitmproxy/nas_addon.py`（Task 1 のセクションに続けて）
- Test: `src/docker/mitmproxy/nas_addon_mask_test.py`

**Interfaces:**
- Consumes: 既存 `_mask_bytes(data, patterns)`、`_build_mask_patterns(mask_values)`
- Produces: 定数 `_KNOWN_BLOCK_TYPES: frozenset[str]`、`_schema_mask_json(body: bytes, patterns: list) -> tuple[Optional[bytes], bool]`（`(masked_body, blocked)`、変更なしは `masked_body=None`、`blocked=True` はフェイルクローズド）

- [ ] **Step 1: 失敗するテストを書く**

`nas_addon_mask_test.py` に追加:

```python
class TestSchemaMask(unittest.TestCase):
    def setUp(self):
        self.patterns = nas_addon._build_mask_patterns(["SECRET123"])

    def _mask(self, obj):
        import json
        return nas_addon._schema_mask_json(json.dumps(obj).encode("utf-8"), self.patterns)

    def test_masks_text_block(self):
        body, blocked = self._mask({"model": "m", "messages": [
            {"role": "user", "content": [{"type": "text", "text": "key is SECRET123 ok"}]}]})
        self.assertFalse(blocked)
        self.assertIn(b"****", body)
        self.assertNotIn(b"SECRET123", body)

    def test_masks_system_string(self):
        body, blocked = self._mask({"model": "m", "system": "token SECRET123",
            "messages": [{"role": "user", "content": "hi"}]})
        self.assertFalse(blocked)
        self.assertNotIn(b"SECRET123", body)

    def test_masks_base64_blob(self):
        import base64, json
        blob = base64.b64encode(b"prefix SECRET123 suffix").decode()
        body, blocked = self._mask({"model": "m", "messages": [{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": blob}}]}]})
        self.assertFalse(blocked)
        parsed = json.loads(body)
        decoded = base64.b64decode(parsed["messages"][0]["content"][0]["source"]["data"])
        self.assertNotIn(b"SECRET123", decoded)

    def test_masks_nested_tool_result(self):
        body, blocked = self._mask({"model": "m", "messages": [{"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "t1",
             "content": [{"type": "text", "text": "out SECRET123"}]}]}]})
        self.assertFalse(blocked)
        self.assertNotIn(b"SECRET123", body)

    def test_unknown_block_type_blocks(self):
        body, blocked = self._mask({"model": "m", "messages": [{"role": "user", "content": [
            {"type": "quantum_payload", "data": "x"}]}]})
        self.assertTrue(blocked)
        self.assertIsNone(body)

    def test_unknown_toplevel_field_passes(self):
        body, blocked = self._mask({"model": "m", "future_param": {"nested": "SECRET123"},
            "messages": [{"role": "user", "content": "hi"}]})
        self.assertFalse(blocked)
        self.assertNotIn(b"SECRET123", body)

    def test_tools_type_not_block_checked(self):
        body, blocked = self._mask({"model": "m",
            "tools": [{"type": "bash_20250124", "name": "bash"}],
            "messages": [{"role": "user", "content": "hi"}]})
        self.assertFalse(blocked)

    def test_no_secret_returns_unchanged(self):
        body, blocked = self._mask({"model": "m", "messages": [{"role": "user", "content": "clean"}]})
        self.assertFalse(blocked)
        self.assertIsNone(body)

    def test_unparseable_body_blocks(self):
        body, blocked = nas_addon._schema_mask_json(b"{not json", self.patterns)
        self.assertTrue(blocked)
        self.assertIsNone(body)

    def test_empty_body_passthrough(self):
        body, blocked = nas_addon._schema_mask_json(b"", self.patterns)
        self.assertFalse(blocked)
        self.assertIsNone(body)
```

- [ ] **Step 2: テスト失敗を確認**

Run: `cd src/docker/mitmproxy && PYTHONPATH=testdata/mitmproxy_stub python3 nas_addon_mask_test.py -v`
Expected: FAIL — `AttributeError: ... '_schema_mask_json'`

- [ ] **Step 3: 最小実装を書く**

`src/docker/mitmproxy/nas_addon.py` に追加（冒頭 import に `json`・`base64` があることを確認、無ければ追加）:

```python
# コンテンツコンテナ内で許可するブロック型。ここに無い type が
# system / *.content 直下に現れたらフェイルクローズドする。
# 維持トリガー: Anthropic が新しいコンテンツブロック型を出荷したとき。
_KNOWN_BLOCK_TYPES = frozenset({
    "text", "image", "document", "thinking", "redacted_thinking",
    "tool_use", "tool_result", "server_tool_use",
    "web_search_tool_result", "code_execution_tool_result",
    "mcp_tool_use", "mcp_tool_result", "search_result",
    "container_upload", "fallback",
})

# この名前のキー直下の list を「ブロックリスト」とみなし type を検証する。
_BLOCK_LIST_KEYS = frozenset({"content", "system"})


def _walk_schema(node, parent_key, patterns):
    """(masked_node, changed, blocked) を返す。文字列はパターンマスク、
    base64 source はデコードして走査、ブロックリスト内の未知 type は blocked。"""
    if isinstance(node, dict):
        changed = False
        blocked = False
        working = node
        if node.get("type") == "base64" and isinstance(node.get("data"), str):
            try:
                decoded = base64.b64decode(node["data"], validate=False)
            except Exception:
                decoded = None
            if decoded is not None:
                masked_blob = _mask_bytes(decoded, patterns)
                if masked_blob != decoded:
                    working = dict(node)
                    working["data"] = base64.b64encode(masked_blob).decode("ascii")
                    changed = True
        new_node = {}
        for k, v in working.items():
            nv, ch, bl = _walk_schema(v, k, patterns)
            new_node[k] = nv
            changed = changed or ch
            blocked = blocked or bl
        return new_node, changed, blocked
    if isinstance(node, list):
        changed = False
        blocked = False
        is_block_list = parent_key in _BLOCK_LIST_KEYS
        new_list = []
        for item in node:
            if is_block_list and isinstance(item, dict):
                t = item.get("type")
                if t is not None and t not in _KNOWN_BLOCK_TYPES:
                    blocked = True
            nv, ch, bl = _walk_schema(item, None, patterns)
            new_list.append(nv)
            changed = changed or ch
            blocked = blocked or bl
        return new_list, changed, blocked
    if isinstance(node, str):
        masked = _mask_bytes(
            node.encode("utf-8", "surrogatepass"), patterns
        ).decode("utf-8", "surrogatepass")
        if masked != node:
            return masked, True, False
        return node, False, False
    return node, False, False


def _schema_mask_json(body: bytes, patterns: list) -> tuple:
    """(masked_body|None, blocked) を返す。"""
    if not body:
        return None, False
    try:
        parsed = json.loads(body)
    except (json.JSONDecodeError, ValueError):
        return None, True
    masked, changed, blocked = _walk_schema(parsed, None, patterns)
    if blocked:
        return None, True
    if not changed:
        return None, False
    return json.dumps(masked, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), False
```

- [ ] **Step 4: テスト成功を確認**

Run: `cd src/docker/mitmproxy && PYTHONPATH=testdata/mitmproxy_stub python3 nas_addon_mask_test.py -v`
Expected: PASS（`TestSchemaMask`）

- [ ] **Step 5: コミット**

```bash
git add src/docker/mitmproxy/nas_addon.py src/docker/mitmproxy/nas_addon_mask_test.py
git commit -m "feat(network): add schema-aware JSON masking walker"
```

---

### Task 3: Anthropic マスク方針の純粋プランナー

**Files:**
- Modify: `src/docker/mitmproxy/nas_addon.py`（Task 2 のセクションに続けて）
- Test: `src/docker/mitmproxy/nas_addon_mask_test.py`

**Interfaces:**
- Consumes: `_anthropic_json_endpoint`、`_schema_mask_json`
- Produces: `_plan_anthropic_masking(method, path, body, patterns) -> tuple[str, Optional[bytes]]`（`action` は `"block"`/`"rewrite"`/`"passthrough"`。`body=None` は `"block"`）

- [ ] **Step 1: 失敗するテストを書く**

`nas_addon_mask_test.py` に追加:

```python
class TestAnthropicPlan(unittest.TestCase):
    def setUp(self):
        self.patterns = nas_addon._build_mask_patterns(["SECRET123"])

    def test_unknown_path_blocks(self):
        action, out = nas_addon._plan_anthropic_masking("POST", "/v1/files", b"{}", self.patterns)
        self.assertEqual(action, "block")
        self.assertIsNone(out)

    def test_undecodable_body_blocks(self):
        action, out = nas_addon._plan_anthropic_masking("POST", "/v1/messages", None, self.patterns)
        self.assertEqual(action, "block")

    def test_secret_rewrites(self):
        import json
        body = json.dumps({"model": "m", "messages": [{"role": "user", "content": "SECRET123"}]}).encode()
        action, out = nas_addon._plan_anthropic_masking("POST", "/v1/messages", body, self.patterns)
        self.assertEqual(action, "rewrite")
        self.assertNotIn(b"SECRET123", out)

    def test_clean_passthrough(self):
        import json
        body = json.dumps({"model": "m", "messages": [{"role": "user", "content": "clean"}]}).encode()
        action, out = nas_addon._plan_anthropic_masking("POST", "/v1/messages", body, self.patterns)
        self.assertEqual(action, "passthrough")
        self.assertIsNone(out)

    def test_unknown_block_blocks(self):
        import json
        body = json.dumps({"model": "m", "messages": [
            {"role": "user", "content": [{"type": "quantum", "x": 1}]}]}).encode()
        action, out = nas_addon._plan_anthropic_masking("POST", "/v1/messages", body, self.patterns)
        self.assertEqual(action, "block")
```

- [ ] **Step 2: テスト失敗を確認**

Run: `cd src/docker/mitmproxy && PYTHONPATH=testdata/mitmproxy_stub python3 nas_addon_mask_test.py -v`
Expected: FAIL — `AttributeError: ... '_plan_anthropic_masking'`

- [ ] **Step 3: 最小実装を書く**

`src/docker/mitmproxy/nas_addon.py` に追加:

```python
def _plan_anthropic_masking(method, path, body, patterns):
    """(action, masked_body) を返す。action は 'block'/'rewrite'/'passthrough'。"""
    if _anthropic_json_endpoint(method, path) is None:
        return "block", None
    if body is None:
        return "block", None
    masked, blocked = _schema_mask_json(body, patterns)
    if blocked:
        return "block", None
    if masked is None:
        return "passthrough", None
    return "rewrite", masked
```

- [ ] **Step 4: テスト成功を確認**

Run: `cd src/docker/mitmproxy && PYTHONPATH=testdata/mitmproxy_stub python3 nas_addon_mask_test.py -v`
Expected: PASS（`TestAnthropicPlan`）

- [ ] **Step 5: コミット**

```bash
git add src/docker/mitmproxy/nas_addon.py src/docker/mitmproxy/nas_addon_mask_test.py
git commit -m "feat(network): add Anthropic masking planner"
```

---

### Task 4: Config フラグと検証

**Files:**
- Modify: `src/config/Schema.pkl`（`class MaskConfig`、`filter` の後）
- Modify: `src/config/types.ts`（`interface MaskConfig`）
- Modify: `src/config/validate.ts`（mask boolean 検証の後、現行 118 行付近）
- Test: `src/config/validate_mask_test.ts`

**Interfaces:**
- Consumes: 既存 `Profile`（`profile.agent: AgentType`、`profile.mask: MaskConfig`）、検証ループ内の `name`
- Produces: `MaskConfig.anthropicEgress: boolean`（デフォルト false）と3つの検証ルール

- [ ] **Step 1: 失敗するテストを書く**

`src/config/validate_mask_test.ts` に追加（既存のプロファイル fixture 構築に合わせる。`mask` に `anthropicEgress` を含める）:

```typescript
test("anthropicEgress must be boolean", () => {
  const errors = validateConfig(makeConfig({
    profiles: { p: makeProfile({ agent: "claude",
      mask: makeMask({ proxy: true, anthropicEgress: "yes" as unknown as boolean }) }) },
  }));
  expect(errors.some((e) => e.includes("mask.anthropicEgress must be a boolean"))).toBe(true);
});

test("anthropicEgress requires claude agent", () => {
  const errors = validateConfig(makeConfig({
    profiles: { p: makeProfile({ agent: "copilot",
      mask: makeMask({ proxy: true, anthropicEgress: true }) }) },
  }));
  expect(errors.some((e) => e.includes('requires agent "claude"'))).toBe(true);
});

test("anthropicEgress requires proxy", () => {
  const errors = validateConfig(makeConfig({
    profiles: { p: makeProfile({ agent: "claude",
      mask: makeMask({ proxy: false, anthropicEgress: true }) }) },
  }));
  expect(errors.some((e) => e.includes("requires mask.proxy"))).toBe(true);
});

test("anthropicEgress valid for claude + proxy", () => {
  const errors = validateConfig(makeConfig({
    profiles: { p: makeProfile({ agent: "claude",
      mask: makeMask({ proxy: true, anthropicEgress: true }) }) },
  }));
  expect(errors.filter((e) => e.includes("anthropicEgress"))).toEqual([]);
});
```

（`makeConfig`/`makeProfile`/`makeMask` はこのテストファイルの既存ヘルパに合わせる。既存ヘルパが `anthropicEgress` を受けない場合は、mask fixture のデフォルトに `anthropicEgress: false` を足す。）

- [ ] **Step 2: テスト失敗を確認**

Run: `bun test src/config/validate_mask_test.ts`
Expected: FAIL（検証ルール未実装 + 型エラー）

- [ ] **Step 3: 最小実装を書く**

`src/config/Schema.pkl` の `class MaskConfig`、`filter` フィールドの後に追加:

```
  /// api.anthropic.com への egress を JSON スキーマ認識でマスクする。
  /// Claude 専用。true かつ agent が claude 以外、または proxy が false の
  /// ときは設定検証でエラーになる。
  anthropicEgress: Boolean = false
```

`src/config/types.ts` の `interface MaskConfig` に追加:

```typescript
  /** api.anthropic.com egress のスキーマ認識マスク有効化。デフォルト false */
  anthropicEgress: boolean;
```

`src/config/validate.ts`、mask boolean 検証（現行 `filter` チェックの後、118 行付近）に追加:

```typescript
    if (typeof profile.mask.anthropicEgress !== "boolean") {
      errors.push(`profile "${name}": mask.anthropicEgress must be a boolean`);
    }
    if (profile.mask.anthropicEgress === true) {
      if (profile.agent !== "claude") {
        errors.push(
          `profile "${name}": mask.anthropicEgress requires agent "claude" ` +
            `(got "${profile.agent}"); this protection only covers ` +
            `api.anthropic.com traffic`,
        );
      }
      if (profile.mask.proxy !== true) {
        errors.push(
          `profile "${name}": mask.anthropicEgress requires mask.proxy to be ` +
            `true (it runs in the mitmproxy addon)`,
        );
      }
    }
```

- [ ] **Step 4: テストと型チェック成功を確認**

Run: `bun test src/config/validate_mask_test.ts && bun run check`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/config/Schema.pkl src/config/types.ts src/config/validate.ts src/config/validate_mask_test.ts
git commit -m "feat(config): add anthropicEgress flag with claude+proxy validation"
```

---

### Task 5: レジストリへのフラグ伝達

**Files:**
- Modify: `src/network/protocol.ts`（`interface SessionRegistryEntry`）
- Modify: `src/stages/proxy/session_broker_service.ts`（`interface SessionBrokerConfig` とレジストリ書き込み）
- Modify: `src/stages/proxy/stage.ts`（`sessionBrokerService.start({...})` 呼び出し、現行 371 行付近）
- Test: `src/stages/proxy/session_broker_service_test.ts`（無ければ新規、既存の broker service テストパターンに合わせる）

**Interfaces:**
- Consumes: `MaskConfig.anthropicEgress`（Task 4）、既存の `SessionBrokerConfig.agent` 伝達経路
- Produces: `SessionRegistryEntry.anthropicEgress?: boolean`、`SessionBrokerConfig.anthropicEgress?: boolean`、レジストリ書き込みへの反映

- [ ] **Step 1: 失敗するテストを書く**

broker service のレジストリ書き込みが `anthropicEgress` を含むことを検証する。既存の broker service / proxy stage テストの中で、`start({ ..., anthropicEgress: true })` 後に `readSessionRegistry` が `anthropicEgress: true` を返すことを assert する。既存テストの fixture（temp runtimeDir、`resolveNetworkRuntimePaths`）を再利用する:

```typescript
test("session registry carries anthropicEgress flag", async () => {
  // 既存の broker service テストと同じ temp paths / start() 呼び出しを使う。
  const handle = await startBrokerForTest({ anthropicEgress: true });
  try {
    const entry = await readSessionRegistry(paths, sessionId);
    expect(entry?.anthropicEgress).toBe(true);
  } finally {
    await handle.close();
  }
});
```

（`startBrokerForTest` / `paths` / `sessionId` は既存テストのセットアップに合わせる。無ければ既存の broker start テストに `anthropicEgress: true` を渡す assertion を1つ足す。）

- [ ] **Step 2: テスト失敗を確認**

Run: `bun test src/stages/proxy/session_broker_service_test.ts`
Expected: FAIL（`anthropicEgress` がレジストリに書かれない / 型エラー）

- [ ] **Step 3: 最小実装を書く**

`src/network/protocol.ts` の `SessionRegistryEntry` に追加:

```typescript
  anthropicEgress?: boolean;
```

`src/stages/proxy/session_broker_service.ts` の `SessionBrokerConfig` に追加:

```typescript
  readonly anthropicEgress?: boolean;
```

同ファイルのレジストリ書き込み（`agent: config.agent` を書いている箇所）に追加:

```typescript
                anthropicEgress: config.anthropicEgress,
```

`src/stages/proxy/stage.ts` の `sessionBrokerService.start({...})` 呼び出し（`agent: plan.agent` の隣）に追加:

```typescript
        anthropicEgress: input.profile.mask.anthropicEgress,
```

- [ ] **Step 4: テストと型チェック成功を確認**

Run: `bun test src/stages/proxy/session_broker_service_test.ts && bun run check`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/network/protocol.ts src/stages/proxy/session_broker_service.ts src/stages/proxy/stage.ts src/stages/proxy/session_broker_service_test.ts
git commit -m "feat(network): thread anthropicEgress flag to session registry"
```

---

### Task 6: addon への結線（URL/ヘッダー抽出 + レジストリゲート + スキーマ分岐）

**Files:**
- Modify: `src/docker/mitmproxy/nas_addon.py`（`_apply_request_masking` と `request()` ハンドラのマスク箇所、現行 543-556 行付近）
- Test: `src/docker/mitmproxy/nas_addon_mask_test.py`

**Interfaces:**
- Consumes: `_is_anthropic_host`、`_plan_anthropic_masking`、既存 `_apply_request_masking`、`request()` 内で既にロード済みの `registry`
- Produces: `_registry_anthropic_egress(registry) -> bool`、`_mask_url_and_headers(flow, patterns) -> None`、`request()` の Anthropic 分岐

- [ ] **Step 1: 失敗するテストを書く**

`nas_addon_mask_test.py` に追加:

```python
class TestGateAndUrlHeader(unittest.TestCase):
    def test_registry_gate(self):
        self.assertTrue(nas_addon._registry_anthropic_egress({"anthropicEgress": True}))
        self.assertFalse(nas_addon._registry_anthropic_egress({"anthropicEgress": False}))
        self.assertFalse(nas_addon._registry_anthropic_egress({}))
        self.assertFalse(nas_addon._registry_anthropic_egress(None))

    def test_mask_url_and_headers_not_body(self):
        patterns = nas_addon._build_mask_patterns(["SECRET123"])
        flow = _make_stub_flow(
            path="/v1/messages?k=SECRET123",
            headers={"x-custom": "SECRET123"},
            content=b'{"body":"SECRET123"}')
        nas_addon._mask_url_and_headers(flow, patterns)
        self.assertNotIn("SECRET123", flow.request.path)
        self.assertNotIn("SECRET123", flow.request.headers["x-custom"])
        self.assertIn(b"SECRET123", flow.request.content)  # body は触らない
```

`_make_stub_flow` は、このファイル内の既存 stub flow 構築方法（`testdata/mitmproxy_stub/mitmproxy/http.py` の Request/Response 形状、multidict headers）に合わせて最小ヘルパを定義する。`path`・`headers`（get_all/set_all 対応）・`content` を設定できるものを作る。

- [ ] **Step 2: テスト失敗を確認**

Run: `cd src/docker/mitmproxy && PYTHONPATH=testdata/mitmproxy_stub python3 nas_addon_mask_test.py -v`
Expected: FAIL — `AttributeError: ... '_registry_anthropic_egress'`（またはヘルパ未定義）

- [ ] **Step 3: ゲート helper と URL/ヘッダー抽出を実装**

`src/docker/mitmproxy/nas_addon.py` に追加:

```python
def _registry_anthropic_egress(registry) -> bool:
    return bool(registry and registry.get("anthropicEgress"))
```

`_apply_request_masking` から URL/ヘッダー部分を抽出:

```python
def _mask_url_and_headers(flow, patterns: list) -> None:
    """URL パスとヘッダーから秘密値を **** に置換する（body は触らない）。"""
    if not patterns:
        return
    masked_path = _mask_bytes(
        flow.request.path.encode("utf-8", errors="surrogateescape"), patterns)
    flow.request.path = masked_path.decode("utf-8", errors="surrogateescape")
    seen = set()
    for name in list(flow.request.headers.keys()):
        if name in seen:
            continue
        seen.add(name)
        values = flow.request.headers.get_all(name)
        masked_values = [
            _mask_bytes(v.encode("utf-8", errors="surrogateescape"), patterns)
            .decode("utf-8", errors="surrogateescape")
            for v in values
        ]
        if masked_values != values:
            flow.request.headers.set_all(name, masked_values)


def _apply_request_masking(flow, patterns: list) -> None:
    if not patterns:
        return
    _mask_url_and_headers(flow, patterns)
    try:
        content = flow.request.content
    except ValueError:
        content = None
    if content is not None:
        if content:
            masked_content = _mask_bytes(content, patterns)
            if masked_content != content:
                flow.request.content = masked_content
    else:
        ce = flow.request.headers.get("content-encoding", "unknown")
        print(
            f"[nas-addon] MASK-BLOCKED: cannot decode content-encoding "
            f"'{ce}' for masking, blocking request to prevent secret leak",
            file=sys.stderr,
        )
        flow.mask_blocked = True
```

（`_apply_request_masking` は URL/ヘッダー部分を `_mask_url_and_headers` へ委譲するのみで、body 部分と非 Anthropic 挙動は不変。）

- [ ] **Step 4: helper テスト成功を確認**

Run: `cd src/docker/mitmproxy && PYTHONPATH=testdata/mitmproxy_stub python3 nas_addon_mask_test.py -v`
Expected: PASS（`TestGateAndUrlHeader`）。既存テストも PASS。

- [ ] **Step 5: `request()` ハンドラに Anthropic 分岐を結線**

`request()` 内、`mask_values = decision.get("maskValues") or []` 以降（credential 注入の前）を置換:

```python
        mask_values = decision.get("maskValues") or []
        patterns = self._patterns_for(mask_values) if mask_values else []

        if _is_anthropic_host(host) and _registry_anthropic_egress(registry):
            try:
                body = flow.request.content
            except ValueError:
                body = None
            action, masked_body = _plan_anthropic_masking(
                method, request_path, body, patterns)
            if action == "block":
                print(
                    f"[nas-addon] SCHEMA-BLOCKED: fail-closed on "
                    f"{method} {request_path} (unrecognized structure or "
                    f"undecodable body)", file=sys.stderr)
                flow.response = http.Response.make(
                    403, b"blocked: unrecognized Anthropic request structure")
                return
            if action == "rewrite":
                flow.request.content = masked_body
            if patterns:
                _mask_url_and_headers(flow, patterns)
        else:
            if mask_values:
                _apply_request_masking(flow, patterns)
                if getattr(flow, "mask_blocked", False):
                    flow.response = http.Response.make(
                        403,
                        b"blocked: cannot decode request body for secret masking",
                    )
                    return
```

（credential 注入以降は現行のまま。`registry` は同メソッド冒頭で `_load_registry(session_id)` 済み。）

- [ ] **Step 6: 全 Python 単体テスト成功を確認**

Run: `cd src/docker/mitmproxy && PYTHONPATH=testdata/mitmproxy_stub python3 nas_addon_mask_test.py -v`
Expected: PASS（全クラス）

- [ ] **Step 7: Bun 経由の単体テストと型チェック**

Run: `bun test src/docker/mitmproxy/nas_addon_test.ts && bun run check`
Expected: PASS

- [ ] **Step 8: コミット**

```bash
git add src/docker/mitmproxy/nas_addon.py src/docker/mitmproxy/nas_addon_mask_test.py
git commit -m "feat(network): gate schema masking on anthropicEgress registry flag"
```

---

### Task 7: 統合テスト（実 mitmproxy）

**Files:**
- Modify: `src/docker/mitmproxy/nas_addon_integration_test.ts`

**Interfaces:**
- Consumes: 既存ヘルパ `sendProxyRequest(...)`、fake broker（`{decision:"allow", maskValues:[...]}` を返す）、`writeSessionRegistry`、`dockerRunDetached`
- Produces: 新規 `test.skipIf(...)` ケース3件

- [ ] **Step 1: 統合テストケースを追加**

既存テスト（現行 137 行付近）の fixture を再利用する。**セッションレジストリに `anthropicEgress: true` を書く**（`writeSessionRegistry` の呼び出しにフラグを足す）。fake broker は `maskValues:["SECRET123"]` を返す。次の3ケースを追加する:

```typescript
test.skipIf(!dockerAvailable || !canBindMount)(
  "anthropic /v1/messages: masks secret in JSON body",
  async () => {
    // fixture: mitmproxy + fake broker(maskValues:["SECRET123"])、
    // レジストリ anthropicEgress:true。upstream 受信内容の取得は既存テストに合わせる。
    const body = JSON.stringify({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: [{ type: "text", text: "k=SECRET123" }] }],
    });
    const forwarded = await sendProxyRequest({
      host: "api.anthropic.com", method: "POST", path: "/v1/messages",
      headers: { "content-type": "application/json" }, body,
    });
    expect(forwarded.body).not.toContain("SECRET123");
    expect(forwarded.body).toContain("****");
  },
);

test.skipIf(!dockerAvailable || !canBindMount)(
  "anthropic: unknown content block type is failed closed (403)",
  async () => {
    const body = JSON.stringify({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: [{ type: "quantum_payload", data: "x" }] }],
    });
    const resp = await sendProxyRequest({
      host: "api.anthropic.com", method: "POST", path: "/v1/messages",
      headers: { "content-type": "application/json" }, body,
    });
    expect(resp.status).toBe(403);
  },
);

test.skipIf(!dockerAvailable || !canBindMount)(
  "anthropic: unknown path is failed closed (403)",
  async () => {
    const resp = await sendProxyRequest({
      host: "api.anthropic.com", method: "POST", path: "/v1/files",
      headers: { "content-type": "application/json" }, body: "{}",
    });
    expect(resp.status).toBe(403);
  },
);
```

`sendProxyRequest` の実シグネチャ（現行 106 行付近）と upstream 受信内容の取得方法は既存テストに合わせる。

- [ ] **Step 2: 統合テスト実行**

Run: `bun test src/docker/mitmproxy/nas_addon_integration_test.ts`
Expected: PASS（Docker 利用可能時）。Docker 不在時は skip。

- [ ] **Step 3: コミット**

```bash
git add src/docker/mitmproxy/nas_addon_integration_test.ts
git commit -m "test(network): integration tests for Anthropic schema masking"
```

---

## Self-Review

**Spec coverage:**
- egress チョークポイント / スキーマアローリスト → Task 1/2/3/6
- 検知したらマスク → Task 2（文字列/blob マスク）
- 理解できなければ遮断（未知パス/ブロック型/デコード不能）→ Task 2/3/6
- 未知トップレベルは平文走査して通過 → Task 2（`test_unknown_toplevel_field_passes`）
- base64/URL/gzip の再帰デコード → base64 は Task 2、URL/gzip は既存パターン集合と mitmproxy の CE 展開
- Config（フラグ・デフォルト false・claude 必須・proxy 必須・レジストリ伝達）→ Task 4/5/6
- 未知ベータは log のみ、維持トリガー = 新ブロック型 → `_KNOWN_BLOCK_TYPES` コメント + Task 6 の SCHEMA-BLOCKED ログ
- 既存コンポーネント統合（nas_addon / mask_patterns / broker / mask_blocked / agent 伝達経路）→ Task 5/6
- 非目標（ターンまたぎ・非 Anthropic ホスト・レスポンス）→ 維持。非 Anthropic は Task 6 で現行挙動保持

**Placeholder scan:** 各ステップに実コードあり。統合テスト（Task 7）と一部 TS テスト（Task 5）は既存 fixture/ヘルパ再利用のため、セットアップを既存参照としたが、追加するリクエストボディ・期待値・assertion は具体化済み。

**Type consistency:** `_schema_mask_json → (Optional[bytes], bool)`、`_plan_anthropic_masking → (str, Optional[bytes])`、`_registry_anthropic_egress → bool`、`MaskConfig.anthropicEgress: boolean`、`SessionRegistryEntry.anthropicEgress?: boolean`、`SessionBrokerConfig.anthropicEgress?: boolean` は Task 間で一貫。

**検討点（diffity レビューで確認済み）:** Global Constraints 末尾の4点 + Config のエラー設計（Task 4）。
