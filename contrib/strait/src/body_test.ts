import { describe, expect, test } from "bun:test";
import { readBody } from "./body.ts";
import { BODY_LIMIT } from "./policy.ts";

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request("https://api.github.com/graphql", {
    method: "POST",
    body,
    headers,
  });

describe("readBody", () => {
  test("reads UTF-8 text", async () => {
    expect(await readBody(post('{"query":"é"}'))).toBe('{"query":"é"}');
  });
  test("a body at the limit is read", async () => {
    expect(await readBody(post("a".repeat(BODY_LIMIT)))).toHaveLength(
      BODY_LIMIT,
    );
  });
  test("a declared length over the limit is not read", async () => {
    const r = post("{}", { "content-length": String(BODY_LIMIT + 1) });
    expect(await readBody(r)).toBeNull();
  });
  test("a streamed body over the limit is not read", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(97);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent++ < 8) c.enqueue(chunk);
        else c.close();
      },
    });
    expect(await readBody(post(stream))).toBeNull();
  });
  test("bytes that are not UTF-8 are not read", async () => {
    expect(await readBody(post(new Uint8Array([0xff, 0xfe])))).toBeNull();
  });
});
