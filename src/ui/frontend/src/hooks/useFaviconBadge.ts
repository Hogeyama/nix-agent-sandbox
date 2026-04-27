/**
 * Favicon badge hook for the control room UI.
 *
 * The hook reads a single `Lamp` accessor and re-renders the favicon
 * whenever the lamp changes. The actual canvas drawing is split out
 * into the pure `renderFaviconBadge` function so tests can exercise
 * the drawing contract (which colour, where the dot lands, whether
 * the link href is updated) without spinning up Solid's reactive
 * runtime: the hook itself only owns the `createEffect` wrapper.
 *
 * Renders a 32×32 favicon: #1e293b rounded-square, #38bdf8 "N", with a
 * (SIZE-6, 6, r=6) lamp-coloured badge dot. The DI seam
 * (`createCanvas` / `getLinkElement`) lets the test replace the DOM
 * surface area without touching `document` directly; production code
 * continues to use `document.createElement` / `document.querySelector`
 * via the defaults below.
 */

import { createEffect } from "solid-js";
import type { Lamp } from "../components/sessionLamp";

const SIZE = 32;

/**
 * Minimal subset of `HTMLLinkElement` the badge writer needs. Typed
 * structurally so test fakes don't have to implement the full DOM
 * Link element surface.
 */
export interface FaviconLink {
  href: string;
  rel: string;
}

/**
 * Minimal subset of `HTMLCanvasElement` the badge writer needs. The
 * concrete browser canvas satisfies this shape; tests pass in a
 * spyable fake whose `getContext` returns a mock 2D context.
 */
export interface FaviconCanvas {
  width: number;
  height: number;
  getContext(contextId: "2d"): CanvasRenderingContext2D | null;
  toDataURL(type?: string): string;
}

export interface FaviconBadgeDeps {
  /** Returns a fresh canvas. Defaults to `document.createElement("canvas")`. */
  createCanvas?: () => FaviconCanvas;
  /**
   * Returns the existing favicon link element, or null if the page
   * has not declared one yet. Defaults to
   * `document.querySelector("link[rel='icon']")`.
   */
  getLinkElement?: () => FaviconLink | null;
  /**
   * Creates a new favicon link element when the page lacks one. The
   * returned link must already be attached to the document so that
   * subsequent `href` writes take effect; the default implementation
   * appends to `document.head`.
   */
  createLinkElement?: () => FaviconLink;
}

/**
 * Pure draw routine. Exported so tests can drive the canvas contract
 * directly (without requiring Solid's reactive runtime). Returns the
 * data URL it wrote to `link.href`, which the test can also assert
 * against the mock canvas's `toDataURL` return value.
 */
export function renderFaviconBadge(
  lamp: Lamp,
  canvas: FaviconCanvas,
  link: FaviconLink,
): string {
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return link.href;

  // Base icon: dark rounded square with a #38bdf8 "N" — the
  // lamp-agnostic baseline that the badge dot is layered on top of.
  ctx.fillStyle = "#1e293b";
  roundRect(ctx, 0, 0, SIZE, SIZE, 6);
  ctx.fill();
  ctx.fillStyle = "#38bdf8";
  ctx.font = "bold 20px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("N", SIZE / 2, SIZE / 2 + 1);

  // Badge dot — pending is red and wins over user-turn (yellow); a
  // `none` lamp deliberately skips the arc so the base icon shows
  // through unchanged.
  const badgeColor =
    lamp === "pending" ? "#ef4444" : lamp === "user-turn" ? "#eab308" : null;
  if (badgeColor !== null) {
    ctx.fillStyle = badgeColor;
    ctx.beginPath();
    ctx.arc(SIZE - 6, 6, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  const url = canvas.toDataURL("image/png");
  link.href = url;
  return url;
}

/**
 * Solid hook: re-renders the favicon whenever the `lamp` accessor
 * changes. Wraps `renderFaviconBadge` in a `createEffect` so the
 * effect runs once on mount and again on every lamp transition.
 */
export function useFaviconBadge(
  lamp: () => Lamp,
  deps?: FaviconBadgeDeps,
): void {
  const createCanvas = deps?.createCanvas ?? defaultCreateCanvas;
  const getLinkElement = deps?.getLinkElement ?? defaultGetLinkElement;
  const createLinkElement = deps?.createLinkElement ?? defaultCreateLinkElement;
  createEffect(() => {
    const value = lamp();
    const canvas = createCanvas();
    const link = getLinkElement() ?? createLinkElement();
    renderFaviconBadge(value, canvas, link);
  });
}

function defaultCreateCanvas(): FaviconCanvas {
  return document.createElement("canvas");
}

function defaultGetLinkElement(): FaviconLink | null {
  return document.querySelector<HTMLLinkElement>("link[rel='icon']");
}

function defaultCreateLinkElement(): FaviconLink {
  const link = document.createElement("link");
  link.rel = "icon";
  document.head.appendChild(link);
  return link;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
