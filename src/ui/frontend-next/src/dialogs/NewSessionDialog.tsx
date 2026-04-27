import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import {
  getLaunchBranches,
  getLaunchInfo,
  type LaunchBranches,
  type LaunchInfo,
  launchSession,
} from "../api/client";
import { createFocusTrap } from "./createFocusTrap";
import {
  pickEffectiveCwd,
  pickWorktreeBase,
  reconcileWorktreeChoice,
  type WorktreeChoice,
} from "./newSessionForm";

const DIALOG_TITLE_ID = "new-session-dialog-title";

type DirChoice = "default" | "recent" | "custom";

type Props = {
  /**
   * Reactive accessor for the open/closed state. The dialog mounts only
   * when this is true; closing it unmounts the body so the form resets
   * naturally on the next open without manual state-clear plumbing.
   */
  open: () => boolean;
  /** Invoked when the user dismisses the dialog (Cancel, Esc, backdrop). */
  onClose: () => void;
  /**
   * Invoked once the launch HTTP call resolves successfully. The parent
   * is expected to call `terminals.requestActivate(sessionId)` so the
   * center pane auto-attaches when the next SSE snapshot confirms the
   * dtach session.
   */
  onLaunched: (sessionId: string) => void;
};

/**
 * New-session dialog: profile / cwd / worktree / name input, two-stage
 * fetch (`/api/launch/info` on open, `/api/launch/branches?cwd=...` on
 * cwd change), POST `/api/launch` on submit.
 *
 * Everything stateless about turning form values into a launch payload
 * lives in `./newSessionForm`. This component is the Solid binding:
 * signals for inputs, effects for the two fetches, and a
 * `<Show when={open()}>` gate that owns the mount/unmount lifecycle so
 * the form starts fresh every time the user reopens it.
 */
