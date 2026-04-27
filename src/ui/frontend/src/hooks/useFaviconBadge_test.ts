import { describe, expect, mock, test } from "bun:test";
import type { Lamp } from "../components/sessionLamp";
import {
  type FaviconCanvas,
  type FaviconLink,
  renderFaviconBadge,
} from "./useFaviconBadge";

/**
 * Build a fake `CanvasRenderingContext2D` whose mutating calls are
 * spyable. Only the methods/props the renderer touches are wired up;
 * the cast through `unknown` confines the partial-mock surface to the
 * test boundary so production code keeps the full type.
 */
function makeFakeCtx() {
  const fillStyleHistory: string[] = [];
  const fillCalls: number[] = [];
  const arcCalls: { x: number; y: number; r: number }[] = [];
  let fillStyle = "";
  const ctx = {
    set fillStyle(value: string) {
      fillStyle = value;
      fillStyleHistory.push(value);
    },
    get fillStyle() {
      return fillStyle;
    },
    font: "",
    textAlign: "",
    textBaseline: "",
    beginPath: mock(() => undefined),
    moveTo: mock((_x: number, _y: number) => undefined),
    arcTo: mock(
      (_x1: number, _y1: number, _x2: number, _y2: number, _r: number) =>
        undefined,
    ),
    closePath: mock(() => undefined),
    fill: mock(() => {
      fillCalls.push(fillCalls.length);
    }),
    fillText: mock((_text: string, _x: number, _y: number) => undefined),
    arc: mock(
      (x: number, y: number, r: number, _start: number, _end: number): void => {
        arcCalls.push({ x, y, r });
      },
    ),
  };
  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    fillStyleHistory,
    fillCalls,
    arcCalls,
    arcSpy: ctx.arc,
  };
}

function makeFakeCanvas(ctx: CanvasRenderingContext2D): {
  canvas: FaviconCanvas;
  toDataURL: ReturnType<typeof mock>;
} {
  const toDataURL = mock((_type?: string) => "data:image/png;base64,FAKEPNG");
  const canvas: FaviconCanvas = {
    width: 0,
    height: 0,
    getContext: (id: "2d") => (id === "2d" ? ctx : null),
    toDataURL: toDataURL as (type?: string) => string,
  };
  return { canvas, toDataURL };
}

function makeFakeLink(): FaviconLink {
  return { href: "", rel: "icon" };
}

describe("renderFaviconBadge", () => {
  test("pending lamp paints a red dot in the top-right and updates link.href", () => {
    const { ctx, fillStyleHistory, arcCalls } = makeFakeCtx();
    const { canvas, toDataURL } = makeFakeCanvas(ctx);
    const link = makeFakeLink();

    const url = renderFaviconBadge("pending", canvas, link);

    expect(toDataURL).toHaveBeenCalledTimes(1);
    expect(toDataURL).toHaveBeenCalledWith("image/png");
    expect(link.href).toBe("data:image/png;base64,FAKEPNG");
    expect(url).toBe("data:image/png;base64,FAKEPNG");
    // Base + badge fillStyles: dark square, sky-blue letter, red dot.
    expect(fillStyleHistory).toEqual(["#1e293b", "#38bdf8", "#ef4444"]);
    expect(arcCalls).toEqual([{ x: 32 - 6, y: 6, r: 6 }]);
  });

  test("user-turn lamp paints a yellow dot", () => {
    const { ctx, fillStyleHistory, arcCalls } = makeFakeCtx();
    const { canvas } = makeFakeCanvas(ctx);
    const link = makeFakeLink();

    renderFaviconBadge("user-turn", canvas, link);

    expect(fillStyleHistory).toEqual(["#1e293b", "#38bdf8", "#eab308"]);
    expect(arcCalls).toEqual([{ x: 32 - 6, y: 6, r: 6 }]);
  });

  test("none lamp does not call ctx.arc (no badge dot)", () => {
    const { ctx, fillStyleHistory, arcCalls, arcSpy } = makeFakeCtx();
    const { canvas, toDataURL } = makeFakeCanvas(ctx);
    const link = makeFakeLink();

    renderFaviconBadge("none", canvas, link);

    expect(arcSpy).toHaveBeenCalledTimes(0);
    expect(arcCalls).toEqual([]);
    // Only the base icon's fillStyles are recorded; no badge colour.
    expect(fillStyleHistory).toEqual(["#1e293b", "#38bdf8"]);
    // Even with no badge, link.href is still updated to the latest
    // toDataURL output so the favicon refreshes on every lamp change.
    expect(toDataURL).toHaveBeenCalledTimes(1);
    expect(link.href).toBe("data:image/png;base64,FAKEPNG");
  });

  test("canvas dimensions are set to 32x32 before drawing", () => {
    const { ctx } = makeFakeCtx();
    const { canvas } = makeFakeCanvas(ctx);
    const link = makeFakeLink();

    renderFaviconBadge("none", canvas, link);

    expect(canvas.width).toBe(32);
    expect(canvas.height).toBe(32);
  });

  test("when getContext returns null, link.href is left untouched", () => {
    const link: FaviconLink = { href: "preserved", rel: "icon" };
    const toDataURL = mock(() => "data:image/png;base64,SHOULDNOTSEE");
    const canvas: FaviconCanvas = {
      width: 0,
      height: 0,
      getContext: () => null,
      toDataURL: toDataURL as (type?: string) => string,
    };

    const result = renderFaviconBadge("pending", canvas, link);

    expect(toDataURL).toHaveBeenCalledTimes(0);
    expect(link.href).toBe("preserved");
    expect(result).toBe("preserved");
  });

  test("each lamp value selects a distinct badge colour", () => {
    const colours: Record<Lamp, string | null> = {
      pending: "#ef4444",
      "user-turn": "#eab308",
      none: null,
    };
    for (const [lamp, expected] of Object.entries(colours) as [
      Lamp,
      string | null,
    ][]) {
      const { ctx, fillStyleHistory } = makeFakeCtx();
      const { canvas } = makeFakeCanvas(ctx);
      renderFaviconBadge(lamp, canvas, makeFakeLink());
      if (expected === null) {
        expect(fillStyleHistory).toEqual(["#1e293b", "#38bdf8"]);
      } else {
        expect(fillStyleHistory).toEqual(["#1e293b", "#38bdf8", expected]);
      }
    }
  });
});
