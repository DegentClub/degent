/**
 * scripts/signet-parent.mjs against a mocked esplora + ord (no network): coin selection never touches the parent or
 * inscription-bearing outputs, the commit pays the @bsh/inscription commit address, the reveal spends it and puts the
 * inscription at offset 0 of output 0 (the collection address for the parent), both transactions decode and carry
 * valid signatures, the result is machine-readable, and --state makes the run resumable and idempotent.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { hex } from '@scure/base';
import { Transaction } from '@scure/btc-signer';
import { addressToScript, commitAddress, inscriptionDestination, sha256Hex } from '@bsh/inscription';
import { parseRoster } from '../src/domain/roster.js';
import { InMemoryPolicySigner } from '../src/adapters/in-memory-policy-signer.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { keyAddress, memberContent, parentContent, planInscription, run } from '../scripts/signet-parent.mjs';

const KEY = '7f'.repeat(32);
const dir = mkdtempSync(join(tmpdir(), 'degent-signet-parent-'));
const keyFile = join(dir, 'parent-key');
writeFileSync(keyFile, `${KEY}\n`);
const ADDR = keyAddress(KEY, 'signet').address;
const txid = (n: number) => sha256Hex(new TextEncoder().encode(`faucet-${n}`));
const MEMBER = keyAddress('11'.repeat(32), 'signet').address;

interface MockOpts {
  utxos?: Array<{ txid: string; vout: number; value: number; confirmed?: boolean }>;
  inscribed?: string[];
  ordDown?: boolean;
  broadcastFail?: number;
}

/** esplora + ord mock; records every broadcast body. */
function mock(o: MockOpts = {}) {
  const broadcasts: string[] = [];
  const calls: string[] = [];
  let fail = o.broadcastFail ?? 0;
  const utxos = o.utxos ?? [
    { txid: txid(1), vout: 0, value: 500_000 },
    { txid: txid(2), vout: 1, value: 10_000 }, // postage-sized (e.g. the parent): never spent
    { txid: txid(3), vout: 0, value: 200_000 }, // carries an inscription per ord: never spent
    { txid: txid(4), vout: 0, value: 900_000, confirmed: false }, // unconfirmed: skipped by default
  ];
  const inscribed = new Set(o.inscribed ?? [`${txid(3)}:0`]);
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === `https://mempool.space/signet/api/address/${ADDR}/utxo`)
      return Response.json(utxos.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, status: { confirmed: u.confirmed ?? true } })));
    if (url === 'https://mempool.space/signet/api/fee-estimates') return Response.json({ '1': 3.2, '2': 2.1, '6': 1 });
    if (url === 'https://mempool.space/signet/api/tx' && init?.method === 'POST') {
      if (fail > 0) {
        fail--;
        return new Response('sendrawtransaction RPC error: timeout', { status: 502 });
      }
      const body = String(init.body);
      broadcasts.push(body);
      return new Response(Transaction.fromRaw(hex.decode(body), { allowUnknownInputs: true, allowUnknownOutputs: true }).id);
    }
    const m = /^https:\/\/signet\.ordinals\.com\/r\/utxo\/(.+)$/.exec(url);
    if (m) {
      if (o.ordDown) return new Response('bad gateway', { status: 502 });
      const op = decodeURIComponent(m[1]!);
      return Response.json({ inscriptions: inscribed.has(op) ? [`${'e'.repeat(64)}i0`] : [], value: 1 });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, broadcasts, calls };
}

const decode = (h: string) => Transaction.fromRaw(hex.decode(h), { allowUnknownInputs: true, allowUnknownOutputs: true });
const quiet = () => undefined;

describe('keys and addresses', () => {
  it('the collection address is exactly the policy signer address; mainnet is refused', () => {
    expect(ADDR).toBe(new InMemoryPolicySigner(hexToBytes(KEY), 'signet', undefined, { warn: () => {} }).collectionAddress());
    expect(ADDR).toMatch(/^tb1p/);
    expect(() => keyAddress(KEY, 'mainnet')).toThrow(/test networks only/);
    expect(() => keyAddress('zz', 'signet')).toThrow(/32 bytes of hex/);
  });
});

