"""
nas_addon.py — mitmproxy addon for nas network authorization.

Intercepts HTTP/HTTPS requests, extracts session credentials from
Proxy-Authorization, queries the per-session broker UDS for authorization
decisions, and evaluates review rules for request body inspection.
"""

import asyncio
import base64
import hashlib
import ipaddress
import json
import os
import socket
import sys
import time
import urllib.parse
from typing import Optional

from mitmproxy import connection, http

NETWORK_DIR = "/nas-network"
SESSIONS_DIR = os.path.join(NETWORK_DIR, "sessions")
BROKERS_DIR = os.path.join(NETWORK_DIR, "brokers")
REVIEW_RULES_DIR = os.path.join(NETWORK_DIR, "review-rules")

BODY_PREVIEW_MAX = 1024
DNS_TIMEOUT_SECONDS = 5.0

DENIED_IPV4_NETWORKS = tuple(
    ipaddress.ip_network(cidr)
    for cidr in (
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.168.0.0/16",
    )
)
DENIED_IPV6_NETWORKS = tuple(
    ipaddress.ip_network(cidr)
    for cidr in ("::/128", "::1/128", "fc00::/7", "fe80::/10")
)


def _parse_ip(address: str):
    try:
        return ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return None


def _denied_ip_classification(address: str) -> Optional[str]:
    parsed = _parse_ip(address)
    if parsed is None:
        return None
    if isinstance(parsed, ipaddress.IPv6Address) and parsed.ipv4_mapped:
        parsed = parsed.ipv4_mapped
    networks = (
        DENIED_IPV4_NETWORKS
        if isinstance(parsed, ipaddress.IPv4Address)
        else DENIED_IPV6_NETWORKS
    )
    for network in networks:
        if parsed in network:
            return str(network)
    return None


def _is_denied_ip(address: str) -> bool:
    return _denied_ip_classification(address) is not None


def _addresses_from_addrinfo(results) -> list[str]:
    addresses: list[str] = []
    seen: set[str] = set()
    for family, socktype, _proto, _canonname, sockaddr in results:
        if family not in (socket.AF_INET, socket.AF_INET6):
            continue
        if socktype not in (0, socket.SOCK_STREAM):
            continue
        address = sockaddr[0]
        parsed = _parse_ip(address)
        if parsed is None:
            continue
        normalized = str(parsed)
        if normalized not in seen:
            seen.add(normalized)
            addresses.append(normalized)
    return addresses

# --- request masking -------------------------------------------------------
# Pattern expansion mirrors src/network/mask_patterns.ts (broker-side
# reviewContext masking). Keep both implementations in sync.

MASK_REPLACEMENT = b"****"
B64_MIN_PATTERN_LEN = 8


