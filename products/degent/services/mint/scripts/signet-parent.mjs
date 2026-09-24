#!/usr/bin/env node
/**
 * signet-parent — inscribe the Club parent (or a test member Degent) on PUBLIC signet straight from the signet
 * parent key, with the public esplora API (docs/SERVER.md "Signet parent"). Test networks only: mainnet is refused;
 * the mainnet parent follows docs/LAUNCH-CHAIN-SETUP.md.
 *
 * The inscription maths (envelope, commit address, exact reveal weight, fee rounding, reveal signing) is
 * @bsh/inscription's: this file only selects coins, funds the commit and broadcasts.
 *
 *   node scripts/signet-parent.mjs --key-file <hex key file> [--network signet] [--esplora <url>] [--ord <url>]
 *        [--fee-rate <sat/vB>] [--postage 10000] [--min-utxo 50000] [--state <file>] [--dry-run]
 *   node scripts/signet-parent.mjs --key-file <f> --member <tb1p address> --roster <roster.json> [...]
 *   node scripts/signet-parent.mjs --key-file <f> --address-only
 *
 * Parent mode: commit `[funding UTXOs of the key] -> [commit, change]`, reveal `[commit] -> [collection address]`;
 * the parent lands on the first sat of reveal output 0 (offset 0) at COLLECTION_ADDRESS, so
 * PARENT_INSCRIPTION_ID = <reveal txid>i0 and PARENT_OUTPOINT = <reveal txid>:0.
 * Member mode: the same two transactions with a small SVG test Degent sent to --member; prints the signet roster
 * with the new member appended (a roster whose `network` is not "signet" is replaced), so the member's wallet can
 * sign in and vote on the signet beta.
 *
 * Safety: coins below --min-utxo (the parent and every postage-sized output) are never spent, and every candidate is
 * checked with ord `/r/utxo/<outpoint>` (fails closed). --state makes a run resumable and idempotent: the planned
 * transactions are written before anything is broadcast; a finished state is returned as is (never a second parent).
 *
 * Output: human-readable lines on stderr, ONE JSON line on stdout:
 *   {"ok":true,"kind":"parent","network":"signet","commitTxid":…,"revealTxid":…,"inscriptionId":…,
 *    "env":{"PARENT_INSCRIPTION_ID":…,"PARENT_OUTPOINT":…,"COLLECTION_ADDRESS":…}}
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { schnorr } from '@noble/curves/secp256k1.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { p2tr, Transaction } from '@scure/btc-signer';
import {
  addressToScript,
  buildHalfSignedReveal,
  commitAddress,
  estimateRevealWeight,
  finalizeReveal,
  inscriptionDestination,
  inscriptionIdFromReveal,
  LIMITS,
  networkParams,
  quoteReveal,
} from '@bsh/inscription';
import { charterHtml, encodeCbor, parentMetadata, parseArgs, sha256Hex, utf8 } from './lib/chain-prep.mjs';

export const TEST_NETWORKS = ['signet', 'testnet', 'regtest'];
export const DEFAULTS = Object.freeze({
  network: 'signet',
  esplora: 'https://mempool.space/signet/api',
  ord: 'https://signet.ordinals.com',
  postage: 10_000n,
  minUtxo: 50_000n,
});
const DUST = BigInt(LIMITS.DUST_P2TR);

/** The key's BIP86-style key-path taproot address (the same as InMemoryPolicySigner's COLLECTION_ADDRESS). */
export function keyAddress(keyHex, network) {
  if (!TEST_NETWORKS.includes(network)) throw new Error(`refusing network "${network}": test networks only (${TEST_NETWORKS.join(', ')})`);
  const h = String(keyHex).trim();
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error('key file must contain 32 bytes of hex');
  const key = hexToBytes(h);
  const pubkey = schnorr.getPublicKey(key);
  const pay = p2tr(pubkey, undefined, networkParams(network));
  return { key, pubkey, address: pay.address, script: pay.script };
}

