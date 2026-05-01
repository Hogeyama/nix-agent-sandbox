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
 *   - `"#/history"` resolves to the conversation list page.
 *   - `"#/history/conversation/<id>"` and `"#/history/invocation/<id>"`
 *     resolve to the per-detail pages. Ids that fail the safe-id
 *     allowlist (or are empty) fall back to the workspace, mirroring
 *     the unknown-settings-page branch so a malformed bookmark cannot
 *     drive a fetch against an arbitrary path segment.
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
  | { kind: "settings"; page: SettingsPage }
  | { kind: "history" }
  | { kind: "history-conversation"; id: string }
  | { kind: "history-invocation"; id: string };

/**
 * Allowlist for history ids that arrive in the hash. Mirrors the shape
 * of `isSafeId` in `src/ui/routes/validate_ids.ts` (the backend gate)
 * but is intentionally narrower at the frontend edge: we only need to
 * stop a malformed hash from triggering a fetch against an arbitrary
 * path segment. The backend remains the authoritative gate.
 */
const SAFE_HISTORY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function isSafeHistoryId(value: string): boolean {
  return SAFE_HISTORY_ID_RE.test(value) && !value.includes("..");
}

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
  if (segments[0] === "settings") {
    const pageSegment = segments[1];
    if (pageSegment === undefined || pageSegment === "") {
      return { kind: "settings", page: DEFAULT_SETTINGS_PAGE };
    }
    if (!SETTINGS_PAGES.has(pageSegment as SettingsPage)) {
      return WORKSPACE_ROUTE;
    }
    // Reject anything past the page segment so `#/settings/audit/extra`
    // does not silently resolve to the audit page.
    if (segments.length > 2) return WORKSPACE_ROUTE;
    return { kind: "settings", page: pageSegment as SettingsPage };
  }

  if (segments[0] === "history") {
    const sub = segments[1];
    if (sub === undefined || sub === "") {
      // Reject `#/history/` with trailing junk; the bare list route only
      // matches an exact segment count of 1.
      if (segments.length > 2) return WORKSPACE_ROUTE;
      return { kind: "history" };
    }
    if (sub !== "conversation" && sub !== "invocation") {
      return WORKSPACE_ROUTE;
    }
    // Detail routes require exactly three segments: `history/<sub>/<id>`.
    // A missing or extra segment falls back to workspace so a partially
    // typed url cannot mount a detail page with an empty id.
    if (segments.length !== 3) return WORKSPACE_ROUTE;
    const id = segments[2];
    if (!isSafeHistoryId(id)) return WORKSPACE_ROUTE;
    if (sub === "conversation") {
      return { kind: "history-conversation", id };
    }
    return { kind: "history-invocation", id };
  }

  return WORKSPACE_ROUTE;
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
