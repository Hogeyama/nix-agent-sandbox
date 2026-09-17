const vscode = require("vscode");
const { runNas, spawnNasWatch } = require("./lib/nasCli");
const { parseDevcontainerStatus, readySessionId } = require("./lib/session");
const {
  makeWatchState,
  applyWatchEvent,
  pendingCount,
} = require("./lib/watchState");
const { cardViewModel } = require("./lib/cards");
const { decisionArgv } = require("./lib/decision");
const { ApprovalsPanel } = require("./lib/webview");

const POLL_MS = 30_000;
const DOMAINS = ["hostexec", "network"];

function activate(context) {
  // nas Dev Container 以外 (local / SSH / WSL / web) では何もしない。
  if (vscode.env.remoteName !== "dev-container") return;

  const nasPath = () =>
    vscode.workspace.getConfiguration("nas-approval").get("nasPath", "nas");
  const output = vscode.window.createOutputChannel("nas approval");
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    10,
  );
  statusBar.command = "nas-approval.review";
  context.subscriptions.push(statusBar, output);

  // fsPath -> { sessionId, watchState, watchers, pollTimer, gaveUp, dead, resolving }
  const folders = new Map();
  let lastTotal = 0;
  let panel = null; // ApprovalsPanel.show() のシングルトン参照

  const collectCards = () => {
    const cards = [];
    for (const f of folders.values()) {
      for (const domain of DOMAINS) {
        for (const entry of f.watchState[domain].values()) {
          const vm = cardViewModel(domain, entry);
          if (vm) cards.push(vm);
        }
      }
    }
    return cards;
  };

  const refreshUi = () => {
    const total = [...folders.values()].reduce(
      (n, f) => n + pendingCount(f.watchState),
      0,
    );
    const watching = [...folders.values()].some((f) => f.sessionId);
    if (watching) {
      statusBar.text =
        total > 0 ? `$(bell-dot) nas: ${total}` : "$(shield) nas";
      statusBar.backgroundColor =
        total > 0
          ? new vscode.ThemeColor("statusBarItem.warningBackground")
          : undefined;
      statusBar.show();
    } else {
      statusBar.hide();
    }
    if (total > 0 && lastTotal === 0) {
      vscode.window
        .showWarningMessage(`nas: ${total} pending approval(s)`, "Review")
        .then((pick) => {
          if (pick === "Review")
            vscode.commands.executeCommand("nas-approval.review");
        });
    }
    lastTotal = total;
    panel?.update(collectCards());
  };

  const stopWatchers = (f) => {
    for (const w of f.watchers) w.kill("SIGTERM");
    f.watchers = [];
    f.watchState = makeWatchState();
    f.sessionId = null;
  };

  const schedulePoll = (fsPath, f) => {
    if (f.pollTimer || f.gaveUp || f.dead) return;
    f.pollTimer = setTimeout(() => {
      f.pollTimer = null;
      resolveSession(fsPath, f);
    }, POLL_MS);
  };

  const startWatchers = (fsPath, f, sessionId) => {
    if (f.dead) return;
    f.sessionId = sessionId;
    for (const domain of DOMAINS) {
      f.watchers.push(
        spawnNasWatch(nasPath(), domain, sessionId, {
          onLine: (line) => {
            try {
              if (applyWatchEvent(f.watchState, JSON.parse(line))) refreshUi();
            } catch {
              // 壊れた行は捨てる。購読自体は継続する。
            }
          },
          onError: (msg) => output.appendLine(`[${domain}] ${msg.trimEnd()}`),
          onExit: () => {
            // teardown 済み (rescan で除去 / dispose) なら再起動しない。
            if (f.dead) return;
            // EOF はセッション終了。次のセッションを待つ。
            stopWatchers(f);
            refreshUi();
            schedulePoll(fsPath, f);
          },
        }),
      );
    }
  };

  const resolveSession = async (fsPath, f) => {
    if (f.dead || f.resolving) return;
    f.resolving = true;
    try {
      let out;
      try {
        out = await runNas(nasPath(), [
          "devcontainer",
          "status",
          "--workspace",
          fsPath,
          "--json",
        ]);
      } catch (err) {
        if (err.code === "ENOENT") {
          f.gaveUp = true; // nas 不在: この folder では諦める
          return;
        }
        output.appendLine(`status failed for ${fsPath}: ${err.message}`);
        schedulePoll(fsPath, f);
        return;
      }
      let status;
      try {
        status = parseDevcontainerStatus(out);
      } catch {
        output.appendLine(`unparseable status for ${fsPath}`);
        schedulePoll(fsPath, f);
        return;
      }
      if (status === null) {
        f.gaveUp = true; // nas 管理外の workspace: 以後ポーリングしない
        return;
      }
      const sid = readySessionId(status);
      if (sid) startWatchers(fsPath, f, sid);
      else schedulePoll(fsPath, f);
      refreshUi();
    } finally {
      f.resolving = false;
    }
  };

  const rescan = () => {
    const open = new Set(
      (vscode.workspace.workspaceFolders ?? []).map((w) => w.uri.fsPath),
    );
    for (const fsPath of open) {
      if (!folders.has(fsPath)) {
        folders.set(fsPath, {
          sessionId: null,
          watchState: makeWatchState(),
          watchers: [],
          pollTimer: null,
          gaveUp: false,
          dead: false,
          resolving: false,
        });
      }
      const f = folders.get(fsPath);
      if (!f.sessionId && !f.pollTimer && !f.gaveUp) resolveSession(fsPath, f);
    }
    for (const [fsPath, f] of folders) {
      if (!open.has(fsPath)) {
        f.dead = true; // SIGTERM した子の close → onExit で再ポーリングしない
        if (f.pollTimer) clearTimeout(f.pollTimer);
        stopWatchers(f);
        folders.delete(fsPath);
      }
    }
    refreshUi();
  };

  rescan();
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(rescan),
    vscode.commands.registerCommand("nas-approval.refresh", () => {
      for (const f of folders.values()) f.gaveUp = false;
      rescan();
    }),
    vscode.commands.registerCommand("nas-approval.review", () => {
      const cards = collectCards();
      if (cards.length === 0) {
        vscode.window.showInformationMessage("No pending nas approvals.");
        return;
      }
      panel = ApprovalsPanel.show(context, {
        getCards: collectCards,
        onDecision: async (msg) => {
          const argv = decisionArgv(msg); // 検証失敗は throw → カードにエラー表示
          await runNas(nasPath(), argv);
        },
      });
      panel.update(cards);
    }),
    {
      dispose: () => {
        for (const f of folders.values()) {
          f.dead = true;
          if (f.pollTimer) clearTimeout(f.pollTimer);
          stopWatchers(f);
        }
      },
    },
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
