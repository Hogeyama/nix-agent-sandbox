"""
nas_addon.py — mitmproxy addon for nas network authorization.

Intercepts HTTP/HTTPS requests, extracts session credentials from
Proxy-Authorization, queries the per-session broker UDS for authorization
decisions, and evaluates review rules for request body inspection.
"""

import base64
import hashlib
import json
import os
import socket
import sys
import time
from typing import Optional

from mitmproxy import connection, http

NETWORK_DIR = "/nas-network"
SESSIONS_DIR = os.path.join(NETWORK_DIR, "sessions")
BROKERS_DIR = os.path.join(NETWORK_DIR, "brokers")
REVIEW_RULES_DIR = os.path.join(NETWORK_DIR, "review-rules")

BODY_PREVIEW_MAX = 1024

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
    def __init__(self):
        # CONNECT credentials keyed by client connection id.
        # For HTTPS, Proxy-Authorization is only on the CONNECT request,
        # not on inner requests after TLS decryption.
        self._connect_creds: dict[str, tuple[str, str]] = {}

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

        # Inject credential headers from broker decision.
        # Only inject if the header is not already present so that an agent
        # that explicitly sets its own Authorization header is not overwritten.
        # mitmproxy Headers.__contains__ is case-insensitive.
        inject_headers = decision.get("injectHeaders", [])
        for h in inject_headers:
            if h["name"] not in flow.request.headers:
                flow.request.headers[h["name"]] = h["value"]
                print(f"[nas-addon] INJECT: {h['name']} -> {host}:{port}{request_path} "
                      f"(cred_source={cred_source})", file=sys.stderr)
            else:
                print(f"[nas-addon] INJECT SKIP: {h['name']} already present on "
                      f"{host}:{port}{request_path}", file=sys.stderr)
        if not inject_headers and decision.get("decision") == "allow":
            print(f"[nas-addon] NO INJECT: no credentials matched for "
                  f"{host}:{port}{request_path}", file=sys.stderr)

        if "proxy-authorization" in flow.request.headers:
            del flow.request.headers["proxy-authorization"]

    def client_disconnected(self, client: connection.Client) -> None:
        self._connect_creds.pop(client.id, None)


addons = [NasAddon()]
