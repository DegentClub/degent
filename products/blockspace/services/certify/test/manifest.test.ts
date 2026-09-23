import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { run } from '../src/cli/manifest-from-collection-json.js';
import { manifestFromCollectionJson, manifestInscriptionBody, manifestSha256, parseManifest, ManifestError } from '../src/domain/manifest.js';

/** First four and last entry of Degent-Marketplace/collection.json, verbatim. */
const fixturePath = fileURLToPath(new URL('./fixtures/collection.sample.json', import.meta.url));
const sample = JSON.parse(readFileSync(fixturePath, 'utf8')) as { inscription_id: string }[];

function cli(argv: string[], files: Record<string, string> = {}) {
  let out = '';
  let err = '';
  const code = run(argv, {
    out: (s) => (out += s),
    err: (s) => (err += s),
    readFile: (p) => {
      if (p in files) return files[p]!;
      return readFileSync(p, 'utf8');
    },
  });
  return { code, out, err };
}

describe('manifestFromCollectionJson', () => {
  it('converts every entry, in order, to {inscriptionId} only', () => {
    const r = manifestFromCollectionJson(sample, 'degent');
    expect(r.entries).toBe(5);
    expect(r.manifest.collection).toBe('degent');
    expect(r.manifest.items.map((i) => i.inscriptionId)).toEqual(sample.map((e) => e.inscription_id));
    // size_kb is rounded and unit-ambiguous: never turned into contentLength
    expect(r.manifest.items.every((i) => Object.keys(i).join() === 'inscriptionId')).toBe(true);
    expect(r.declaredSizeKb).toBeCloseTo(1692.37, 2);
    // the output is itself a valid manifest
    expect(parseManifest(r.manifest)).toEqual(r.manifest);
  });

  it('fails loudly on duplicates and malformed entries, listing each', () => {
    const bad = [...sample, sample[1], { name: 'Degent #X', inscription_id: 'nope' }, null];
    try {
      manifestFromCollectionJson(bad, 'degent');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ManifestError);
      const issues = (e as ManifestError).issues;
      expect(issues).toHaveLength(3);
      expect(issues[0]).toMatch(/\[5\] "Degent #2": duplicate of \[1\]/);
      expect(issues[1]).toMatch(/\[6\] "Degent #X": bad inscription_id "nope"/);
      expect(issues[2]).toMatch(/\[7\]: not an object/);
    }
    expect(() => manifestFromCollectionJson({ items: [] }, 'degent')).toThrow(/array/);
    expect(() => manifestFromCollectionJson(sample, 'Not A Slug')).toThrow(/slug/);
  });
});

describe('CLI manifest-from-collection-json', () => {
  it('writes the manifest to stdout and a summary to stderr', () => {
    const r = cli([fixturePath]);
    expect(r.code).toBe(0);
    const m = JSON.parse(r.out);
    expect(m.items).toHaveLength(5);
    expect(r.err).toMatch(/^5 items, collection "degent", manifestSha256 [0-9a-f]{64}/);
  });

  it('--compact prints the canonical inscription body; its sha256 is manifestSha256', () => {
    const r = cli([fixturePath, '--compact', '--collection', 'degent']);
    const body = r.out.trimEnd();
    const m = parseManifest(JSON.parse(body));
    expect(body).toBe(manifestInscriptionBody(m));
    expect(createHash('sha256').update(body).digest('hex')).toBe(manifestSha256(m));
  });

  it('usage and input errors have distinct exit codes', () => {
    expect(cli([]).code).toBe(2);
    expect(cli(['--bogus', fixturePath]).code).toBe(2);
    expect(cli(['/nonexistent.json']).code).toBe(1);
    const dup = cli(['/dup.json'], { '/dup.json': JSON.stringify([sample[0], sample[0]]) });
    expect(dup.code).toBe(1);
    expect(dup.err).toMatch(/duplicate/);
    expect(dup.out).toBe('');
  });

  it('runs as a real process via tsx', () => {
    const tsx = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
    const script = fileURLToPath(new URL('../src/cli/manifest-from-collection-json.ts', import.meta.url));
    const p = spawnSync(tsx, [script, fixturePath, '--compact'], { encoding: 'utf8' });
    expect(p.status).toBe(0);
    expect(parseManifest(JSON.parse(p.stdout)).items).toHaveLength(5);
  });
});

describe('parseManifest', () => {
  const ok = { collection: 'degent', items: [{ inscriptionId: sample[0]!.inscription_id, sha256: 'a'.repeat(64), contentLength: 355_975 }] };
  it('accepts the documented shape', () => {
    expect(parseManifest(ok)).toEqual(ok);
    expect(parseManifest({ ...ok, manifestInscriptionId: sample[1]!.inscription_id }).manifestInscriptionId).toBe(sample[1]!.inscription_id);
  });
  it('is strict', () => {
    expect(() => parseManifest({ ...ok, extra: 1 })).toThrow(/unknown key "extra"/);
    expect(() => parseManifest({ ...ok, items: [{ inscriptionId: 'x' }] })).toThrow(/inscription id/);
    expect(() => parseManifest({ ...ok, items: [{ ...ok.items[0], sha256: 'A'.repeat(64) }] })).toThrow(/sha256/);
    expect(() => parseManifest({ ...ok, items: [{ ...ok.items[0], contentLength: -1 }] })).toThrow(/contentLength/);
    expect(() => parseManifest({ ...ok, items: [ok.items[0], ok.items[0]] })).toThrow(/duplicate/);
    expect(() => parseManifest([])).toThrow(/object/);
  });
  it('manifestSha256 ignores the off-chain manifestInscriptionId pointer', () => {
    expect(manifestSha256({ ...ok, manifestInscriptionId: sample[1]!.inscription_id })).toBe(manifestSha256(ok));
  });
});
