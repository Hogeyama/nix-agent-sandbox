# Anthropic egress スキーマ認識マスク Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** api.anthropic.com へのリクエストボディを JSON スキーマ認識でマスクし、理解できない構造をフェイルクローズドで遮断することで、Read ツール／`@file` 経由のシークレット漏洩を egress で捕捉する。

**Architecture:** mitmproxy addon（`src/docker/mitmproxy/nas_addon.py`）の `request()` ハンドラに、Anthropic ホスト専用の分岐を追加する。既知の JSON エンドポイント（`/v1/messages`、`/v1/messages/count_tokens`）は、パース済み JSON を再帰的に走査して全文字列をパターンマスクし、base64 blob フィールドはデコードして走査、既知コンテンツコンテナ内の未知ブロック型は遮断する。未知パス・デコード不能ボディ・未知ブロック型はすべて 403 でフェイルクローズドする。ロジックはすべて addon 内の純粋関数に閉じ、既存の `_build_mask_patterns` / `_mask_bytes` と broker 供給の `maskValues` を流用する。

**Tech Stack:** Python 3（mitmproxy addon、単一ファイル配置）、Python `unittest`（`nas_addon_mask_test.py` + mitmproxy stub）、Bun test（TS 統合テスト、実 mitmproxy コンテナ）。

**Why — なぜこのアプローチを選んだか:**
egress（api.anthropic.com）はエージェントが何を経由してシークレットを読んでも必ず通過する唯一の完全なチョークポイントであり、取り込み側（Read/`@file`/MCP）を個別に塞ぐより完全性が高い。宛先が構造化 JSON で秘密値も既知のため、パース → 全文字列走査 → base64 blob デコード → 未知構造は遮断、という「アローリスト＋フェイルクローズド」で、現行 proxy のバイト列総当たりが取りこぼすアプリ層エンコードを塞げる。ロジックを addon 内に閉じることで TS/Effect 側の変更をゼロにし、既存の pattern 展開・maskValues 供給・403 機構を再利用して変更面を最小化する。

**Why Not — なぜ他の案を選ばなかったか:**
- **案 B: 取り込み側フック（Read の PreToolUse マスク）** — `@file` はツール呼び出しでなくクライアント側展開のためフックが介入できず、MCP・将来機能も取りこぼす。完全性を担保できない。
- **案 C: spec の「JSON パス単位 content/control 表」を厳密実装** — パスごとの分類表は保守面が広い。全文字列を一律マスクしても、マスクは既知シークレット値にしか作用せず非シークレットを壊さないため安全であり、既存パターン集合が url/base64 変種を含むので分類表なしでも捕捉できる。保守対象を「既知ブロック型集合」に縮約できる本案を選んだ（この簡素化は本プランの検討点。下記 Global Constraints 参照）。
- **案 D: 未知ベータを一律遮断（spec 記載）** — 制御専用ベータ（fast-mode 等）まで遮断しセッションを壊す。コンテンツ搬送面の追加はブロック型チェックが捕捉し、既存パターンが base64 変種を含むため、未知ベータは log のみとする（本プランの検討点）。

## Global Constraints

- 実装者・レビュアーは着手前に次のスキルを読む: `security-constraints`（コンテナ境界・シークレット取り扱いの不変条件、特に S1/C1）、`test-policy`（テスト分類・命名・cleanup）、`effect-separation`（TS 側を触る場合のみ。本プランは Python 中心のため主に非該当）。
- ランタイムは Bun。テストは `bun test`（`deno task` 表記は旧情報）。Python 純粋関数テストは `nas_addon_mask_test.py` に追加し、TS ラッパー `nas_addon_test.ts` 経由で `bun test` から実行される。
- addon は単一ファイル `src/docker/mitmproxy/nas_addon.py` として配置される（`network_runtime_service.ts` が resolveAsset で materialize）。**Python モジュール分割をしない**（配置機構の変更を避ける）。ロジックはファイル内のセクションとして整理する。
- シークレット値の解決はホスト側のみ（S1）。addon はスキーマ表（静的な既知ブロック型集合）のみをベイクインし、秘密値は broker decision の `maskValues` から受け取る。新たなホスト→addon データ経路を追加しない。
- 既存の非 Anthropic ホストのマスク挙動（`_apply_request_masking`）を変更・退行させない。
- **本プランの検討点（diffity レビューで確認する）:**
  1. spec の「JSON パス単位 content/control 表」を「全文字列一律マスク + 既知ブロック型集合 + base64 blob デコード」に簡素化した。
  2. 未知 `anthropic-beta` は spec では遮断だが、本プランでは log のみ（enforcement はブロック型チェック + base64 パターンの backstop）。
  3. フェイルクローズドの動作は 403 遮断のみ（spec の「broker 人間判断へ回す」経路は本プランのスコープ外、follow-up）。
  4. スキーマ対象は `/v1/messages`・`/v1/messages/count_tokens` のみ。`/v1/files`（multipart）とその他 Anthropic パスは 403 遮断（files 対応は follow-up）。

