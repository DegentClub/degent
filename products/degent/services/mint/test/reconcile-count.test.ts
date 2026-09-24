/**
 * reconcile-count: one certified count, every discrepancy class explained. Fixtures + an injected fetch (and a
 * loopback ord stub for the CLI); nothing here reaches the internet.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { fetchOrdSizes, parseExport, reconcile, toMarkdown, type FetchLike } from '../scripts/lib/reconcile.mjs';

const svc = new URL('..', import.meta.url).pathname;
const fx = (f: string) => readFileSync(join(svc, 'test/fixtures/reconcile', f), 'utf8');
const id = (c: string) => `${c.repeat(64)}i0`;
const roster = JSON.parse(fx('roster.json'));
const realRoster = JSON.parse(readFileSync(join(svc, 'data/roster.json'), 'utf8'));

/** ord stub: content_length per id, 404 for unknown ids; records every URL asked. */
function fakeOrd(lengths: Record<string, number>) {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const m = /\/r\/inscription\/([0-9a-f]{64}i\d+)$/.exec(url);
    const len = m ? lengths[m[1]!] : undefined;
    return len === undefined
      ? { ok: false, status: 404, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => ({ id: m![1], content_length: len }) };
  };
  return { fetch, calls };
}
const ORD = { [id('1')]: 307_200, [id('2')]: 256_515, [id('3')]: 1_030_000 }; // #6 unknown to ord

describe('export parsing', () => {
  it('accepts Magic Eden-style JSON, arrays, and plain text', () => {
    expect(parseExport(fx('magic-eden-export.json'))).toHaveLength(6);
    expect(parseExport(fx('ids.txt'))).toEqual([id('1'), id('2'), id('3')]);
    expect(parseExport(JSON.stringify([id('1'), { inscription_id: id('2') }, { inscriptionId: id('3') }]))).toEqual([id('1'), id('2'), id('3')]);
    expect(parseExport(`${id('1')}, ${id('2')}`)).toEqual([id('1'), id('2')]);
    expect(() => parseExport('{"nope":1}')).toThrow(/array/);
  });
});