describe('planInscription (pure)', () => {
  it('commit pays the commit address from the key; reveal lands the inscription at output 0 offset 0', () => {
    const content = parentContent();
    const plan = planInscription({ network: 'signet', keyHex: KEY, utxos: [{ txid: txid(1), vout: 0, value: 500_000n }], feeRate: 2, content, destination: ADDR });
    const commit = decode(plan.commit.hex);
    const reveal = decode(plan.reveal.hex);
    // commit: 1 input (the faucet coin), output 0 = commit address with commitValue, output 1 = change to the key
    expect(commit.inputsLength).toBe(1);
    expect(hex.encode(commit.getInput(0).txid!)).toBe(txid(1));
    const pubkey = schnorr.getPublicKey(hexToBytes(KEY));
    expect(hex.encode(commit.getOutput(0).script!)).toBe(hex.encode(commitAddress(pubkey, content, 'signet').script));
    expect(commit.getOutput(0).amount).toBe(plan.commitValue);
    expect(hex.encode(commit.getOutput(1).script!)).toBe(hex.encode(addressToScript(ADDR, 'signet')));
    expect(500_000n - plan.commitValue - commit.getOutput(1).amount!).toBe(plan.commit.fee);
    expect(plan.commit.fee).toBeGreaterThanOrEqual(BigInt(Math.ceil(plan.commit.vsize * 2)));
    // reveal: spends commit:0, one output = postage to the collection address
    expect(reveal.inputsLength).toBe(1);
    expect(hex.encode(reveal.getInput(0).txid!)).toBe(plan.commit.txid);
    expect(reveal.getInput(0).index).toBe(0);
    expect(reveal.outputsLength).toBe(1);
    expect(hex.encode(reveal.getOutput(0).script!)).toBe(hex.encode(addressToScript(ADDR, 'signet')));
    expect(reveal.getOutput(0).amount).toBe(10_000n);
    expect(plan.commitValue - 10_000n).toBe(plan.reveal.fee);
    expect(plan.reveal.fee).toBeGreaterThanOrEqual(BigInt(Math.ceil(plan.reveal.vsize * 2)));
    expect(inscriptionDestination({ inputs: [{ value: plan.commitValue }], outputs: [{ value: reveal.getOutput(0).amount! }] }, 0, 0n)).toEqual({ vout: 0, offset: 0n });
    // the witness carries the envelope with the exact content
    const witness = reveal.getInput(0).finalScriptWitness!;
    expect(witness).toHaveLength(3);
    const leaf = Buffer.from(witness[1]!);
    expect(leaf.includes(Buffer.from('ord'))).toBe(true);
    expect(leaf.includes(Buffer.from(content.body.subarray(0, 200)))).toBe(true);
    expect(plan.inscriptionId).toBe(`${plan.reveal.txid}i0`);
    expect(plan.outpoint).toBe(`${plan.reveal.txid}:0`);
  });

  it('the commit key-path signature verifies (BIP341, SIGHASH_DEFAULT)', () => {
    const plan = planInscription({ network: 'signet', keyHex: KEY, utxos: [{ txid: txid(1), vout: 0, value: 500_000n }], feeRate: 1, content: parentContent(), destination: ADDR });
    const commit = decode(plan.commit.hex);
    const script = addressToScript(ADDR, 'signet');
    const msg = commit.preimageWitnessV1(0, [script], 0, [500_000n]);
    const sig = commit.getInput(0).finalScriptWitness![0]!;
    expect(sig).toHaveLength(64);
    expect(schnorr.verify(sig, msg, script.subarray(2))).toBe(true);
  });

  it('refuses when the coins cannot fund commit + fees', () => {
    expect(() => planInscription({ network: 'signet', keyHex: KEY, utxos: [{ txid: txid(1), vout: 0, value: 12_000n }], feeRate: 5, content: parentContent(), destination: ADDR })).toThrow(/signet faucet/);
    expect(() => planInscription({ network: 'signet', keyHex: KEY, utxos: [], feeRate: 1, content: parentContent(), destination: ADDR })).toThrow(/not enough/);
  });
});

