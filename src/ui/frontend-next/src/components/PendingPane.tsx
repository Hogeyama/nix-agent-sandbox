export function PendingPane() {
  return (
    <aside class="pane pane-right">
      <div class="pane-header">
        <div class="pane-title">
          <span class="label">Pending</span>
        </div>
        <button
          class="pane-collapse"
          type="button"
          disabled
          aria-label="collapse"
        >
          ⟩⟩
        </button>
      </div>
      <div class="content"></div>
    </aside>
  );
}