---

### Task 1: Anthropic ホスト判定とエンドポイントルーティング

**Files:**
- Modify: `src/docker/mitmproxy/nas_addon.py`（新セクション追加。`_normalize_host` の後、`_apply_request_masking` の周辺）
- Test: `src/docker/mitmproxy/nas_addon_mask_test.py`

**Interfaces:**
- Consumes: 既存 `_normalize_host(host: str) -> str`
- Produces:
  - `_is_anthropic_host(host: str) -> bool`
  - `_anthropic_json_endpoint(method: str, path: str) -> Optional[str]` — 既知 JSON エンドポイントなら `"messages"`、それ以外は `None`

- [ ] **Step 1: 失敗するテストを書く**

`src/docker/mitmproxy/nas_addon_mask_test.py` の末尾（`unittest.main()` の前）に追加:

```python
class TestAnthropicRouting(unittest.TestCase):
    def test_is_anthropic_host(self):
        self.assertTrue(nas_addon._is_anthropic_host("api.anthropic.com"))
        self.assertTrue(nas_addon._is_anthropic_host("API.ANTHROPIC.COM"))
        self.assertFalse(nas_addon._is_anthropic_host("example.com"))
        self.assertFalse(nas_addon._is_anthropic_host("evil-anthropic.com"))

    def test_known_json_endpoints(self):
        self.assertEqual(
            nas_addon._anthropic_json_endpoint("POST", "/v1/messages"), "messages")
        self.assertEqual(
            nas_addon._anthropic_json_endpoint("POST", "/v1/messages/count_tokens"),
            "messages")
        self.assertEqual(
            nas_addon._anthropic_json_endpoint("POST", "/v1/messages?beta=true"),
            "messages")
        self.assertEqual(
            nas_addon._anthropic_json_endpoint("POST", "/v1/messages/"), "messages")

    def test_unknown_endpoints_return_none(self):
        self.assertIsNone(nas_addon._anthropic_json_endpoint("POST", "/v1/files"))
        self.assertIsNone(nas_addon._anthropic_json_endpoint("GET", "/v1/messages"))
        self.assertIsNone(nas_addon._anthropic_json_endpoint("POST", "/v1/models"))
```

- [ ] **Step 2: テスト失敗を確認**

Run: `cd src/docker/mitmproxy && PYTHONPATH=testdata/mitmproxy_stub python3 nas_addon_mask_test.py -v`
Expected: FAIL — `AttributeError: module 'nas_addon' has no attribute '_is_anthropic_host'`

- [ ] **Step 3: 最小実装を書く**

`src/docker/mitmproxy/nas_addon.py` に追加（`_normalize_host` の定義後）:

```python
_ANTHROPIC_HOSTS = ("api.anthropic.com",)


def _is_anthropic_host(host: str) -> bool:
    return _normalize_host(host) in _ANTHROPIC_HOSTS


def _anthropic_json_endpoint(method: str, path: str) -> Optional[str]:
    """既知の JSON リクエストエンドポイントなら schema キーを返す。
    それ以外の (method, path) は None（呼び出し側でフェイルクローズド）。"""
    if method != "POST":
        return None
    p = path.split("?", 1)[0].rstrip("/")
    if p in ("/v1/messages", "/v1/messages/count_tokens"):
        return "messages"
    return None
```

- [ ] **Step 4: テスト成功を確認**

Run: `cd src/docker/mitmproxy && PYTHONPATH=testdata/mitmproxy_stub python3 nas_addon_mask_test.py -v`
Expected: PASS（`TestAnthropicRouting` の3テスト）

- [ ] **Step 5: コミット**

