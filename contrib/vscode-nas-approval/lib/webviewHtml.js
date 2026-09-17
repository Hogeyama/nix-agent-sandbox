// Webview の骨格 HTML を返す純粋関数。カードの view model は
// extension 側から postMessage で届き、インラインスクリプトが DOM を描く。
function renderShell(nonce) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         padding: 12px; }
  .card { border: 1px solid var(--vscode-panel-border);
          border-radius: 6px; padding: 10px 12px; margin-bottom: 10px; }
  .title-row { display: flex; justify-content: space-between;
               align-items: baseline; gap: 8px; }
  .title { font-weight: 600; word-break: break-all; }
  .elapsed { font-size: 0.85em; opacity: 0.7; white-space: nowrap; }
  .meta, .reason, .viol { font-size: 0.9em; opacity: 0.85; margin-top: 4px; }
  .warning { color: var(--vscode-editorWarning-foreground); margin-top: 4px; }
  .err { color: var(--vscode-errorForeground); margin-top: 4px; }
  .row { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
  select, button { font: inherit; color: var(--vscode-button-secondaryForeground);
                   background: var(--vscode-button-secondaryBackground);
                   border: 1px solid var(--vscode-button-border, transparent);
                   border-radius: 4px; padding: 3px 8px; }
  button.primary { color: var(--vscode-button-foreground);
                   background: var(--vscode-button-background); }
  button[disabled] { opacity: 0.5; }
  .empty { opacity: 0.7; }
</style>
</head>
<body>
<div id="root"><p class="empty">No pending approvals.</p></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");
  const esc = (s) => String(s).replace(/[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // pendingCardView.ts の formatRelativeTime と同じ粒度。
  // createdAt は ISO 文字列。パース不能なら "—"、未来時刻は 0 に丸める。
  function formatRelativeTime(createdAt, nowMs) {
    const targetMs = Date.parse(createdAt);
    if (Number.isNaN(targetMs)) return "—";
    const deltaSec = Math.max(0, Math.round((nowMs - targetMs) / 1000));
    if (deltaSec < 60) return deltaSec + "s ago";
    const deltaMin = Math.floor(deltaSec / 60);
    if (deltaMin < 60) return deltaMin + "m ago";
    const deltaHr = Math.floor(deltaMin / 60);
    if (deltaHr < 24) return deltaHr + "h ago";
    return Math.floor(deltaHr / 24) + "d ago";
  }

  // state メッセージごとの再描画が select を selectedScope に巻き戻すと、
  // ユーザーが選んだ scope が黙って差し替わる。選択を key 単位で保持し、
  // 描画時に優先する。
  const selections = {};

  function render(cards) {
    if (!cards.length) {
      root.innerHTML = '<p class="empty">No pending approvals.</p>';
      return;
    }
    root.innerHTML = cards.map((c) => {
      const chosen = selections[c.key] ?? c.selectedScope;
      const opts = c.scopes.map((s) =>
        '<option value="' + esc(s.value) + '"' +
        (s.value === chosen ? " selected" : "") + ">" +
        esc(s.label) + "</option>").join("");
      const meta = c.meta.map((m) =>
        '<div class="meta"><b>' + esc(m.label) + ":</b> " + esc(m.value) +
        "</div>").join("");
      const reason = c.reason
        ? '<div class="reason">' + esc(c.reason.label) +
          (c.reason.hint ? " — " + esc(c.reason.hint) : "") + "</div>" : "";
      const viol = c.violations.length
        ? '<div class="viol">violations: ' +
          c.violations.map((v) => esc(v.label)).join("; ") + "</div>" : "";
      const warn = c.warning
        ? '<div class="warning">&#9888; ' + esc(c.warning) + "</div>" : "";
      const elapsed = c.createdAt
        ? '<span class="elapsed" data-created="' + esc(c.createdAt) + '">' +
          esc(formatRelativeTime(c.createdAt, Date.now())) + "</span>"
        : "";
      return '<div class="card" data-key="' + esc(c.key) + '">' +
        '<div class="title-row"><div class="title">' + esc(c.title) +
        "</div>" + elapsed + "</div>" +
        meta + reason + viol + warn +
        '<div class="row"><select>' + opts + "</select>" +
        '<button class="primary" data-act="approve">Approve</button>' +
        '<button data-act="deny">Deny this request only</button></div>' +
        '<div class="err"></div></div>';
    }).join("");
  }

  // watch イベントの間で経過時間が古くならないよう、ラベルだけ定期的に
  // 再計算する。カード全体を再描画すると開いている select が閉じるので、
  // textContent の更新に留める。
  function refreshElapsed() {
    const now = Date.now();
    for (const el of root.querySelectorAll(".elapsed[data-created]")) {
      el.textContent = formatRelativeTime(el.dataset.created, now);
    }
  }
  setInterval(refreshElapsed, 15000);

  root.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const cardEl = btn.closest(".card");
    const key = cardEl.dataset.key;
    const card = lastCards.find((c) => c.key === key);
    if (!card) return;
    for (const b of cardEl.querySelectorAll("button")) b.disabled = true;
    vscode.postMessage({
      type: "decide",
      key,
      domain: card.domain,
      action: btn.dataset.act,
      sessionId: card.sessionId,
      requestId: card.requestId,
      scope: cardEl.querySelector("select").value,
    });
  });

  root.addEventListener("change", (e) => {
    const sel = e.target.closest("select");
    if (!sel) return;
    const cardEl = sel.closest(".card");
    if (cardEl) selections[cardEl.dataset.key] = sel.value;
  });

  let lastCards = [];
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "state") {
      lastCards = m.cards;
      // 消えたカードの選択記録を掃除する。
      const keys = new Set(m.cards.map((c) => c.key));
      for (const k of Object.keys(selections)) {
        if (!keys.has(k)) delete selections[k];
      }
      render(m.cards);
    }
    if (m.type === "error") {
      const el = document.querySelector(
        '.card[data-key="' + CSS.escape(m.key) + '"] .err');
      if (el) {
        el.textContent = m.message;
        for (const b of el.closest(".card").querySelectorAll("button"))
          b.disabled = false;
      }
    }
  });
  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}

module.exports = { renderShell };
