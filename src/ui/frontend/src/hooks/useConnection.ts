/**
 * Solid binding around `createConnectionController`.
 *
 * Exposes a `connected` accessor that tracks the SSE connection state
 * with the offline-grace semantics defined in `createConnectionController`.
 *
 * CSR-only. `onMount` does not run during Solid's hydration path, and
 * `EventSource` is a browser-only API; this hook is intended for the
 * client-side bundle and will not work under server rendering.
 */

import { type Accessor, createSignal, onCleanup, onMount } from "solid-js";
import {
  type ConnectionDeps,
  createConnectionController,
} from "./createConnectionController";

export interface UseConnectionResult {
  connected: Accessor<boolean>;
}

export interface UseConnectionOptions {
  /**
   * Names of SSE events to subscribe to. Forwarded to the underlying
   * `ConnectionDeps.eventNames`; without this the controller stays in
   * connection-only mode and registers no `addEventListener` handlers.
   */
  eventNames?: readonly string[];
}

export function useConnection(
  url: string,
  onEvent?: ConnectionDeps["onEvent"],
  options?: UseConnectionOptions,
): UseConnectionResult {
  const [connected, setConnected] = createSignal<boolean>(false);
  const controller = createConnectionController({
    setConnected,
    createEventSource: (u) => new EventSource(u),
    setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h),
    onEvent,
    eventNames: options?.eventNames,
  });
  onMount(() => controller.start(url));
  onCleanup(() => controller.dispose());
  return { connected };
}
