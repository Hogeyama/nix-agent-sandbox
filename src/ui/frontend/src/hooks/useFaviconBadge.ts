import { useEffect } from "preact/hooks";

/**
 * Dynamically sets the favicon to show a red notification dot
 * when there are pending items (like Slack does).
 */
export function useFaviconBadge(count: number) {
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

    // Red badge dot when count > 0
    if (count > 0) {
      ctx.fillStyle = "#ef4444";
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
  }, [count]);
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
