/**
 * Center-pane toolbar that surfaces the keep-alive terminal layer's
 * affordances: Ack turn, Shell toggle, Search, font-size, and Kill
 * clients.
 *
 * The component is rendering-only for the rules it depends on: visibility
 * / disable state for Ack, the agent ⇄ shell toggle label, search-submit
 * dispatch, and font-size clamping are factored into pure helpers so the
 * Solid shell stays trivially testable (`terminalToolbarLogic` for Ack /
 * search / font-size, `shellMapping` for the shell toggle).
 *
 * Behaviour notes
 * ---------------
 *
 *   - Ack: a single in-flight signal disables the visible button while
 *     the request is in flight. `HttpError.status === 409` is silently
 *     absorbed because the daemon returns 409 when the snapshot raced
 *     the ack; the next SSE push reconciles the state. All other errors
 *     surface in `aria-live="polite"` for 5 s.
 *   - Shell: the button label names the destination view ("Shell" while
 *     viewing the agent, "Agent" while viewing the shell). The click
 *     delegates to `onShellToggle`; the toolbar owns no shell state of
 *     its own. `shellSpawnInFlight` collapses the label to "Spawning…"
 *     and disables the button so a double-click cannot issue a second
 *     POST while the first is in flight.
 *   - Kill clients: same in-flight pattern as Ack, no benign-status
 *     branch.
 *   - Font-size: a Toolbar-local signal clamped via `clampFontSize`.
 *     Persistence is intentionally out of scope for this layer.
 *   - Search: a session-scoped buffer. When the active session changes,
 *     the input collapses and the addon's decorations are cleared so
 *     the next session does not inherit the previous query's highlights.
 */

import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
} from "solid-js";
import { describeShellToggle, type ShellView } from "../stores/shellMapping";
import type { SessionRow } from "../stores/types";
import type { TerminalHandle } from "../terminal/attachTerminalSession";
import {
  clampFontSize,
  decideSearchSubmit,
  describeAckButton,
  FONT_SIZE_DEFAULT,
  FONT_SIZE_STEP,
  shouldSurfaceAckError,
} from "./terminalToolbarLogic";

export interface TerminalToolbarProps {
  activeRow: () => SessionRow | null;
  handle: () => TerminalHandle | null;
  /**
   * Resolves the active row's recorded view position. Returns
   * `undefined` when the user has not interacted with the toggle yet,
   * in which case the button defaults to the "agent" branch.
   */
  viewFor: (sessionId: string) => ShellView | undefined;
  /**
   * Reports whether a shell-spawn HTTP request is in flight for the
   * active row. Drives the toolbar's Shell-toggle disabled state and
   * its "Spawning…" label.
   */
  shellSpawnInFlight: (sessionId: string) => boolean;
  onAck: (sessionId: string) => Promise<void>;
  onKillClients: (sessionId: string) => Promise<void>;
  onShellToggle: (row: SessionRow) => void | Promise<void>;
}

const ERROR_TIMEOUT_MS = 5000;