/** The Club parent: the charter page + CBOR metadata, exactly as prepare-parent.mjs builds them. */
export function parentContent() {
  return { contentType: 'text/html;charset=utf-8', body: utf8(charterHtml()), metadata: encodeCbor(parentMetadata()) };
}

/** A tiny framed test Degent for the signet roster (SVG, a few hundred bytes). */
export function memberContent(n) {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
    '<rect width="100" height="100" fill="#c9a227"/><rect x="8" y="8" width="84" height="84" fill="#0b0b0d"/>',
    '<circle cx="50" cy="44" r="20" fill="#2efc86"/><path d="M38 70l12-6 12 6-12 6z" fill="#fff"/>',
    `<text x="50" y="94" font-size="7" text-anchor="middle" fill="#0b0b0d" font-family="monospace">SIGNET TEST #${n}</text>`,
    '</svg>',
  ].join('');
  return { contentType: 'image/svg+xml', body: utf8(svg) };
}

const vsizeOf = (weight) => Math.ceil(weight / 4);

function signedCommit({ keyInfo, inputs, commitScript, commitValue, change }) {
  const tx = new Transaction();
  for (const u of inputs)
    tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script: keyInfo.script, amount: u.value }, tapInternalKey: keyInfo.pubkey });
  tx.addOutput({ script: commitScript, amount: commitValue });
  if (change !== null) tx.addOutput({ script: keyInfo.script, amount: change });
  tx.sign(keyInfo.key);
  tx.finalize();
  const full = tx.toBytes(true, true);
  const stripped = tx.toBytes(true, false);
  return { hex: Buffer.from(full).toString('hex'), txid: tx.id, weight: stripped.length * 3 + full.length };
}

/**
 * Pure: plan (and sign) the commit and reveal. `utxos` are the spendable candidates ({txid, vout, value: bigint}),
 * largest first is used. Throws when they cannot fund commit + fees.
 */
export function planInscription({ network, keyHex, utxos, feeRate, content, destination, postage = DEFAULTS.postage }) {
  const keyInfo = keyAddress(keyHex, network);
  if (!(Number.isFinite(feeRate) && feeRate > 0)) throw new Error('fee rate must be a positive number');
  if (typeof postage !== 'bigint' || postage < DUST) throw new Error(`postage must be >= ${DUST}`);
  const recipientScript = addressToScript(destination, network);
  // Reveal key = the parent key: a failed reveal can always be rebuilt from the key file alone.
  const commit = commitAddress(keyInfo.pubkey, content, network);
  const revealWeight = estimateRevealWeight({ content, withParent: false, recipientScript });
  const { revealFee, commitValue } = quoteReveal({ revealWeight, feeRate, postage });

  const sorted = [...utxos].sort((a, b) => (a.value === b.value ? 0 : a.value > b.value ? -1 : 1));
  const inputs = [];
  let total = 0n;
  for (const u of sorted) {
    inputs.push(u);
    total += u.value;
    // Weight of the signed commit does not depend on amounts: measure it with a placeholder change.
    if (total <= commitValue) continue;
    const probe = signedCommit({ keyInfo, inputs, commitScript: commit.script, commitValue, change: total - commitValue });
    const feeWithChange = quoteReveal({ revealWeight: probe.weight, feeRate, postage: 0n }).revealFee;
    const change = total - commitValue - feeWithChange;
    let tx;
    let commitFee;
    if (change >= DUST) {
      tx = signedCommit({ keyInfo, inputs, commitScript: commit.script, commitValue, change });
      commitFee = feeWithChange;
    } else {
      const noChange = signedCommit({ keyInfo, inputs, commitScript: commit.script, commitValue, change: null });
      const feeNoChange = quoteReveal({ revealWeight: noChange.weight, feeRate, postage: 0n }).revealFee;
      if (total - commitValue < feeNoChange) continue;
      tx = noChange;
      commitFee = total - commitValue;
    }
    const revealPsbt = buildHalfSignedReveal({
      network,
      revealPrivkey: keyInfo.key,
      content,
      commitOutpoint: { txid: tx.txid, vout: 0 },
      commitValue,
      recipientAddress: destination,
      postage,
      withParent: false,
    });
    const reveal = finalizeReveal(revealPsbt.psbtBase64);
    if (reveal.weight !== revealWeight) throw new Error(`internal: reveal weight ${reveal.weight} != estimate ${revealWeight}`);
    // ord FIFO: the inscription is on the first sat of the commit input; it must land at offset 0 of output 0.
    const dest = inscriptionDestination({ inputs: [{ value: commitValue }], outputs: [{ value: postage }] }, 0, 0n);
    if (dest === 'fee' || dest.vout !== 0 || dest.offset !== 0n) throw new Error('internal: inscription would not land at output 0 offset 0');
    return {
      address: keyInfo.address,
      destination,
      commitAddress: commit.address,
      commitValue,
      postage,
      feeRate,
      inputs: inputs.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value })),
      commit: { hex: tx.hex, txid: tx.txid, vsize: vsizeOf(tx.weight), fee: commitFee },
      reveal: { hex: reveal.hex, txid: reveal.txid, vsize: reveal.vsize, fee: revealFee },
      inscriptionId: inscriptionIdFromReveal(reveal.txid, 0),
      outpoint: `${reveal.txid}:0`,
      contentSha256: sha256Hex(content.body),
      contentBytes: content.body.length,
    };
  }
  throw new Error(
    `not enough spendable coins at ${keyInfo.address}: need more than ${commitValue} sat plus the commit fee (have ${total} sat in ${inputs.length} UTXO(s) >= the minimum). Fund it from a signet faucet.`,
  );
}

