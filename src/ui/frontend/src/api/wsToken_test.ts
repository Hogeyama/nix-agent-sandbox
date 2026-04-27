/**
 * Tests for `getWsToken`.
 *
 * The function refuses to invent a token under any degenerate input —
 * missing meta tag, empty content, or the literal placeholder. Each
 * branch is exercised, plus the happy path where a real token is
 * returned verbatim.
 *
 * A minimal `Document`-shaped fake is used so the tests do not depend
 * on a real DOM (and so they run unchanged under `bun test`).
 */

import { describe, expect, test } from "bun:test";
import { getWsToken } from "./wsToken";

function fakeDocument(meta: { content: string | null } | null): Document {
  return {
    querySelector(selector: string) {
      if (selector !== 'meta[name="nas-ws-token"]') return null;
      if (meta === null) return null;
      return {
        getAttribute(name: string) {
          return name === "content" ? meta.content : null;
        },
      };
    },
  } as unknown as Document;
}

describe("getWsToken", () => {
  test("throws when the meta tag is absent", () => {
    expect(() => getWsToken(fakeDocument(null))).toThrow(
      /WS token not injected/,
    );
  });

  test("throws when content attribute is empty", () => {
    expect(() => getWsToken(fakeDocument({ content: "" }))).toThrow(
      /WS token not injected/,
    );
  });

  test("throws when content is the unmaterialised placeholder", () => {
    expect(() =>
      getWsToken(fakeDocument({ content: "{{NAS_WS_TOKEN}}" })),
    ).toThrow(/WS token not injected/);
  });

  test("returns the token verbatim when injected with a real value", () => {
    expect(getWsToken(fakeDocument({ content: "real-token-abc" }))).toBe(
      "real-token-abc",
    );
  });
});
