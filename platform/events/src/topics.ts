import { createEvent, type CreateEventOptions, type EventEnvelope } from './envelope.js';
import { templateToPattern } from './match.js';
import { validate, type JsonSchema, type ValidationIssue, type ValidationResult } from './schema.js';

/**
 * Topics are the unit of event versioning.
 *
 * Name grammar: dot-separated lowercase words; a word may be a `{param}` placeholder, bound at publish time
 * (`block.indexed.{network}` → `block.indexed.mainnet`). Each placeholder is declared in `params`.
 *
 * Versioning (contracts/README.md): `version` is SemVer. Additive changes bump minor, doc fixes bump patch.
 * A breaking change (see `detectBreakingChanges`) requires a NEW MAJOR, published side by side under a new
 * name ending in `.v<major>` (`collection.minted` → `collection.minted.v2`). Major 1 carries no suffix.
 */
export interface TopicParam {
  description: string;
  /** Allowed values; omit for any single word. */
  enum?: readonly string[];
}

export interface TopicDefinition<T = unknown> {
  name: string;
  /** SemVer of the payload schema. Major must agree with the `.vN` name suffix. */
  version: string;
  /** JSON Schema (validator subset, see schema.ts) for `data`. */
  schema: JsonSchema;
  /** Component name (catalog key) that publishes the topic. */
  producer: string;
  description: string;
  params?: Readonly<Record<string, TopicParam>>;
  /** Set as the envelope's `dataschema` (e.g. the AsyncAPI pointer). */
  dataschema?: string;
  /** Phantom: carries the payload type for inference. Never set. */
  readonly __data?: T;
}

export interface Topic<T = unknown> extends TopicDefinition<T> {
  readonly params: Readonly<Record<string, TopicParam>>;
  /** Parameter names in name order. */
  readonly paramNames: readonly string[];
  /** AMQP binding key matching every concrete name of this topic (`{x}` → `*`). */
  readonly pattern: string;
  readonly major: number;
  /** Name without the `.vN` suffix: the topic family. */
  readonly family: string;
  /** Concrete name for the given params; throws on missing or disallowed values. */
  typeFor(params?: Record<string, string>): string;
  /** Params extracted from a concrete name, or null if the name is not an instance of this topic. */
  match(type: string): Record<string, string> | null;
  validate(data: unknown): ValidationResult;
  /** Validated envelope for this topic. */
  create(
    input: { source: string; data: T; params?: Record<string, string>; subject?: string; id?: string; time?: string | Date; traceparent?: string },
    opts?: CreateEventOptions,
  ): EventEnvelope<T>;
}

export type DataOf<X> = X extends Topic<infer T> ? T : never;