// ------------------------------------------------------------------ esplora / ord over an injectable fetch

const trim = (u) => String(u).replace(/\/+$/, '');

export function esploraClient(baseUrl, fetchImpl) {
  const base = trim(baseUrl);
  return {
    async utxos(address) {
      const res = await fetchImpl(`${base}/address/${encodeURIComponent(address)}/utxo`, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`esplora utxo: HTTP ${res.status}`);
      return (await res.json()).map((u) => ({ txid: u.txid, vout: u.vout, value: BigInt(u.value), confirmed: Boolean(u.status?.confirmed) }));
    },
    async feeRate() {
      const res = await fetchImpl(`${base}/fee-estimates`, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`esplora fee-estimates: HTTP ${res.status}`);
      const est = await res.json();
      const r = Number(est['2'] ?? est['3'] ?? est['1'] ?? 1);
      return Math.max(1, Math.ceil(Number.isFinite(r) ? r : 1));
    },
    async broadcast(hex) {
      const res = await fetchImpl(`${base}/tx`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: hex });
      const text = (await res.text()).trim();
      if (res.ok) return text;
      // Resuming: an already-known transaction is fine.
      if (/already (in block chain|known)|txn-already-(known|in-mempool)|Transaction already in block chain/i.test(text)) return null;
      throw new Error(`esplora broadcast: HTTP ${res.status} ${text.slice(0, 200)}`);
    },
  };
}

