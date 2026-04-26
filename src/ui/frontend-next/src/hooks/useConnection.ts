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

export function useConnection(
  url: string,
  onEvent?: ConnectionDeps["onEvent"],
): UseConnectionResult {
  const [connected, setConnected] = createSignal<boolean>(false);
  const controller = createConnectionController({
    setConnected,
    createEventSource: (u) => new EventSource(u),
    setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h),
    onEvent,
  });
  onMount(() => controller.start(url));
  onCleanup(() => controller.dispose());
  return { connected };
}