export class TopicError extends Error {
  constructor(
    message: string,
    readonly issues: ValidationIssue[] = [],
  ) {
    super(issues.length ? `${message}: ${issues.map((i) => `${i.path} ${i.message}`).join('; ')}` : message);
    this.name = 'TopicError';
  }
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const NAME_WORD = /^([a-z0-9_-]+|\{[a-zA-Z][a-zA-Z0-9_]*\})$/;
const VERSION_SUFFIX = /\.v([1-9]\d*)$/;

export function parseSemver(v: string): [number, number, number] {
  const m = SEMVER.exec(v);
  if (!m) throw new TopicError(`version "${v}" is not SemVer MAJOR.MINOR.PATCH`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** `x.y.v2` → `x.y`; `x.y` → `x.y`. */
export function topicFamily(name: string): string {
  return name.replace(VERSION_SUFFIX, '');
}

export function defineTopic<T = unknown>(def: TopicDefinition<T>): Topic<T> {
  const words = def.name.split('.');
  if (!def.name || !words.every((w) => NAME_WORD.test(w))) throw new TopicError(`invalid topic name "${def.name}"`);
  const [major] = parseSemver(def.version);
  const suffix = VERSION_SUFFIX.exec(def.name);
  if (major <= 1 && suffix) throw new TopicError(`topic "${def.name}" v${def.version}: major ${major} must not carry a .vN suffix`);
  if (major >= 2 && (!suffix || Number(suffix[1]) !== major))
    throw new TopicError(`topic "${def.name}" v${def.version}: breaking major ${major} must be named "${topicFamily(def.name)}.v${major}"`);
  if (!def.producer) throw new TopicError(`topic "${def.name}" needs a producer`);
  if (!def.description) throw new TopicError(`topic "${def.name}" needs a description`);

  const params = def.params ?? {};
  const paramNames = words.filter((w) => w.startsWith('{')).map((w) => w.slice(1, -1));
  if (new Set(paramNames).size !== paramNames.length) throw new TopicError(`topic "${def.name}" repeats a parameter`);
  for (const p of paramNames) if (!params[p]) throw new TopicError(`topic "${def.name}" does not declare parameter "${p}"`);
  for (const p of Object.keys(params)) if (!paramNames.includes(p)) throw new TopicError(`topic "${def.name}" declares unused parameter "${p}"`);
  for (const [p, spec] of Object.entries(params))
    for (const v of spec.enum ?? []) if (!/^[a-z0-9_-]+$/.test(v)) throw new TopicError(`parameter ${p} value "${v}" is not a routing-key word`);

  const checkParam = (p: string, v: string | undefined): string => {
    if (v === undefined || !/^[a-z0-9_-]+$/.test(v)) throw new TopicError(`topic "${def.name}": parameter ${p}="${v}" is missing or not a routing-key word`);
    const allowed = params[p]!.enum;
    if (allowed && !allowed.includes(v)) throw new TopicError(`topic "${def.name}": parameter ${p}="${v}" not in [${allowed.join(', ')}]`);
    return v;
  };

  const topic: Topic<T> = {
    ...def,
    params,
    paramNames,
    pattern: templateToPattern(def.name),
    major: Math.max(1, major),
    family: topicFamily(def.name),
    typeFor(values = {}) {
      return words.map((w) => (w.startsWith('{') ? checkParam(w.slice(1, -1), values[w.slice(1, -1)]) : w)).join('.');
    },
    match(type) {
      const parts = type.split('.');
      if (parts.length !== words.length) return null;
      const out: Record<string, string> = {};
      for (let i = 0; i < words.length; i++) {
        const w = words[i]!;
        const part = parts[i]!;
        if (w.startsWith('{')) {
          const p = w.slice(1, -1);
          const allowed = params[p]!.enum;
          if (!/^[a-z0-9_-]+$/.test(part) || (allowed && !allowed.includes(part))) return null;
          out[p] = part;
        } else if (w !== part) return null;
      }
      return out;
    },
    validate(data) {
      return validate(def.schema, data);
    },
    create(input, opts) {
      const r = validate(def.schema, input.data);
      if (!r.valid) throw new TopicError(`invalid payload for ${def.name}`, r.errors);
      const { params: values, ...rest } = input;
      return createEvent<T>(
        { ...rest, type: topic.typeFor(values), ...(def.dataschema ? { dataschema: def.dataschema } : {}) },
        opts,
      );
    },
  };
  return Object.freeze(topic);
}

/** Two templates overlap when some concrete name is an instance of both. */
function overlaps(a: string, b: string): boolean {
  const x = a.split('.');
  const y = b.split('.');
  return x.length === y.length && x.every((w, i) => w.startsWith('{') || y[i]!.startsWith('{') || w === y[i]);
}

export interface Resolved {
  topic: Topic;
  params: Record<string, string>;
}

export class TopicRegistry {
  private readonly topics = new Map<string, Topic>();

  constructor(topics: Iterable<Topic> = []) {
    for (const t of topics) this.register(t);
  }

  register<T>(topic: Topic<T>): Topic<T> {
    if (this.topics.has(topic.name)) throw new TopicError(`topic "${topic.name}" already registered`);
    for (const other of this.topics.values())
      if (overlaps(other.name, topic.name)) throw new TopicError(`topic "${topic.name}" overlaps "${other.name}"`);
    this.topics.set(topic.name, topic as Topic);
    return topic;
  }

  get(name: string): Topic | undefined {
    return this.topics.get(name);
  }

  list(): Topic[] {
    return [...this.topics.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Topic (template) that a concrete event type belongs to. */
  resolve(type: string): Resolved | undefined {
    for (const topic of this.topics.values()) {
      const params = topic.match(type);
      if (params) return { topic, params };
    }
    return undefined;
  }

  /** Validate an envelope: known type, params in range, `data` matches the topic schema. */
  validate(env: EventEnvelope): ValidationResult {
    const r = this.resolve(env.type);
    if (!r) return { valid: false, errors: [{ path: '/type', message: `unknown topic "${env.type}"` }] };
    const v = r.topic.validate(env.data);
    return { valid: v.valid, errors: v.errors.map((e) => ({ path: `/data${e.path === '/' ? '' : e.path}`, message: e.message })) };
  }

  assertValid(env: EventEnvelope): void {
    const r = this.validate(env);
    if (!r.valid) throw new TopicError(`invalid event ${env.type} (${env.id})`, r.errors);
  }
}

// ------------------------------------------------------------------------------------------ evolution

const typesOf = (s: JsonSchema): string[] => (s.type === undefined ? [] : Array.isArray(s.type) ? [...s.type] : [s.type]).sort();

/**
 * Consumer-facing breaking changes between two payload schemas (events flow producer → consumer):
 * removed property, required → optional, changed type set, changed const, removed enum value.
 * Adding optional or required properties and adding enum values are compatible (consumers must ignore unknowns).
 */
export function detectBreakingChanges(prev: JsonSchema, next: JsonSchema, path = ''): string[] {
  const out: string[] = [];
  const at = path || '/';
  const [pt, nt] = [typesOf(prev), typesOf(next)];
  if (pt.join() !== nt.join()) out.push(`${at}: type ${pt.join('|') || 'any'} → ${nt.join('|') || 'any'}`);
  if (prev.const !== undefined && JSON.stringify(prev.const) !== JSON.stringify(next.const)) out.push(`${at}: const changed`);
  if (prev.enum) {
    const removed = prev.enum.filter((v) => !(next.enum ?? []).some((w) => JSON.stringify(w) === JSON.stringify(v)));
    if (next.enum === undefined) {
      /* widening to any value of the type: compatible for enum-less consumers, flag conservatively */
      out.push(`${at}: enum removed`);
    } else if (removed.length) out.push(`${at}: enum values removed ${removed.map((v) => JSON.stringify(v)).join(', ')}`);
  }
  for (const [k, ps] of Object.entries(prev.properties ?? {})) {
    const ns = next.properties?.[k];
    if (!ns) {
      out.push(`${path}/${k}: property removed`);
      continue;
    }
    if (prev.required?.includes(k) && !next.required?.includes(k)) out.push(`${path}/${k}: no longer required`);
    out.push(...detectBreakingChanges(ps, ns, `${path}/${k}`));
  }
  if (prev.items && next.items) out.push(...detectBreakingChanges(prev.items, next.items, `${path}/items`));
  return out;
}

/**
 * Enforce the versioning rule for a new revision of a topic. Throws `TopicError` when:
 * the version goes backwards; a breaking change keeps the same major; a new major is not named `<family>.v<major>`;
 * or a same-major revision renames the topic.
 */
export function assertCompatibleEvolution(prev: Topic, next: Topic): void {
  const [pM, pm, pp] = parseSemver(prev.version);
  const [nM, nm, np] = parseSemver(next.version);
  if (nM * 1e12 + nm * 1e6 + np <= pM * 1e12 + pm * 1e6 + pp)
    throw new TopicError(`${next.name}: version ${next.version} must be greater than ${prev.version}`);
  if (topicFamily(next.name) !== prev.family) throw new TopicError(`${next.name} is not in family ${prev.family}`);
  if (nM === pM) {
    if (next.name !== prev.name) throw new TopicError(`${next.name}: same major must keep the name ${prev.name}`);
    const breaking = detectBreakingChanges(prev.schema, next.schema);
    if (breaking.length)
      throw new TopicError(
        `${prev.name} ${prev.version} → ${next.version} is breaking; publish it as ${prev.family}.v${Math.max(pM, 1) + 1} (major ${Math.max(pM, 1) + 1})`,
        breaking.map((message) => ({ path: '/schema', message })),
      );
  }
}