export async function ordInscriptionsAt(ordUrl, outpoint, fetchImpl) {
  const res = await fetchImpl(`${trim(ordUrl)}/r/utxo/${encodeURIComponent(outpoint)}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`ord /r/utxo/${outpoint}: HTTP ${res.status}`);
  const j = await res.json();
  return Array.isArray(j?.inscriptions) ? j.inscriptions : [];
}

/** Spendable candidates: confirmed, >= minUtxo, and holding no inscription according to ord (fails closed). */
export async function spendableUtxos({ esplora, ordUrl, address, minUtxo, fetchImpl, skipOrdCheck = false, allowUnconfirmed = false }) {
  const all = await esplora.utxos(address);
  const out = [];
  for (const u of all) {
    if (u.value < minUtxo) continue;
    if (!u.confirmed && !allowUnconfirmed) continue;
    if (!skipOrdCheck && (await ordInscriptionsAt(ordUrl, `${u.txid}:${u.vout}`, fetchImpl)).length > 0) continue;
    out.push(u);
  }
  return { all, spendable: out };
}

// ------------------------------------------------------------------ roster (member mode)

export function appendRoster(existing, entry) {
  const base = existing && existing.network === 'signet' && Array.isArray(existing.members) ? existing.members : [];
  const n = base.length + 1;
  return {
    version: 1,
    collection: 'Decentralized Gentlemen Club (signet beta)',
    network: 'signet',
    count: n,
    members: [...base, { n, inscriptionId: entry.inscriptionId, inscriptionNumber: null, sat: null, sizeKb: +(entry.bytes / 1024).toFixed(2), bytes: entry.bytes, height: null, timestamp: null }],
  };
}

// ------------------------------------------------------------------ run

const json = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x));

function readState(path) {
  if (!path || !existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeState(path, state) {
  if (!path) return;
  writeFileSync(`${path}.tmp`, `${json(state)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

/**
 * The CLI, testable: `fetchImpl` is injected (tests pass a mocked esplora/ord), `log` receives human lines.
 * Returns the result object printed as JSON.
 */
export async function run(argv, { fetchImpl = (u, i) => fetch(u, i), log = (l) => process.stderr.write(`${l}\n`), env = process.env } = {}) {
  const a = parseArgs(argv);
  if (a.help || !a['key-file']) throw new UsageError();
  const network = typeof a.network === 'string' ? a.network : DEFAULTS.network;
  const keyHex = readFileSync(String(a['key-file']), 'utf8').trim();
  const keyInfo = keyAddress(keyHex, network);
  if (a['address-only']) return { ok: true, kind: 'address', network, env: { COLLECTION_ADDRESS: keyInfo.address } };

  const esploraUrl = typeof a.esplora === 'string' ? a.esplora : env.ESPLORA_URL || DEFAULTS.esplora;
  const ordUrl = typeof a.ord === 'string' ? a.ord : env.ORD_URL || DEFAULTS.ord;
  const esplora = esploraClient(esploraUrl, fetchImpl);
  const postage = a.postage === undefined ? DEFAULTS.postage : BigInt(String(a.postage));
  const minUtxo = a['min-utxo'] === undefined ? DEFAULTS.minUtxo : BigInt(String(a['min-utxo']));
  if (minUtxo <= postage) throw new Error('--min-utxo must exceed --postage (postage-sized outputs may carry inscriptions)');

  const member = typeof a.member === 'string' ? a.member : null;
  if (member !== null) addressToScript(member, network); // throws on a wrong-network address
  const kind = member ? 'member' : 'parent';
  const statePath = typeof a.state === 'string' ? a.state : null;
  let state = readState(statePath);
  if (state && (state.kind !== kind || state.destination !== (member ?? keyInfo.address) || state.network !== network))
    throw new Error(`state file ${statePath} belongs to another run (${state.kind} -> ${state.destination}); move it away first`);

  let rosterDoc = null;
  if (member) {
    if (typeof a.roster !== 'string') throw new Error('--member needs --roster <current signet roster file>');
    rosterDoc = existsSync(a.roster) ? JSON.parse(readFileSync(a.roster, 'utf8')) : null;
  }

  if (!state) {
    const feeRate = a['fee-rate'] === undefined ? await esplora.feeRate() : Number(a['fee-rate']);
    const { all, spendable } = await spendableUtxos({
      esplora,
      ordUrl,
      address: keyInfo.address,
      minUtxo,
      fetchImpl,
      skipOrdCheck: a['skip-ord-check'] === true,
      allowUnconfirmed: a['allow-unconfirmed'] === true,
    });
    log(`${keyInfo.address}: ${all.length} UTXO(s), ${spendable.length} spendable (confirmed, >= ${minUtxo} sat, no inscription)`);
    const nextN = member ? (rosterDoc?.network === 'signet' ? (rosterDoc.members?.length ?? 0) : 0) + 1 : 0;
    const content = member ? memberContent(nextN) : parentContent();
    const plan = planInscription({ network, keyHex, utxos: spendable, feeRate, content, destination: member ?? keyInfo.address, postage });
    state = { version: 1, kind, network, ...plan, broadcast: { commit: false, reveal: false }, done: false };
    log(`plan: commit ${plan.commit.txid} (${plan.commit.vsize} vB, fee ${plan.commit.fee} sat), reveal ${plan.reveal.txid} (${plan.reveal.vsize} vB, fee ${plan.reveal.fee} sat) at ${feeRate} sat/vB`);
    if (a['dry-run']) return result(state, keyInfo, rosterDoc, { dryRun: true });
    writeState(statePath, state);
  } else if (state.done) {
    log(`already done: ${state.inscriptionId} (state ${statePath})`);
    return result(state, keyInfo, rosterDoc, { resumed: true });
  } else log(`resuming from ${statePath}`);

  if (!state.broadcast.commit) {
    await esplora.broadcast(state.commit.hex);
    state.broadcast.commit = true;
    writeState(statePath, state);
    log(`commit broadcast: ${state.commit.txid}`);
  }
  if (!state.broadcast.reveal) {
    await esplora.broadcast(state.reveal.hex);
    state.broadcast.reveal = true;
    state.done = true;
    writeState(statePath, state);
    log(`reveal broadcast: ${state.reveal.txid} -> ${state.inscriptionId}`);
  }
  return result(state, keyInfo, rosterDoc, {});
}

function result(state, keyInfo, rosterDoc, extra) {
  const base = {
    ok: true,
    kind: state.kind,
    network: state.network,
    ...extra,
    commitTxid: state.commit.txid,
    revealTxid: state.reveal.txid,
    inscriptionId: state.inscriptionId,
    outpoint: state.outpoint,
    destination: state.destination,
    fees: { commit: state.commit.fee, reveal: state.reveal.fee, feeRate: state.feeRate },
  };
  if (state.kind === 'parent')
    return { ...base, env: { PARENT_INSCRIPTION_ID: state.inscriptionId, PARENT_OUTPOINT: state.outpoint, COLLECTION_ADDRESS: keyInfo.address } };
  const roster = rosterDoc?.members?.some((m) => m.inscriptionId === state.inscriptionId) ? rosterDoc : appendRoster(rosterDoc, { inscriptionId: state.inscriptionId, bytes: state.contentBytes });
  return { ...base, roster };
}

export class UsageError extends Error {
  constructor() {
    super(`usage: signet-parent.mjs --key-file <file> [--network signet|testnet|regtest] [--esplora <url>] [--ord <url>]
         [--fee-rate <sat/vB>] [--postage 10000] [--min-utxo 50000] [--state <file>] [--dry-run]
         [--member <taproot address> --roster <roster.json>] [--address-only] [--allow-unconfirmed] [--skip-ord-check]`);
    this.name = 'UsageError';
  }
}

async function main() {
  try {
    const out = await run(process.argv.slice(2));
    if (out.kind === 'parent')
      process.stderr.write(`\nSet in the signet .env (deploy.sh signet-parent does this for you):\n  PARENT_INSCRIPTION_ID=${out.env.PARENT_INSCRIPTION_ID}\n  PARENT_OUTPOINT=${out.env.PARENT_OUTPOINT}\n  COLLECTION_ADDRESS=${out.env.COLLECTION_ADDRESS}\n`);
    process.stdout.write(`${json(out)}\n`);
  } catch (e) {
    process.stdout.write(`${json({ ok: false, error: e instanceof Error ? e.message : String(e) })}\n`);
    if (e instanceof UsageError) process.stderr.write(`${e.message}\n`);
    process.exit(e instanceof UsageError ? 2 : 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
