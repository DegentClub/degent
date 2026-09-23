import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { iid } from './helpers.js';

const example = readFileSync(new URL('../config/collections.example.json', import.meta.url), 'utf8');
const manifest = JSON.stringify({ collection: 'degent', items: [{ inscriptionId: iid('a') }] });
const files: Record<string, string> = { '/etc/certify/collections.json': example, '/etc/certify/degent-manifest.json': manifest };
const readFile = (p: string) => {
  if (!(p in files)) throw new Error(`ENOENT ${p}`);
  return files[p]!;
};

describe('loadConfig', () => {
  const base = {
    CERTIFY_ORD_URL: 'http://ord.local',
    CERTIFY_ADMIN_TOKEN: 'x'.repeat(24),
    CERTIFY_SIGNING_KEY: 'AB'.repeat(32),
    CERTIFY_COLLECTIONS_FILE: '/etc/certify/collections.json',
  };

  it('loads the example collections file, resolving the manifest path next to it', () => {
    const c = loadConfig(base, readFile);
    expect(c.signingKeyHex).toBe('ab'.repeat(32));
    expect(c.ord).toEqual({ kind: 'http', url: 'http://ord.local', timeoutMs: 20_000, childrenPath: 'r/children' });
    expect(c.collections[0]).toMatchObject({ slug: 'degent', parentInscriptionId: null, manifest: { document: { collection: 'degent' } } });
  });

  it('reports every problem at once and refuses dev shortcuts outside dev', () => {
    try {
      loadConfig({ CERTIFY_ORD: 'fake', CERTIFY_ADMIN_TOKEN: 'short', PORT: '99999' }, readFile);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).problems).toEqual([
        'CERTIFY_ORD=fake requires CERTIFY_DEV=1',
        'CERTIFY_ADMIN_TOKEN must be at least 16 characters',
        'CERTIFY_SIGNING_KEY is required (CERTIFY_DEV=1 generates an ephemeral key)',
        'CERTIFY_COLLECTIONS_FILE is required',
        'PORT must be an integer 1..65535',
      ]);
    }
    const dev = loadConfig({ ...base, CERTIFY_SIGNING_KEY: undefined, CERTIFY_DEV: '1', CERTIFY_ORD: 'fake' }, readFile);
    expect(dev.signingKeyHex).toBeNull();
    expect(dev.ord).toEqual({ kind: 'fake' });
  });

  it('validates the collections file', () => {
    const bad = JSON.stringify({ collections: [{ slug: 'degent', name: 'x' }, { slug: 'degent', name: 'y', parentInscriptionId: 'nope' }] });
    expect(() => loadConfig(base, (p) => (p === base.CERTIFY_COLLECTIONS_FILE ? bad : readFile(p)))).toThrow(
      /needs a parentInscriptionId and\/or a manifest[\s\S]*duplicate slug degent[\s\S]*parentInscriptionId must be an inscription id/,
    );
  });
});
