/**
 * History shell — wraps the history-route family.
 *
 * Owns the conversation-list SSE subscription for the `history` route
 * and renders the conversation list page. Detail routes
 * (`history-conversation`, `history-invocation`) currently render a
 * neutral placeholder.
 *
 * Mounting the shell inside the route Switch/Match (rather than
 * keeping it always-mounted like the settings shell) ties the
 * EventSource lifetime to the user's presence on a history page:
 * navigating away closes the socket, navigating back opens a fresh
 * one. This avoids holding an open stream against the daemon for
 * users who never visit the page.
 */

import { Match, Switch } from "solid-js";
import type { ConversationListRow } from "../../../../../history/types";
import { HISTORY_SSE_LIST_EVENT } from "../../../../routes/history_sse_events";
import { useHistoryStream } from "../../hooks/useHistoryStream";
import { HistoryListPage } from "./HistoryListPage";

export type HistoryRoute =
  | { kind: "history" }
  | { kind: "history-conversation"; id: string }
  | { kind: "history-invocation"; id: string };

export interface HistoryShellProps {
  route: HistoryRoute;
}

/** Wire payload of the `history:list` SSE event. */
interface HistoryListPayload {
  conversations: ConversationListRow[];
}

export function HistoryShell(props: HistoryShellProps) {
  return (
    <section class="history-shell" aria-label="History">
      <Switch>
        <Match when={props.route.kind === "history"}>
          <HistoryListView />
        </Match>
        <Match when={props.route.kind !== "history"}>
          <div class="history-placeholder">Detail view not available</div>
        </Match>
      </Switch>
    </section>
  );
}

/**
 * Owns the conversation-list SSE subscription. Split out so the
 * EventSource is created lazily — only when the list route is the
 * active match, never when the user is on a detail route.
 */
function HistoryListView() {
  const stream = useHistoryStream<HistoryListPayload>({
    url: "/api/history/conversations/events",
    payloadEventName: HISTORY_SSE_LIST_EVENT,
  });

  const conversations = () => stream.data()?.conversations ?? [];
  const loading = () => stream.data() === null;

  return (
    <HistoryListPage
      conversations={conversations}
      loading={loading}
      error={stream.error}
    />
  );
}
