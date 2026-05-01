/**
 * History shell — wraps the history-route family.
 *
 * Owns the per-page SSE subscription for whichever history route is
 * active: list, conversation detail, or invocation detail. Each
 * branch is split into its own component so the EventSource is
 * created lazily — only when the matching route is active — and torn
 * down by `useHistoryStream`'s `onCleanup` when the user navigates
 * away or to a sibling detail.
 *
 * The detail `<Match>` entries are `keyed` on the route id so an
 * id-only navigation (e.g. detail A → detail B within the same kind)
 * disposes the previous detail view, closing its EventSource, and
 * mounts a fresh view that opens a new EventSource against the new
 * URL. Without `keyed`, Solid's `Switch` would treat any two truthy
 * `when` values as equal and keep the original child mounted, leaving
 * the old EventSource attached to the old id.
 *
 * Mounting the shell inside the route Switch/Match (rather than
 * keeping it always-mounted like the settings shell) ties the
 * EventSource lifetime to the user's presence on a history page.
 */

import { Match, Switch } from "solid-js";
import type {
  ConversationDetail,
  ConversationListRow,
  InvocationDetail,
} from "../../../../../history/types";
import {
  HISTORY_SSE_CONVERSATION_EVENT,
  HISTORY_SSE_INVOCATION_EVENT,
  HISTORY_SSE_LIST_EVENT,
  HISTORY_SSE_NOT_FOUND_EVENT,
} from "../../../../routes/history_sse_events";
import { useHistoryStream } from "../../hooks/useHistoryStream";
import { ConversationDetailPage } from "./ConversationDetailPage";
import { HistoryListPage } from "./HistoryListPage";
import { InvocationDetailPage } from "./InvocationDetailPage";

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
        <Match
          keyed
          when={
            props.route.kind === "history-conversation"
              ? props.route.id
              : undefined
          }
        >
          {(id) => <ConversationDetailView id={id} />}
        </Match>
        <Match
          keyed
          when={
            props.route.kind === "history-invocation"
              ? props.route.id
              : undefined
          }
        >
          {(id) => <InvocationDetailView id={id} />}
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

/**
 * Owns the conversation-detail SSE subscription. The id flows into
 * the URL via `encodeURIComponent`; the parent route already
 * sanitised it through `parseRoute`'s allowlist, but encoding here
 * is a defence in depth so an unexpected route value still produces
 * a syntactically valid URL.
 */
function ConversationDetailView(props: { id: string }) {
  const stream = useHistoryStream<ConversationDetail>({
    url: `/api/history/conversation/${encodeURIComponent(props.id)}/events`,
    payloadEventName: HISTORY_SSE_CONVERSATION_EVENT,
    notFoundEventName: HISTORY_SSE_NOT_FOUND_EVENT,
  });

  const detail = () => stream.data();
  const loading = () => stream.data() === null && !stream.notFound();

  return (
    <ConversationDetailPage
      detail={detail}
      notFound={stream.notFound}
      loading={loading}
      error={stream.error}
    />
  );
}

function InvocationDetailView(props: { id: string }) {
  const stream = useHistoryStream<InvocationDetail>({
    url: `/api/history/invocation/${encodeURIComponent(props.id)}/events`,
    payloadEventName: HISTORY_SSE_INVOCATION_EVENT,
    notFoundEventName: HISTORY_SSE_NOT_FOUND_EVENT,
  });

  const detail = () => stream.data();
  const loading = () => stream.data() === null && !stream.notFound();

  return (
    <InvocationDetailPage
      detail={detail}
      notFound={stream.notFound}
      loading={loading}
      error={stream.error}
    />
  );
}
