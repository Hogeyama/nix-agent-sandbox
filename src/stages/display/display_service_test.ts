import { expect, test } from "bun:test";
import {
  buildWildXauthorityRecord,
  extractCookieFromXauthList,
} from "./display_service.ts";

/**
 * Xauthority(5) wire format:
 *   u16 family       — 0xffff for FamilyWild
 *   u16 addr_len     — 0 when family is Wild
 *   u16 number_len   — bytes of display number string
 *   <number bytes>
 *   u16 name_len     — bytes of protocol name
 *   <name bytes>
 *   u16 data_len     — bytes of cookie
 *   <cookie bytes>
 *
 * The Wild family is what makes the same cookie work from inside an agent
 * container whose hostname differs from the host where nas wrote the file.
 */

function readUInt16BE(buf: Uint8Array, offset: number): number {
  return (buf[offset] << 8) | buf[offset + 1];
}

function decode(buf: Uint8Array, offset: number, len: number): string {
  return new TextDecoder().decode(buf.subarray(offset, offset + len));
}

test("buildWildXauthorityRecord: encodes family=Wild and zero-length address", () => {
  const cookie = new Uint8Array(16).fill(0xab);
  const buf = buildWildXauthorityRecord(100, cookie);
  expect(readUInt16BE(buf, 0)).toEqual(0xffff);
  expect(readUInt16BE(buf, 2)).toEqual(0);
});

test("buildWildXauthorityRecord: encodes display number, protocol, and cookie", () => {
  const cookie = new Uint8Array([
    0x04, 0xa7, 0x6b, 0xeb, 0x4f, 0x51, 0xb8, 0x7c, 0x07, 0xf3, 0x2c, 0x14,
    0x83, 0x1d, 0xaf, 0xa7,
  ]);
  const buf = buildWildXauthorityRecord(100, cookie);

  let off = 4; // skip family + addr_len
  const numberLen = readUInt16BE(buf, off);
  off += 2;
  expect(numberLen).toEqual(3);
  expect(decode(buf, off, numberLen)).toEqual("100");
  off += numberLen;

  const nameLen = readUInt16BE(buf, off);
  off += 2;
  expect(nameLen).toEqual(18);
  expect(decode(buf, off, nameLen)).toEqual("MIT-MAGIC-COOKIE-1");
  off += nameLen;

  const dataLen = readUInt16BE(buf, off);
  off += 2;
  expect(dataLen).toEqual(16);
  expect(Array.from(buf.subarray(off, off + 16))).toEqual(Array.from(cookie));
  off += 16;

  expect(off).toEqual(buf.length);
});

test("buildWildXauthorityRecord: handles multi-digit display numbers", () => {
  const cookie = new Uint8Array(16);
  const buf = buildWildXauthorityRecord(12345, cookie);
  // family(2) + addr_len(2) + number_len(2) + "12345"(5)
  //   + name_len(2) + "MIT-MAGIC-COOKIE-1"(18) + data_len(2) + cookie(16)
  expect(buf.length).toEqual(2 + 2 + 2 + 5 + 2 + 18 + 2 + 16);
  expect(readUInt16BE(buf, 4)).toEqual(5);
  expect(decode(buf, 6, 5)).toEqual("12345");
});

test("buildWildXauthorityRecord: total length matches the canonical 47 bytes for :100", () => {
  // 2 + 2 + 2 + 3 + 2 + 18 + 2 + 16 = 47
  const buf = buildWildXauthorityRecord(100, new Uint8Array(16));
  expect(buf.length).toEqual(47);
});

// ---------------------------------------------------------------------------
// extractCookieFromXauthList
// ---------------------------------------------------------------------------

test("extractCookieFromXauthList: picks the entry for the requested display", () => {
  const stdout = [
    "nixos/unix:0  MIT-MAGIC-COOKIE-1  0102030405060708090a0b0c0d0e0f10",
    "nixos/unix:100  MIT-MAGIC-COOKIE-1  aabbccddeeff00112233445566778899",
    "nixos/unix:201  MIT-MAGIC-COOKIE-1  ffffffffffffffffffffffffffffffff",
  ].join("\n");
  const out = extractCookieFromXauthList(stdout, 100);
  expect(Array.from(out)).toEqual([
    0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55,
    0x66, 0x77, 0x88, 0x99,
  ]);
});

test("extractCookieFromXauthList: throws when display not present", () => {
  const stdout = "nixos/unix:0  MIT-MAGIC-COOKIE-1  aabbccdd";
  expect(() => extractCookieFromXauthList(stdout, 100)).toThrow(/:100/);
});

test("extractCookieFromXauthList: ignores lines with non-MIT protocol", () => {
  const stdout = [
    "nixos/unix:100  XDM-AUTHORIZATION-1  cafebabecafebabecafebabecafebabe",
    "nixos/unix:100  MIT-MAGIC-COOKIE-1  00112233445566778899aabbccddeeff",
  ].join("\n");
  const out = extractCookieFromXauthList(stdout, 100);
  expect(out[0]).toEqual(0x00);
  expect(out[out.length - 1]).toEqual(0xff);
});
