/** Minimal IPv4 / IPv6 parsing and CIDR matching for proxy trust decisions. */
export interface ParsedIp {
  version: 4 | 6;
  value: bigint;
}

function parseV4(s: string): bigint | undefined {
  const parts = s.split('.');
  if (parts.length !== 4) return undefined;
  let v = 0n;
  for (const p of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return undefined;
    const n = Number(p);
    if (n > 255) return undefined;
    v = (v << 8n) | BigInt(n);
  }
  return v;
}

function parseV6(s: string): bigint | undefined {
  let str = s;
  const zone = str.indexOf('%');
  if (zone >= 0) str = str.slice(0, zone);
  let tail: number[] = [];
  // embedded IPv4 (e.g. ::ffff:1.2.3.4)
  const lastColon = str.lastIndexOf(':');
  if (str.includes('.') && lastColon >= 0) {
    const v4 = parseV4(str.slice(lastColon + 1));
    if (v4 === undefined) return undefined;
    tail = [Number(v4 >> 16n), Number(v4 & 0xffffn)];
    const prefix = str.slice(0, lastColon + 1); // always ends with ':'
    str = prefix.endsWith('::') ? prefix : prefix.slice(0, -1);
  }
  const halves = str.split('::');
  if (halves.length > 2) return undefined;
  const parse = (h: string): number[] | undefined => {
    if (h === '') return [];
    const out: number[] = [];
    for (const g of h.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  if (!head || !rest) return undefined;
  const total = head.length + rest.length + tail.length;
  let groups: number[];
  if (halves.length === 2) {
    if (total > 7) return undefined;
    groups = [...head, ...new Array<number>(8 - total).fill(0), ...rest, ...tail];
  } else {
    if (total !== 8) return undefined;
    groups = [...head, ...tail];
  }
  let v = 0n;
  for (const g of groups) v = (v << 16n) | BigInt(g);
  return v;
}

const V4_MAPPED_PREFIX = 0xffffn << 32n;

/** Parse an IP literal. IPv4-mapped IPv6 (::ffff:a.b.c.d) is normalised to IPv4. Brackets are stripped. */
export function parseIp(input: string): ParsedIp | undefined {
  let s = input.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (s.length === 0 || s.length > 64) return undefined;
  if (!s.includes(':')) {
    const v = parseV4(s);
    return v === undefined ? undefined : { version: 4, value: v };
  }
  const v = parseV6(s);
  if (v === undefined) return undefined;
  if (v >> 32n === 0xffffn && (v & ~((1n << 32n) - 1n)) === V4_MAPPED_PREFIX) return { version: 4, value: v & 0xffffffffn };
  return { version: 6, value: v };
}

export interface Cidr {
  version: 4 | 6;
  base: bigint;
  bits: number;
}

export function parseCidr(input: string): Cidr {
  const parts = input.split('/');
  if (parts.length > 2) throw new Error(`invalid CIDR: ${input}`);
  const [addr, bitsStr] = parts;
  const ip = parseIp(addr ?? '');
  if (!ip) throw new Error(`invalid CIDR: ${input}`);
  const max = ip.version === 4 ? 32 : 128;
  const bits = bitsStr === undefined ? max : Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > max || (bitsStr !== undefined && !/^\d{1,3}$/.test(bitsStr)))
    throw new Error(`invalid CIDR: ${input}`);
  const shift = BigInt(max - bits);
  return { version: ip.version, base: (ip.value >> shift) << shift, bits };
}

export function cidrContains(cidr: Cidr, ip: ParsedIp): boolean {
  if (cidr.version !== ip.version) return false;
  const shift = BigInt((ip.version === 4 ? 32 : 128) - cidr.bits);
  return (ip.value >> shift) << shift === cidr.base;
}

/** Canonical textual form (IPv4 dotted, IPv6 full lower-case hex groups) for use as a rate-limit key. */
export function formatIp(ip: ParsedIp): string {
  if (ip.version === 4) return [24n, 16n, 8n, 0n].map((s) => String((ip.value >> s) & 0xffn)).join('.');
  const groups: string[] = [];
  for (let i = 7; i >= 0; i--) groups.push(((ip.value >> BigInt(i * 16)) & 0xffffn).toString(16));
  return groups.join(':');
}