```bash
git add src/docker/mitmproxy/nas_addon.py src/docker/mitmproxy/nas_addon_mask_test.py
git commit -m "feat(network): add Anthropic host and JSON endpoint routing"
```

---

### Task 2: スキーマ走査（マスク + base64 デコード + 未知ブロック型検知）

**Files:**
- Modify: `src/docker/mitmproxy/nas_addon.py`（Task 1 のセクションに続けて追加）
- Test: `src/docker/mitmproxy/nas_addon_mask_test.py`

**Interfaces:**
- Consumes: 既存 `_mask_bytes(data: bytes, patterns: list[bytes]) -> bytes`、`_build_mask_patterns(mask_values: list[str]) -> list[bytes]`
- Produces:
  - 定数 `_KNOWN_BLOCK_TYPES: frozenset[str]`
  - `_schema_mask_json(body: bytes, patterns: list[bytes]) -> tuple[Optional[bytes], bool]` — 戻り値は `(masked_body, blocked)`。`masked_body` は変更が無ければ `None`。`blocked=True` はフェイルクローズド（未知ブロック型 or パース不能）

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
        body, blocked = self._mask({
            "model": "claude-opus-4-8",
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": "key is SECRET123 ok"}]}],
        })
        self.assertFalse(blocked)
        self.assertIn(b"****", body)
        self.assertNotIn(b"SECRET123", body)

    def test_masks_system_string(self):
        body, blocked = self._mask({
            "model": "m", "system": "token SECRET123",
            "messages": [{"role": "user", "content": "hi"}]})
        self.assertFalse(blocked)
        self.assertNotIn(b"SECRET123", body)

    def test_masks_base64_blob(self):
        import base64, json
        blob = base64.b64encode(b"prefix SECRET123 suffix").decode()
        body, blocked = self._mask({
            "model": "m",
            "messages": [{"role": "user", "content": [
                {"type": "image",
                 "source": {"type": "base64", "media_type": "image/png", "data": blob}}]}]})
        self.assertFalse(blocked)
        # 再エンコード後の data をデコードすると secret が消えている
        parsed = json.loads(body)
        decoded = base64.b64decode(parsed["messages"][0]["content"][0]["source"]["data"])
        self.assertNotIn(b"SECRET123", decoded)

    def test_masks_nested_tool_result(self):
        body, blocked = self._mask({
            "model": "m",
            "messages": [{"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "t1",
                 "content": [{"type": "text", "text": "out SECRET123"}]}]}]})
        self.assertFalse(blocked)
        self.assertNotIn(b"SECRET123", body)

    def test_unknown_block_type_blocks(self):
        body, blocked = self._mask({
            "model": "m",
            "messages": [{"role": "user", "content": [
                {"type": "quantum_payload", "data": "x"}]}]})
        self.assertTrue(blocked)
        self.assertIsNone(body)

    def test_unknown_toplevel_field_passes(self):
        body, blocked = self._mask({
            "model": "m", "future_param": {"nested": "SECRET123"},
            "messages": [{"role": "user", "content": "hi"}]})
        self.assertFalse(blocked)
        # 未知トップレベルでも文字列はマスクされる
        self.assertNotIn(b"SECRET123", body)

    def test_tools_type_not_block_checked(self):
        # tools[] の type（bash_20250124 等）はブロック型チェック対象外
        body, blocked = self._mask({
            "model": "m",
            "tools": [{"type": "bash_20250124", "name": "bash"}],
            "messages": [{"role": "user", "content": "hi"}]})
        self.assertFalse(blocked)

    def test_no_secret_returns_unchanged(self):
        body, blocked = self._mask({
            "model": "m", "messages": [{"role": "user", "content": "clean"}]})
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
Expected: FAIL — `AttributeError: module 'nas_addon' has no attribute '_schema_mask_json'`

- [ ] **Step 3: 最小実装を書く**

`src/docker/mitmproxy/nas_addon.py` に追加（Task 1 のセクションに続けて）。ファイル冒頭の import に `json`・`base64` が既存であることを確認する（無ければ追加）:

