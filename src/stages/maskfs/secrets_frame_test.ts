import { expect, test } from "bun:test";
import { encodeMaskSecrets } from "./secrets_frame.ts";

test("encodeMaskSecrets frames count and length-prefixed values", () => {
  const frame = encodeMaskSecrets(["ab", "xyz"]);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  expect(view.getUint32(0, true)).toEqual(2);
  expect(view.getUint32(4, true)).toEqual(2);
  expect(new TextDecoder().decode(frame.slice(8, 10))).toEqual("ab");
  expect(view.getUint32(10, true)).toEqual(3);
  expect(new TextDecoder().decode(frame.slice(14, 17))).toEqual("xyz");
  expect(frame.byteLength).toEqual(4 + 4 + 2 + 4 + 3);
});

test("encodeMaskSecrets handles multibyte utf-8", () => {
  const frame = encodeMaskSecrets(["ぱす"]);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  expect(view.getUint32(0, true)).toEqual(1);
  expect(view.getUint32(4, true)).toEqual(6); // 3 bytes × 2 chars
});

test("encodeMaskSecrets handles empty secrets list", () => {
  const frame = encodeMaskSecrets([]);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  expect(view.getUint32(0, true)).toEqual(0);
  expect(frame.byteLength).toEqual(4);
});
