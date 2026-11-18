/**
 * Address classification for webhook SSRF checks. SEP-3415 says servers SHOULD reject
 * callback addresses that are not globally routable (IANA special-purpose registries) and
 * MUST check again at delivery time, connecting to the address they validated.
 */
import { isIP } from "node:net";

const V4_BLOCKS: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inV4Block(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
}

function expandV6(ip: string): number[] | undefined {
  let addr = ip.toLowerCase();
  const zone = addr.indexOf("%");
  if (zone !== -1) addr = addr.slice(0, zone);
  // Trailing embedded IPv4 (::ffff:1.2.3.4).
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4 && v4[1]) {
    const n = v4ToInt(v4[1]);
    addr = addr.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const parts = [...head, ...Array(Math.max(fill, 0)).fill("0"), ...tail];
  if (parts.length !== 8) return undefined;
  return parts.map((p) => parseInt(p || "0", 16));
}

/** True when an IP literal is publicly routable (not loopback, private, link-local, ULA, documentation, ...). */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !V4_BLOCKS.some(([base, bits]) => inV4Block(ip, base, bits)) && ip !== "255.255.255.255";
  if (family !== 6) return false;
  const w = expandV6(ip);
  if (!w) return false;
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = w;
  if (w.every((x) => x === 0)) return false; // ::
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && g === 0 && h === 1) return false; // ::1
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) {
    return isPublicAddress(`${g >> 8}.${g & 0xff}.${h >> 8}.${h & 0xff}`); // IPv4-mapped
  }
  if ((a & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((a & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((a & 0xff00) === 0xff00) return false; // multicast
  if (a === 0x2001 && b === 0x0db8) return false; // documentation
  if (a === 0x0100 && b === 0 && c === 0 && d === 0) return false; // discard-only
  if (a === 0x64 && b === 0xff9b) return false; // NAT64 well-known prefix
  return true;
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (isIP(h) === 4) return inV4Block(h, "127.0.0.0", 8);
  if (isIP(h) === 6) return h === "::1";
  return false;
}