describe('run (CLI) with a mocked esplora + ord', () => {
  it('inscribes the parent: spends only the safe coin, broadcasts commit then reveal, prints the env', async () => {
    const m = mock();
    const out = await run(['--key-file', keyFile], { fetchImpl: m.fetchImpl, log: quiet, env: {} });
    expect(out.ok).toBe(true);
    expect(out.kind).toBe('parent');
    expect(m.broadcasts).toHaveLength(2);
    const [commitHex, revealHex] = m.broadcasts as [string, string];
    const commit = decode(commitHex);
    expect(commit.inputsLength).toBe(1);
    expect(hex.encode(commit.getInput(0).txid!)).toBe(txid(1)); // not the postage-sized, inscribed or unconfirmed ones
    expect(decode(revealHex).id).toBe(out.revealTxid);
    expect(out.env).toEqual({ PARENT_INSCRIPTION_ID: `${out.revealTxid}i0`, PARENT_OUTPOINT: `${out.revealTxid}:0`, COLLECTION_ADDRESS: ADDR });
    expect(out.fees!.feeRate).toBe(3); // ceil of the 2-block estimate
    // JSON-serialisable (bigints become numbers in the CLI's printer)
    expect(() => JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))).not.toThrow();
  });

  it('fails closed when ord cannot say whether a coin carries an inscription', async () => {
    const m = mock({ ordDown: true });
    await expect(run(['--key-file', keyFile], { fetchImpl: m.fetchImpl, log: quiet, env: {} })).rejects.toThrow(/ord \/r\/utxo/);
    expect(m.broadcasts).toHaveLength(0);
  });

  it('--dry-run plans without broadcasting', async () => {
    const m = mock();
    const out = await run(['--key-file', keyFile, '--dry-run', '--fee-rate', '1'], { fetchImpl: m.fetchImpl, log: quiet, env: {} });
    expect(out.dryRun).toBe(true);
    expect(m.broadcasts).toHaveLength(0);
  });

  it('--state resumes after a failed broadcast and never inscribes a second parent', async () => {
    const state = join(mkdtempSync(join(tmpdir(), 'degent-state-')), 'parent.json');
    const m = mock({ broadcastFail: 1 });
    await expect(run(['--key-file', keyFile, '--state', state], { fetchImpl: m.fetchImpl, log: quiet, env: {} })).rejects.toThrow(/broadcast/);
    expect(existsSync(state)).toBe(true);
    const planned = JSON.parse(readFileSync(state, 'utf8'));
    expect(planned.broadcast).toEqual({ commit: false, reveal: false });
    const again = await run(['--key-file', keyFile, '--state', state], { fetchImpl: m.fetchImpl, log: quiet, env: {} });
    expect(again.revealTxid).toBe(planned.reveal.txid);
    expect(m.broadcasts).toHaveLength(2);
    const third = await run(['--key-file', keyFile, '--state', state], { fetchImpl: m.fetchImpl, log: quiet, env: {} });
    expect(third.resumed).toBe(true);
    expect(third.inscriptionId).toBe(again.inscriptionId);
    expect(m.broadcasts).toHaveLength(2); // nothing new
    // a member run cannot reuse the parent's state file
    await expect(run(['--key-file', keyFile, '--state', state, '--member', MEMBER, '--roster', join(dir, 'none.json')], { fetchImpl: m.fetchImpl, log: quiet, env: {} })).rejects.toThrow(/another run/);
  });

  it('member mode sends a test Degent to the member and returns a valid signet roster', async () => {
    const m = mock();
    const rosterFile = join(dir, 'roster.json');
    // A non-signet roster (the mainnet Gallery placeholder) is replaced.
    writeFileSync(rosterFile, JSON.stringify({ version: 1, count: 1, members: [{ n: 1, inscriptionId: `${'a'.repeat(64)}i0`, bytes: 1 }] }));
    const out = await run(['--key-file', keyFile, '--member', MEMBER, '--roster', rosterFile, '--fee-rate', '1'], { fetchImpl: m.fetchImpl, log: quiet, env: {} });
    expect(out.kind).toBe('member');
    const reveal = decode(m.broadcasts[1]!);
    expect(hex.encode(reveal.getOutput(0).script!)).toBe(hex.encode(addressToScript(MEMBER, 'signet')));
    expect(out.roster!.network).toBe('signet');
    expect(parseRoster(out.roster)).toEqual([expect.objectContaining({ n: 1, inscriptionId: out.inscriptionId, bytes: memberContent(1).body.length })]);
    // appending to a signet roster numbers the next member
    writeFileSync(rosterFile, JSON.stringify(out.roster));
    const m2 = mock({ utxos: [{ txid: txid(9), vout: 0, value: 400_000 }] });
    const second = await run(['--key-file', keyFile, '--member', MEMBER, '--roster', rosterFile, '--fee-rate', '1'], { fetchImpl: m2.fetchImpl, log: quiet, env: {} });
    expect(parseRoster(second.roster).map((r) => r.n)).toEqual([1, 2]);
  });

  it('rejects wrong-network member addresses and usage errors', async () => {
    const m = mock();
    await expect(run(['--key-file', keyFile, '--member', 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', '--roster', 'x'], { fetchImpl: m.fetchImpl, log: quiet, env: {} })).rejects.toThrow();
    await expect(run([], { fetchImpl: m.fetchImpl, log: quiet, env: {} })).rejects.toThrow(/usage/);
    const addr = await run(['--key-file', keyFile, '--address-only'], { fetchImpl: m.fetchImpl, log: quiet, env: {} });
    expect(addr.env).toEqual({ COLLECTION_ADDRESS: ADDR });
    expect(m.calls).toEqual([]);
  });
});
