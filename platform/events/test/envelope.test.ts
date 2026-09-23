import { describe, expect, it } from 'vitest';
import { assertEnvelope, createEvent, EnvelopeError, isEventEnvelope } from '../src/index.js';

const fixed = { now: () => new Date('2026-09-23T12:00:00.000Z'), newId: () => 'evt-1' };

describe('createEvent', () => {
  it('builds a CloudEvents 1.0 envelope with defaults', () => {
    const e = createEvent({ source: 'urn:bsh:test', type: 'collection.minted', data: { a: 1 } }, fixed);
    expect(e).toEqual({
      specversion: '1.0',
      id: 'evt-1',
      source: 'urn:bsh:test',
      type: 'collection.minted',
      time: '2026-09-23T12:00:00.000Z',
      datacontenttype: 'application/json',
      data: { a: 1 },
    });
    expect(Object.isFrozen(e)).toBe(true);
    expect('subject' in e).toBe(false);
  });

  it('keeps optional attributes and accepts Date time', () => {
    const tp = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const e = createEvent({
      source: 's',
      type: 'x.y',
      data: null,
      subject: 'order-1',
      id: 'fixed',
      time: new Date(0),
      dataschema: 'https://example/schema',
      traceparent: tp,
    });
    expect(e).toMatchObject({ id: 'fixed', subject: 'order-1', time: '1970-01-01T00:00:00.000Z', traceparent: tp, dataschema: 'https://example/schema' });
  });

  it('generates UUID ids by default', () => {
    const e = createEvent({ source: 's', type: 'x', data: 1 });
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(e.time)).not.toBeNaN();
  });

  it.each([
    [{ source: '', type: 'x', data: 1 }, /source/],
    [{ source: 's', type: 'Bad Type', data: 1 }, /type/],
    [{ source: 's', type: 'x', data: 1, time: 'yesterday' }, /time/],
    [{ source: 's', type: 'x', data: 1, traceparent: 'nope' }, /traceparent/],
  ])('rejects malformed attributes %#', (input, msg) => {
    expect(() => createEvent(input as never)).toThrow(msg);
    expect(() => createEvent(input as never)).toThrow(EnvelopeError);
  });

  it('assertEnvelope checks wire input', () => {
    const e = createEvent({ source: 's', type: 'x', data: {} });
    expect(isEventEnvelope(JSON.parse(JSON.stringify(e)))).toBe(true);
    expect(isEventEnvelope({ ...e, specversion: '0.3' })).toBe(false);
    expect(isEventEnvelope({ ...e, datacontenttype: 'text/plain' })).toBe(false);
    const { data: _d, ...noData } = e;
    expect(() => assertEnvelope(noData)).toThrow(/data/);
    expect(isEventEnvelope('x')).toBe(false);
  });
});
