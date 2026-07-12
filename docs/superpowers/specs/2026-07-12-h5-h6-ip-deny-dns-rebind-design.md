# H5+H6: IP 拒否リスト修正 + DNS リバインディング防御

## 背景

nas の egress 封じ込めは mitmproxy を経由して allowlist/承認フローで制御する。
deny-by-default ターゲット（loopback, RFC1918, link-local 等）は `denyReasonForTarget`
（broker.ts:262）で承認より先に hard-deny される。

2 つの穴がある：

1. **H6（述語バグ）**: `isDeniedIpv4/6` が複数の CIDR を見逃す。primary 防御の明確な欠陥。
2. **H5（多層防御）**: deny 判定はホスト名文字列のみに効き、解決後 IP を再検証しない。
   信頼できないホストを事故で allow/承認した場合に DNS リバインディングで内部到達が可能。
   Primary 防御は allowlist/承認フローの正しさであり、H5 は defense-in-depth 層。

## 修正範囲

### H6: `src/network/protocol.ts` — `isDeniedIpv4` / `isDeniedIpv6` の修正

#### isDeniedIpv4 — 追加すべき CIDR

| CIDR | 用途 | 現状 |
|---|---|---|
| `0.0.0.0/8` | "this" network (RFC 1122) | `a===0` チェック無し |
| `100.64.0.0/10` | CGNAT (RFC 6598) | 未ブロック |

実装: `a === 0` と `a === 100 && b >= 64 && b <= 127` を追加。

#### isDeniedIpv6 — 正規パースへの書き換え

現状は `split(":")[0]` で先頭 hextet のみ検査。以下がすり抜ける：

- `::` (unspecified) — 先頭グループ空文字 → `length===0` で false
- `::1` — 現在は `normalized === "::1"` で拾うが、`0:0:0:0:0:0:0:1` 表記等で回避可能
- `::ffff:127.0.0.1` (IPv4-mapped) — 先頭空

修正方針:
1. IPv6 文字列を完全展開（8 hextet に正規化）する純粋ヘルパー `expandIpv6` を追加。
2. IPv4-mapped (`::ffff:x.x.x.x`) を検出したら `isDeniedIpv4` に委譲。
3. `::` (all-zeros) を明示ブロック。
4. 既存の ULA (`fc00::/7`) と link-local (`fe80::/10`) チェックは展開後 hextet で判定。

#### テスト: `src/network/protocol_test.ts`

すり抜けていた全ケースの網羅テストを追加：

```
isDeniedIpv4:
  - 0.0.0.0, 0.255.255.255 → blocked
  - 100.64.0.0, 100.127.255.255 → blocked
  - 100.128.0.0 → allowed (CGNAT 外)
  - 既存ケース (10.x, 127.x, 169.254.x, 172.16-31.x, 192.168.x) 維持

isDeniedIpv6:
  - :: → blocked
  - ::1, 0:0:0:0:0:0:0:1 → blocked
  - ::ffff:127.0.0.1, ::ffff:169.254.1.1, ::ffff:10.0.0.1 → blocked
  - ::ffff:8.8.8.8 → allowed
  - fc00::1, fdab::1 → blocked (ULA)
  - fe80::1 → blocked (link-local)
  - 2001:db8::1 → allowed
```

### H5: `src/docker/mitmproxy/nas_addon.py` — 解決後 IP 再チェック + ピン留め

#### 設計

addon の `request()` フック内、broker が `allow` を返した後・上流接続の前に：

1. `socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)` で全 A/AAAA レコードを取得。
2. 全 IP に対して `_is_denied_ip(ip)` をチェック。いずれかが denied なら 403 を返す。
3. 通った場合、最初の IP を `flow.request.host` / `flow.request.port` にピン留めし、
   `flow.request.headers["Host"]` に元のホスト名を保持（SNI はホスト名ベースのまま）。

注: mitmproxy 11 ではフォワードプロキシモードで `flow.request.host` が接続先を決定する。
ホスト名を IP に書き換えると mitmproxy はその IP に直接接続する。TLS の場合 SNI は
`flow.request.pretty_host` (Host ヘッダー) から取られるため、Host ヘッダーを元ホスト名に
保持すれば証明書検証は正常に動作する。

#### `_is_denied_ip` — Python 側の denied-CIDR 判定

`ipaddress` 標準ライブラリを使用：

```python
import ipaddress

_DENIED_IPV4_NETWORKS = [
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("100.64.0.0/10"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
]

_DENIED_IPV6_NETWORKS = [
    ipaddress.ip_network("::/128"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
]

def _is_denied_ip(ip_str: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip_str)
    except ValueError:
        return True  # パース不能は fail-closed
    # IPv4-mapped IPv6 → 内包 IPv4 で再判定
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    if isinstance(addr, ipaddress.IPv4Address):
        return any(addr in net for net in _DENIED_IPV4_NETWORKS)
    return any(addr in net for net in _DENIED_IPV6_NETWORKS)
```

IPv4-mapped IPv6 (`::ffff:x.x.x.x`) は `ipv4_mapped` プロパティで IPv4 に変換してから
IPv4 ネットワーク群で再判定する。`::ffff:0:0/96` を別途リストに持つ必要はない。

#### DNS 解決失敗時

`getaddrinfo` が例外を投げた場合は fail-closed で 403。mitmproxy 自身も解決に失敗して
502 を返すはずだが、addon 側で先に弾くことで確実に防ぐ。

#### テスト: `src/docker/mitmproxy/nas_addon_mask_test.py` に追加

既存の mask テストと同じ harness（python3 直接実行、mitmproxy_stub 使用）で：

- `_is_denied_ip` の各 CIDR + 境界テスト
- `_resolve_and_check` の mock テスト（`socket.getaddrinfo` を patch）
  - 全 IP が allowed → returns first IP
  - いずれかが denied → raises/returns None
  - getaddrinfo 例外 → fail-closed

## TS/Python 二重実装の drift 防止

mask パターンの前例（`nas_addon.py` 冒頭コメント: "keep both implementations in sync"）に倣い：

1. 両側に同一のテストケース表（上記）を配置。
2. `protocol_test.ts` と Python テストの両方が同じ IP → expected 結果を検証。
3. CIDR リストの変更時は両ファイルを同一 commit で更新する旨をコード内コメントに明記。

## スコープ外

- config による private-host 除外リスト（将来必要になったら別途追加）
- broker 側での解決後 IP 再判定（addon 側で原子的に check+pin する方が堅牢）
- mitmproxy の `server_connect` フック利用（フォワードプロキシモードでは `request` フックで
  `flow.request.host` を書き換える方が確実かつテストしやすい）

## リスク

- **mitmproxy 11 の IP ピン留め動作**: `flow.request.host` を IP に書き換えた時の TLS 検証
  挙動を実機テスト（integration test）で確認する必要がある。Host ヘッダー保持で SNI が
  正しく送られることの検証が必須。問題があれば `server_connect` フックへ fallback。
- **getaddrinfo のブロッキング**: mitmproxy の asyncio ループ上で同期 `getaddrinfo` を
  呼ぶと遅延する可能性。Python 3.9+ の `asyncio.to_thread` か `loop.getaddrinfo` で
  非同期化する。ただし mitmproxy のフック自体が同期なので、実影響は限定的。