```python
# コンテンツコンテナ内で許可するブロック型。ここに無い type を持つブロックが
# system / *.content 直下に現れたら、未知構造としてフェイルクローズドする。
# 維持トリガー: Anthropic が新しいコンテンツブロック型を出荷したとき。
_KNOWN_BLOCK_TYPES = frozenset({
    "text", "image", "document", "thinking", "redacted_thinking",
    "tool_use", "tool_result", "server_tool_use",
    "web_search_tool_result", "code_execution_tool_result",
    "mcp_tool_use", "mcp_tool_result", "search_result",
    "container_upload", "fallback",
})

# この名前のキーの直下にある list を「ブロックリスト」とみなし、
# 各要素の type を _KNOWN_BLOCK_TYPES で検証する。
_BLOCK_LIST_KEYS = frozenset({"content", "system"})


def _walk_schema(node, parent_key, patterns):
    """(masked_node, changed, blocked) を返す。文字列はパターンマスクし、
    base64 source はデコードして走査、ブロックリスト内の未知 type は blocked。"""
    if isinstance(node, dict):
        changed = False
        blocked = False
        working = node
        # base64 source blob: デコードして中身を走査し、再エンコードする。
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
    """(masked_body|None, blocked) を返す。masked_body は変更が無ければ None。
    blocked=True はフェイルクローズド（未知ブロック型 or パース不能）。"""
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
Expected: PASS（`TestSchemaMask` の全テスト）

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
- Produces:
  - `_plan_anthropic_masking(method: str, path: str, body: Optional[bytes], patterns: list) -> tuple[str, Optional[bytes]]` — 戻り値 `(action, masked_body)`。`action` は `"block"`（フェイルクローズド）/ `"rewrite"`（`masked_body` で置換）/ `"passthrough"`（変更なし）。`body` が `None`（コンテンツデコード不能）のときは `"block"`。

- [ ] **Step 1: 失敗するテストを書く**

`nas_addon_mask_test.py` に追加:

```python
class TestAnthropicPlan(unittest.TestCase):
    def setUp(self):
        self.patterns = nas_addon._build_mask_patterns(["SECRET123"])

    def test_unknown_path_blocks(self):
        action, out = nas_addon._plan_anthropic_masking(
            "POST", "/v1/files", b"{}", self.patterns)
        self.assertEqual(action, "block")
        self.assertIsNone(out)

    def test_undecodable_body_blocks(self):
        action, out = nas_addon._plan_anthropic_masking(
            "POST", "/v1/messages", None, self.patterns)
        self.assertEqual(action, "block")

    def test_secret_rewrites(self):
        import json
        body = json.dumps({"model": "m", "messages": [
            {"role": "user", "content": "SECRET123"}]}).encode()
        action, out = nas_addon._plan_anthropic_masking(
            "POST", "/v1/messages", body, self.patterns)
        self.assertEqual(action, "rewrite")
        self.assertNotIn(b"SECRET123", out)

    def test_clean_passthrough(self):
        import json
        body = json.dumps({"model": "m", "messages": [
            {"role": "user", "content": "clean"}]}).encode()
        action, out = nas_addon._plan_anthropic_masking(
            "POST", "/v1/messages", body, self.patterns)
        self.assertEqual(action, "passthrough")
        self.assertIsNone(out)

    def test_unknown_block_blocks(self):
        import json
        body = json.dumps({"model": "m", "messages": [
            {"role": "user", "content": [{"type": "quantum", "x": 1}]}]}).encode()
        action, out = nas_addon._plan_anthropic_masking(
            "POST", "/v1/messages", body, self.patterns)
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
Expected: PASS（`TestAnthropicPlan` の全テスト）

- [ ] **Step 5: コミット**

```bash
git add src/docker/mitmproxy/nas_addon.py src/docker/mitmproxy/nas_addon_mask_test.py
git commit -m "feat(network): add Anthropic masking planner"
```

---

### Task 4: `request()` ハンドラへの結線と URL/ヘッダーマスクの抽出

**Files:**
- Modify: `src/docker/mitmproxy/nas_addon.py`（`_apply_request_masking` と `request()` ハンドラのマスク箇所、現行 543-556 行付近）
- Test: `src/docker/mitmproxy/nas_addon_mask_test.py`

**Interfaces:**
- Consumes: `_is_anthropic_host`、`_plan_anthropic_masking`、既存 `_apply_request_masking`
- Produces:
  - `_mask_url_and_headers(flow, patterns: list) -> None` — `_apply_request_masking` から URL/ヘッダーマスク部分を抽出した関数（body は触らない）
  - `request()` ハンドラの Anthropic 分岐（返り値なし、`flow.response` か `flow.request.content` を変更）

- [ ] **Step 1: 失敗するテストを書く**