export function NewSessionDialog(props: Props) {
  const [launchInfo, setLaunchInfo] = createSignal<LaunchInfo | null>(null);
  const [launchBranches, setLaunchBranches] =
    createSignal<LaunchBranches | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);
  const [errorMsg, setErrorMsg] = createSignal<string | null>(null);

  const [profile, setProfile] = createSignal("");
  const [dirChoice, setDirChoice] = createSignal<DirChoice>("default");
  const [customDir, setCustomDir] = createSignal("");
  const [selectedRecentDir, setSelectedRecentDir] = createSignal("");
  const [worktreeChoice, setWorktreeChoice] =
    createSignal<WorktreeChoice>("none");
  const [customWorktree, setCustomWorktree] = createSignal("");
  const [sessionName, setSessionName] = createSignal("");

  const effectiveCwd = () =>
    pickEffectiveCwd(dirChoice(), customDir(), selectedRecentDir());

  // Fetch /api/launch/info every time the dialog opens. The Show-gated
  // mount means this also resets the form on every open, since the
  // signals above are recreated by the new component instance.
  createEffect(() => {
    if (!props.open()) return;
    setLoading(true);
    setErrorMsg(null);
    getLaunchInfo()
      .then((info) => {
        setLaunchInfo(info);
        setProfile(info.defaultProfile ?? info.profiles[0] ?? "");
        const firstRecent = info.recentDirectories[0] ?? "";
        setSelectedRecentDir(firstRecent);
        setDirChoice(firstRecent === "" ? "default" : "recent");
      })
      .catch((e) => {
        setErrorMsg(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        setLoading(false);
      });
  });

  // Re-fetch branch info whenever the effective cwd changes. Empty cwd
  // (the "default" choice) yields the no-git baseline so the radio
  // collapses to just "none" / "custom".
  createEffect(() => {
    if (!props.open()) return;
    const cwd = effectiveCwd();
    if (cwd === "") {
      setLaunchBranches({ currentBranch: null, hasMain: false });
      return;
    }
    getLaunchBranches(cwd)
      .then((b) => {
        setLaunchBranches(b);
      })
      .catch(() => {
        // Branch lookup failure is non-fatal: degrade to the no-git
        // baseline so the radio still renders sensibly. The launch
        // endpoint will surface any real cwd error on submit.
        setLaunchBranches({ currentBranch: null, hasMain: false });
      });
  });

  // Reconcile worktreeChoice against the freshest branches snapshot so a
  // stale "main" / "current" selection from a previous cwd cannot leak
  // through to the launch payload.
  createEffect(() => {
    const next = reconcileWorktreeChoice(worktreeChoice(), launchBranches());
    if (next !== worktreeChoice()) {
      setWorktreeChoice(next);
    }
  });

  // Centralised dismissal: Cancel button, Esc key, and backdrop click
  // all funnel through here so an in-flight submit is never aborted by
  // a stray dismiss path.
  function tryClose() {
    if (!submitting()) props.onClose();
  }

  // Backdrop click dismisses only when the click lands on the overlay
  // itself; clicks that bubble up from the dialog content are ignored
  // so the user can interact with form controls without closing.
  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) tryClose();
  }

  // Escape closes the dialog. Listener is bound only while the dialog
  // is open so we do not shadow other Esc handlers when it is hidden.
  createEffect(() => {
    if (!props.open()) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") tryClose();
    };
    window.addEventListener("keydown", handler);
    onCleanup(() => window.removeEventListener("keydown", handler));
  });

  // Focus trap: cycles Tab / Shift+Tab inside the dialog and restores
  // focus to the opener (e.g. the topbar "+ new session" button or the
  // element that held focus when Ctrl+N fired) on close. The form body
  // sits behind a `Show when={!loading() && launchInfo()}` gate that
  // waits on `/api/launch/info`, so the microtask-deferred `activate()`
  // typically runs before any focusable descendant exists and the
  // initial-focus call is a no-op. That is acceptable: the trap still
  // engages immediately, so the first `Tab` press is captured and
  // cycles within the root once the form mounts, and Esc / backdrop /
  // restore-on-close all work independently of initial focus. The
  // common entry pattern is opener -> open dialog -> Tab, which the
  // trap handles correctly.
  let dialogRef: HTMLDivElement | undefined;
  const focusTrap = createFocusTrap({
    getRoot: () => dialogRef ?? null,
    getActiveElement: () =>
      typeof document === "undefined" ? null : document.activeElement,
    setFocus: (el) => {
      el.focus();
    },
  });

  createEffect(() => {
    if (!props.open()) return;
    // Defer activation past the synchronous render so `dialogRef` is
    // assigned by the Show-gated subtree before the trap queries it.
    // `activate()` is idempotent on `previouslyFocused`, so even if this
    // effect re-runs while the dialog is already open the opener is
    // preserved for restore.
    queueMicrotask(() => {
      if (props.open()) focusTrap.activate();
    });
    onCleanup(() => focusTrap.deactivate());
  });

  // Belt-and-braces: if the component itself unmounts (rather than the
  // open() flag flipping) make sure focus is still restored.
  onCleanup(() => focusTrap.deactivate());

  function handleSubmit() {
    const info = launchInfo();
    if (!info) return;
    setSubmitting(true);
    setErrorMsg(null);
    const worktreeBase = pickWorktreeBase(
      worktreeChoice(),
      customWorktree(),
      launchBranches(),
    );
    const cwd = effectiveCwd();
    launchSession({
      profile: profile(),
      worktreeBase,
      name: sessionName().trim() || undefined,
      cwd: cwd === "" ? undefined : cwd,
    })
      .then((result) => {
        props.onLaunched(result.sessionId);
        props.onClose();
      })
      .catch((e) => {
        setErrorMsg(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        setSubmitting(false);
      });
  }

  return (
    <Show when={props.open()}>
      {/** biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-outside dismissal; focusable controls handle real interaction */}
      <div
        class="dialog-overlay"
        role="presentation"
        onClick={handleBackdropClick}
      >
        <div
          ref={(el) => {
            dialogRef = el;
          }}
          class="dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby={DIALOG_TITLE_ID}
          onKeyDown={(e) => focusTrap.handleKeyDown(e)}
        >
          <h2 id={DIALOG_TITLE_ID} class="dialog-title">
            New Session
          </h2>

          <Show when={loading()}>
            <p class="dialog-muted">Loading...</p>
          </Show>

          <Show when={!loading() && launchInfo()} keyed>
            {(info) => (
              <div class="dialog-form">
                <span class="dialog-label">Directory</span>
                <div class="dialog-radio-group">
                  <label class="dialog-radio">
                    <input
                      type="radio"
                      name="dir"
                      checked={dirChoice() === "default"}
                      onChange={() => setDirChoice("default")}
                    />
                    Default (daemon)
                  </label>
                  <Show when={info.recentDirectories.length > 0}>
                    <label class="dialog-radio">
                      <input
                        type="radio"
                        name="dir"
                        checked={dirChoice() === "recent"}
                        onChange={() => setDirChoice("recent")}
                      />
                      Recent
                    </label>
                    <Show when={dirChoice() === "recent"}>
                      <select
                        class="dialog-input"
                        value={selectedRecentDir()}
                        onChange={(e) =>
                          setSelectedRecentDir(e.currentTarget.value)
                        }
                      >
                        <For each={info.recentDirectories}>
                          {(d) => <option value={d}>{d}</option>}
                        </For>
                      </select>
                    </Show>
                  </Show>
                  <label class="dialog-radio">
                    <input
                      type="radio"
                      name="dir"
                      checked={dirChoice() === "custom"}
                      onChange={() => setDirChoice("custom")}
                    />
                    Custom
                  </label>
                  <Show when={dirChoice() === "custom"}>
                    <input
                      type="text"
                      class="dialog-input"
                      placeholder="/path/to/directory"
                      value={customDir()}
                      onInput={(e) => setCustomDir(e.currentTarget.value)}
                    />
                  </Show>
                </div>

                <label class="dialog-label" for="new-session-profile">
                  Profile
                </label>
                <select
                  id="new-session-profile"
                  class="dialog-input"
                  value={profile()}
                  onChange={(e) => setProfile(e.currentTarget.value)}
                >
                  <For each={info.profiles}>
                    {(p) => <option value={p}>{p}</option>}
                  </For>
                </select>

                <span class="dialog-label">Worktree Base Branch</span>
                <div class="dialog-radio-group">
                  <label class="dialog-radio">
                    <input
                      type="radio"
                      name="worktree"
                      checked={worktreeChoice() === "none"}
                      onChange={() => setWorktreeChoice("none")}
                    />
                    None (use profile default)
                  </label>
                  <Show when={launchBranches()?.hasMain === true}>
                    <label class="dialog-radio">
                      <input
                        type="radio"
                        name="worktree"
                        checked={worktreeChoice() === "main"}
                        onChange={() => setWorktreeChoice("main")}
                      />
                      main
                    </label>
                  </Show>
                  <Show
                    when={(() => {
                      const cb = launchBranches()?.currentBranch ?? null;
                      return cb !== null && cb !== "main";
                    })()}
                  >
                    <label class="dialog-radio">
                      <input
                        type="radio"
                        name="worktree"
                        checked={worktreeChoice() === "current"}
                        onChange={() => setWorktreeChoice("current")}
                      />
                      {launchBranches()?.currentBranch ?? ""}
                    </label>
                  </Show>
                  <label class="dialog-radio">
                    <input
                      type="radio"
                      name="worktree"
                      checked={worktreeChoice() === "custom"}
                      onChange={() => setWorktreeChoice("custom")}
                    />
                    Custom
                  </label>
                  <Show when={worktreeChoice() === "custom"}>
                    <input
                      type="text"
                      class="dialog-input"
                      placeholder="Branch name"
                      value={customWorktree()}
                      onInput={(e) => setCustomWorktree(e.currentTarget.value)}
                    />
                  </Show>
                </div>

                <label class="dialog-label" for="new-session-name">
                  Session Name (optional)
                </label>
                <input
                  id="new-session-name"
                  type="text"
                  class="dialog-input"
                  placeholder="my-session"
                  value={sessionName()}
                  onInput={(e) => setSessionName(e.currentTarget.value)}
                />

                <Show when={errorMsg()}>
                  {(msg) => <p class="dialog-error">{msg()}</p>}
                </Show>

                <div class="dialog-actions">
                  <button
                    type="button"
                    class="dialog-btn dialog-btn-cancel"
                    onClick={tryClose}
                    disabled={submitting()}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    class="dialog-btn dialog-btn-submit"
                    onClick={handleSubmit}
                    disabled={submitting() || !profile()}
                  >
                    {submitting() ? "Launching..." : "Launch"}
                  </button>
                </div>
              </div>
            )}
          </Show>

          <Show when={!launchInfo() && !loading() && errorMsg()}>
            {(msg) => <p class="dialog-error">{msg()}</p>}
          </Show>
        </div>
      </div>
    </Show>
  );
}
