import { useCallback, useEffect, useRef, useState } from "preact/hooks";

export function TerminalTabLabel({
  sessionId,
  sessionName,
  isActive,
  onRenameSession,
  onDone,
}: {
  sessionId: string;
  sessionName?: string;
  isActive: boolean;
  onRenameSession: (sessionId: string, name: string) => Promise<void> | void;
  onDone?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(sessionName ?? "");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the input explicitly after entering edit mode.
  // autoFocus alone doesn't work because the parent button's
  // onMouseDown={preventFocusSteal} calls preventDefault() on the
  // double-click's mousedown events, suppressing browser focus transfer.
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
    }
  }, [editing]);

  const handleSave = useCallback(async () => {
    const next = value.trim();
    if (!next) return;
    setSaving(true);
    try {
      await onRenameSession(sessionId, next);
      setEditing(false);
      onDone?.();
    } catch (e) {
      console.error("Failed to rename session from terminal:", e);
    } finally {
      setSaving(false);
    }
  }, [onDone, onRenameSession, sessionId, value]);

  if (editing) {
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: wrapper only stops event propagation; actual controls are the child input/buttons
      <span
        role="presentation"
        class="terminal-session-name-editor"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          type="text"
          value={value}
          class="terminal-session-name-input"
          ref={inputRef}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleSave();
            if (e.key === "Escape") {
              setEditing(false);
              onDone?.();
            }
          }}
          disabled={saving}
        />
        <button
          type="button"
          class="btn btn-ghost terminal-session-name-save"
          disabled={saving || !value.trim()}
          onClick={() => void handleSave()}
        >
          {saving ? "..." : "OK"}
        </button>
        <button
          type="button"
          class="btn btn-ghost terminal-session-name-cancel"
          disabled={saving}
          onClick={() => {
            setEditing(false);
            onDone?.();
          }}
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dblclick-to-rename is a power-user shortcut; primary tab activation is the surrounding button
    <span
      role="presentation"
      class="terminal-modal-tab-label"
      onDblClick={
        isActive
          ? (e) => {
              e.stopPropagation();
              setValue(sessionName ?? "");
              setEditing(true);
            }
          : undefined
      }
      title={isActive ? "Double-click to rename" : undefined}
    >
      {sessionName || sessionId}
    </span>
  );
}
