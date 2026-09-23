/**
 * Minimal JSON Schema (2020-12 subset) validator: enough for event payload contracts, zero dependencies.
 *
 * Supported: type (incl. arrays and "integer"), enum, const, properties, required, additionalProperties
 * (boolean or schema), items, minItems, maxItems, minLength, maxLength, pattern, minimum, maximum,
 * exclusiveMinimum, exclusiveMaximum, format (date-time, uri, uuid; others ignored), oneOf, anyOf, allOf,
 * and local `$ref` to `#/$defs/...`. Unknown keywords are ignored (annotations: description, examples, ...).
 * Anything richer should move to ajv; contracts must stay within this subset (see README).
 */
export type JsonSchema = {
  $id?: string;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  type?: JsonType | JsonType[];
  enum?: readonly unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  format?: string;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  description?: string;
  title?: string;
  examples?: unknown[];
};
export type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

export interface ValidationIssue {
  /** JSON Pointer into the instance. */
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
}

const FORMATS: Record<string, (s: string) => boolean> = {
  'date-time': (s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i.test(s) && !Number.isNaN(Date.parse(s)),
  uri: (s) => /^[a-z][a-z0-9+.-]*:\S*$/i.test(s),
  uuid: (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
};

function typeOf(v: unknown): JsonType {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v as JsonType;
}

function typeMatches(actual: JsonType, expected: JsonType): boolean {
  return actual === expected || (expected === 'number' && actual === 'integer');
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual((a as never)[k], (b as never)[k]));
}

const esc = (k: string) => k.replace(/~/g, '~0').replace(/\//g, '~1');

export function validate(schema: JsonSchema, value: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  const root = schema;
  const regexCache = new Map<string, RegExp>();

  const resolve = (ref: string): JsonSchema => {
    const m = /^#\/\$defs\/(.+)$/.exec(ref);
    const target = m ? root.$defs?.[m[1]!] : undefined;
    if (!target) throw new Error(`unsupported or dangling $ref ${ref}`);
    return target;
  };

  const check = (s: JsonSchema, v: unknown, path: string, out: ValidationIssue[]): void => {
    const add = (message: string) => out.push({ path: path || '/', message });
    if (s.$ref) check(resolve(s.$ref), v, path, out);
    const t = typeOf(v);
    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      if (!types.some((x) => typeMatches(t, x))) {
        add(`expected ${types.join('|')}, got ${t}`);
        return;
      }
    }
    if (s.const !== undefined && !deepEqual(s.const, v)) add(`must equal ${JSON.stringify(s.const)}`);
    if (s.enum && !s.enum.some((e) => deepEqual(e, v))) add(`must be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`);

    if (t === 'string') {
      const str = v as string;
      const len = [...str].length;
      if (s.minLength !== undefined && len < s.minLength) add(`shorter than ${s.minLength}`);
      if (s.maxLength !== undefined && len > s.maxLength) add(`longer than ${s.maxLength}`);
      if (s.pattern !== undefined) {
        let re = regexCache.get(s.pattern);
        if (!re) regexCache.set(s.pattern, (re = new RegExp(s.pattern, 'u')));
        if (!re.test(str)) add(`does not match ${s.pattern}`);
      }
      if (s.format && FORMATS[s.format] && !FORMATS[s.format]!(str)) add(`not a valid ${s.format}`);
    }
    if (t === 'number' || t === 'integer') {
      const n = v as number;
      if (s.minimum !== undefined && n < s.minimum) add(`below minimum ${s.minimum}`);
      if (s.maximum !== undefined && n > s.maximum) add(`above maximum ${s.maximum}`);
      if (s.exclusiveMinimum !== undefined && n <= s.exclusiveMinimum) add(`must be > ${s.exclusiveMinimum}`);
      if (s.exclusiveMaximum !== undefined && n >= s.exclusiveMaximum) add(`must be < ${s.exclusiveMaximum}`);
    }
    if (t === 'array') {
      const arr = v as unknown[];
      if (s.minItems !== undefined && arr.length < s.minItems) add(`fewer than ${s.minItems} items`);
      if (s.maxItems !== undefined && arr.length > s.maxItems) add(`more than ${s.maxItems} items`);
      if (s.items) arr.forEach((item, i) => check(s.items!, item, `${path}/${i}`, out));
    }
    if (t === 'object') {
      const obj = v as Record<string, unknown>;
      for (const r of s.required ?? []) if (!(r in obj)) add(`missing required property "${r}"`);
      for (const [k, val] of Object.entries(obj)) {
        const ps = s.properties?.[k];
        if (ps) check(ps, val, `${path}/${esc(k)}`, out);
        else if (s.additionalProperties === false) out.push({ path: `${path}/${esc(k)}`, message: 'additional property not allowed' });
        else if (typeof s.additionalProperties === 'object') check(s.additionalProperties, val, `${path}/${esc(k)}`, out);
      }
    }
    if (s.allOf) for (const sub of s.allOf) check(sub, v, path, out);
    if (s.anyOf && !s.anyOf.some((sub) => probe(sub, v, path))) add('does not match any schema in anyOf');
    if (s.oneOf) {
      const n = s.oneOf.filter((sub) => probe(sub, v, path)).length;
      if (n !== 1) add(`must match exactly one schema in oneOf (matched ${n})`);
    }
  };
  const probe = (s: JsonSchema, v: unknown, path: string): boolean => {
    const tmp: ValidationIssue[] = [];
    check(s, v, path, tmp);
    return tmp.length === 0;
  };

  check(schema, value, '', errors);
  return { valid: errors.length === 0, errors };
}
