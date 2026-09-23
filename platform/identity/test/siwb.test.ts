import { describe, expect, it } from 'vitest';
import {
  InMemoryNonceStore,
  createChallenge,
  formatSiwbMessage,
  issueChallenge,
  parseSiwbMessage,
  signBip322Simple,
  signLegacyMessage,
  verifySignIn,
  type BitcoinNetwork,
} from '../src/index.js';
import { BIP322_P2TR, BIP322_P2WPKH, BIP322_PRIV, addr, flipBase64Byte, key } from './helpers.js';

const T0 = Date.parse('2026-09-23T12:00:00.000Z');
const DOMAIN = 'id.example.com';

async function setup(opts: { address?: string; network?: BitcoinNetwork; ttlSeconds?: number } = {}) {
  const nonces = new InMemoryNonceStore();
  const address = opts.address ?? BIP322_P2TR;
  const ch = await issueChallenge(nonces, {
    domain: DOMAIN,
    address,
    network: opts.network ?? 'mainnet',
    ttlSeconds: opts.ttlSeconds ?? 300,
    now: T0,
  });
  return { nonces, ch, address };
}

describe('SIWB message', () => {
  it('formats the documented grammar', () => {
    const ch = createChallenge({
      domain: DOMAIN,
      address: BIP322_P2WPKH,
      network: 'mainnet',
      nonce: 'abcdef0123456789',
      ttlSeconds: 300,
      statement: 'Sign in to Blockspace ID.',
      requestId: 'req-1',
      resources: ['https://id.example.com/terms'],
      notBefore: new Date(T0),
      now: T0,
    });
    expect(ch.message).toBe(
      [
        'id.example.com wants you to sign in with your Bitcoin account:',
        BIP322_P2WPKH,
        '',
        'Sign in to Blockspace ID.',
        '',
        'URI: https://id.example.com',
        'Version: 1',
        'Network: mainnet',
        'Nonce: abcdef0123456789',
        'Issued At: 2026-09-23T12:00:00.000Z',
        'Expiration Time: 2026-09-23T12:05:00.000Z',
        'Not Before: 2026-09-23T12:00:00.000Z',
        'Request ID: req-1',
        'Resources:',
        '- https://id.example.com/terms',
      ].join('\n'),
    );
    expect(parseSiwbMessage(ch.message)).toEqual(ch.fields);
  });

  it('generates 128-bit hex nonces that differ per challenge', () => {
    const a = createChallenge({ domain: DOMAIN, address: BIP322_P2TR, network: 'mainnet', ttlSeconds: 60 });
    const b = createChallenge({ domain: DOMAIN, address: BIP322_P2TR, network: 'mainnet', ttlSeconds: 60 });
    expect(a.fields.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(a.fields.nonce).not.toBe(b.fields.nonce);
  });

  it.each([
    ['CRLF line endings', (m: string) => m.replace(/\n/g, '\r\n')],
    ['trailing newline', (m: string) => `${m}\n`],
    ['trailing whitespace', (m: string) => m.replace('Version: 1', 'Version: 1 ')],
    ['reordered fields', (m: string) => m.replace('Version: 1\nNetwork: mainnet', 'Network: mainnet\nVersion: 1')],
    ['unknown version', (m: string) => m.replace('Version: 1', 'Version: 2')],
    ['unknown network', (m: string) => m.replace('Network: mainnet', 'Network: liquid')],
    ['non-canonical timestamp', (m: string) => m.replace('2026-09-23T12:05:00.000Z', '2026-09-23T12:05:00Z')],
    ['injected extra line', (m: string) => m.replace('URI:', 'Evil: 1\nURI:')],
    ['uri host differs from domain', (m: string) => m.replace('URI: https://id.example.com', 'URI: https://evil.com')],
    ['upper-case domain', (m: string) => m.replace('id.example.com wants', 'ID.example.com wants')],
    ['address of another network', (m: string) => m.replace('Network: mainnet', 'Network: testnet')],
  ])('parse rejects %s', (_n, mutate) => {
    const { message } = createChallenge({ domain: DOMAIN, address: BIP322_P2TR, network: 'mainnet', ttlSeconds: 300, now: T0 });
    expect(() => parseSiwbMessage(mutate(message))).toThrow();
  });

  it.each([
    ['scheme in domain', { domain: 'https://example.com' }],
    ['path in domain', { domain: 'example.com/x' }],
    ['http uri off loopback', { uri: 'http://id.example.com' }],
    ['uri host mismatch', { uri: 'https://example.org' }],
    ['ttl of zero', { ttlSeconds: 0 }],
    ['ttl above max', { ttlSeconds: 3601 }],
    ['short nonce', { nonce: 'abc' }],
    ['non-alphanumeric nonce', { nonce: 'abcdefghijklmnop\nx' }],
    ['multi-line statement', { statement: 'a\nURI: https://evil.com' }],
    ['testnet address on mainnet', { address: addr('wpkh', key(1), 'testnet') }],
    ['unsupported address type (p2wsh)', { address: 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3' }],
  ])('createChallenge rejects %s', (_n, patch) => {
    expect(() => createChallenge({ domain: DOMAIN, address: BIP322_P2TR, network: 'mainnet', ttlSeconds: 300, ...patch })).toThrow();
  });

  it('allows http for loopback development', () => {
    const ch = createChallenge({ domain: 'localhost:5173', uri: 'http://localhost:5173', address: addr('tr', key(2), 'regtest'), network: 'regtest', ttlSeconds: 60 });
    expect(parseSiwbMessage(ch.message).uri).toBe('http://localhost:5173');
  });
});

describe('verifySignIn', () => {
  it('accepts a BIP-322 P2TR sign-in (BIP-322 vector key)', async () => {
    const { nonces, ch } = await setup();
    const signature = signBip322Simple(BIP322_PRIV, 'p2tr', ch.message);
    const r = await verifySignIn({ message: ch.message, signature, address: BIP322_P2TR }, { domain: DOMAIN, nonces, now: T0 + 1000 });
    expect(r).toMatchObject({ ok: true, address: BIP322_P2TR, network: 'mainnet', method: 'bip322-simple' });
  });

  it('accepts a BIP-322 P2WPKH sign-in', async () => {
    const { nonces, ch } = await setup({ address: BIP322_P2WPKH });
    const signature = signBip322Simple(BIP322_PRIV, 'p2wpkh', ch.message);
    const r = await verifySignIn({ message: ch.message, signature, address: BIP322_P2WPKH }, { domain: DOMAIN, nonces, now: T0 });
    expect(r.ok).toBe(true);
  });

  it('accepts legacy signmessage for P2WPKH and P2PKH', async () => {
    for (const [kind, a] of [
      ['p2wpkh', addr('wpkh', key(3))],
      ['p2pkh', addr('pkh', key(3))],
    ] as const) {
      const { nonces, ch } = await setup({ address: a });
      const signature = signLegacyMessage(key(3), ch.message, kind);
      const r = await verifySignIn({ message: ch.message, signature, address: a }, { domain: DOMAIN, nonces, now: T0 });
      expect(r).toMatchObject({ ok: true, method: 'legacy' });
    }
  });

  it('works on testnet / signet / regtest addresses', async () => {
    for (const net of ['testnet', 'signet', 'regtest'] as const) {
      const a = addr('tr', key(4), net);
      const { nonces, ch } = await setup({ address: a, network: net });
      const signature = signBip322Simple(key(4), 'p2tr', ch.message);
      expect((await verifySignIn({ message: ch.message, signature, address: a }, { domain: DOMAIN, nonces, now: T0, network: net })).ok).toBe(true);
    }
  });

  it('rejects a signature over a different message', async () => {
    const { nonces, ch } = await setup();
    const signature = signBip322Simple(BIP322_PRIV, 'p2tr', ch.message.replace('Sign in', 'Sign up'));
    const r = await verifySignIn({ message: ch.message, signature, address: BIP322_P2TR }, { domain: DOMAIN, nonces, now: T0 });
    expect(r).toMatchObject({ ok: false, error: 'invalid_signature' });
  });

  it('rejects when the claimed address differs from the message', async () => {
    const { nonces, ch } = await setup();
    const signature = signBip322Simple(BIP322_PRIV, 'p2tr', ch.message);
    const r = await verifySignIn({ message: ch.message, signature, address: addr('tr', key(5)) }, { domain: DOMAIN, nonces, now: T0 });
    expect(r).toMatchObject({ ok: false, error: 'address_mismatch' });
  });

  it('rejects a signature from another key (wrong address owner)', async () => {
    const { nonces, ch } = await setup();
    const signature = signBip322Simple(key(5), 'p2tr', ch.message);
    const r = await verifySignIn({ message: ch.message, signature, address: BIP322_P2TR }, { domain: DOMAIN, nonces, now: T0 });
    expect(r).toMatchObject({ ok: false, error: 'invalid_signature' });
  });

  it('rejects a tampered signature', async () => {
    const { nonces, ch } = await setup();
    const signature = flipBase64Byte(signBip322Simple(BIP322_PRIV, 'p2tr', ch.message), 10);
    const r = await verifySignIn({ message: ch.message, signature, address: BIP322_P2TR }, { domain: DOMAIN, nonces, now: T0 });
    expect(r).toMatchObject({ ok: false, error: 'invalid_signature' });
  });

  it('rejects an expired challenge (no leeway on expiry)', async () => {
    const { nonces, ch } = await setup({ ttlSeconds: 60 });
    const signature = signBip322Simple(BIP322_PRIV, 'p2tr', ch.message);
    const r = await verifySignIn({ message: ch.message, signature, address: BIP322_P2TR }, { domain: DOMAIN, nonces, now: T0 + 60_000 });
    expect(r).toMatchObject({ ok: false, error: 'expired' });
    const ok = await verifySignIn({ message: ch.message, signature, address: BIP322_P2TR }, { domain: DOMAIN, nonces, now: T0 + 59_999 });
    expect(ok.ok).toBe(true);
  });

  it('rejects a challenge issued in the future (beyond clock skew)', async () => {
    const { nonces, ch } = await setup();
    const signature = signBip322Simple(BIP322_PRIV, 'p2tr', ch.message);
    const r = await verifySignIn({ message: ch.message, signature, address: BIP322_P2TR }, { domain: DOMAIN, nonces, now: T0 - 61_000 });
    expect(r).toMatchObject({ ok: false, error: 'not_yet_valid' });
  });

  it('rejects a replayed nonce', async () => {
    const { nonces, ch } = await setup();
    const signature = signBip322Simple(BIP322_PRIV, 'p2tr', ch.message);
    const input = { message: ch.message, signature, address: BIP322_P2TR };
    expect((await verifySignIn(input, { domain: DOMAIN, nonces, now: T0 })).ok).toBe(true);
    expect(await verifySignIn(input, { domain: DOMAIN, nonces, now: T0 })).toMatchObject({ ok: false, error: 'nonce_replayed' });
    // a fresh signature over the same message is still a replay
    const again = signBip322Simple(BIP322_PRIV, 'p2tr', ch.message, { auxRand: new Uint8Array(32).fill(9) });
    expect(await verifySignIn({ ...input, signature: again }, { domain: DOMAIN, nonces, now: T0 })).toMatchObject({ error: 'nonce_replayed' });
  });

  it('rejects the wrong domain', async () => {
    const { nonces, ch } = await setup();
    const signature = signBip322Simple(BIP322_PRIV, 'p2tr', ch.message);
    const r = await verifySignIn({ message: ch.message, signature, address: BIP322_P2TR }, { domain: 'evil.example.com', nonces, now: T0 });
    expect(r).toMatchObject({ ok: false, error: 'domain_mismatch' });
    const multi = await verifySignIn({ message: ch.message, signature, address: BIP322_P2TR }, { domain: ['a.example.com', DOMAIN], nonces, now: T0 });
    expect(multi.ok).toBe(true);
  });

  it('rejects a self-made challenge whose nonce the server never issued', async () => {
    const nonces = new InMemoryNonceStore();
    const ch = createChallenge({ domain: DOMAIN, address: BIP322_P2TR, network: 'mainnet', ttlSeconds: 300, now: T0 });
    const signature = signBip322Simple(BIP322_PRIV, 'p2tr', ch.message);
    const r = await verifySignIn({ message: ch.message, signature, address: BIP322_P2TR }, { domain: DOMAIN, nonces, now: T0 });
    expect(r).toMatchObject({ ok: false, error: 'nonce_unknown' });
  });

  it('rejects a nonce issued for another address', async () => {
    const nonces = new InMemoryNonceStore();
    const other = await issueChallenge(nonces, { domain: DOMAIN, address: addr('tr', key(6)), network: 'mainnet', ttlSeconds: 300, now: T0 });
    const ch = createChallenge({ domain: DOMAIN, address: BIP322_P2TR, network: 'mainnet', ttlSeconds: 300, now: T0, nonce: other.fields.nonce });
    const signature = signBip322Simple(BIP322_PRIV, 'p2tr', ch.message);
    const r = await verifySignIn({ message: ch.message, signature, address: BIP322_P2TR }, { domain: DOMAIN, nonces, now: T0 });
    expect(r).toMatchObject({ ok: false, error: 'nonce_unknown' });
  });

  it('an invalid signature does not burn the nonce', async () => {
    const { nonces, ch } = await setup();
    const bad = signBip322Simple(key(8), 'p2tr', ch.message);
    expect((await verifySignIn({ message: ch.message, signature: bad, address: BIP322_P2TR }, { domain: DOMAIN, nonces, now: T0 })).ok).toBe(false);
    const good = signBip322Simple(BIP322_PRIV, 'p2tr', ch.message);
    expect((await verifySignIn({ message: ch.message, signature: good, address: BIP322_P2TR }, { domain: DOMAIN, nonces, now: T0 })).ok).toBe(true);
  });

  it('enforces the expected network and the legacy switch', async () => {
    const { nonces, ch } = await setup();
    const signature = signBip322Simple(BIP322_PRIV, 'p2tr', ch.message);
    expect(await verifySignIn({ message: ch.message, signature, address: BIP322_P2TR }, { domain: DOMAIN, nonces, now: T0, network: 'testnet' })).toMatchObject({
      error: 'network_mismatch',
    });
    const a = addr('wpkh', key(9));
    const s2 = await setup({ address: a });
    const legacy = signLegacyMessage(key(9), s2.ch.message);
    expect(await verifySignIn({ message: s2.ch.message, signature: legacy, address: a }, { domain: DOMAIN, nonces: s2.nonces, now: T0, allowLegacy: false })).toMatchObject({
      error: 'invalid_signature',
    });
  });

  it('never throws on garbage input', async () => {
    const nonces = new InMemoryNonceStore();
    for (const message of ['', 'hello', '\n\n\n', 'x'.repeat(10_000)]) {
      const r = await verifySignIn({ message, signature: '???', address: BIP322_P2TR }, { domain: DOMAIN, nonces });
      expect(r).toMatchObject({ ok: false, error: 'malformed_message' });
    }
    const { ch } = await setup();
    expect(await verifySignIn({ message: ch.message, signature: '???', address: BIP322_P2TR }, { domain: DOMAIN, nonces, now: T0 })).toMatchObject({
      error: 'invalid_signature',
    });
  });

  it('formatSiwbMessage(parse(m)) is the identity', async () => {
    const { ch } = await setup();
    expect(formatSiwbMessage(parseSiwbMessage(ch.message))).toBe(ch.message);
  });
});
