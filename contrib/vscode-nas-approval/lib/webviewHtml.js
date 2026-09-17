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
  .title { font-weight: 600; word-break: break-all; }
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

  function render(cards) {
    if (!cards.length) {
      root.innerHTML = '<p class="empty">No pending approvals.</p>';
      return;
    }
    root.innerHTML = cards.map((c) => {
      const opts = c.scopes.map((s) =>
        '<option value="' + esc(s.value) + '"' +
        (s.value === c.selectedScope ? " selected" : "") + ">" +
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
      return '<div class="card" data-key="' + esc(c.key) + '">' +
        '<div class="title">' + esc(c.title) + "</div>" +
        meta + reason + viol + warn +
        '<div class="row"><select>' + opts + "</select>" +
        '<button class="primary" data-act="approve">Approve</button>' +
        '<button data-act="deny">Deny</button></div>' +
        '<div class="err"></div></div>';
    }).join("");
  }

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

  let lastCards = [];
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "state") { lastCards = m.cards; render(m.cards); }
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