URL/ヘッダー抽出関数の単体テストを `nas_addon_mask_test.py` に追加（stub の flow を使う）:

```python
class TestUrlHeaderMask(unittest.TestCase):
    def test_masks_header_not_body(self):
        import types
        patterns = nas_addon._build_mask_patterns(["SECRET123"])
        # 既存の mask テストと同じ stub flow 構築ヘルパを使う。
        flow = _make_stub_flow(
            path="/v1/messages?k=SECRET123",
            headers={"x-custom": "SECRET123"},
            content=b'{"body":"SECRET123"}')
        nas_addon._mask_url_and_headers(flow, patterns)
        self.assertNotIn("SECRET123", flow.request.path)
        self.assertNotIn("SECRET123", flow.request.headers["x-custom"])
        # body は変更しない（schema 側の責務）
        self.assertIn(b"SECRET123", flow.request.content)
```

`_make_stub_flow` が未定義なら、このファイル内の既存 stub flow 構築方法（`nas_addon_mask_test.py` 冒頭の import と既存テストのパターン）に合わせて最小のヘルパを定義する。stub の `mitmproxy.http` が提供する Request/Response 形状を使い、`path`・`headers`（get_all/set_all 対応の multidict）・`content` を設定できるものを作る。

- [ ] **Step 2: テスト失敗を確認**

Run: `cd src/docker/mitmproxy && PYTHONPATH=testdata/mitmproxy_stub python3 nas_addon_mask_test.py -v`
Expected: FAIL — `AttributeError: ... '_mask_url_and_headers'`（またはヘルパ未定義エラー）

- [ ] **Step 3: 最小実装を書く**

まず `_apply_request_masking` から URL/ヘッダー部分を抽出する。`src/docker/mitmproxy/nas_addon.py` の `_apply_request_masking` を次のように分割する:

```python
def _mask_url_and_headers(flow, patterns: list) -> None:
    """リクエストの URL パスとヘッダーから秘密値を **** に置換する（body は触らない）。"""
    if not patterns:
        return
    masked_path = _mask_bytes(
        flow.request.path.encode("utf-8", errors="surrogateescape"), patterns
    )
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
    """allow されたリクエストの URL・ヘッダー・ボディから秘密値を **** に
    置換する。credential 注入 (injectHeaders) より前に呼ぶこと。"""
    if not patterns:
        return
    _mask_url_and_headers(flow, patterns)

    # .content は Content-Encoding 展開済みビュー。展開不能は fail-closed。
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

（`_apply_request_masking` の body 部分は現行のまま。URL/ヘッダー部分のみ `_mask_url_and_headers` へ移動する。非 Anthropic ホストの挙動は不変。）

- [ ] **Step 4: URL/ヘッダーテスト成功を確認**

Run: `cd src/docker/mitmproxy && PYTHONPATH=testdata/mitmproxy_stub python3 nas_addon_mask_test.py -v`
Expected: PASS（`TestUrlHeaderMask`）。既存の mask テストも引き続き PASS。

- [ ] **Step 5: `request()` ハンドラに Anthropic 分岐を結線**

`src/docker/mitmproxy/nas_addon.py` の `request()` 内、現行のマスク箇所（`mask_values = decision.get("maskValues") or []` 以降、credential 注入の前）を次に置換する:

```python
        mask_values = decision.get("maskValues") or []
        patterns = self._patterns_for(mask_values) if mask_values else []

        if _is_anthropic_host(host):
            # Anthropic egress: スキーマ認識マスク + フェイルクローズド。
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

（credential 注入以降は現行のまま。）

- [ ] **Step 6: 全 Python 単体テスト成功を確認**

Run: `cd src/docker/mitmproxy && PYTHONPATH=testdata/mitmproxy_stub python3 nas_addon_mask_test.py -v`
Expected: PASS（全クラス）

- [ ] **Step 7: 型チェックと単体テスト（Bun 経由）**

Run: `bun test src/docker/mitmproxy/nas_addon_test.ts`
Expected: PASS（TS ラッパーが python unittest を実行）

- [ ] **Step 8: コミット**

```bash
git add src/docker/mitmproxy/nas_addon.py src/docker/mitmproxy/nas_addon_mask_test.py
git commit -m "feat(network): wire schema-aware masking into Anthropic egress path"
```

---

### Task 5: 統合テスト（実 mitmproxy）

