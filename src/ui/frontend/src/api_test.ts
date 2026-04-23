/**
 * Unit tests for `getWsToken` — the bridge between the HTML shell's
 * `<meta name="nas-ws-token">` tag and the frontend's WebSocket auth.
 *
 * Bun's test runtime has no DOM, so we fabricate a minimal `Document`
 * stub covering just the `querySelector` path `getWsToken` exercises.
 * Keeping the stub inline (instead of pulling in jsdom) preserves the
 * "no new npm deps" constraint from the plan.
 */

import { expect, test } from "bun:test";
import { getWsToken } from "./api.ts";

type MetaStub = { getAttribute(name: string): string | null } | null;

function makeDocStub(meta: MetaStub): Document {
  const doc = {
    querySelector(selector: string) {
      if (selector === 'meta[name="nas-ws-token"]') return meta;
      return null;
    },
  };
  // `getWsToken` only touches `querySelector` + `getAttribute`, so the
  // unused surface of the Document type is safe to cast away here.
  return doc as unknown as Document;
}

function makeMetaStub(content: string | null): MetaStub {
  return {
    getAttribute(name: string): string | null {
      if (name === "content") return content;
      return null;
    },
  };
}

test("getWsToken returns the token when meta tag carries a valid value", () => {
  const doc = makeDocStub(makeMetaStub("abc123_-XYZ"));
  expect(getWsToken(doc)).toBe("abc123_-XYZ");
});

test("getWsToken throws when the meta tag is missing entirely", () => {
  const doc = makeDocStub(null);
  expect(() => getWsToken(doc)).toThrow(/WS token not injected/);
});

test("getWsToken throws when the content attribute is empty", () => {
  const doc = makeDocStub(makeMetaStub(""));
  expect(() => getWsToken(doc)).toThrow(/WS token not injected/);
});

test("getWsToken throws when the content attribute is the literal placeholder", () => {
  // A production failure mode: the daemon never ran materializeAssets
  // (stale build or broken injection) so the raw template reaches the
  // browser. We want a loud error, not a silent spoofable fallback.
  const doc = makeDocStub(makeMetaStub("{{NAS_WS_TOKEN}}"));
  expect(() => getWsToken(doc)).toThrow(/WS token not injected/);
});

test("getWsToken throws when the content attribute is null (meta has no content)", () => {
  const doc = makeDocStub(makeMetaStub(null));
  expect(() => getWsToken(doc)).toThrow(/WS token not injected/);
});
