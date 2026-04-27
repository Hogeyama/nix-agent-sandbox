/**
 * Settings shell: two-column layout that hosts every `#/settings/*` page.
 *
 * The left column is a navigation rail of anchor links pointing at the
 * four settings hashes. Anchors (rather than buttons) are used so the
 * browser handles back/forward natively and so middle-click / open in
 * new tab keep working without component-level handlers.
 *
 * The right column renders a page-specific component selected by the
 * `page` prop. The shell itself owns layout and navigation only; each
 * page component is responsible for its own data fetching and state.
 */

import { Match, Switch } from "solid-js";
import type { getAuditLogs } from "../../api/client";
import type { SettingsPage } from "../../routes/router";
import type { AuditPageStore } from "../../stores/auditPageStore";
import type { AuditLogEntryLike } from "../../stores/types";
import { AuditPage } from "./AuditPage";
import { SidecarsPage } from "./SidecarsPage";
import type { SidecarRow } from "./sidecarRowView";

interface SettingsShellProps {
  page: SettingsPage;
  /**
   * When true, the shell renders with `display: none` so it stays
   * mounted while the workspace is the active route. Keeping the
   * shell mounted lets per-page state survive a round-trip through
   * the workspace.
   */
  hidden?: boolean;
  /** Sidecar rows for the `#/settings/sidecars` page. */
  sidecars: () => SidecarRow[];
  /**
   * Stop the named container. Forwarded verbatim to `SidecarsPage`,
   * which catches errors and renders them per-row; the shell never
   * inspects the result.
   */
  onStop: (name: string) => Promise<unknown>;
  /** Live SSE-driven audit window for the `#/settings/audit` page. */
  auditLiveRows: () => AuditLogEntryLike[];
  /**
   * Set of session ids considered "active" — running containers plus
   * sessions with pending approvals. Drives the "Active only"
   * checkbox on the audit filter bar.
   */
  auditActiveIds: () => ReadonlySet<string>;
  auditPageStore: AuditPageStore;
  /** Injected for testability; production passes the real client. */
  fetchAuditLogs: typeof getAuditLogs;
}

interface NavLink {
  page: SettingsPage;
  hash: string;
  label: string;
}

const NAV_LINKS: readonly NavLink[] = [
  { page: "sidecars", hash: "#/settings/sidecars", label: "Sidecars" },
  { page: "audit", hash: "#/settings/audit", label: "Audit" },
  { page: "keybinds", hash: "#/settings/keybinds", label: "Keybinds" },
  { page: "prefs", hash: "#/settings/prefs", label: "Preferences" },
];

export function SettingsShell(props: SettingsShellProps) {
  return (
    <section
      class="settings-shell"
      classList={{ "settings-shell-hidden": props.hidden === true }}
      aria-label="Settings"
    >
      <nav class="settings-nav" aria-label="Settings sections">
        {NAV_LINKS.map((link) => (
          <a
            href={link.hash}
            class="settings-nav-link"
            aria-current={props.page === link.page ? "page" : undefined}
          >
            {link.label}
          </a>
        ))}
      </nav>
      <div class="settings-content">
        <Switch>
          <Match when={props.page === "sidecars"}>
            <SidecarsPage sidecars={props.sidecars} onStop={props.onStop} />
          </Match>
          <Match when={props.page === "audit"}>
            <AuditPage
              liveRows={props.auditLiveRows}
              activeIds={props.auditActiveIds}
              store={props.auditPageStore}
              fetchAuditLogs={props.fetchAuditLogs}
            />
          </Match>
          <Match when={props.page === "keybinds"}>
            <SettingsPageIntro
              heading="Keybinds"
              note="Inspect the keyboard shortcuts the control room responds to."
            />
          </Match>
          <Match when={props.page === "prefs"}>
            <SettingsPageIntro
              heading="Preferences"
              note="Adjust per-user UI preferences such as font size and pane layout."
            />
          </Match>
        </Switch>
      </div>
    </section>
  );
}

interface IntroProps {
  heading: string;
  note: string;
}

function SettingsPageIntro(props: IntroProps) {
  return (
    <div>
      <h1 class="settings-page-heading">{props.heading}</h1>
      <p class="settings-page-note">{props.note}</p>
    </div>
  );
}
