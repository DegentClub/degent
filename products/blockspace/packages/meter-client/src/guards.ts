/**
 * A tiny runtime shape checker (no dependencies). Each guard both validates an unknown JSON value
 * and carries the static type it proves, so the schemas in `schemas.ts` are checked against the
 * hand-written interfaces in `types.ts` at compile time (see the `Same<>` assertions there).
 *
 * Policy: unknown extra fields are accepted (the API may add fields; that is not drift). A missing
 * required field, a wrong type, or an enum value we do not know IS drift and fails loudly.
 */

export interface Issue {
  /** JSON path of the offending value, e.g. `$.rows[3].a_bytes`. */
  path: string;
  expected: string;
  /** Short description of what was found (`undefined`, `string "12"`, …). */
  got: string;
}

export interface Guard<T> {
  readonly expected: string;
  readonly optional: boolean;
  check(value: unknown, path: string, issues: Issue[]): void;
  /** Phantom: never set at runtime. */
  readonly _type?: T;
}

export type Infer<G> = G extends Guard<infer T> ? T : never;

const MAX_ISSUES = 25;

function describe(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array(${v.length})`;
  if (typeof v === 'string') return `string ${JSON.stringify(v.length > 40 ? v.slice(0, 40) + '…' : v)}`;
  if (typeof v === 'number') return `number ${v}`;
  return typeof v;
}

function push(issues: Issue[], path: string, expected: string, v: unknown): void {
  if (issues.length < MAX_ISSUES) issues.push({ path, expected, got: describe(v) });
}

function leaf<T>(expected: string, ok: (v: unknown) => boolean): Guard<T> {
  return {
    expected,
    optional: false,
    check(v, path, issues) {
      if (!ok(v)) push(issues, path, expected, v);
    },
  };
}

/** A finite JSON number. */
export const num: Guard<number> = leaf('number', (v) => typeof v === 'number' && Number.isFinite(v));
export const str: Guard<string> = leaf('string', (v) => typeof v === 'string');
export const bool: Guard<boolean> = leaf('boolean', (v) => typeof v === 'boolean');

export function literal<const L extends readonly (string | number)[]>(...values: L): Guard<L[number]> {
  return leaf(`one of ${values.map((x) => JSON.stringify(x)).join('|')}`, (v) => (values as readonly unknown[]).includes(v));
}

export function nullable<T>(g: Guard<T>): Guard<T | null> {
  return {
    expected: `${g.expected}|null`,
    optional: false,
    check(v, path, issues) {
      if (v !== null) g.check(v, path, issues);
    },
  };
}

/** Marks an object property optional: absent (or `undefined`) is fine; present must match `g`. */
export function opt<T>(g: Guard<T>): Guard<T> & { readonly optional: true } {
  return {
    expected: `${g.expected} (optional)`,
    optional: true,
    check(v, path, issues) {
      if (v !== undefined) g.check(v, path, issues);
    },
  };
}

export function arr<T>(g: Guard<T>): Guard<T[]> {
  const expected = `array<${g.expected}>`;
  return {
    expected,
    optional: false,
    check(v, path, issues) {
      if (!Array.isArray(v)) return push(issues, path, expected, v);
      for (let i = 0; i < v.length && issues.length < MAX_ISSUES; i++) g.check(v[i], `${path}[${i}]`, issues);
    },
  };
}

type Shape = Record<string, Guard<unknown>>;
type OptKeys<S extends Shape> = { [K in keyof S]: S[K] extends { readonly optional: true } ? K : never }[keyof S];
type Simplify<T> = { [K in keyof T]: T[K] } & {};
export type ObjOf<S extends Shape> = Simplify<
  { [K in Exclude<keyof S, OptKeys<S>>]: Infer<S[K]> } & { [K in OptKeys<S>]?: Infer<S[K]> }
>;

export function obj<S extends Shape>(shape: S): Guard<ObjOf<S>> {
  return {
    expected: 'object',
    optional: false,
    check(v, path, issues) {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return push(issues, path, 'object', v);
      const rec = v as Record<string, unknown>;
      for (const [k, g] of Object.entries(shape)) {
        if (issues.length >= MAX_ISSUES) return;
        g.check(rec[k], `${path}.${k}`, issues);
      }
    },
  };
}

/** `Record<string, T>` where every present value must match. */
export function record<K extends string, T>(keys: readonly K[], g: Guard<T>): Guard<Record<K, T>> {
  return {
    expected: `record<${keys.join('|')}, ${g.expected}>`,
    optional: false,
    check(v, path, issues) {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return push(issues, path, 'object', v);
      const rec = v as Record<string, unknown>;
      for (const k of keys) g.check(rec[k], `${path}.${k}`, issues);
    },
  };
}

/** Runs a guard and returns the issues (empty = valid). */
export function validate<T>(g: Guard<T>, value: unknown): Issue[] {
  const issues: Issue[] = [];
  g.check(value, '$', issues);
  return issues;
}

/** Compile-time: A and B are mutually assignable. Used to keep schemas and interfaces in lockstep. */
export type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
