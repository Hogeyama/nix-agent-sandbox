/**
 * Schedule-send dialog: message + time input, preview, Submit / Cancel.
 *
 * The dialog collects a message (textarea) and a time (text input in
 * "HH:MM" format). `parseTimeInput` validates the time; the parsed
 * result is previewed live below the input. On submit the entry is
 * added to the `ScheduledSendStore` and the dialog closes.
 *
 * Below the input form, scheduled entries are listed with a message
 * preview, scheduled time, a live-updating remaining-time display,
 * and a cancel button. The list section is hidden when no entries exist.
 *
 * Reuses the existing `.dialog-*` CSS classes from styles.css. The
 * focus trap follows the same pattern as `NewSessionDialog`.
 */

import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import type { ScheduledSendStore } from "../stores/scheduledSendStore";
import {
  formatTimeRemaining,
  parseTimeInput,
} from "../terminal/scheduledSendLogic";
import { createFocusTrap } from "./createFocusTrap";

const DIALOG_TITLE_ID = "schedule-send-dialog-title";

type Props = {
  open: () => boolean;
  onClose: () => void;
  store: ScheduledSendStore;
  activeSessionId: () => string | null;
};

export function ScheduleSendDialog(props: Props) {
  const [message, setMessage] = createSignal("");
  const [timeInput, setTimeInput] = createSignal("");

  const parsedTime = createMemo(() => {
    const raw = timeInput();
    if (raw === "") return null;
    return parseTimeInput(raw, new Date());
  });

  function tryClose() {
    props.onClose();
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) tryClose();
  }

  createEffect(() => {
    if (!props.open()) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") tryClose();
    };
    window.addEventListener("keydown", handler);
    onCleanup(() => window.removeEventListener("keydown", handler));
  });

  // Reset form fields when the dialog opens so each open cycle starts
  // with a blank slate.
  createEffect(() => {
    if (props.open()) {
      setMessage("");
      setTimeInput("");
    }
  });

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
    queueMicrotask(() => {
      if (props.open()) focusTrap.activate();
    });
    onCleanup(() => focusTrap.deactivate());
  });

  onCleanup(() => focusTrap.deactivate());

  function handleSubmit() {
    const parsed = parsedTime();
    const msg = message().trim();
    const sid = props.activeSessionId();
    if (!parsed || msg === "" || !sid) return;
    props.store.add(sid, msg, parsed);
    props.onClose();
  }

  const canSubmit = createMemo(
    () =>
      parsedTime() !== null &&
      message().trim() !== "" &&
      props.activeSessionId() !== null,
  );

  // Live-updating "now" signal for remaining-time display.
  // The interval is created when the dialog opens and cleaned up
  // when it closes, preventing leaks.
  const [now, setNow] = createSignal(new Date());
  createEffect(() => {
    if (!props.open()) return;
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    onCleanup(() => clearInterval(id));
  });

  const MAX_PREVIEW_LENGTH = 60;
  function truncateMessage(msg: string): string {
    if (msg.length <= MAX_PREVIEW_LENGTH) return msg;
    return `${msg.slice(0, MAX_PREVIEW_LENGTH)}...`;
  }

  return (
    <Show when={props.open()}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-outside dismissal */}
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
            Schedule Send
          </h2>

          <div class="dialog-form">
            <label class="dialog-label" for="schedule-send-message">
              Message
            </label>
            <textarea
              id="schedule-send-message"
              class="dialog-input dialog-textarea"
              rows={4}
              placeholder="Type a message to send later..."
              value={message()}
              onInput={(e) => setMessage(e.currentTarget.value)}
            />

            <label class="dialog-label" for="schedule-send-time">
              Time (HH:MM)
            </label>
            <input
              id="schedule-send-time"
              type="text"
              class="dialog-input"
              placeholder="20:10"
              value={timeInput()}
              onInput={(e) => setTimeInput(e.currentTarget.value)}
            />

            <Show when={timeInput() !== ""}>
              <Show
                when={parsedTime()}
                fallback={
                  <p class="dialog-muted">
                    Invalid time format. Use HH:MM (e.g. 20:10).
                  </p>
                }
              >
                {(time) => (
                  <p class="dialog-muted">
                    Scheduled for: {time().toLocaleString()}
                  </p>
                )}
              </Show>
            </Show>

            <div class="dialog-actions">
              <button
                type="button"
                class="dialog-btn dialog-btn-cancel"
                onClick={tryClose}
              >
                Cancel
              </button>
              <button
                type="button"
                class="dialog-btn dialog-btn-submit"
                onClick={handleSubmit}
                disabled={!canSubmit()}
              >
                Schedule
              </button>
            </div>
          </div>

          <Show when={props.store.entries().length > 0}>
            <div class="scheduled-list">
              <h3 class="scheduled-list-heading">Scheduled</h3>
              <For each={props.store.entries()}>
                {(entry) => (
                  <div class="scheduled-item">
                    <div class="scheduled-item-info">
                      <span class="scheduled-item-message">
                        {truncateMessage(entry.message)}
                      </span>
                      <span class="scheduled-item-meta">
                        {entry.scheduledAt.toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                        {" — "}
                        {formatTimeRemaining(entry.scheduledAt, now())}
                      </span>
                    </div>
                    <button
                      type="button"
                      class="scheduled-item-cancel"
                      onClick={() => props.store.remove(entry.id)}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}
