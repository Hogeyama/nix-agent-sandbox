// Webview の骨格 HTML を返す純粋関数。カードの view model は
// extension 側から postMessage で届き、インラインスクリプトが DOM を描く。
//
// 見た目は nas ui (src/ui/frontend/src/styles.css) の pending card を
// vscode のテーマ変数に写したもの。palette だけここで定義し、
// レイアウトのルールは nas ui の class 名をそのまま使う。
function renderShell(nonce) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  /* 色はすべて vscode テーマ変数から取る。nas ui の palette 名だけ残し、
     値の決定はテーマに任せる (alpha だけ color-mix で合成)。 */
  :root {
    --surface: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    --surface-2: var(--vscode-list-hoverBackground, var(--surface));
    --line: var(--vscode-panel-border, var(--vscode-widget-border));
    --line-soft: var(--line);
    --ink: var(--vscode-editor-background);
    --cream: var(--vscode-foreground);
    --cream-dim: var(--vscode-foreground);
    --muted: var(--vscode-descriptionForeground);
    --muted-2: var(--vscode-disabledForeground, var(--muted));
    --amber: var(--vscode-editorWarning-foreground, var(--vscode-charts-orange));
    --amber-hi: var(--vscode-editorWarning-foreground, var(--amber));
    --rose: var(--vscode-errorForeground);
    --mono: var(--vscode-editor-font-family, monospace);
  }
  body {
    font-family: var(--vscode-font-family);
    color: var(--cream);
    background: var(--vscode-editor-background);
    padding: 12px;
  }

  .empty {
    margin: 10px 4px 0;
    padding: 14px;
    border: 1px dashed var(--line);
    text-align: center;
    font-size: 11px;
    color: var(--muted-2);
    letter-spacing: 0.06em;
  }

  .card {
    margin: 0 0 12px;
    background: var(--surface);
    border: 1px solid var(--line);
    padding: 12px 14px 12px;
    position: relative;
  }
  .card:hover {
    background: var(--surface-2);
  }
  .card::before {
    content: "";
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--amber);
    opacity: 0.5;
  }

  .card-head {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 4px 8px;
    margin-bottom: 10px;
  }
  .card-head .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    min-width: 0;
  }
  .chip {
    display: inline-block;
    padding: 2px 8px;
    font-size: 10px;
    letter-spacing: 0.12em;
    border: 1px solid var(--line);
    color: var(--cream-dim);
    background: var(--ink);
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .card-time {
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted-2);
    white-space: nowrap;
  }

  .card-req {
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 500;
    line-height: 1.45;
    color: var(--cream);
    margin: 0 0 12px;
    word-break: break-all;
  }
  .card-req .verb {
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.2em;
    color: var(--amber-hi);
    padding: 1px 6px;
    border: 1px solid currentColor;
    margin-right: 8px;
    vertical-align: 1px;
    text-transform: uppercase;
  }

  .card-ask-reason {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 8px;
    min-width: 0;
    margin: 0 0 10px;
    font-size: 11px;
    color: var(--cream-dim);
    overflow-wrap: anywhere;
  }
  .card-ask-reason-label {
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--amber-hi);
  }
  .card-warning {
    margin: 0 0 10px;
    font-size: 11px;
    color: var(--amber-hi);
  }

  .card-review-context {
    border: 1px solid var(--line);
    border-radius: 4px;
    margin: 0 0 10px;
    overflow: hidden;
  }
  .card-review-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    padding: 5px 8px;
    font-size: 11px;
    color: var(--cream-dim);
  }
  .card-review-meta > span {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .card-review-ct,
  .card-review-size {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  /* 承認が覚える違反 1 件ごとに 1 ブロック。headline は押す人が
     訊かれている値そのものなので先頭に置く。 */
  .card-violations {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0 0 10px;
  }
  .card-violation {
    border: 1px solid var(--line);
    border-radius: 4px;
    overflow: hidden;
  }
  .card-violation-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 8px;
    padding: 5px 8px;
    font-size: 11px;
    border-bottom: 1px solid var(--line-soft);
  }
  .card-violation-value {
    color: var(--amber-hi);
    word-break: break-all;
  }
  .card-violation-count {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .card-violation-at {
    margin-left: auto;
    color: var(--muted);
    word-break: break-all;
  }
  .card-violation-pointer {
    padding: 4px 8px;
    font-size: 11px;
    color: var(--cream-dim);
    word-break: break-all;
  }
  .card-violation-excerpt {
    margin: 0;
    padding: 6px 8px;
    font-size: 11px;
    line-height: 1.5;
    color: var(--cream);
    font-family: var(--mono);
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 160px;
    overflow-y: auto;
    border-top: 1px solid var(--line-soft);
  }

  .hostexec-match {
    display: grid;
    gap: 5px;
    margin: 0 0 10px;
  }
  .hostexec-match-row {
    display: grid;
    grid-template-columns: minmax(80px, 0.45fr) minmax(0, 1fr);
    gap: 8px;
    font-size: 10px;
  }
  .hostexec-match-row dt,
  .hostexec-match-row dd {
    min-width: 0;
    margin: 0;
    overflow-wrap: anywhere;
  }
  .hostexec-match-row dt {
    color: var(--muted);
  }
  .hostexec-match-row dd {
    color: var(--cream-dim);
  }

  .scope-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 10px;
    padding-bottom: 10px;
    border-bottom: 1px dashed var(--line);
  }
  .scope-row.hostexec-scope-row {
    flex-direction: column;
    border-bottom: 0;
    padding-bottom: 0;
  }
  .scope {
    padding: 4px 10px;
    border: 1px solid var(--line);
    background: transparent;
    color: var(--muted);
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    cursor: pointer;
  }
  .scope:hover {
    color: var(--cream);
    border-color: var(--muted);
  }
  .scope.selected {
    color: var(--amber-hi);
    border-color: var(--amber);
    background: color-mix(in srgb, var(--amber) 10%, transparent);
  }
  .scope:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
  .scope.hostexec-scope {
    width: 100%;
    text-align: left;
    text-transform: none;
    letter-spacing: 0.02em;
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .action-row {
    display: flex;
    gap: 8px;
  }
  .action-row + .action-row {
    margin-top: 10px;
    border-top: 1px dashed var(--line);
    padding-top: 10px;
  }
  .action {
    flex: 1;
    padding: 8px 12px;
    border: 1px solid currentColor;
    background: transparent;
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    cursor: pointer;
  }
  .action.approve {
    color: var(--amber-hi);
  }
  .action.approve:hover {
    background: color-mix(in srgb, var(--amber-hi) 15%, transparent);
  }
  .action.deny {
    color: var(--rose);
  }
  .action.deny:hover {
    background: color-mix(in srgb, var(--rose) 12%, transparent);
  }
  .action:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
  .action:disabled:hover {
    background: transparent;
  }

  .card-error {
    margin: 8px 0 0;
    color: var(--rose);
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.04em;
    word-break: break-word;
  }
</style>
</head>
<body>
<div id="root"><p class="empty">No pending approvals.</p></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");
  const esc = (s) => String(s).replace(/[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

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

  // state メッセージごとの再描画で scope 選択が巻き戻らないよう、
  // ユーザーが選んだ scope を key 単位で保持し、描画時に優先する。
  const selections = {};

  function scopeChips(c, chosen) {
    return c.scopes.map((s) =>
      '<button type="button" class="scope' +
      (c.domain === "hostexec" ? " hostexec-scope" : "") +
      (s.value === chosen ? " selected" : "") +
      '" data-scope="' + esc(s.value) + '"' +
      (s.hint ? ' title="' + esc(s.hint) + '"' : "") +
      ">" + esc(s.label) + "</button>").join("");
  }

  function effectLine(c, chosen) {
    const s = c.scopes.find((x) => x.value === chosen) ?? c.scopes[0];
    const label = c.domain === "hostexec" ? "This approval" : "This action";
    return '<p class="card-ask-reason">' +
      '<span class="card-ask-reason-label">' + label + "</span>" +
      '<span class="effect">' + esc(s ? s.effect : "") + "</span></p>";
  }

  function violationBlock(v) {
    return '<div class="card-violation">' +
      '<div class="card-violation-head">' +
      '<span class="card-violation-value">' + esc(v.headline) + "</span>" +
      (v.count > 1
        ? '<span class="card-violation-count">×' + esc(v.count) + "</span>"
        : "") +
      (v.at
        ? '<span class="card-violation-at">' + esc(v.at) + "</span>"
        : "") +
      "</div>" +
      (v.pointer
        ? '<div class="card-violation-pointer">' + esc(v.pointer) + "</div>"
        : "") +
      (v.excerpt
        ? '<pre class="card-violation-excerpt">' + esc(v.excerpt) + "</pre>"
        : "") +
      "</div>";
  }

  function render(cards) {
    if (!cards.length) {
      root.innerHTML = '<p class="empty">No pending approvals.</p>';
      return;
    }
    root.innerHTML = cards.map((c) => {
      const chosen = selections[c.key] ?? c.selectedScope;
      const chips =
        '<span class="chip">' + esc(c.sessionShortId || c.sessionId) +
        "</span>" +
        (c.ruleId
          ? '<span class="chip" title="Rule that raised this confirmation">' +
            esc(c.ruleId) + "</span>"
          : "");
      const elapsed = c.createdAt
        ? '<span class="card-time" data-created="' + esc(c.createdAt) + '">' +
          esc(formatRelativeTime(c.createdAt, Date.now())) + "</span>"
        : "";
      const reason = c.reason
        ? '<p class="card-ask-reason"' +
          (c.reason.hint ? ' title="' + esc(c.reason.hint) + '"' : "") +
          '><span class="card-ask-reason-label">why</span>' +
          esc(c.reason.label) + "</p>"
        : "";
      const review = c.reviewContext
        ? '<div class="card-review-context"><div class="card-review-meta">' +
          "<span>" + esc(c.reviewContext.path) + "</span>" +
          (c.reviewContext.contentType
            ? '<span class="card-review-ct">' +
              esc(c.reviewContext.contentType) + "</span>"
            : "") +
          (c.reviewContext.bodySize != null
            ? '<span class="card-review-size">' +
              esc(c.reviewContext.bodySize) + "B</span>"
            : "") +
          "</div></div>"
        : "";
      const warn = c.warning
        ? '<p class="card-warning">&#9888; ' + esc(c.warning) + "</p>"
        : "";
      const viol = c.violations.length
        ? '<div class="card-violations">' +
          c.violations.map(violationBlock).join("") + "</div>"
        : "";
      const match = (c.matchDetails ?? []).length
        ? '<dl class="hostexec-match">' +
          c.matchDetails.map((d) =>
            '<div class="hostexec-match-row"><dt>' + esc(d.label) +
            "</dt><dd>" + esc(d.value) + "</dd></div>").join("") +
          "</dl>"
        : "";
      const isHostExec = c.domain === "hostexec";
      const scopeRow =
        '<div class="scope-row' + (isHostExec ? " hostexec-scope-row" : "") +
        '">' +
        (isHostExec
          ? '<span class="card-ask-reason-label">Approve scope</span>'
          : "") +
        scopeChips(c, chosen) + "</div>";
      const actions = isHostExec
        ? '<div class="action-row">' +
          '<button type="button" class="action approve" data-act="approve">' +
          "Approve</button></div>" +
          '<div class="action-row">' +
          '<button type="button" class="action deny" data-act="deny">' +
          "Deny this request only</button></div>"
        : '<div class="action-row">' +
          '<button type="button" class="action approve" data-act="approve">' +
          "Allow</button>" +
          '<button type="button" class="action deny" data-act="deny">' +
          "Deny</button></div>";
      return '<article class="card" data-key="' + esc(c.key) + '">' +
        '<div class="card-head"><span class="chips">' + chips + "</span>" +
        elapsed + "</div>" +
        '<p class="card-req"><span class="verb">' + esc(c.verb) + "</span>" +
        esc(c.summary) + "</p>" +
        reason + review + warn + viol + match +
        scopeRow + effectLine(c, chosen) + actions +
        '<p class="card-error" hidden></p></article>';
    }).join("");
  }

  // watch イベントの間で経過時間が古くならないよう、ラベルだけ定期的に
  // 再計算する。カード全体を再描画すると操作途中の状態が飛ぶので、
  // textContent の更新に留める。
  function refreshElapsed() {
    const now = Date.now();
    for (const el of root.querySelectorAll(".card-time[data-created]")) {
      el.textContent = formatRelativeTime(el.dataset.created, now);
    }
  }
  setInterval(refreshElapsed, 15000);

  root.addEventListener("click", (e) => {
    const cardEl = e.target.closest(".card");
    if (!cardEl) return;
    const key = cardEl.dataset.key;
    const card = lastCards.find((c) => c.key === key);
    if (!card) return;

    const scopeBtn = e.target.closest("button.scope[data-scope]");
    if (scopeBtn) {
      // 再描画なしで選択と説明文だけ更新する。
      selections[key] = scopeBtn.dataset.scope;
      for (const b of cardEl.querySelectorAll("button.scope"))
        b.classList.toggle("selected", b === scopeBtn);
      const eff = cardEl.querySelector(".effect");
      const s = card.scopes.find((x) => x.value === scopeBtn.dataset.scope);
      if (eff && s) eff.textContent = s.effect;
      return;
    }

    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    for (const b of cardEl.querySelectorAll("button")) b.disabled = true;
    // 保持していた選択が今のカードの scope に無ければ既定へ落とす。
    const chosen = selections[key];
    const scope = card.scopes.some((s) => s.value === chosen)
      ? chosen
      : card.selectedScope;
    vscode.postMessage({
      type: "decide",
      key,
      domain: card.domain,
      action: btn.dataset.act,
      sessionId: card.sessionId,
      requestId: card.requestId,
      scope,
    });
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
        '.card[data-key="' + CSS.escape(m.key) + '"] .card-error');
      if (el) {
        el.hidden = false;
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
