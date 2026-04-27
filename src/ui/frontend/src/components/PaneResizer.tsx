/**
 * Vertical drag handle that resizes the pane to its `side`.
 *
 * Pointer interaction uses the pointer-capture pattern: capturing the
 * pointer on the resizer element keeps the move/up/cancel events
 * targeted at this resizer even when the cursor leaves it during the
 * drag. Listeners for all three events (`pointermove`, `pointerup`,
 * `pointercancel`) are registered on `document` and removed
 * symmetrically — `onCleanup` provides a safety net in case the
 * component unmounts mid-drag.
 *
 * WAI-ARIA: the element exposes `role="separator"` with the vertical
 * orientation and `aria-valuenow/min/max` so assistive tech can read
 * the live width. `tabindex={0}` makes the divider keyboard-reachable;
 * Arrow keys nudge the width by 8px and Home/End jump to the bounds.
 */

import { onCleanup } from "solid-js";
import { clampWidth, MAX_PANE, MIN_LEFT, MIN_RIGHT } from "./paneResizerLogic";

export interface PaneResizerProps {
  side: "left" | "right";
  width: () => number;
  setWidth: (px: number) => void;
}

const KEYBOARD_STEP_PX = 8;

export function PaneResizer(props: PaneResizerProps) {
  let resizerEl: HTMLDivElement | undefined;
  let dragStartX = 0;
  let dragStartWidth = 0;
  let pointerId: number | null = null;

  const minFor = (side: "left" | "right") =>
    side === "left" ? MIN_LEFT : MIN_RIGHT;

  const handleMove = (e: PointerEvent) => {
    // Pointer capture is held on the active resizer pointer; events
    // from other pointers (e.g. concurrent multi-touch) belong to
    // separate interactions and are ignored here. onCleanup at the
    // end of the component provides the unmount safety net.
    if (e.pointerId !== pointerId) return;
    const dx = e.clientX - dragStartX;
    // Left pane: dragging the right edge rightwards grows the pane.
    // Right pane: dragging the left edge rightwards shrinks the pane.
    const delta = props.side === "left" ? dx : -dx;
    props.setWidth(
      clampWidth(dragStartWidth + delta, minFor(props.side), MAX_PANE),
    );
  };

  const handleUp = (e: PointerEvent) => {
    // Same pointer-id guard as handleMove: only the captured pointer
    // ends the drag, so pointerup / pointercancel from other pointers
    // does not tear down our document listeners.
    if (e.pointerId !== pointerId) return;
    if (resizerEl && pointerId !== null) {
      try {
        resizerEl.releasePointerCapture(pointerId);
      } catch {
        // releasePointerCapture throws on browsers if the pointer is no
        // longer captured; the capture is gone either way, so swallow.
      }
    }
    pointerId = null;
    document.removeEventListener("pointermove", handleMove);
    document.removeEventListener("pointerup", handleUp);
    document.removeEventListener("pointercancel", handleUp);
  };

  const handleDown = (e: PointerEvent) => {
    if (!resizerEl) return;
    pointerId = e.pointerId;
    dragStartX = e.clientX;
    dragStartWidth = props.width();
    try {
      resizerEl.setPointerCapture(e.pointerId);
    } catch {
      // setPointerCapture can throw if the pointer is gone before the
      // capture call lands; the drag still works via document listeners.
    }
    e.preventDefault();
    document.addEventListener("pointermove", handleMove);
    document.addEventListener("pointerup", handleUp);
    document.addEventListener("pointercancel", handleUp);
  };

  const handleKey = (e: KeyboardEvent) => {
    const min = minFor(props.side);
    let next = props.width();
    if (e.key === "ArrowLeft") next -= KEYBOARD_STEP_PX;
    else if (e.key === "ArrowRight") next += KEYBOARD_STEP_PX;
    else if (e.key === "Home") next = min;
    else if (e.key === "End") next = MAX_PANE;
    else return;
    e.preventDefault();
    props.setWidth(clampWidth(next, min, MAX_PANE));
  };

  onCleanup(() => {
    // Safety net: an unmount mid-drag must not leave document listeners
    // or a captured pointer behind.
    document.removeEventListener("pointermove", handleMove);
    document.removeEventListener("pointerup", handleUp);
    document.removeEventListener("pointercancel", handleUp);
    if (resizerEl && pointerId !== null) {
      try {
        resizerEl.releasePointerCapture(pointerId);
      } catch {
        // see handleUp.
      }
    }
  });

  return (
    // biome-ignore lint/a11y/useSemanticElements: the resizer carries pointer/keyboard handlers for drag-to-resize, which an <hr> cannot host; role="separator" with aria-orientation expresses the same affordance.
    // biome-ignore lint/a11y/useFocusableInteractive: tabindex={0} below makes the element focusable; biome does not recognise the lowercase Solid attribute.
    <div
      ref={(el) => {
        resizerEl = el;
      }}
      class="pane-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={props.width()}
      aria-valuemin={minFor(props.side)}
      aria-valuemax={MAX_PANE}
      tabindex={0}
      onPointerDown={handleDown}
      onKeyDown={handleKey}
    />
  );
}
