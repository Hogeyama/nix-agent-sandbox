import { useEffect, useState } from "preact/hooks";
import { api, type LaunchInfo } from "../api.ts";

interface NewSessionDialogProps {
  open: boolean;
  onClose: () => void;
  onLaunched: (sessionId: string) => void;
}

type WorktreeChoice = "none" | "main" | "current" | "custom";
type DirChoice = "recent" | "custom";

export function NewSessionDialog({
  open,
  onClose,
  onLaunched,
}: NewSessionDialogProps) {
  const [launchInfo, setLaunchInfo] = useState<LaunchInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [profile, setProfile] = useState("");
  const [worktreeChoice, setWorktreeChoice] = useState<WorktreeChoice>("none");
  const [customWorktree, setCustomWorktree] = useState("");
  const [dirChoice, setDirChoice] = useState<DirChoice>("recent");
  const [selectedDir, setSelectedDir] = useState("");
  const [customDir, setCustomDir] = useState("");
  const [sessionName, setSessionName] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setLoadError(null);
    setSubmitError(null);
    api
      .getLaunchInfo()
      .then((info) => {
        setLaunchInfo(info);
        setProfile(info.defaultProfile ?? info.profiles[0] ?? "");
        setSelectedDir(info.recentDirectories[0] ?? "");
        setWorktreeChoice("none");
        setCustomWorktree("");
        setDirChoice("recent");
        setCustomDir("");
        setSessionName("");
      })
      .catch((e) => {
        setLoadError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [open]);

  if (!open) return null;

  function handleSubmit() {
    if (!launchInfo) return;
    setSubmitting(true);
    setSubmitError(null);

    let worktreeBase: string | undefined;
    if (worktreeChoice === "main") worktreeBase = "main";
    else if (worktreeChoice === "current" && launchInfo.currentBranch)
      worktreeBase = launchInfo.currentBranch;
    else if (worktreeChoice === "custom" && customWorktree.trim())
      worktreeBase = customWorktree.trim();

    const cwd =
      dirChoice === "custom"
        ? customDir.trim() || undefined
        : selectedDir || undefined;

    api
      .launchSession({
        profile,
        worktreeBase,
        name: sessionName.trim() || undefined,
        cwd,
      })
      .then((result) => {
        onLaunched(result.sessionId);
        onClose();
      })
      .catch((e) => {
        setSubmitError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        setSubmitting(false);
      });
  }

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <h2 style={titleStyle}>New Session</h2>

        {loading && <p style={mutedStyle}>Loading...</p>}
        {loadError && <p style={errorStyle}>{loadError}</p>}

        {launchInfo && !loading && (
          <div style={formStyle}>
            {/* Profile */}
            <label style={labelStyle}>Profile</label>
            <select
              style={inputStyle}
              value={profile}
              onChange={(e) =>
                setProfile((e.target as HTMLSelectElement).value)
              }
            >
              {launchInfo.profiles.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>

            {/* Worktree Base Branch */}
            <label style={labelStyle}>Worktree Base Branch</label>
            <div style={radioGroupStyle}>
              <label style={radioLabelStyle}>
                <input
                  type="radio"
                  name="worktree"
                  checked={worktreeChoice === "none"}
                  onChange={() => setWorktreeChoice("none")}
                />
                None (use profile default)
              </label>
              <label style={radioLabelStyle}>
                <input
                  type="radio"
                  name="worktree"
                  checked={worktreeChoice === "main"}
                  onChange={() => setWorktreeChoice("main")}
                />
                main
              </label>
              {launchInfo.currentBranch != null &&
                launchInfo.currentBranch !== "main" && (
                  <label style={radioLabelStyle}>
                    <input
                      type="radio"
                      name="worktree"
                      checked={worktreeChoice === "current"}
                      onChange={() => setWorktreeChoice("current")}
                    />
                    {launchInfo.currentBranch}
                  </label>
                )}
              <label style={radioLabelStyle}>
                <input
                  type="radio"
                  name="worktree"
                  checked={worktreeChoice === "custom"}
                  onChange={() => setWorktreeChoice("custom")}
                />
                Custom
              </label>
              {worktreeChoice === "custom" && (
                <input
                  type="text"
                  style={{ ...inputStyle, marginTop: "4px" }}
                  placeholder="Branch name"
                  value={customWorktree}
                  onInput={(e) =>
                    setCustomWorktree((e.target as HTMLInputElement).value)
                  }
                />
              )}
            </div>

            {/* Directory */}
            <label style={labelStyle}>Directory</label>
            <div
              style={{ display: "flex", flexDirection: "column", gap: "6px" }}
            >
              <label style={radioLabelStyle}>
                <input
                  type="radio"
                  name="dir"
                  checked={dirChoice === "recent"}
                  onChange={() => setDirChoice("recent")}
                />
                Recent
              </label>
              {dirChoice === "recent" &&
                launchInfo.recentDirectories.length > 0 && (
                  <select
                    style={inputStyle}
                    value={selectedDir}
                    onChange={(e) =>
                      setSelectedDir((e.target as HTMLSelectElement).value)
                    }
                  >
                    {launchInfo.recentDirectories.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                )}
              <label style={radioLabelStyle}>
                <input
                  type="radio"
                  name="dir"
                  checked={dirChoice === "custom"}
                  onChange={() => setDirChoice("custom")}
                />
                Custom
              </label>
              {dirChoice === "custom" && (
                <input
                  type="text"
                  style={inputStyle}
                  placeholder="/path/to/directory"
                  value={customDir}
                  onInput={(e) =>
                    setCustomDir((e.target as HTMLInputElement).value)
                  }
                />
              )}
            </div>

            {/* Session Name */}
            <label style={labelStyle}>Session Name (optional)</label>
            <input
              type="text"
              style={inputStyle}
              placeholder="my-session"
              value={sessionName}
              onInput={(e) =>
                setSessionName((e.target as HTMLInputElement).value)
              }
            />

            {submitError && <p style={errorStyle}>{submitError}</p>}

            <div style={buttonRowStyle}>
              <button
                type="button"
                style={cancelBtnStyle}
                onClick={onClose}
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                type="button"
                style={submitBtnStyle}
                onClick={handleSubmit}
                disabled={submitting || !profile}
              >
                {submitting ? "Launching..." : "Launch"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const overlayStyle: Record<string, string> = {
  position: "fixed",
  top: "0",
  left: "0",
  width: "100vw",
  height: "100vh",
  background: "rgba(0, 0, 0, 0.6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: "1000",
};

const modalStyle: Record<string, string> = {
  background: "#0f172a",
  border: "1px solid #334155",
  borderRadius: "8px",
  padding: "24px",
  width: "480px",
  maxWidth: "90vw",
  maxHeight: "85vh",
  overflowY: "auto",
  color: "#cbd5e1",
};

const titleStyle = {
  fontSize: "18px",
  color: "#e2e8f0",
  marginTop: "0",
  marginBottom: "16px",
};

const formStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "12px",
};

const labelStyle = {
  color: "#94a3b8",
  fontSize: "13px",
  fontWeight: "500" as const,
  marginBottom: "-4px",
};

const inputStyle = {
  background: "#1e293b",
  color: "#e2e8f0",
  border: "1px solid #475569",
  borderRadius: "4px",
  padding: "6px 10px",
  fontSize: "14px",
  width: "100%",
  boxSizing: "border-box" as const,
};

const radioGroupStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "6px",
};

const radioLabelStyle = {
  display: "flex",
  alignItems: "center" as const,
  gap: "6px",
  color: "#cbd5e1",
  fontSize: "14px",
  cursor: "pointer" as const,
};

const buttonRowStyle = {
  display: "flex",
  justifyContent: "flex-end" as const,
  gap: "8px",
  marginTop: "8px",
};

const submitBtnStyle = {
  background: "#6366f1",
  color: "white",
  border: "none",
  borderRadius: "6px",
  padding: "8px 20px",
  cursor: "pointer",
  fontSize: "14px",
};

const cancelBtnStyle = {
  background: "transparent",
  color: "#94a3b8",
  border: "1px solid #475569",
  borderRadius: "6px",
  padding: "8px 20px",
  cursor: "pointer",
  fontSize: "14px",
};

const mutedStyle = {
  color: "#94a3b8",
};

const errorStyle = {
  color: "#f87171",
  fontSize: "13px",
  margin: "0",
};
