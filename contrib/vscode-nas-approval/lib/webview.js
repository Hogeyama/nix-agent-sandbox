const crypto = require("node:crypto");
const vscode = require("vscode");
const { renderShell } = require("./webviewHtml.js");

class ApprovalsPanel {
  // getCards(): view model 配列を返す関数。onDecision(msg): decide を処理。
  static show(context, { getCards, onDecision }) {
    if (ApprovalsPanel.current) {
      ApprovalsPanel.current.panel.reveal();
      ApprovalsPanel.current.update(getCards());
      return ApprovalsPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      "nasApprovals",
      "nas approvals",
      vscode.ViewColumn.Active,
      { enableScripts: true },
    );
    context.subscriptions.push(panel); // deactivate 時に panel を dispose
    const instance = new ApprovalsPanel(panel, getCards, onDecision);
    ApprovalsPanel.current = instance;
    panel.onDidDispose(() => {
      ApprovalsPanel.current = null;
    });
    return instance;
  }

  constructor(panel, getCards, onDecision) {
    this.panel = panel;
    const nonce = crypto.randomBytes(16).toString("hex");
    panel.webview.html = renderShell(nonce);
    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === "ready") this.update(getCards());
      if (msg?.type === "decide") {
        try {
          await onDecision(msg);
        } catch (err) {
          this.postError(msg.key, String(err?.message ?? err));
        }
      }
    });
  }

  update(cards) {
    this.panel.webview.postMessage({ type: "state", cards });
  }

  postError(key, message) {
    this.panel.webview.postMessage({ type: "error", key, message });
  }
}

module.exports = { ApprovalsPanel };
