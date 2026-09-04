import { createSignal, For, Show } from "solid-js";
import { bindPort, unbindPort } from "../../api/client";
import type { PortBindSessionLike } from "../../stores/types";

type Props = {
  sessionId: () => string | null;
  portBindings: () => PortBindSessionLike[];
};

export function PortBindingsPanel(props: Props) {
  const [containerPort, setContainerPort] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const bindings = () => {
    const sessionId = props.sessionId();
    if (sessionId === null) return [];
    return (
      props.portBindings().find((entry) => entry.sessionId === sessionId)
        ?.bindings ?? []
    );
  };

  const handleBind = async (event: SubmitEvent) => {
    event.preventDefault();
    const sessionId = props.sessionId();
    const port = Number(containerPort());
    if (
      sessionId === null ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      setError("Enter a container port between 1 and 65535");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await bindPort(sessionId, port);
      setContainerPort("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to bind port");
    } finally {
      setBusy(false);
    }
  };

  const handleUnbind = async (containerPort: number) => {
    const sessionId = props.sessionId();
    if (sessionId === null) return;

    setBusy(true);
    setError(null);
    try {
      await unbindPort(sessionId, containerPort);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to unbind port",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="port-bindings-panel" aria-label="Port bindings">
      <div class="section-label">
        <span>Ports · in</span>
        <span class="section-sub">{bindings().length}</span>
      </div>
      <Show
        when={props.sessionId() !== null}
        fallback={<div class="empty">Select a session to manage ports</div>}
      >
        <div class="port-binding-list">
          <For
            each={bindings()}
            fallback={<div class="empty">No open ports</div>}
          >
            {(binding) => (
              <div class="port-binding-row">
                <a
                  href={`http://localhost:${binding.hostPort}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  localhost:{binding.hostPort}
                </a>
                <span>→ :{binding.containerPort}</span>
                <button
                  type="button"
                  disabled={busy()}
                  onClick={() => void handleUnbind(binding.containerPort)}
                >
                  Unbind
                </button>
              </div>
            )}
          </For>
        </div>
        <form class="port-binding-form" onSubmit={handleBind}>
          <input
            type="number"
            min="1"
            max="65535"
            step="1"
            required
            aria-label="Container port"
            placeholder="Container port"
            value={containerPort()}
            disabled={busy()}
            onInput={(event) => setContainerPort(event.currentTarget.value)}
          />
          <button type="submit" disabled={busy()}>
            Bind
          </button>
        </form>
        <Show when={error()}>
          {(message) => <p class="port-binding-error">{message()}</p>}
        </Show>
      </Show>
    </section>
  );
}
