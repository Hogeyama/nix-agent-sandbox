import { expect, test } from "bun:test";
import { renderShell } from "./webviewHtml.js";

test("shell carries a nonce-scoped CSP and no remote resources", () => {
  const html = renderShell("NONCE123");
  expect(html).toContain("default-src 'none'");
  expect(html).toContain("script-src 'nonce-NONCE123'");
  expect(html).toContain('nonce="NONCE123"');
  expect(html).not.toContain("http://");
  expect(html).not.toContain("https://");
});

test("shell script posts ready and decides on click", () => {
  const html = renderShell("N");
  expect(html).toContain('vscode.postMessage({ type: "ready" })');
  expect(html).toContain('type: "decide"');
});

test("shell script persists scope selections across re-renders", () => {
  const html = renderShell("N");
  // change リスナーが selections[key] に選んだ scope を記録し、render が
  // selectedScope よりそれを優先する。state メッセージで消えた key は掃除する。
  expect(html).toContain('addEventListener("change"');
  expect(html).toContain("selections[");
  expect(html).toContain("selections[c.key] ?? c.selectedScope");
  expect(html).toContain("delete selections[k]");
});

test("shell script renders relative elapsed time and refreshes it", () => {
  const html = renderShell("N");
  expect(html).toContain("formatRelativeTime");
  expect(html).toContain("ago");
  expect(html).toContain("setInterval(refreshElapsed, 15000)");
  expect(html).toContain('class="elapsed"');
});

test("deny button matches nas ui label", () => {
  const html = renderShell("N");
  expect(html).toContain("Deny this request only");
});
