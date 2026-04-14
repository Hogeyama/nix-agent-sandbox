import type { Terminal } from "@xterm/xterm";

const FORWARDED_CTRL_KEYS = new Set(["a", "e", "w"]);

function shouldForwardCtrlShortcut(event: KeyboardEvent): boolean {
  if (event.type !== "keydown") return false;
  if (!event.ctrlKey || event.altKey || event.metaKey) return false;
  return FORWARDED_CTRL_KEYS.has(event.key.toLowerCase());
}

/**
 * xterm.js の hidden textarea にフォーカスがあるか判定する。
 * xterm は内部的に .xterm-helper-textarea クラスの textarea を使う。
 */
function isTerminalFocused(): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLTextAreaElement &&
    active.classList.contains("xterm-helper-textarea")
  );
}

/**
 * ターミナルにフォーカスがなければ focus() を呼ぶ。
 * 過剰な focus() 呼び出しを避けるためにチェックを挟む。
 */
export function ensureTerminalFocus(term: Terminal): void {
  if (!isTerminalFocused()) {
    term.focus();
  }
}

export function setupTerminalInputForwarding(
  term: Terminal,
  container: HTMLElement,
  extraKeyHandler?: (event: KeyboardEvent) => boolean,
): () => void {
  term.attachCustomKeyEventHandler((event) => {
    if (extraKeyHandler && extraKeyHandler(event) === false) {
      return false;
    }
    if (shouldForwardCtrlShortcut(event)) {
      event.preventDefault();
      event.stopPropagation();
    }
    return true;
  });

  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    term.focus();
  };
  container.addEventListener("contextmenu", onContextMenu);

  // コンテナ内クリックで xterm textarea にフォーカスを戻す。
  // xterm は canvas 上のクリックを処理するが、
  // container 自体やパディング領域をクリックした場合に備える。
  const onMouseDown = (_event: MouseEvent) => {
    // rAF でクリック処理後にフォーカスを確認・復帰
    requestAnimationFrame(() => ensureTerminalFocus(term));
  };
  container.addEventListener("mousedown", onMouseDown);

  return () => {
    container.removeEventListener("contextmenu", onContextMenu);
    container.removeEventListener("mousedown", onMouseDown);
  };
}