def _base64_confident_substrings(secret: bytes) -> set[bytes]:
    """truffleHog 方式: 3 バイトアライメントごとに、隣接バイトの影響を
    受けない「確定部分文字列」を生成する (標準 / URL-safe 両アルファベット)。
    短すぎるパターンは誤マスク防止のため捨てる。"""
    out: set[bytes] = set()
    for k in range(3):
        encoded = base64.b64encode(b"\x00" * k + secret).rstrip(b"=")
        start = -(-8 * k // 6)                # ceil(8k/6)
        end = (8 * (k + len(secret))) // 6    # floor(8(k+n)/6)
        candidate = encoded[start:end]
        if len(candidate) >= B64_MIN_PATTERN_LEN:
            out.add(candidate)
            out.add(candidate.replace(b"+", b"-").replace(b"/", b"_"))
    return out


def _build_mask_patterns(mask_values: list[str]) -> list[bytes]:
    """秘密値ごとに 生値 / percent-encoded (quote, quote_plus) / base64
    バリアントを展開し、長い順に返す (部分重複対策)。"""
    patterns: set[bytes] = set()
    for value in mask_values:
        if not value:
            continue
        raw = value.encode("utf-8")
        patterns.add(raw)
        patterns.add(urllib.parse.quote(value, safe="").encode("ascii"))
        patterns.add(urllib.parse.quote_plus(value).encode("ascii"))
        patterns.update(_base64_confident_substrings(raw))
    return sorted(patterns, key=len, reverse=True)


def _mask_bytes(data: bytes, patterns: list[bytes]) -> bytes:
    for pattern in patterns:
        data = data.replace(pattern, MASK_REPLACEMENT)
    return data


def _mask_url_and_headers(flow, patterns: list[bytes]) -> None:
    """URL パスとヘッダーから秘密値を **** に置換する（body は触らない）。"""
    if not patterns:
        return

    masked_path = _mask_bytes(
        flow.request.path.encode("utf-8", errors="surrogateescape"), patterns
    )
    flow.request.path = masked_path.decode("utf-8", errors="surrogateescape")

    # Headers is a multidict: item access does not reliably expose every
    # occurrence of a duplicated header name, so use get_all/set_all to
    # scan and rewrite all occurrences of each header name.
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


def _apply_request_masking(flow, patterns: list[bytes]) -> None:
    """allow されたリクエストの URL・ヘッダー・ボディから秘密値を **** に
    置換する。credential 注入 (injectHeaders) より前に呼ぶこと —
    逆順だと注入したばかりの本物の credential をマスクして壊す。"""
    if not patterns:
        return

    _mask_url_and_headers(flow, patterns)

    # .content は Content-Encoding 展開済みビュー。再代入で mitmproxy が
    # 再圧縮と Content-Length 更新を行う。展開できないエンコーディングは
    # ValueError になる — その場合 raw_content は圧縮済みバイト列なので
    # 生パターンのマッチは効かず、マスクできない。
    # fail-closed: 展開不能 = マスク不能 = 漏洩リスクなので blocked を返す。
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
        # content 展開失敗。blocked フラグを立てて呼び出し元で 403 にする。
        ce = flow.request.headers.get("content-encoding", "unknown")
        print(
            f"[nas-addon] MASK-BLOCKED: cannot decode content-encoding "
            f"'{ce}' for masking, blocking request to prevent secret leak",
            file=sys.stderr,
        )
        flow.mask_blocked = True


_registry_cache: dict[str, tuple[float, dict]] = {}
_review_rules_cache: dict[str, tuple[float, list]] = {}
CACHE_TTL = 5.0


def _load_registry(session_id: str) -> Optional[dict]:
    now = time.monotonic()
    cached = _registry_cache.get(session_id)
    if cached and now - cached[0] < CACHE_TTL:
        return cached[1]
    path = os.path.join(SESSIONS_DIR, f"{session_id}.json")
    try:
        with open(path) as f:
            data = json.load(f)
        _registry_cache[session_id] = (now, data)
        return data
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def _load_review_rules(session_id: str) -> list:
    now = time.monotonic()
    cached = _review_rules_cache.get(session_id)
    if cached and now - cached[0] < CACHE_TTL:
        return cached[1]
    path = os.path.join(REVIEW_RULES_DIR, f"{session_id}.json")
    try:
        with open(path) as f:
            rules = json.load(f)
        _review_rules_cache[session_id] = (now, rules)
        return rules
    except (FileNotFoundError, json.JSONDecodeError):
        _review_rules_cache[session_id] = (now, [])
        return []


def _hash_token(token: str) -> str:
    digest = hashlib.sha256(token.encode()).hexdigest()
    return f"sha256:{digest}"


def _decode_proxy_auth(header: Optional[str]) -> Optional[tuple[str, str]]:
    if not header:
        return None
    if not header.lower().startswith("basic "):
        return None
    try:
        decoded = base64.b64decode(header[6:].strip()).decode()
        idx = decoded.index(":")
        if idx <= 0 or idx == len(decoded) - 1:
            return None
        return decoded[:idx], decoded[idx + 1:]
    except Exception:
        return None


def _query_broker(socket_path: str, request: dict) -> dict:
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.settimeout(10.0)
        sock.connect(socket_path)
        line = json.dumps(request) + "\n"
        sock.sendall(line.encode())
        data = b""
        while b"\n" not in data:
            chunk = sock.recv(4096)
            if not chunk:
                break
            data += chunk
        if not data:
            return {"decision": "deny", "reason": "empty-broker-response"}
        return json.loads(data.decode().strip())
    except Exception as e:
        return {"decision": "deny", "reason": f"broker-unavailable: {e}"}
    finally:
        sock.close()


def _normalize_host(host: str) -> str:
    h = host.strip().lower()
    if h.startswith("[") and h.endswith("]"):
        h = h[1:-1]
    while h.endswith("."):
        h = h[:-1]
    return h


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
    except Exception:
        return None, True
    # _walk_schema (深いネストで RecursionError の可能性) と後続の
    # json.dumps().encode("utf-8") (lone surrogate を含む文字列で
    # UnicodeEncodeError を送出する可能性) をまとめて保護する。
    # fail-closed: ここで捕捉できない例外を通過させると、マスク未適用の
    # 本文がそのまま送信されて秘密漏洩につながるため、あらゆる例外を
    # blocked 扱いにする。
    try:
        masked, changed, blocked = _walk_schema(parsed, None, patterns)
        if blocked:
            return None, True
        if not changed:
            return None, False
        return json.dumps(masked, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), False
    except Exception:
        return None, True


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


def _registry_anthropic_egress(registry) -> bool:
    return bool(registry and registry.get("anthropicEgress"))


def _match_host_pattern(host: str, pattern: str) -> bool:
    normalized = _normalize_host(host)
    if pattern.startswith("*."):
        suffix = pattern[2:].lower()
        return normalized == suffix or normalized.endswith(f".{suffix}")
    return normalized == pattern.lower()


def _matches_path_prefix(path: str, prefix: str) -> bool:
    if not path.startswith(prefix):
        return False
    if len(path) == len(prefix):
        return True
    if prefix.endswith("/"):
        return True
    nxt = path[len(prefix)]
    return nxt == "/" or nxt == "?"


def _match_review_rule(rule: dict, method: str, host: str, path: str) -> bool:
    if "method" in rule and rule["method"]:
        if rule["method"].upper() != method.upper():
            return False
    if "host" in rule and rule["host"]:
        if not _match_host_pattern(host, rule["host"]):
            return False
    if "pathPrefix" in rule and rule["pathPrefix"]:
        if not _matches_path_prefix(path, rule["pathPrefix"]):
            return False
    return True


def _generate_request_id() -> str:
    return f"req_{os.urandom(6).hex()}"


def _verify_creds(session_id: str, token: str) -> Optional[dict]:
    registry = _load_registry(session_id)
    if not registry:
        return None
    token_hash = _hash_token(token)
    if token_hash != registry.get("tokenHash"):
        return None
    return registry


class NasAddon:
    def __init__(self, resolver=None, dns_timeout=DNS_TIMEOUT_SECONDS):
        self._resolver = resolver
        self._dns_timeout = dns_timeout
        # CONNECT credentials keyed by client connection id.
        # For HTTPS, Proxy-Authorization is only on the CONNECT request,
        # not on inner requests after TLS decryption.
        self._connect_creds: dict[str, tuple[str, str]] = {}
        # mask_values is fixed for the whole session, so cache the derived
        # patterns instead of re-deriving raw + quote + quote_plus + base64
        # variants per secret on every allowed request.
        self._mask_values_cache: Optional[list[str]] = None
        self._mask_patterns_cache: list[bytes] = []

    async def server_connect(self, data) -> None:
        if not data.server.address:
            data.server.error = "nas: missing upstream address"
            return

        host, port = data.server.address
        parsed = _parse_ip(host)
        if parsed is not None:
            denied_range = _denied_ip_classification(host)
            if denied_range is not None:
                print(
                    f"[nas-addon] DNS-BLOCKED: denied direct IP {host}:{port} "
                    f"(range {denied_range})",
                    file=sys.stderr,
                )
                data.server.error = "nas: denied upstream IP"
            return

        resolver = self._resolver or asyncio.get_running_loop().getaddrinfo
        try:
            results = await asyncio.wait_for(
                resolver(host, port, type=socket.SOCK_STREAM),
                timeout=self._dns_timeout,
            )
            addresses = _addresses_from_addrinfo(results)
        except asyncio.TimeoutError:
            data.server.error = "nas: DNS resolution timed out"
            return
        except Exception as exc:
            print(
                f"[nas-addon] DNS-BLOCKED: resolution failed for "
                f"{host}:{port}: {exc}",
                file=sys.stderr,
            )
            data.server.error = "nas: DNS resolution failed"
            return

        allowed: list[str] = []
        for address in addresses:
            denied_range = _denied_ip_classification(address)
            if denied_range is not None:
                print(
                    f"[nas-addon] DNS-BLOCKED: denied answer {address} "
                    f"for {host}:{port} (range {denied_range})",
                    file=sys.stderr,
                )
            else:
                allowed.append(address)

        if not addresses:
            data.server.error = (
                "nas: DNS resolution returned no usable addresses"
            )
            return
        if not allowed:
            data.server.error = "nas: all resolved upstream IPs were denied"
            return

        if data.server.sni is None:
            data.server.sni = host
        data.server.address = (allowed[0], port)

    def _patterns_for(self, mask_values: list[str]) -> list[bytes]:
        if mask_values == self._mask_values_cache:
            return self._mask_patterns_cache
        patterns = _build_mask_patterns(mask_values)
        self._mask_values_cache = mask_values
        self._mask_patterns_cache = patterns
        return patterns

    def http_connect(self, flow: http.HTTPFlow) -> None:
        proxy_auth = flow.request.headers.get("proxy-authorization", "")
        creds = _decode_proxy_auth(proxy_auth)
        if not creds:
            print(f"[nas-addon] CONNECT 407: missing creds, "
                  f"client={flow.client_conn.id}, "
                  f"target={flow.request.host}:{flow.request.port}",
                  file=sys.stderr)
            flow.response = http.Response.make(
                407, b"missing proxy credentials",
                {"Proxy-Authenticate": 'Basic realm="nas"'},
            )
            flow.kill()
            return

        session_id, token = creds
        if not _verify_creds(session_id, token):
            print(f"[nas-addon] CONNECT 407: invalid creds, "
                  f"client={flow.client_conn.id}, "
                  f"session={session_id}, "
                  f"target={flow.request.host}:{flow.request.port}",
                  file=sys.stderr)
            flow.response = http.Response.make(
                407, b"invalid proxy credentials",
                {"Proxy-Authenticate": 'Basic realm="nas"'},
            )
            flow.kill()
            return

        self._connect_creds[flow.client_conn.id] = creds

    def request(self, flow: http.HTTPFlow) -> None:
        # Try request header first (HTTP forward proxy),
        # fall back to stored CONNECT creds (HTTPS after MitM).
        proxy_auth = flow.request.headers.get("proxy-authorization", "")
        creds = _decode_proxy_auth(proxy_auth)
        cred_source = "header" if creds else None
        if not creds:
            creds = self._connect_creds.get(flow.client_conn.id)
            if creds:
                cred_source = "connect_cache"
        if not creds:
            print(f"[nas-addon] REQUEST 407: no creds found, "
                  f"client={flow.client_conn.id}, "
                  f"has_proxy_auth={bool(proxy_auth)}, "
                  f"connect_cache_keys={list(self._connect_creds.keys())}, "
                  f"url={flow.request.pretty_url}",
                  file=sys.stderr)
            flow.response = http.Response.make(
                407, b"missing proxy credentials",
                {"Proxy-Authenticate": 'Basic realm="nas"'},
            )
            flow.kill()
            return

        session_id, token = creds
        registry = _load_registry(session_id)
        if not registry:
            flow.response = http.Response.make(403, b"stale-session")
            return

        token_hash = _hash_token(token)
        if token_hash != registry.get("tokenHash"):
            flow.response = http.Response.make(
                407, b"invalid proxy credentials",
                {"Proxy-Authenticate": 'Basic realm="nas"'},
            )
            return

        host = _normalize_host(flow.request.host)
        port = flow.request.port
        method = flow.request.method
        request_path = flow.request.path

        review_rules = _load_review_rules(session_id)
        matched_rule = None
        for rule in review_rules:
            if _match_review_rule(rule, method, host, request_path):
                matched_rule = rule
                break

        request_id = _generate_request_id()
        broker_socket = os.path.join(BROKERS_DIR, session_id, "sock")

        authorize_req = {
            "version": 1,
            "type": "authorize",
            "requestId": request_id,
            "sessionId": session_id,
            "target": {"host": host, "port": port},
            "method": method,
            "requestKind": "forward",
            "observedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        }

        # Always include path for credential matching (pathPrefix credentials
        # need the path even when no review rule matched).
        authorize_req["reviewContext"] = {
            "path": request_path,
            "contentType": None,
            "bodyPreview": None,
            "bodySize": 0,
        }

        if matched_rule:
            body_bytes = flow.request.content or b""
            body_preview = None
            if body_bytes:
                try:
                    body_preview = body_bytes[:BODY_PREVIEW_MAX].decode("utf-8", errors="replace")
                except Exception:
                    body_preview = f"<binary {len(body_bytes)} bytes>"
            authorize_req["reviewContext"] = {
                "path": request_path,
                "contentType": flow.request.headers.get("content-type"),
                "bodyPreview": body_preview,
                "bodySize": len(body_bytes),
            }

            if matched_rule.get("action") == "deny":
                flow.response = http.Response.make(403, b"denied by review rule")
                return

        decision = _query_broker(broker_socket, authorize_req)

        if decision.get("decision") != "allow":
            message = decision.get("message", decision.get("reason", "denied"))
            flow.response = http.Response.make(
                403, message.encode() if isinstance(message, str) else b"denied"
            )
            return

        # Mask secrets out of the outgoing request (URL / headers / body)
        # before credential injection so injected headers stay intact.
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

        # Inject credential headers from broker decision (overwrites existing).
        inject_headers = decision.get("injectHeaders", [])
        for h in inject_headers:
            flow.request.headers[h["name"]] = h["value"]
            print(f"[nas-addon] INJECT: {h['name']} -> {host}:{port}{flow.request.path} "
                  f"(cred_source={cred_source})", file=sys.stderr)
        if not inject_headers and decision.get("decision") == "allow":
            print(f"[nas-addon] NO INJECT: no credentials matched for "
                  f"{host}:{port}{flow.request.path}", file=sys.stderr)

        if "proxy-authorization" in flow.request.headers:
            del flow.request.headers["proxy-authorization"]

    def client_disconnected(self, client: connection.Client) -> None:
        self._connect_creds.pop(client.id, None)


addons = [NasAddon()]