**Files:**
- Modify: `src/docker/mitmproxy/nas_addon_integration_test.ts`
- 参照: 既存の fake broker fixture（`decision: "allow"` に `maskValues` を含めて返す。現行 137 行付近のテストと同じ `resolveNetworkRuntimePaths` / `writeSessionRegistry` / broker unix socket / `sendProxyRequest` ヘルパを再利用する）

**Interfaces:**
- Consumes: 既存ヘルパ `sendProxyRequest(...)`、fake broker サーバ構築、`dockerRunDetached` による mitmproxy 起動
- Produces: 新規 `test.skipIf(...)` ケース3件

- [ ] **Step 1: 統合テストケースを追加**

`nas_addon_integration_test.ts` に、既存テスト（137 行付近）と同じ fixture 構築（mitmproxy コンテナ起動 + fake broker が `{decision:"allow", maskValues:["SECRET123"]}` を返す）を再利用して、次の3ケースを追加する。既存テストの本体をヘルパ化して共有してよい。

```typescript
test.skipIf(!dockerAvailable || !canBindMount)(
  "anthropic /v1/messages: masks secret in JSON body",
  async () => {
    // 既存 fixture で mitmproxy + fake broker(maskValues:["SECRET123"]) を起動。
    // 宛先ホスト api.anthropic.com、経路は upstream をモックした echo か
    // 既存テストと同じ upstream 受け口を使う。
    const body = JSON.stringify({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: [{ type: "text", text: "k=SECRET123" }] }],
    });
    const forwarded = await sendProxyRequest({
      host: "api.anthropic.com",
      method: "POST",
      path: "/v1/messages",
      headers: { "content-type": "application/json" },
      body,
    });
    // upstream が受け取ったボディに生の秘密が含まれない
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
      host: "api.anthropic.com",
      method: "POST",
      path: "/v1/messages",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(resp.status).toBe(403);
  },
);

test.skipIf(!dockerAvailable || !canBindMount)(
  "anthropic: unknown path is failed closed (403)",
  async () => {
    const resp = await sendProxyRequest({
      host: "api.anthropic.com",
      method: "POST",
      path: "/v1/files",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(resp.status).toBe(403);
  },
);
```

`sendProxyRequest` の実シグネチャ（現行 106 行付近）と upstream 受け口の取得方法は既存テストに合わせる。upstream が echo でない場合は、既存テストが forwarded body を検証している方法（mitmproxy → mock upstream の受信内容取得）をそのまま踏襲する。

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
- 「egress チョークポイント / スキーマアローリスト」→ Task 2/3/4
- 「検知したらマスク」→ Task 2（`_walk_schema` の文字列/blob マスク）
- 「理解できなければ遮断（未知パス/未知ブロック型/デコード不能）」→ Task 2（blocked）/ Task 3（block）/ Task 4（403）
- 「未知トップレベルは平文走査して通過」→ Task 2（`test_unknown_toplevel_field_passes`）
- 「base64/URL/gzip の再帰デコード」→ base64 は Task 2、URL/gzip は既存パターン集合（`_build_mask_patterns` の quote/quote_plus）と mitmproxy の Content-Encoding 展開で担保
- 「anthropic-version + anthropic-beta でスキーマ変種選択」→ **簡素化**: ブロック型集合で enforcement、未知ベータは log のみ（Global Constraints の検討点 2）
- 「維持トリガー = 新ベータ + 新ブロック型」→ `_KNOWN_BLOCK_TYPES` のコメントに明記。可観測性の SCHEMA-BLOCKED ログは Task 4
- 「既存コンポーネント統合（nas_addon / mask_patterns / broker / mask_blocked）」→ Task 4
- 非目標（ターンまたぎ・非 Anthropic ホスト・レスポンス）→ 対象外を維持

**Placeholder scan:** 各ステップに実コードあり。統合テスト（Task 5）のみ既存 fixture 再利用のため upstream 受け口取得を既存テスト参照としたが、追加するリクエストボディと期待値は具体化済み。

**Type consistency:** `_schema_mask_json` の戻り `(Optional[bytes], bool)`、`_plan_anthropic_masking` の戻り `(str, Optional[bytes])` は Task 2→3→4 で一貫。`_walk_schema` の `(node, changed, blocked)` は内部のみ。

**検討点（spec からの意図的な簡素化・逸脱、diffity レビューで確認）:** Global Constraints 末尾の4点。
