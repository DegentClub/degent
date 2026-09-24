/** Events: the in-memory bus, the platform bridge (CloudEvents envelopes) and the topic's schema vs the AsyncAPI contract. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { InMemoryBus, TopicRegistry, type EventEnvelope } from '@bsh/events';
import { ARTWORK_STATUS_EVENT_SCHEMA, PlatformEventBusAdapter, STUDIO_SOURCE, degentArtwork } from '../src/adapters/platform-event-bus.js';
import { MemoryEventBus } from '../src/adapters/system.js';
import { eventFor } from '../src/domain/events.js';
import { transition, type ArtworkRecord } from '../src/domain/artwork.js';
import type { ArtworkStatusEvent } from '../src/domain/events.js';

const root = new URL('../../../../../', import.meta.url).pathname;
const asyncapi = parse(readFileSync(join(root, 'contracts/asyncapi/degent-studio.yaml'), 'utf8'));

const sample = (over: Partial<ArtworkStatusEvent> = {}): ArtworkStatusEvent => ({
  type: 'degent.artwork.approved',
  eventId: 'art_1:3',
  artworkId: 'art_1',
  artist: 'bcrt1alice',
  network: 'regtest',
  status: 'approved',
  previousStatus: 'reviewing',
  at: '2026-09-24T12:00:00.000Z',
  contentSha256: 'a'.repeat(64),
  detail: 'ok',
  ...over,
});

describe('MemoryEventBus', () => {
  it('keeps history, fans out, and a throwing subscriber never breaks publishing', async () => {
    const bus = new MemoryEventBus(3);
    const seen: string[] = [];
    bus.subscribe(() => {
      throw new Error('boom');
    });
    const off = bus.subscribe((e) => seen.push(e.eventId));
    for (let i = 1; i <= 4; i++) await bus.publish(sample({ eventId: `art_1:${i}` }));
    expect(bus.events.map((e) => e.eventId)).toEqual(['art_1:2', 'art_1:3', 'art_1:4']);
    expect(seen).toHaveLength(4);
    off();
    await bus.publish(sample({ eventId: 'art_1:5' }));
    expect(seen).toHaveLength(4);
  });
});

describe('degent.artwork.{status} topic', () => {
  it('schema equals the AsyncAPI contract schema (contract first)', () => {
    const contract = asyncapi.components.schemas.ArtworkStatusEvent;
    // The contract nests ArtworkStatus via $ref; the topic inlines the enum. Compare after resolving.
    const resolve = (n: unknown): unknown => {
      if (Array.isArray(n)) return n.map(resolve);
      if (n && typeof n === 'object') {
        const o = n as Record<string, unknown>;
        if (typeof o.$ref === 'string') return resolve(asyncapi.components.schemas[o.$ref.split('/').pop()!]);
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(o)) if (k !== 'description') out[k] = resolve(v);
        return out;
      }
      return n;
    };
    expect(resolve(contract)).toEqual(ARTWORK_STATUS_EVENT_SCHEMA);
    expect(degentArtwork.name).toBe(asyncapi.channels.artworkStatus.address);
    expect(degentArtwork.params.status!.enum).toEqual(asyncapi.channels.artworkStatus.parameters.status.enum);
    expect(degentArtwork.producer).toBe('degent-studio');
  });

  it('builds concrete types per status and rejects unknown statuses', () => {
    expect(degentArtwork.typeFor({ status: 'delisted' })).toBe('degent.artwork.delisted');
    expect(() => degentArtwork.typeFor({ status: 'minted' })).toThrow();
    expect(degentArtwork.match('degent.artwork.rejected')).toEqual({ status: 'rejected' });
    expect(degentArtwork.match('degent.mint.order.paid')).toBeNull();
  });

  it('validates payloads', () => {
    expect(degentArtwork.validate(sample()).valid).toBe(true);
    expect(degentArtwork.validate({ ...sample(), previousStatus: undefined }).valid).toBe(false);
    expect(degentArtwork.validate({ ...sample(), extra: 1 }).valid).toBe(false);
    expect(degentArtwork.validate({ ...sample(), contentSha256: 'xyz' }).valid).toBe(false);
    expect(degentArtwork.validate({ ...sample(), type: 'degent.mint.order.paid' }).valid).toBe(false);
  });
});

describe('PlatformEventBusAdapter', () => {
  it('publishes CloudEvents envelopes with id = eventId, subject = artworkId, type = routing key', async () => {
    const bus = new InMemoryBus({ registry: new TopicRegistry([degentArtwork]) });
    const got: EventEnvelope[] = [];
    await bus.subscribe('degent.artwork.*', (e) => {
      got.push(e);
    });
    const adapter = new PlatformEventBusAdapter(bus);
    await adapter.publish(sample());
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      specversion: '1.0',
      id: 'art_1:3',
      source: STUDIO_SOURCE,
      type: 'degent.artwork.approved',
      subject: 'art_1',
      time: '2026-09-24T12:00:00.000Z',
      datacontenttype: 'application/json',
      dataschema: degentArtwork.dataschema,
      data: sample(),
    });
  });

  it('refuses a payload that does not match the topic schema (drift is a thrown error)', async () => {
    const adapter = new PlatformEventBusAdapter(new InMemoryBus());
    await expect(adapter.publish({ ...sample(), status: 'minted' } as unknown as ArtworkStatusEvent)).rejects.toThrow(/invalid payload/);
  });

  it('subscribers can filter one status', async () => {
    const bus = new InMemoryBus();
    const approved: string[] = [];
    await bus.subscribe('degent.artwork.approved', (e) => {
      approved.push(e.id);
    });
    const adapter = new PlatformEventBusAdapter(bus);
    await adapter.publish(sample({ status: 'reviewing', type: 'degent.artwork.reviewing', eventId: 'art_1:2', previousStatus: 'submitted' }));
    await adapter.publish(sample());
    expect(approved).toEqual(['art_1:3']);
  });
});

describe('eventFor / transition', () => {
  const base: ArtworkRecord = {
    id: 'art_9', artist: 'bcrt1alice', network: 'regtest', title: 't', description: null, contentType: 'image/jpeg', contentLength: 1, contentSha256: null,
    status: 'submitted', needsHuman: false, review: null, featured: false, featuredAt: null, timeline: [{ status: 'submitted', at: '2026-09-24T12:00:00.000Z' }],
    createdAt: '2026-09-24T12:00:00.000Z', updatedAt: '2026-09-24T12:00:00.000Z', version: 0, uploadTokenHash: 'c'.repeat(64),
  };

  it('derives the event from the last timeline entry with a 1-based index', () => {
    const e = eventFor(base, null);
    expect(e).toEqual({ type: 'degent.artwork.submitted', eventId: 'art_9:1', artworkId: 'art_9', artist: 'bcrt1alice', network: 'regtest', status: 'submitted', previousStatus: null, at: '2026-09-24T12:00:00.000Z' });
    const next = transition({ ...base, contentSha256: 'b'.repeat(64) }, 'reviewing', '2026-09-24T12:01:00.000Z', 'bytes received');
    expect(eventFor(next, 'submitted')).toMatchObject({ type: 'degent.artwork.reviewing', eventId: 'art_9:2', previousStatus: 'submitted', contentSha256: 'b'.repeat(64), detail: 'bytes received' });
    expect(degentArtwork.validate(eventFor(next, 'submitted')).valid).toBe(true);
  });

  it('the transition table forbids everything ADR-0007 does not list', () => {
    const at = '2026-09-24T12:01:00.000Z';
    expect(() => transition(base, 'approved', at)).toThrow(/cannot become approved/);
    expect(() => transition(base, 'delisted', at)).toThrow();
    const reviewing = transition(base, 'reviewing', at);
    expect(() => transition(reviewing, 'delisted', at)).toThrow();
    const approved = transition(reviewing, 'approved', at);
    expect(transition(approved, 'delisted', at).status).toBe('delisted');
    expect(transition(approved, 'rejected', at).status).toBe('rejected');
    expect(() => transition(transition(approved, 'delisted', at), 'approved', at)).toThrow();
    expect(transition(transition(approved, 'rejected', at), 'approved', at).status).toBe('approved');
    expect(() => transition(approved, 'reviewing', at)).toThrow();
  });
});
