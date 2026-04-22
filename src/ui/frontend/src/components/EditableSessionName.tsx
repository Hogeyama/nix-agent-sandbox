import { useState } from "preact/hooks";
import {
  nameCancelBtnStyle,
  nameInputStyle,
  nameSaveBtnStyle,
} from "./containersTab.styles.ts";

export function EditableSessionName({
  sessionId,
  currentName,
  fallbackName,
  onRename,
}: {
  sessionId: string;
  currentName?: string;
  fallbackName?: string;
  onRename?: (sessionId: string, name: string) => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentName ?? "");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!onRename || !value.trim()) return;
    setSaving(true);
    try {
      await onRename(sessionId, value.trim());
      setEditing(false);
    } catch (e) {
      console.error("Rename failed:", e);
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    if (!onRename) {
      return (
        <>
          {currentName || fallbackName || (
            <span style={{ color: "#64748b" }}>-</span>
          )}
        </>
      );
    }

    return (
      <button
        type="button"
        style={{
          cursor: "pointer",
          border: 0,
          padding: 0,
          background: "transparent",
          color: "inherit",
          font: "inherit",
          textAlign: "left",
          borderBottom: "1px dashed #475569",
        }}
        onClick={(e) => {
          e.stopPropagation();
          setValue(currentName ?? "");
          setEditing(true);
        }}
      >
        {currentName || fallbackName || (
          <span style={{ color: "#64748b" }}>-</span>
        )}
      </button>
    );
  }

  return (
    <span style={{ display: "inline-flex", gap: "4px", alignItems: "center" }}>
      <input
        type="text"
        value={value}
        onInput={(e) => setValue((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void handleSave();
          if (e.key === "Escape") setEditing(false);
        }}
        onClick={(e) => e.stopPropagation()}
        disabled={saving}
        style={nameInputStyle}
        // biome-ignore lint/a11y/noAutofocus: intentional for inline edit
        autoFocus
      />
      <button
        type="button"
        style={nameSaveBtnStyle}
        disabled={saving || !value.trim()}
        onClick={(e) => {
          e.stopPropagation();
          void handleSave();
        }}
      >
        {saving ? "..." : "OK"}
      </button>
      <button
        type="button"
        style={nameCancelBtnStyle}
        disabled={saving}
        onClick={(e) => {
          e.stopPropagation();
          setEditing(false);
        }}
      >
        Cancel
      </button>
    </span>
  );
}
