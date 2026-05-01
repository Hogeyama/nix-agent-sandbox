interface TopbarProps {
  connected: boolean;
  onNewSession: () => void;
}

export function Topbar(props: TopbarProps) {
  return (
    <header class="topbar">
      <a class="brand" href="#/" aria-label="Home">
        <span class="logo" aria-hidden="true"></span>
        <span class="name">nas</span>
        <span class="sep">/</span>
        <span class="sub">control room</span>
      </a>
      <div class="topbar-center">
        <button
          class="btn"
          type="button"
          onClick={() => props.onNewSession()}
          aria-keyshortcuts="Control+N"
        >
          <span class="plus">+</span>
          <span>new session</span>
        </button>
      </div>
      <div class="topbar-right">
        <div class="live" classList={{ offline: !props.connected }}>
          <span class="dot"></span>
          <span>{props.connected ? "live" : "offline"}</span>
        </div>
        <a class="topbar-link" href="#/history">
          History
        </a>
        {/* biome-ignore lint/a11y/useAnchorContent: the visible content is the
            gear SVG (aria-hidden) and the link text is supplied via aria-label;
            biome only inspects child text and does not credit aria-label here. */}
        <a class="btn-icon" href="#/settings/sidecars" aria-label="Settings">
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
          </svg>
        </a>
      </div>
    </header>
  );
}
