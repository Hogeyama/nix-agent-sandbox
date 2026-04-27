/**
 * Hash-based router for the control room shell.
 *
 * The router parses `window.location.hash` into a discriminated `Route`
 * union and exposes a Solid signal that re-emits whenever the hash
 * changes. Hashes are used (instead of pushState) so the daemon's
 * static asset path keeps serving the same `index.html` regardless of
 * which page the user navigates to: the server never sees the fragment.
 *
 * Routing taxonomy:
 *
 *   - `""` and `"#/"` resolve to the workspace (the default view).
 *   - `"#/settings/<page>"` resolves to a settings page; unknown pages
 *     fall back to the workspace so a stale bookmark cannot strand the
 *     user on a blank Settings shell.
 *   - `"#/settings"` (no page) resolves to the default settings page,
 *     `"sidecars"`, so the gear icon can link to `#/settings` and still
 *     land on a populated page.
 *
 * `parseRoute` is pure so it can be unit-tested without a Solid runtime
 * or a real `window`. `createRouter` is a thin Solid + DOM wrapper that
 * subscribes to `hashchange`; the listener is removed via `onCleanup`
 * so a hot reload or unmount cannot leak a global listener.
 */

import { type Accessor, createSignal, onCleanup } from "solid-js";

export type SettingsPage = "sidecars" | "audit" | "keybinds" | "prefs";

export type Route =
  | { kind: "workspace" }
  | { kind: "settings"; page: SettingsPage };

const DEFAULT_SETTINGS_PAGE: SettingsPage = "sidecars";

const SETTINGS_PAGES: ReadonlySet<SettingsPage> = new Set<SettingsPage>([
  "sidecars",
  "audit",
  "keybinds",
  "prefs",
]);

const WORKSPACE_ROUTE: Route = { kind: "workspace" };

/**
 * Convert a hash string (with or without the leading `#`) into a
 * `Route`. Unknown shapes fall back to the workspace; the Settings
 * shell can therefore not be mounted from a bookmark that points at a
 * page the daemon does not recognise.
 */
export function parseRoute(hash: string): Route {
  // Strip the leading `#`, then strip a leading `/` so both `#/foo`
  // and `#foo` (which the browser normalises away anyway) resolve the
  // same way. Empty string -> workspace.
  let body = hash.startsWith("#") ? hash.slice(1) : hash;
  if (body.startsWith("/")) body = body.slice(1);
  if (body === "") return WORKSPACE_ROUTE;

  const segments = body.split("/");
  if (segments[0] !== "settings") return WORKSPACE_ROUTE;

  const pageSegment = segments[1];
  if (pageSegment === undefined || pageSegment === "") {
    return { kind: "settings", page: DEFAULT_SETTINGS_PAGE };
  }
  if (!SETTINGS_PAGES.has(pageSegment as SettingsPage)) {
    return WORKSPACE_ROUTE;
  }
  return { kind: "settings", page: pageSegment as SettingsPage };
}

export interface Router {
  route: Accessor<Route>;
  navigate: (hash: string) => void;
}

/**
 * Build a Solid-backed router rooted at `window.location.hash`.
 *
 * The factory subscribes to `hashchange` immediately (no `onMount`
 * indirection) so the signal stays in sync with the address bar from
 * the very first reactive read. `onCleanup` removes the listener when
 * the owning Solid root tears down, which matters during dev-server
 * hot reload more than in production but is wired the same in both.
 *
 * `navigate` writes to `window.location.hash`, which the browser
 * normalises and then dispatches a `hashchange` event for; the signal
 * is therefore always updated through the same code path regardless
 * of whether navigation came from a click on an anchor, the back
 * button, or this method.
 */
export function createRouter(): Router {
  const [route, setRoute] = createSignal<Route>(
    parseRoute(window.location.hash),
  );

  const onHashChange = () => {
    setRoute(parseRoute(window.location.hash));
  };
  window.addEventListener("hashchange", onHashChange);
  onCleanup(() => {
    window.removeEventListener("hashchange", onHashChange);
  });

  const navigate = (hash: string) => {
    window.location.hash = hash;
  };

  return { route, navigate };
}
