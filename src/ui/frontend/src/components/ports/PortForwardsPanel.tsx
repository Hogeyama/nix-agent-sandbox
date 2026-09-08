import { createSignal, For, Show } from "solid-js";
import { forwardPort, unforwardPort } from "../../api/client";
import type { PortBindSessionLike } from "../../stores/types";

type Props = {
  sessionId: () => string | null;
  portBindings: () => PortBindSessionLike[];
};

/**
 * Host ports the selected session's container can reach at `localhost:<port>`
 * — the direction opposite to PortBindingsPanel. The forwards ride the same
 * SSE snapshot as the bindings, so the panel needs no poll of its own.
 */
export function PortForwardsPanel(props: Props) {
  const [hostPort, setHostPort] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);
  const forwards = () => {
    const sessionId = props.sessionId();
    if (sessionId === null) return [];
    return (
      props.portBindings().find((entry) => entry.sessionId === sessionId)
        ?.forwards ?? []
    );
  };

  const handleForward = async (event: SubmitEvent) => {
    event.preventDefault();
    const sessionId = props.sessionId();
    if (sessionId === null) return;
    const port = Number(hostPort());
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError("Enter a host port between 1 and 65535");
      return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await forwardPort(sessionId, port);
      setHostPort("");
      if (result.hostProbe === "no-answer") {
        setNotice(`Nothing is answering on 127.0.0.1:${port} yet`);
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to forward port",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleUnforward = async (containerPort: number) => {
    const sessionId = props.sessionId();
    if (sessionId === null) return;

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await unforwardPort(sessionId, containerPort);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to unforward port",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="port-bindings-panel" aria-label="Port forwards">
      <div class="section-label">
        <span>Ports · out</span>
        <span class="section-sub">{forwards().length}</span>
      </div>
      <Show
        when={props.sessionId() !== null}
        fallback={<div class="empty">Select a session to manage ports</div>}
      >
        <div class="port-binding-list">
          <For
            each={forwards()}
            fallback={<div class="empty">No host ports forwarded</div>}
          >
            {(forward) => (
              <div class="port-binding-row">
                <span>:{forward.containerPort}</span>
                <span>→ host 127.0.0.1:{forward.hostPort}</span>
                <button
                  type="button"
                  disabled={busy()}
                  onClick={() => void handleUnforward(forward.containerPort)}
                >
                  Unforward
                </button>
              </div>
            )}
          </For>
        </div>
        <form class="port-binding-form" onSubmit={handleForward}>
          <input
            type="number"
            min="1"
            max="65535"
            step="1"
            required
            aria-label="Host port"
            placeholder="Host port"
            value={hostPort()}
            disabled={busy()}
            onInput={(event) => setHostPort(event.currentTarget.value)}
          />
          <button type="submit" disabled={busy()}>
            Forward
          </button>
        </form>
        <Show when={notice()}>
          {(message) => <p class="port-candidate-notice">{message()}</p>}
        </Show>
        <Show when={error()}>
          {(message) => <p class="port-binding-error">{message()}</p>}
        </Show>
      </Show>
    </section>
  );
}
