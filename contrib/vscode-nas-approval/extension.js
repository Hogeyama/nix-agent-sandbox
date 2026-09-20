const vscode = require("vscode");
const {
  runNas,
  spawnNasWatch,
  resolveNasCommand,
  clearResolvedCommandCache,
  extractWslDistroFromAuthority,
} = require("./lib/nasCli");
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
  const nasPath = () =>
    vscode.workspace.getConfiguration("nas-approval").get("nasPath", "nas");
  const output = vscode.window.createOutputChannel("nas approval");
  output.appendLine(
    `activated (remoteName=${JSON.stringify(vscode.env.remoteName)}; nasPath="${nasPath()}")`,
  );
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

  const startWatchers = async (fsPath, f, sessionId) => {
    if (f.dead) return;
    f.sessionId = sessionId;
    const command = await resolveNasCommand(nasPath(), f.distroHint, (msg) =>
      output.appendLine(msg),
    );
    if (f.dead) return; // folder could have closed while resolving
    for (const domain of DOMAINS) {
      f.watchers.push(
        spawnNasWatch(command, domain, sessionId, {
          onLine: (line) => {
            try {
              if (applyWatchEvent(f.watchState, JSON.parse(line))) refreshUi();
            } catch {
              // 壊れた行は捨てる。購読自体は継続する。
            }
          },
          onError: (msg) => output.appendLine(`[${domain}] ${msg.trimEnd()}`),
          onExit: (code) => {
            // teardown 済み (rescan で除去 / dispose) なら再起動しない。
            if (f.dead) return;
            output.appendLine(
              `[${domain}] watch for session ${sessionId} exited (code ${code}); will re-poll ${fsPath}`,
            );
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
      const command = await resolveNasCommand(nasPath(), f.distroHint, (msg) =>
        output.appendLine(msg),
      );
      let out;
      try {
        out = await runNas(command, [
          "devcontainer",
          "status",
          "--workspace",
          f.workspacePath,
          "--json",
        ]);
      } catch (err) {
        if (err.code === "ENOENT") {
          // nas 不在: この folder では諦める。Windows+WSL2+Dev Container の
          // 三重構成では、UI extensionKind は常に一番外側 (Windows) で動くので、
          // nas が別のリモート層 (WSL) にしかいないとここに来る。
          f.gaveUp = true;
          output.appendLine(
            `giving up on ${fsPath}: "${command}" was not found (${err.message}). ` +
              `Set nas-approval.nasPath explicitly, then run "NAS: Refresh Approval Session".`,
          );
          return;
        }
        output.appendLine(`status failed for ${fsPath}: ${err.message}`);
        schedulePoll(fsPath, f);
        return;
      }
      let status;
      try {
        status = parseDevcontainerStatus(out);
      } catch (err) {
        output.appendLine(
          `unparseable status for ${fsPath}: ${err.message}. Raw output: ${out.trim()}`,
        );
        schedulePoll(fsPath, f);
        return;
      }
      if (status === null) {
        // nas 管理外の workspace: 以後ポーリングしない。
        f.gaveUp = true;
        output.appendLine(
          `giving up on ${fsPath}: not a nas-managed workspace (devcontainer status returned null)`,
        );
        return;
      }
      const sid = readySessionId(status);
      if (sid) {
        output.appendLine(`session ${sid} ready for ${fsPath}; watching`);
        await startWatchers(fsPath, f, sid);
      } else {
        output.appendLine(
          `${fsPath}: phase=${status.phase}, not ready yet; will retry in ${POLL_MS / 1000}s`,
        );
        schedulePoll(fsPath, f);
      }
      refreshUi();
    } finally {
      f.resolving = false;
    }
  };

  const rescan = () => {
    const folderList = vscode.workspace.workspaceFolders ?? [];
    const open = new Set(folderList.map((w) => w.uri.fsPath));
    for (const w of folderList) {
      const fsPath = w.uri.fsPath;
      if (!folders.has(fsPath)) {
        const distroHint = extractWslDistroFromAuthority(w.uri.authority);
        if (distroHint) {
          output.appendLine(
            `${fsPath}: WSL distro from workspace: ${distroHint}`,
          );
        }
        folders.set(fsPath, {
          sessionId: null,
          distroHint,
          // .fsPath is a Windows-style path on Windows+WSL2, meaningless to
          // nas running inside WSL. .path is always POSIX per the URI spec
          // (an official, stable part of the vscode.Uri API), so it's what
          // nas actually needs regardless of platform.
          workspacePath: w.uri.path,
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
      // gaveUp と一緒に WSL 解決キャッシュも捨てないと、activate 時点で
      // 失敗した自動検出 (distro に nas が無かった等) が Refresh 後も
      // キャッシュに残って再試行されない。
      clearResolvedCommandCache();
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
          const owner = [...folders.values()].find(
            (f) => f.sessionId === msg.sessionId,
          );
          const command = await resolveNasCommand(
            nasPath(),
            owner?.distroHint,
            (m) => output.appendLine(m),
          );
          await runNas(command, argv);
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
