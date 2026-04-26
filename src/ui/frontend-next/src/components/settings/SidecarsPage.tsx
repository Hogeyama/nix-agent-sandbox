/**
 * Sidecars settings page.
 *
 * Renders the rows reported by the sidecars store as a small table with
 * one Stop action per row. The page intentionally exposes only Stop:
 * Attach / Shell / Rename are session-side actions and would be
 * confusing on a sidecar that has no agent persona.
 *
 * Per-row UI state (busy flag + error message) lives in component-local
 * `Map` signals keyed by container name. The store reconciles itself
 * when the SSE snapshot drops a row, but a row's busy / error state is
 * a transient UI affordance owned by this component, not a value the
 * server reports — keeping it local avoids a round-trip through the
 * store on every click.
 *
 * The uptime column refreshes once per second so a running sidecar
 * shows an advancing "Xs / Ym / Zh / Wd" without depending on a
 * snapshot from the daemon.
 */

import { createSignal, For, onCleanup, Show } from "solid-js";
import { HttpError } from "../../api/client";
import { formatUptime, type SidecarRow } from "./sidecarRowView";

export interface SidecarsPageProps {
  sidecars: () => SidecarRow[];
  /**
   * Stop the named container. The page calls this on click; it is the
   * caller's responsibility to translate the name into the appropriate
   * REST request. Errors are caught here and rendered as a per-row
   * message — never swallowed silently.
   */
  onStop: (name: string) => Promise<unknown>;
}

const UPTIME_TICK_MS = 1000;

export function SidecarsPage(props: SidecarsPageProps) {
  // Tick once per second so the uptime column advances. Reading `now()`
  // inside the row body makes Solid track the dependency automatically;
  // the cleanup keeps the interval bounded to the page's lifetime.
  const [now, setNow] = createSignal(Date.now());
  const interval = setInterval(() => setNow(Date.now()), UPTIME_TICK_MS);
  onCleanup(() => clearInterval(interval));

  const [busy, setBusy] = createSignal<ReadonlyMap<string, true>>(new Map());
  const [errors, setErrors] = createSignal<ReadonlyMap<string, string>>(
    new Map(),
  );

  const isBusy = (name: string) => busy().has(name);
  const errorFor = (name: string) => errors().get(name) ?? null;

  const setBusyFor = (name: string, value: boolean) => {
    setBusy((prev) => {
      const next = new Map(prev);
      if (value) next.set(name, true);
      else next.delete(name);
      return next;
    });
  };

  const setErrorFor = (name: string, message: string | null) => {
    setErrors((prev) => {
      const next = new Map(prev);
      if (message === null) next.delete(name);
      else next.set(name, message);
      return next;
    });
  };

  const handleStop = async (name: string) => {
    if (isBusy(name)) return;
    setBusyFor(name, true);
    setErrorFor(name, null);
    try {
      await props.onStop(name);
    } catch (err) {
      setErrorFor(name, formatStopError(err));
    } finally {
      setBusyFor(name, false);
    }
  };

  return (
    <div class="sidecars-page">
      <h1 class="settings-page-heading">Sidecars</h1>
      <p class="settings-page-note">
        Manage sidecar containers and their lifecycle.
      </p>
      <Show
        when={props.sidecars().length > 0}
        fallback={<p class="sidecars-empty">No sidecar containers running.</p>}
      >
        <table class="sidecars-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Kind</th>
              <th scope="col">Status</th>
              <th scope="col">Uptime</th>
              <th scope="col" class="sidecars-actions-col">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            <For each={props.sidecars()}>
              {(row) => (
                <>
                  <tr class="sidecars-row">
                    <td class="sidecars-name">{row.name}</td>
                    <td class="sidecars-kind">{row.kind}</td>
                    <td class="sidecars-status">
                      <span
                        class="sidecars-status-dot"
                        classList={{
                          running: row.running,
                          stopped: !row.running,
                        }}
                        aria-hidden="true"
                      />
                      {row.running ? "running" : "stopped"}
                    </td>
                    <td class="sidecars-uptime">
                      {row.running ? formatUptime(row.startedAt, now()) : "-"}
                    </td>
                    <td class="sidecars-actions-col">
                      <button
                        type="button"
                        class="sidecars-action"
                        disabled={!row.running || isBusy(row.name)}
                        onClick={() => handleStop(row.name)}
                      >
                        {isBusy(row.name) ? "Stopping…" : "Stop"}
                      </button>
                    </td>
                  </tr>
                  <Show when={errorFor(row.name)}>
                    {(msg) => (
                      <tr class="sidecars-row-error">
                        <td colspan="5" class="sidecars-error">
                          {msg()}
                        </td>
                      </tr>
                    )}
                  </Show>
                </>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </div>
  );
}

/**
 * Render a thrown value from `onStop` into a user-facing string. The
 * client surfaces backend failures as `HttpError`, so its `.message`
 * already reads as `"<status> <statusText>"` or the daemon's JSON
 * `error` field; non-HTTP failures fall back to `Error.message`, then
 * to `String(err)` so the error is never silently dropped.
 */
function formatStopError(err: unknown): string {
  if (err instanceof HttpError) return err.message;
  if (err instanceof Error && err.message !== "") return err.message;
  return String(err);
}
