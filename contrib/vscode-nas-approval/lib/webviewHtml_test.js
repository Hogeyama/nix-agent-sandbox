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
