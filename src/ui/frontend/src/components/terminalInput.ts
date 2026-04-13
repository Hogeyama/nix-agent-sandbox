import type { Terminal } from "@xterm/xterm";

const FORWARDED_CTRL_KEYS = new Set(["a", "e", "w"]);

function shouldForwardCtrlShortcut(event: KeyboardEvent): boolean {
  if (event.type !== "keydown") return false;
  if (!event.ctrlKey || event.altKey || event.metaKey) return false;
  return FORWARDED_CTRL_KEYS.has(event.key.toLowerCase());
}

export function setupTerminalInputForwarding(
  term: Terminal,
  container: HTMLElement,
): () => void {
  term.attachCustomKeyEventHandler((event) => {
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

  return () => {
    container.removeEventListener("contextmenu", onContextMenu);
  };
}
