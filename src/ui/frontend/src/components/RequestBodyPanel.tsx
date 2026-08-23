import { createSignal, Show } from "solid-js";
import type { getRequestBody, RequestBodyItem } from "../api/client";
import { displayRequestBody, type RequestBodyDisplay } from "./requestBodyView";

type RequestBodyPanelState = "idle" | "loading" | "loaded" | "error";

export interface RequestBodyPanelProps {
  sessionId: string;
  requestId: string;
  fetchRequestBody: typeof getRequestBody;
}

export function RequestBodyPanel(props: RequestBodyPanelProps) {
  const [state, setState] = createSignal<RequestBodyPanelState>("idle");
  const [item, setItem] = createSignal<RequestBodyItem | null>(null);
  const [display, setDisplay] = createSignal<RequestBodyDisplay | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const load = async () => {
    setState("loading");
    setError(null);
    try {
      const result = await props.fetchRequestBody(
        props.sessionId,
        props.requestId,
      );
      setItem(result.item);
      setDisplay(displayRequestBody(result.item.data));
      setState("loaded");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to load request body",
      );
      setState("error");
    }
  };

  const hide = () => {
    setItem(null);
    setDisplay(null);
    setError(null);
    setState("idle");
  };

  return (
    <div class="request-body-panel">
      <Show when={state() !== "loaded"}>
        <button
          type="button"
          class="request-body-load"
          disabled={state() === "loading"}
          onClick={() => void load()}
        >
          {state() === "loading"
            ? "Loading raw body…"
            : state() === "error"
              ? "Retry raw body"
              : "View raw body"}
        </button>
      </Show>
      <Show when={state() === "error" && error()}>
        {(message) => <span class="request-body-error">{message()}</span>}
      </Show>
      <Show when={state() === "loaded" && item() && display()}>
        <div class="request-body-result">
          <button type="button" class="request-body-load" onClick={hide}>
            Hide raw body
          </button>
          <div class="request-body-meta">
            <span>{display()?.encoding}</span>
            <span>{item()?.byteLength} bytes</span>
            <Show when={item()?.contentType}>
              {(contentType) => <span>{contentType()}</span>}
            </Show>
          </div>
          <pre class="request-body-content">{display()?.text}</pre>
        </div>
      </Show>
    </div>
  );
}
