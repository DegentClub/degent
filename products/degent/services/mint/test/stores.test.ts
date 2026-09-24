import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '@bsh/degent-mint-sdk';
import { MemoryOrderStore } from '../src/adapters/memory-order-store.js';
import { SqliteOrderStore } from '../src/adapters/sqlite-order-store.js';
import { FsContentStore, MemoryContentStore } from '../src/adapters/content-stores.js';
import { EncryptedRevealVault, MemorySecretBlobStore } from '../src/adapters/reveal-vault.js';
import { StoreParentUtxoProvider } from '../src/adapters/store-parent-utxo.js';
import { StaleWriteError } from '../src/domain/errors.js';
import type { OrderRecord } from '../src/domain/order.js';
import type { OrderStore } from '../src/ports/order-store.js';

const dir = mkdtempSync(join(tmpdir(), 'degent-mint-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function record(id: string, status: OrderRecord['status'] = 'awaiting_content', createdAt = '2026-09-23T12:00:00.000Z'): OrderRecord {
  return {
    id, network: 'regtest', status, tier: 'standard', lane: 'standard', contentType: 'image/png', contentLength: 1,
    contentSha256: 'a'.repeat(64), recipientAddress: 'bcrt1p', revealPubkey: 'b'.repeat(64), quote: null, review: null,
    commitOutpoint: null, revealTxid: null, inscriptionId: null, rescued: false, serviceFeeAddress: null,
    timeline: [{ status, at: createdAt }], createdAt, updatedAt: createdAt, version: 0, expiresAt: createdAt,
    orderTokenHash: 'c'.repeat(64), hasReveal: false, paidAt: null, queuedAt: null, revealHex: null, revealWeight: null,
    broadcastAttempts: 0, lastError: null, parentOutpoint: null, reviewStartedAt: null, approvedAt: null, degentNumber: null,
  };
}

describe.each([
  ['memory', () => new MemoryOrderStore() as OrderStore],
  ['sqlite :memory:', () => new SqliteOrderStore(':memory:') as OrderStore],
  ['sqlite file', () => new SqliteOrderStore(join(dir, `orders-${Math.random()}.db`)) as OrderStore],
])('OrderStore contract: %s', (_name, make) => {
  it('create / get / save with optimistic concurrency', async () => {
    const s = make();
    await s.create(record('o1'));
    await expect(s.create(record('o1'))).rejects.toThrow();
    const a = (await s.get('o1'))!;
    const saved = await s.save({ ...a, status: 'reviewing' });
    expect(saved.version).toBe(1);
    await expect(s.save({ ...a, status: 'expired' })).rejects.toBeInstanceOf(StaleWriteError);
    expect((await s.get('o1'))!.status).toBe('reviewing');
    expect(await s.get('nope')).toBeNull();
  });

  it('lists by status in creation order and isolates copies', async () => {
    const s = make();
    await s.create(record('b', 'queued', '2026-09-23T12:00:02.000Z'));
    await s.create(record('a', 'queued', '2026-09-23T12:00:01.000Z'));
    await s.create(record('c', 'paid'));
    expect((await s.listByStatus(['queued'])).map((r) => r.id)).toEqual(['a', 'b']);
    expect(await s.listByStatus([])).toEqual([]);
    const got = (await s.get('a'))!;
    got.status = 'failed';
    expect((await s.get('a'))!.status).toBe('queued');
  });

  it('meta key/value', async () => {
    const s = make();
    expect(await s.getMeta('k')).toBeNull();
    await s.setMeta('k', 'v1');
    await s.setMeta('k', 'v2');
    expect(await s.getMeta('k')).toBe('v2');
  });

  it('incrementMeta is atomic and continues an existing count (DGT-SEC-003)', async () => {
    const s = make();
    expect(await s.incrementMeta('n')).toBe(1);
    const many = await Promise.all(Array.from({ length: 20 }, () => s.incrementMeta('n')));
    expect(new Set(many).size).toBe(20);
    expect(Math.max(...many)).toBe(21);
    expect(await s.getMeta('n')).toBe('21');
    await s.setMeta('legacy', '41');
    expect(await s.incrementMeta('legacy')).toBe(42);
  });
});

describe('SqliteOrderStore persistence', () => {
  it('two connections to one file (api processes) never claim the same approval rank', async () => {
    const path = join(dir, 'ranks.db');
    const a = new SqliteOrderStore(path);
    const b = new SqliteOrderStore(path);
    const got: number[] = [];
    for (let i = 0; i < 10; i++) got.push(await a.incrementMeta('approval.approvedCount'), await b.incrementMeta('approval.approvedCount'));
    expect(got).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    a.close();
    b.close();
  });

  it('survives reopen', async () => {
    const path = join(dir, 'persist.db');
    const a = new SqliteOrderStore(path);
    await a.create(record('p1'));
    await a.putBlob('p1', new Uint8Array([1, 2, 3]));
    a.close();
    const b = new SqliteOrderStore(path);
    expect((await b.get('p1'))!.id).toBe('p1');
    expect(await b.getBlob('p1')).toEqual(new Uint8Array([1, 2, 3]));
    await b.deleteBlob('p1');
    expect(await b.getBlob('p1')).toBeNull();
    b.close();
  });
});

describe.each([
  ['fs', () => new FsContentStore(join(dir, `content-${Math.random()}`))],
  ['memory', () => new MemoryContentStore()],
])('ContentStore: %s', (_n, make) => {
  it('is content addressed and idempotent', async () => {
    const s = make();
    const bytes = new TextEncoder().encode('degent');
    const sha = await s.put(bytes);
    expect(sha).toBe(sha256Hex(bytes));
    expect(await s.put(bytes)).toBe(sha);
    expect(await s.has(sha)).toBe(true);
    expect(await s.get(sha)).toEqual(bytes);
    expect(await s.get('0'.repeat(64))).toBeNull();
  });
});

describe('FsContentStore integrity', () => {
  it('refuses corrupted blobs and invalid keys', async () => {
    const root = join(dir, 'corrupt');
    const s = new FsContentStore(root);
    const sha = await s.put(new Uint8Array([9, 9, 9]));
    const file = join(root, sha.slice(0, 2), sha);
    expect(readdirSync(join(root, sha.slice(0, 2)))).toEqual([sha]); // no temp files left
    writeFileSync(file, new Uint8Array([1]));
    await expect(s.get(sha)).rejects.toThrow(/corruption/);
    await expect(s.get('../../etc/passwd')).rejects.toThrow(/invalid/);
    expect(readFileSync(file).length).toBe(1);
  });
});

describe('EncryptedRevealVault', () => {
  const KEY = '22'.repeat(32);
  it('round-trips, stores only ciphertext, and binds ciphertext to the order id', async () => {
    const blobs = new MemorySecretBlobStore();
    const v = new EncryptedRevealVault(blobs, KEY);
    const psbt = 'cHNidP8BAHECAAAAAf' + 'A'.repeat(200);
    await v.put('o1', psbt);
    expect(await v.get('o1')).toBe(psbt);
    expect(Buffer.from(blobs.blobs.get('o1')!).toString('latin1')).not.toContain('cHNidP8');
    // same plaintext encrypts differently (random IV)
    await v.put('o2', psbt);
    expect(Buffer.from(blobs.blobs.get('o1')!).equals(Buffer.from(blobs.blobs.get('o2')!))).toBe(false);
    // swap ciphertexts between orders -> authentication fails
    blobs.blobs.set('o2', blobs.blobs.get('o1')!);
    await expect(v.get('o2')).rejects.toThrow();
    // wrong key fails
    await expect(new EncryptedRevealVault(blobs, '33'.repeat(32)).get('o1')).rejects.toThrow();
    await v.delete('o1');
    expect(await v.get('o1')).toBeNull();
  });

  it('rejects bad keys', () => {
    expect(() => new EncryptedRevealVault(new MemorySecretBlobStore(), 'abc')).toThrow(/32 bytes/);
  });
});

describe('StoreParentUtxoProvider', () => {
  it('exclusive lease, release, advance, markConfirmed', async () => {
    const p = new StoreParentUtxoProvider(new MemoryOrderStore());
    expect(await p.lease('x')).toBeNull();
    await p.initialise({ txid: 'a'.repeat(64), vout: 0, value: 1000n, scriptHex: '5120' + '00'.repeat(32), confirmed: true, createdByLane: null });
    expect((await p.lease('o1'))!.value).toBe(1000n);
    expect(await p.lease('o2')).toBeNull();
    expect(await p.lease('o1')).not.toBeNull(); // re-entrant for the holder
    await expect(p.advance('o2', (await p.current())!)).rejects.toThrow();
    await p.advance('o1', { txid: 'b'.repeat(64), vout: 0, value: 1000n, scriptHex: '5120' + '00'.repeat(32), confirmed: false, createdByLane: 'block' });
    expect(await p.leasedBy()).toBeNull();
    expect(await p.current()).toMatchObject({ txid: 'b'.repeat(64), confirmed: false, createdByLane: 'block' });
    await p.markConfirmed('b'.repeat(64));
    expect((await p.current())!.confirmed).toBe(true);
    await p.lease('o3');
    await expect(p.initialise((await p.current())!, { force: true })).rejects.toThrow(/leased/);
    await p.release('o3');
    await p.initialise({ ...(await p.current())!, txid: 'c'.repeat(64) }, { force: true });
    expect((await p.current())!.txid).toBe('c'.repeat(64));
  });
});
