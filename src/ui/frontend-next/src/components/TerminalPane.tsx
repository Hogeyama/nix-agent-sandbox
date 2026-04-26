import type { TerminalsStore } from "../stores/terminalsStore";

type Props = {
  /**
   * Store backing the active dtach session this pane attaches to.
   * Held on props so future xterm wiring can read `activeId()` and the
   * dtach session list without reaching outside the component.
   */
  terminals: TerminalsStore;
};

export function TerminalPane(props: Props) {
  return (
    <section class="pane pane-center">
      <div class="terminal" data-active-id={props.terminals.activeId() ?? ""} />
      <footer class="term-toolbar"></footer>
    </section>
  );
}
