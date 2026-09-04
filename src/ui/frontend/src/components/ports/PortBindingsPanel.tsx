import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import {
  bindPort,
  getPortCandidates,
  type PortCandidate,
  type PortWatchState,
  unbindPort,
} from "../../api/client";
import type { PortBindSessionLike } from "../../stores/types";
import { candidateRows, watchNotice } from "./portCandidateView";

/**
 * The poll is the subscription: the broker keeps the container-side scan
 * running only while requests keep arriving, so this interval is what makes a
 * suggestion live, and closing the panel is what stops the scan.
 */
const CANDIDATE_POLL_MS = 2000;

type Props = {
  sessionId: () => string | null;
  portBindings: () => PortBindSessionLike[];
};

export function PortBindingsPanel(props: Props) {
  const [containerPort, setContainerPort] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [candidates, setCandidates] = createSignal<PortCandidate[]>([]);
  const [watch, setWatch] = createSignal<PortWatchState | null>(null);
  const bindings = () => {
    const sessionId = props.sessionId();
    if (sessionId === null) return [];
    return (
      props.portBindings().find((entry) => entry.sessionId === sessionId)
        ?.bindings ?? []
    );
  };

  createEffect(() => {
    const sessionId = props.sessionId();
    setCandidates([]);
    setWatch(null);
    if (sessionId === null) return;

    let stopped = false;
    const poll = async () => {
      try {
        const result = await getPortCandidates(sessionId);
        if (stopped) return;
        setCandidates(result.candidates);
        setWatch(result.watch);
      } catch {
        // A session that went away stops suggesting; the bindings list and
        // the bind form already report their own failures.
        if (stopped) return;
        setCandidates([]);
        setWatch(null);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), CANDIDATE_POLL_MS);
    onCleanup(() => {
      stopped = true;
      clearInterval(timer);
    });
  });

  const suggestions = () => candidateRows(candidates());

  const bindContainerPort = async (port: number) => {
    const sessionId = props.sessionId();
    if (sessionId === null) return;

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

  const handleBind = async (event: SubmitEvent) => {
    event.preventDefault();
    const port = Number(containerPort());
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError("Enter a container port between 1 and 65535");
      return;
    }
    await bindContainerPort(port);
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
        <Show when={suggestions().length > 0}>
          <div class="port-candidate-list">
            <div class="port-candidate-label">Detected in container</div>
            <For each={suggestions()}>
              {(row) => (
                <div class="port-candidate-row">
                  <span>:{row.containerPort}</span>
                  <Show when={row.hint}>
                    {(hint) => (
                      <span class="port-candidate-hint" title={hint()}>
                        not on 127.0.0.1
                      </span>
                    )}
                  </Show>
                  <button
                    type="button"
                    disabled={busy()}
                    onClick={() => void bindContainerPort(row.containerPort)}
                  >
                    Bind
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
        <Show when={watchNotice(watch())}>
          {(notice) => <p class="port-candidate-notice">{notice()}</p>}
        </Show>
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
