/**
 * CloudEvents 1.0 envelope (https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md),
 * JSON event format. Every event on the platform bus is one of these; `type` is the concrete topic name
 * (e.g. `block.indexed.mainnet`) and `data` is validated against the topic's JSON Schema.
 */
export interface EventEnvelope<T = unknown> {
  specversion: '1.0';
  /** Unique per source. Consumers de-duplicate on (source, id); outbox relays keep it stable across retries. */
  id: string;
  /** URI-reference of the producer, e.g. `urn:bsh:degent-mint` or `/degent/mint`. */
  source: string;
  /** Concrete topic name; also the AMQP routing key. */
  type: string;
  /** Aggregate the event is about (order id, block hash, ...). */
  subject?: string;
  /** RFC 3339 timestamp of the occurrence. */
  time: string;
  datacontenttype: 'application/json';
  /** URI of the payload schema (the topic's `$id` / AsyncAPI pointer). */
  dataschema?: string;
  data: T;
  /** W3C trace-context `traceparent` (CloudEvents distributed-tracing extension). */
  traceparent?: string;
}

export interface CreateEventInput<T> {
  source: string;
  type: string;
  data: T;
  subject?: string;
  id?: string;
  time?: string | Date;
  dataschema?: string;
  traceparent?: string;
}

export interface CreateEventOptions {
  /** Injectable clock (tests). */
  now?: () => Date;
  /** Injectable id generator (tests). Defaults to `crypto.randomUUID()`. */
  newId?: () => string;
}

const TYPE_RE = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/;
const TRACEPARENT_RE = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeError';
  }
}

/** Build a frozen, spec-conformant envelope. Throws `EnvelopeError` on malformed attributes. */
export function createEvent<T>(input: CreateEventInput<T>, opts: CreateEventOptions = {}): EventEnvelope<T> {
  const time = input.time instanceof Date ? input.time.toISOString() : (input.time ?? (opts.now?.() ?? new Date()).toISOString());
  const env: EventEnvelope<T> = {
    specversion: '1.0',
    id: input.id ?? (opts.newId ?? (() => globalThis.crypto.randomUUID()))(),
    source: input.source,
    type: input.type,
    time,
    datacontenttype: 'application/json',
    data: input.data,
  };
  if (input.subject !== undefined) env.subject = input.subject;
  if (input.dataschema !== undefined) env.dataschema = input.dataschema;
  if (input.traceparent !== undefined) env.traceparent = input.traceparent;
  assertEnvelope(env);
  return Object.freeze(env);
}

/** Structural check of an envelope received from the wire (does not validate `data`). */
export function assertEnvelope(v: unknown): asserts v is EventEnvelope {
  if (typeof v !== 'object' || v === null) throw new EnvelopeError('envelope must be an object');
  const e = v as Record<string, unknown>;
  if (e.specversion !== '1.0') throw new EnvelopeError(`unsupported specversion ${String(e.specversion)}`);
  for (const k of ['id', 'source', 'type', 'time'] as const) {
    if (typeof e[k] !== 'string' || (e[k] as string).length === 0) throw new EnvelopeError(`${k} must be a non-empty string`);
  }
  if (!TYPE_RE.test(e.type as string)) throw new EnvelopeError(`type "${String(e.type)}" is not a dot-separated topic name`);
  if (Number.isNaN(Date.parse(e.time as string))) throw new EnvelopeError(`time "${String(e.time)}" is not RFC 3339`);
  if (e.datacontenttype !== 'application/json') throw new EnvelopeError('datacontenttype must be application/json');
  if (!('data' in e)) throw new EnvelopeError('data is required');
  if (e.subject !== undefined && typeof e.subject !== 'string') throw new EnvelopeError('subject must be a string');
  if (e.dataschema !== undefined && typeof e.dataschema !== 'string') throw new EnvelopeError('dataschema must be a string');
  if (e.traceparent !== undefined && !(typeof e.traceparent === 'string' && TRACEPARENT_RE.test(e.traceparent)))
    throw new EnvelopeError('traceparent must be a W3C trace-context value');
}

export function isEventEnvelope(v: unknown): v is EventEnvelope {
  try {
    assertEnvelope(v);
    return true;
  } catch {
    return false;
  }
}
