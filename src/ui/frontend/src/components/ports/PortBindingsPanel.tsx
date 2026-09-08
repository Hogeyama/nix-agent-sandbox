import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type {
  AddForwardRequest,
  ForwardDirection,
  ManagedForward,
} from "../../../../../network/port_forward_model";
import {
  addPortForward,
  getPortCandidates,
  type PortCandidate,
  type PortWatchState,
  removePortForward,
} from "../../api/client";
import type { PortBindSessionLike } from "../../stores/types";
import { candidateRows, watchNotice } from "./portCandidateView";
import {
  addForwardNotice,
  forwardRow,
  removeForwardNotice,
  sessionForwardRows,
} from "./portForwardView";

const CANDIDATE_POLL_MS = 2000;

type Props = {
  sessionId: () => string | null;
  portBindings: () => PortBindSessionLike[];
};

function parsePort(value: string, endpoint: "host" | "container"): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Enter a ${endpoint} port between 1 and 65535`);
  }
  return port;
}

export function PortBindingsPanel(props: Props) {
  const [direction, setDirection] = createSignal<ForwardDirection>("local");
  const [hostPort, setHostPort] = createSignal("");
  const [containerPort, setContainerPort] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);
  const [candidates, setCandidates] = createSignal<PortCandidate[]>([]);
  const [watch, setWatch] = createSignal<PortWatchState | null>(null);
  let actionGeneration = 0;

  const forwards = () => {
    const sessionId = props.sessionId();
    if (sessionId === null) return [];
    const session = props
      .portBindings()
      .find((entry) => entry.sessionId === sessionId);
    return session === undefined ? [] : sessionForwardRows(session);
  };

  createEffect(() => {
    props.sessionId();
    direction();
    actionGeneration += 1;
    setBusy(false);
    setError(null);
    setNotice(null);
  });

  createEffect(() => {
    const sessionId = props.sessionId();
    const isLocal = direction() === "local";
    setCandidates([]);
    setWatch(null);
    if (sessionId === null || !isLocal) return;

    let stopped = false;
    const poll = async () => {
      try {
        const result = await getPortCandidates(sessionId);
        if (stopped) return;
        setCandidates(result.candidates);
        setWatch(result.watch);
      } catch {
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

  const runAdd = async (request: AddForwardRequest) => {
    const sessionId = props.sessionId();
    if (sessionId === null) return;
    const selectedDirection = direction();
    const generation = ++actionGeneration;

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await addPortForward(sessionId, request);
      if (
        generation !== actionGeneration ||
        props.sessionId() !== sessionId ||
        direction() !== selectedDirection
      )
        return;
      setHostPort("");
      setContainerPort("");
      setNotice(addForwardNotice(result));
    } catch (cause) {
      if (
        generation !== actionGeneration ||
        props.sessionId() !== sessionId ||
        direction() !== selectedDirection
      )
        return;
      setError(cause instanceof Error ? cause.message : "Failed to add port");
    } finally {
      if (generation === actionGeneration) setBusy(false);
    }
  };

  const handleAdd = async (event: SubmitEvent) => {
    event.preventDefault();
    try {
      const selectedDirection = direction();
      const request: AddForwardRequest =
        selectedDirection === "local"
          ? {
              direction: "local",
              hostPort:
                hostPort().trim() === "" ? null : parsePort(hostPort(), "host"),
              containerPort: parsePort(containerPort(), "container"),
            }
          : {
              direction: "remote",
              hostPort: parsePort(hostPort(), "host"),
              containerPort: parsePort(containerPort(), "container"),
            };
      await runAdd(request);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invalid port");
    }
  };

  const handleCandidate = (port: number) =>
    runAdd({ direction: "local", hostPort: null, containerPort: port });

  const handleRemove = async (entry: ManagedForward) => {
    const sessionId = props.sessionId();
    if (sessionId === null) return;
    const selectedDirection = direction();
    const generation = ++actionGeneration;

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const selector =
        entry.direction === "local"
          ? { direction: "local" as const, containerPort: entry.containerPort }
          : {
              direction: "remote" as const,
              containerPort: entry.containerPort,
            };
      const result = await removePortForward(sessionId, selector);
      if (
        generation !== actionGeneration ||
        props.sessionId() !== sessionId ||
        direction() !== selectedDirection
      )
        return;
      setNotice(removeForwardNotice(result));
    } catch (cause) {
      if (
        generation !== actionGeneration ||
        props.sessionId() !== sessionId ||
        direction() !== selectedDirection
      )
        return;
      setError(
        cause instanceof Error ? cause.message : "Failed to remove port",
      );
    } finally {
      if (generation === actionGeneration) setBusy(false);
    }
  };

  return (
    <section class="port-bindings-panel" aria-label="Ports">
      <div class="section-label">
        <span>Ports</span>
        <span class="section-sub">{forwards().length}</span>
      </div>
      <Show
        when={props.sessionId() !== null}
        fallback={<div class="empty">Select a session to manage ports</div>}
      >
        <div class="port-forward-list">
          <For
            each={forwards()}
            fallback={<div class="empty">No port forwards</div>}
          >
            {(entry) => {
              const row = () => forwardRow(entry);
              const removable = () =>
                entry.owners.some((owner) => owner !== "internal");
              const sharedWithInternal = () =>
                removable() && entry.owners.includes("internal");
              return (
                <article class="port-forward-row">
                  <div class="port-forward-row-head">
                    <span>{row().directionLabel}</span>
                    <span class={`port-forward-state is-${entry.state}`}>
                      {row().stateLabel}
                    </span>
                  </div>
                  <div class="port-forward-route">
                    <Show
                      when={row().href}
                      fallback={<span>{row().listenLabel}</span>}
                    >
                      {(href) => (
                        <a href={href()} target="_blank" rel="noreferrer">
                          {row().listenLabel}
                        </a>
                      )}
                    </Show>
                    <span aria-hidden="true">→</span>
                    <span>{row().targetLabel}</span>
                  </div>
                  <div class="port-forward-row-foot">
                    <span>Origin · {row().ownerLabel}</span>
                    <button
                      type="button"
                      disabled={busy() || !removable()}
                      title={
                        removable()
                          ? undefined
                          : "Internal forwarding cannot be removed here"
                      }
                      onClick={() => void handleRemove(entry)}
                    >
                      {sharedWithInternal() ? "Remove user" : "Remove"}
                    </button>
                  </div>
                </article>
              );
            }}
          </For>
        </div>
        <Show when={direction() === "local" && suggestions().length > 0}>
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
                    onClick={() => void handleCandidate(row.containerPort)}
                  >
                    Add
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
        <Show when={direction() === "local" && watchNotice(watch())}>
          {(message) => <p class="port-candidate-notice">{message()}</p>}
        </Show>
        <form class="port-forward-form" onSubmit={handleAdd}>
          <label>
            <span>Direction</span>
            <select
              aria-label="Forward direction"
              value={direction()}
              onChange={(event) =>
                setDirection(event.currentTarget.value as ForwardDirection)
              }
            >
              <option value="local">Local (host → container)</option>
              <option value="remote">Remote (container → host)</option>
            </select>
          </label>
          <div class="port-forward-endpoints">
            <label>
              <span>Host port</span>
              <input
                type="number"
                min="1"
                max="65535"
                step="1"
                required={direction() === "remote"}
                aria-label="Host port"
                placeholder={direction() === "local" ? "Auto" : "Required"}
                value={hostPort()}
                disabled={busy()}
                onInput={(event) => setHostPort(event.currentTarget.value)}
              />
            </label>
            <label>
              <span>Container port</span>
              <input
                type="number"
                min="1"
                max="65535"
                step="1"
                required
                aria-label="Container port"
                placeholder="Required"
                value={containerPort()}
                disabled={busy()}
                onInput={(event) => setContainerPort(event.currentTarget.value)}
              />
            </label>
          </div>
          <button type="submit" disabled={busy()}>
            Add forward
          </button>
        </form>
        <Show when={notice()}>
          {(message) => <p class="port-forward-notice">{message()}</p>}
        </Show>
        <Show when={error()}>
          {(message) => <p class="port-binding-error">{message()}</p>}
        </Show>
      </Show>
    </section>
  );
}
