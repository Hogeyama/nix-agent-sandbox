import { useEffect, useRef, useState } from "preact/hooks";
import type { DeepLink } from "../App.tsx";
import {
  api,
  type HostExecPendingItem,
  type NetworkPendingItem,
} from "../api.ts";

// FIXME: バックエンドからHOMEを渡すようにして正確に判定する
function shortenHome(path: string): string {
  const m = path.match(/^\/home\/[^/]+/);
  if (!m) return path;
  if (path === m[0]) return "~";
  return `~${path.slice(m[0].length)}`;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      class="btn-icon"
      title={copied ? "Copied!" : "Copy"}
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "✓" : "⎘"}
    </button>
  );
}

interface Props {
  networkItems: NetworkPendingItem[];
  hostExecItems: HostExecPendingItem[];
  deepLink?: DeepLink | null;
}

const NETWORK_SCOPES = ["once", "host-port", "host"] as const;
const HOSTEXEC_SCOPES = ["once", "capability"] as const;
const HOSTEXEC_DEFAULT_SCOPE = "capability";

export function PendingTab({ networkItems, hostExecItems, deepLink }: Props) {
  const [scopeMap, setScopeMap] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const highlightRef = useRef<HTMLTableRowElement>(null);

  useEffect(() => {
    if (highlightRef.current) {
      highlightRef.current.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }
  }, [deepLink]);

  const empty = networkItems.length === 0 && hostExecItems.length === 0;

  function setScope(key: string, value: string) {
    setScopeMap((m) => ({ ...m, [key]: value }));
  }

  async function handleNetworkAction(
    item: NetworkPendingItem,
    action: "approve" | "deny",
  ) {
    const key = `net:${item.sessionId}:${item.requestId}`;
    setBusy((s) => new Set(s).add(key));
    try {
      if (action === "approve") {
        await api.approveNetwork(
          item.sessionId,
          item.requestId,
          scopeMap[key] || "host-port",
        );
      } else {
        await api.denyNetwork(
          item.sessionId,
          item.requestId,
          scopeMap[key] || "host-port",
        );
      }
    } catch (e) {
      console.error("Action failed:", e);
    } finally {
      setBusy((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  }

  async function handleHostExecAction(
    item: HostExecPendingItem,
    action: "approve" | "deny",
  ) {
    const key = `he:${item.sessionId}:${item.requestId}`;
    setBusy((s) => new Set(s).add(key));
    try {
      if (action === "approve") {
        await api.approveHostExec(
          item.sessionId,
          item.requestId,
          scopeMap[key] || HOSTEXEC_DEFAULT_SCOPE,
        );
      } else {
        await api.denyHostExec(item.sessionId, item.requestId);
      }
    } catch (e) {
      console.error("Action failed:", e);
    } finally {
      setBusy((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  }

  if (empty) {
    return (
      <div class="empty">
        <div class="icon">✓</div>
        <div class="msg">All clear</div>
        <div class="sub">No approvals waiting.</div>
      </div>
    );
  }

  return (
    <div>
      {networkItems.length > 0 && (
        <section class="section">
          <div class="panel-header">
            <span class="panel-title warn">
              Network
              <span class="count">{networkItems.length}</span>
            </span>
          </div>
          <table class="table">
            <colgroup>
              <col style="width:10%" />
              <col style="width:26%" />
              <col style="width:9%" />
              <col style="width:10%" />
              <col style="width:10%" />
              <col style="width:11%" />
              <col style="width:24%" />
            </colgroup>
            <thead>
              <tr>
                <th>Session</th>
                <th>Target</th>
                <th>Method</th>
                <th>Kind</th>
                <th>Created</th>
                <th>Scope</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {networkItems.map((item) => {
                const key = `net:${item.sessionId}:${item.requestId}`;
                const disabled = busy.has(key);
                const isHighlighted =
                  deepLink?.type === "network" &&
                  deepLink.sessionId === item.sessionId &&
                  deepLink.requestId === item.requestId;
                return (
                  <tr
                    key={key}
                    ref={isHighlighted ? highlightRef : undefined}
                    class={isHighlighted ? "highlight" : undefined}
                  >
                    <td class="session">{item.sessionId.slice(0, 8)}</td>
                    <td class="mono">
                      <div class="scroll-x">
                        {item.target.host}:{item.target.port}
                      </div>
                    </td>
                    <td>
                      <span class="chip">{item.method}</span>
                    </td>
                    <td>
                      <span class="chip">{item.requestKind}</span>
                    </td>
                    <td class="time">
                      {new Date(item.createdAt).toLocaleTimeString()}
                    </td>
                    <td>
                      <select
                        class="select"
                        value={scopeMap[key] || "host-port"}
                        onChange={(e) =>
                          setScope(key, (e.target as HTMLSelectElement).value)
                        }
                      >
                        {NETWORK_SCOPES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <div class="actions">
                        <button
                          type="button"
                          class="btn btn-approve"
                          disabled={disabled}
                          onClick={() => handleNetworkAction(item, "approve")}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          class="btn btn-deny"
                          disabled={disabled}
                          onClick={() => handleNetworkAction(item, "deny")}
                        >
                          Deny
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {hostExecItems.length > 0 && (
        <section class="section">
          <div class="panel-header">
            <span class="panel-title warn">
              HostExec
              <span class="count">{hostExecItems.length}</span>
            </span>
          </div>
          <table class="table">
            <colgroup>
              <col style="width:9%" />
              <col style="width:10%" />
              <col style="width:32%" />
              <col style="width:16%" />
              <col style="width:9%" />
              <col style="width:10%" />
              <col style="width:14%" />
            </colgroup>
            <thead>
              <tr>
                <th>Session</th>
                <th>Rule</th>
                <th>Command</th>
                <th>CWD</th>
                <th>Created</th>
                <th>Scope</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {hostExecItems.map((item) => {
                const key = `he:${item.sessionId}:${item.requestId}`;
                const disabled = busy.has(key);
                const cmd = [item.argv0, ...item.args].join(" ");
                const isHighlighted =
                  deepLink?.type === "hostexec" &&
                  deepLink.sessionId === item.sessionId &&
                  deepLink.requestId === item.requestId;
                return (
                  <tr
                    key={key}
                    ref={isHighlighted ? highlightRef : undefined}
                    class={isHighlighted ? "highlight" : undefined}
                  >
                    <td class="session">{item.sessionId.slice(0, 8)}</td>
                    <td>
                      <span class="chip">{item.ruleId}</span>
                    </td>
                    <td>
                      <div class="cmd-cell">
                        <div class="scroll-x">
                          <code title={cmd}>{cmd}</code>
                        </div>
                        <CopyButton text={cmd} />
                      </div>
                    </td>
                    <td>
                      <div class="cmd-cell">
                        <div class="scroll-x mono">{shortenHome(item.cwd)}</div>
                        <CopyButton text={item.cwd} />
                      </div>
                    </td>
                    <td class="time">
                      {new Date(item.createdAt).toLocaleTimeString()}
                    </td>
                    <td>
                      <select
                        class="select"
                        value={scopeMap[key] || HOSTEXEC_DEFAULT_SCOPE}
                        onChange={(e) =>
                          setScope(key, (e.target as HTMLSelectElement).value)
                        }
                      >
                        {HOSTEXEC_SCOPES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <div class="actions">
                        <button
                          type="button"
                          class="btn btn-approve"
                          disabled={disabled}
                          onClick={() => handleHostExecAction(item, "approve")}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          class="btn btn-deny"
                          disabled={disabled}
                          onClick={() => handleHostExecAction(item, "deny")}
                        >
                          Deny
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