export function TerminalToolbar(props: TerminalToolbarProps) {
  const [acking, setAcking] = createSignal(false);
  const [killing, setKilling] = createSignal(false);
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null);
  const [fontSize, setFontSize] = createSignal(FONT_SIZE_DEFAULT);
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");

  // Reset the search affordance whenever the active session changes so a
  // query typed against one terminal does not survive into the next.
  let lastSessionId: string | null = null;
  createEffect(() => {
    const id = props.activeRow()?.id ?? null;
    if (id === lastSessionId) return;
    lastSessionId = id;
    setSearchOpen(false);
    setSearchQuery("");
    props.handle()?.search.clear();
  });

  // Auto-clear surfaced errors after `ERROR_TIMEOUT_MS` so a transient
  // failure does not pin the toolbar's status line indefinitely.
  // Invariant: `errorTimer !== null` iff a live timer is pending; the
  // timer callback resets the field when it fires so the invariant holds.
  let errorTimer: ReturnType<typeof setTimeout> | null = null;
  const surfaceError = (msg: string) => {
    setErrorMessage(msg);
    if (errorTimer !== null) clearTimeout(errorTimer);
    errorTimer = setTimeout(() => {
      setErrorMessage(null);
      errorTimer = null;
    }, ERROR_TIMEOUT_MS);
  };
  onCleanup(() => {
    if (errorTimer !== null) clearTimeout(errorTimer);
  });

  const ack = createMemo(() =>
    describeAckButton(props.activeRow()?.turn ?? null, acking()),
  );

  const shellToggle = createMemo(() => {
    const row = props.activeRow();
    if (!row) return null;
    return describeShellToggle(
      props.viewFor(row.id) ?? "agent",
      props.shellSpawnInFlight(row.id),
    );
  });

  const handleShellToggleClick = async () => {
    const row = props.activeRow();
    if (!row) return;
    const state = shellToggle();
    if (state === null || state.disabled) return;
    try {
      await props.onShellToggle(row);
    } catch (e) {
      surfaceError(e instanceof Error ? e.message : "Failed to toggle shell");
    }
  };

  const handleAck = async () => {
    const row = props.activeRow();
    if (!row || acking()) return;
    setAcking(true);
    try {
      await props.onAck(row.id);
    } catch (e) {
      // 409 means a stale snapshot raced the ack; the next SSE push
      // reconciles the turn state, so no UI surface is required.
      if (shouldSurfaceAckError(e)) {
        surfaceError(e instanceof Error ? e.message : "Failed to ack turn");
      }
    } finally {
      setAcking(false);
    }
  };

  const handleKillClients = async () => {
    const row = props.activeRow();
    if (!row || killing()) return;
    setKilling(true);
    try {
      await props.onKillClients(row.id);
    } catch (e) {
      surfaceError(e instanceof Error ? e.message : "Failed to kill clients");
    } finally {
      setKilling(false);
    }
  };

  // `applyFontSize` is the single seam that enforces the [MIN, MAX] bounds
  // so callers do not have to know to clamp before dispatching.
  const applyFontSize = (px: number) => {
    const clamped = clampFontSize(px);
    setFontSize(clamped);
    props.handle()?.setFontSize(clamped);
  };
  const handleFontInc = () => applyFontSize(fontSize() + FONT_SIZE_STEP);
  const handleFontDec = () => applyFontSize(fontSize() - FONT_SIZE_STEP);

  const handleSearchKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      setSearchOpen(false);
      setSearchQuery("");
      props.handle()?.search.clear();
      return;
    }
    if (e.key !== "Enter") return;
    const handle = props.handle();
    if (!handle) return;
    const action = decideSearchSubmit(searchQuery(), e.shiftKey);
    if (action === "next") handle.search.findNext(searchQuery());
    else if (action === "prev") handle.search.findPrevious(searchQuery());
    else if (action === "clear") handle.search.clear();
  };

  const toggleSearch = () => {
    const next = !searchOpen();
    setSearchOpen(next);
    if (!next) {
      setSearchQuery("");
      props.handle()?.search.clear();
    }
  };

  return (
    <footer class="term-toolbar">
      <Show when={props.activeRow()}>
        {(row) => (
          <span class="term-context">
            <span class="dot" aria-hidden="true" />
            <span class="name">{row().name}</span>
            <span class="id-hint">{row().shortId}</span>
          </span>
        )}
      </Show>
      <Show when={ack().visible}>
        <button
          type="button"
          class="tool primary"
          disabled={ack().disabled}
          onClick={handleAck}
        >
          {ack().label}
        </button>
      </Show>
      <Show when={shellToggle()}>
        {(state) => (
          <button
            type="button"
            class="tool"
            disabled={state().disabled}
            onClick={handleShellToggleClick}
            aria-label={`Switch to ${state().label}`}
          >
            {state().label}
          </button>
        )}
      </Show>
      <button
        type="button"
        class="tool"
        onClick={toggleSearch}
        aria-pressed={searchOpen()}
      >
        Search
      </button>
      <Show when={searchOpen()}>
        <input
          type="text"
          class="search-input"
          placeholder="Search…"
          value={searchQuery()}
          onInput={(e) => setSearchQuery(e.currentTarget.value)}
          onKeyDown={handleSearchKey}
          aria-label="Search terminal output"
        />
      </Show>
      <span class="spacer" />
      <span class="fontsize">
        <button
          type="button"
          class="tool"
          onClick={handleFontDec}
          aria-label="Decrease font size"
        >
          −
        </button>
        <span class="size-value">{fontSize()}px</span>
        <button
          type="button"
          class="tool"
          onClick={handleFontInc}
          aria-label="Increase font size"
        >
          +
        </button>
      </span>
      <button
        type="button"
        class="tool danger"
        disabled={killing() || props.activeRow() === null}
        onClick={handleKillClients}
      >
        Kill clients
      </button>
      <Show when={errorMessage()}>
        {(msg) => (
          <output class="toolbar-error" aria-live="polite">
            {msg()}
          </output>
        )}
      </Show>
    </footer>
  );
}