describe('fetchOrdSizes (injected fetch, cached)', () => {
  it('fetches each id once, records failures, and re-uses the cache', async () => {
    const ord = fakeOrd(ORD);
    const cache: Record<string, { content_length: number }> = {};
    const ids = [id('1'), id('2'), id('3'), id('2'), id('6')];
    const a = await fetchOrdSizes(ids, { baseUrl: 'http://ord.test/', fetch: ord.fetch, cache, concurrency: 2 });
    expect(a.sizes.size).toBe(3);
    expect(a.failures).toEqual([{ id: id('6'), error: 'HTTP 404' }]);
    expect(ord.calls).toHaveLength(4);
    expect(ord.calls[0]).toMatch(/^http:\/\/ord\.test\/r\/inscription\//);
    const b = await fetchOrdSizes(ids, { baseUrl: 'http://ord.test', fetch: ord.fetch, cache });
    expect(b).toMatchObject({ fetched: 0, cached: 3 });
    expect(ord.calls).toHaveLength(5); // only the failed id is asked again
  });
});

describe('reconcile (fixtures)', () => {
  it('explains duplicates, gaps, export differences, ord mismatches and failures', async () => {
    const ord = await fetchOrdSizes(
      roster.members.map((m: { inscriptionId: string }) => m.inscriptionId),
      { baseUrl: 'http://ord.test', fetch: fakeOrd(ORD).fetch },
    );
    const r = reconcile({
      roster,
      exportIds: parseExport(fx('magic-eden-export.json')),
      ord,
      ordUrl: 'http://ord.test',
      claims: { label: 'site', count: 3, megabytes: 1.8 },
    });
    expect(r.roster).toMatchObject({ rows: 5, uniqueIds: 4, duplicateIds: [{ id: id('2'), n: [2, 4] }], gaps: [5], highestNumber: 6 });
    expect(r.export).toMatchObject({
      rows: 6,
      unique: 5,
      duplicates: [{ id: id('3'), times: 2 }],
      malformed: ['not-an-id'],
      missingFromExport: [{ n: 2, id: id('2') }, { n: 4, id: id('2') }],
      extraInExport: [id('9')],
    });
    expect(r.bytes.ord).toMatchObject({ covered: 3, of: 4, failures: [{ id: id('6'), error: 'HTTP 404' }] });
    expect(r.bytes.ord!.mismatches).toEqual([{ n: 3, id: id('3'), rosterBytes: 1_024_256, ordContentLength: 1_030_000, delta: 5_744 }]);
    // ord incomplete -> the certified bytes are the labelled roster estimate
    expect(r.certified).toMatchObject({ count: 4, bytesSource: 'roster sizeKb×1024 (estimate)' });
    const classes = r.discrepancies.map((d) => d.class);
    expect(classes).toEqual(
      expect.arrayContaining(['duplicate-in-roster', 'roster-numbering', 'missing-from-export', 'extra-in-export', 'export-hygiene', 'size-mismatch-vs-ord', 'ord-unavailable', 'stale-count']),
    );
    for (const d of r.discrepancies) expect(d.explanation.length).toBeGreaterThan(40);
    const md = toMarkdown(r);
    expect(md).toContain('### missing-from-export (2)');
    expect(md).toContain('| ord `/r/inscription` content_length (3/4 answered)');
  });

  it('certifies ord bytes when every id answered', async () => {
    const complete = { ...ORD, [id('6')]: 204_810 };
    const ord = await fetchOrdSizes([id('1'), id('2'), id('3'), id('6')], { baseUrl: 'http://ord.test', fetch: fakeOrd(complete).fetch });
    const r = reconcile({ roster, ord, ordUrl: 'http://ord.test', claims: { count: 4, megabytes: 1.8 } });
    expect(r.certified).toMatchObject({ count: 4, bytes: 307_200 + 256_515 + 1_030_000 + 204_810, bytesSource: 'ord content_length (complete)' });
    expect(r.discrepancies.map((d) => d.class)).not.toContain('stale-count');
  });
});

describe('reconcile (the real roster vs the site claims)', () => {
  const r = reconcile({ roster: realRoster });

  it('certifies 4,112 unique members and their byte total', () => {
    expect(r.certified).toMatchObject({ count: 4112, bytes: 1_544_701_318, MB: 1544.7, MiB: 1473.14 });
    expect(r.roster).toMatchObject({ rows: 4112, uniqueIds: 4112, duplicateIds: [], gaps: [], highestNumber: 4112 });
  });

  it('explains 4,027 / 1,470 MB: stale count (#4028-#4112) and MiB labelled MB', () => {
    const site = r.claims.find((c) => c.source === 'site')!;
    expect(site.count).toMatchObject({ claimed: 4027, delta: 85 });
    expect(site.count.explanation).toContain('#4028–#4112');
    expect(site.megabytes.bestMatch).toBe('bytes/2^20 (MiB) of all 4112');
    expect(r.discrepancies.filter((d) => d.source === 'site').map((d) => d.class)).toEqual(['stale-count', 'unit-mismatch']);
  });

  it('explains the internal 4,113 / 1,508 MB: one extra row and KiB read as KB', () => {
    const internal = r.claims.find((c) => c.source === 'internal analysis')!;
    expect(internal.count.delta).toBe(-1);
    expect(internal.megabytes.bestMatch).toBe('sizeKb/1000 (KiB read as KB) of all 4112');
    expect(internal.megabytes.explanation).toMatch(/understates decimal MB/);
  });
});

describe('CLI', () => {
  const run = promisify(execFile);

  it('offline on fixtures: deterministic JSON + markdown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'degent-count-'));
    const args = [join(svc, 'scripts/reconcile-count.mjs'), '--roster', join(svc, 'test/fixtures/reconcile/roster.json'), '--export', join(svc, 'test/fixtures/reconcile/ids.txt'), '--claimed-count', '4', '--claimed-mb', '1.8'];
    await run(process.execPath, [...args, '--out', join(dir, 'a')]);
    await run(process.execPath, [...args, '--out', join(dir, 'b')]);
    expect(readFileSync(join(dir, 'a.json'), 'utf8')).toBe(readFileSync(join(dir, 'b.json'), 'utf8'));
    expect(readFileSync(join(dir, 'a.md'), 'utf8')).toBe(readFileSync(join(dir, 'b.md'), 'utf8'));
    const rep = JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8'));
    expect(rep.export.missingFromExport).toEqual([{ n: 6, id: id('6') }]);
    expect(rep.inputs.claims.map((c: { label: string }) => c.label)).toEqual(['site', 'internal analysis']);
  });

  it('--ord against a loopback stub, with the cache file', async () => {
    const server = createServer((req, res) => {
      const m = /\/r\/inscription\/(\w+)$/.exec(req.url ?? '');
      const len = m ? (ORD as Record<string, number>)[m[1]!] ?? (m[1] === id('6') ? 204_810 : undefined) : undefined;
      res.writeHead(len === undefined ? 404 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(len === undefined ? {} : { content_length: len }));
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const dir = mkdtempSync(join(tmpdir(), 'degent-count-'));
      await run(process.execPath, [join(svc, 'scripts/reconcile-count.mjs'), '--roster', join(svc, 'test/fixtures/reconcile/roster.json'), '--ord', url, '--site-only', '--cache', join(dir, 'cache.json'), '--out', join(dir, 'r')]);
      const rep = JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8'));
      expect(rep.certified.bytesSource).toBe('ord content_length (complete)');
      expect(Object.keys(JSON.parse(readFileSync(join(dir, 'cache.json'), 'utf8')))).toHaveLength(4);
    } finally {
      server.close();
    }
  });
});
