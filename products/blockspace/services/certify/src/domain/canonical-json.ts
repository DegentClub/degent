/**
 * Canonical JSON (RFC 8785 / JCS for the value domain we sign): object keys sorted by UTF-16 code
 * units, no insignificant whitespace, ECMAScript number and string serialisation. Anything outside
 * plain JSON (undefined, functions, bigint, NaN/Infinity, non-plain objects) throws instead of being
 * silently dropped, so a signed digest can never depend on how a value happened to be built.
 */
export function canonicalJson(value: unknown): string {
  return enc(value, '$');
}

function enc(v: unknown, path: string): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'string':
      return JSON.stringify(v);
    case 'number':
      if (!Number.isFinite(v)) throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      return JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) return '[' + v.map((x, i) => enc(x, `${path}[${i}]`)).join(',') + ']';
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new TypeError(`canonicalJson: non-plain object at ${path}`);
      const rec = v as Record<string, unknown>;
      const keys = Object.keys(rec).sort();
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + enc(rec[k], `${path}.${k}`)).join(',') + '}';
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof v} at ${path}`);
  }
}
