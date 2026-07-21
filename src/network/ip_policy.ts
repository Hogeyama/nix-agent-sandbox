import { isIP } from "node:net";

type Ipv4Octets = readonly [number, number, number, number];

export function isDeniedIpAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = parseIpv4(address);
    return octets !== null && isDeniedIpv4(octets);
  }
  if (version !== 6) return false;

  const words = parseIpv6(address);
  if (words === null) return false;

  const mapped = mappedIpv4(words);
  if (mapped !== null) return isDeniedIpv4(mapped);

  const allZero = words.every((word) => word === 0);
  if (allZero) return true;
  const loopback =
    words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  if (loopback) return true;
  if ((words[0] & 0xfe00) === 0xfc00) return true;
  if ((words[0] & 0xffc0) === 0xfe80) return true;
  return false;
}

function parseIpv4(address: string): Ipv4Octets | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map(Number);
  if (
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return null;
  }
  return octets as unknown as Ipv4Octets;
}

function isDeniedIpv4([a, b]: Ipv4Octets): boolean {
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return a === 192 && b === 168;
}

function parseIpv6(address: string): number[] | null {
  const withoutZone = address.split("%", 1)[0];
  if (withoutZone.indexOf("::") !== withoutZone.lastIndexOf("::")) return null;

  const halves = withoutZone.split("::");
  const left = parseIpv6Half(halves[0]);
  const right = parseIpv6Half(halves[1] ?? "");
  if (left === null || right === null) return null;

  if (halves.length === 1) return left.length === 8 ? left : null;
  const omitted = 8 - left.length - right.length;
  if (omitted < 1) return null;
  return [...left, ...Array<number>(omitted).fill(0), ...right];
}

function parseIpv6Half(half: string): number[] | null {
  if (half === "") return [];
  const tokens = half.split(":");
  const words: number[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token.includes(".")) {
      if (index !== tokens.length - 1) return null;
      const octets = parseIpv4(token);
      if (octets === null) return null;
      words.push((octets[0] << 8) | octets[1]);
      words.push((octets[2] << 8) | octets[3]);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/i.test(token)) return null;
    words.push(Number.parseInt(token, 16));
  }
  return words;
}

function mappedIpv4(words: readonly number[]): Ipv4Octets | null {
  if (
    words.length !== 8 ||
    !words.slice(0, 5).every((word) => word === 0) ||
    words[5] !== 0xffff
  ) {
    return null;
  }
  return [words[6] >> 8, words[6] & 0xff, words[7] >> 8, words[7] & 0xff];
}
