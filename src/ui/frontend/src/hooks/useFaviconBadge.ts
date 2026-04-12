import { useEffect } from "preact/hooks";

/**
 * Dynamically sets the favicon to show a notification dot:
 * - Red dot when there are pending approvals (pendingCount > 0)
 * - Yellow dot when containers await user turn (userTurnCount > 0)
 * Red takes priority over yellow.
 */
export function useFaviconBadge(pendingCount: number, userTurnCount: number) {
  useEffect(() => {
    const SIZE = 32;
    const canvas = document.createElement("canvas");
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Base icon: dark rounded square with "N" letter
    ctx.fillStyle = "#1e293b";
    roundRect(ctx, 0, 0, SIZE, SIZE, 6);
    ctx.fill();
    ctx.fillStyle = "#38bdf8";
    ctx.font = "bold 20px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("N", SIZE / 2, SIZE / 2 + 1);

    // Badge dot: red for pending (priority), yellow for user-turn
    const badgeColor =
      pendingCount > 0 ? "#ef4444" : userTurnCount > 0 ? "#eab308" : null;
    if (badgeColor) {
      ctx.fillStyle = badgeColor;
      ctx.beginPath();
      ctx.arc(SIZE - 6, 6, 6, 0, Math.PI * 2);
      ctx.fill();
    }

    const url = canvas.toDataURL("image/png");
    let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = url;
  }, [pendingCount, userTurnCount]);
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
