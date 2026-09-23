// Shared test fixtures: deterministic keys, addresses, WIFs, and a mocked
// network layer that stands in for mempool.space and the inscription indexer.
import * as btc from '@scure/btc-signer';
import { base58check, hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { pubSchnorr, pubECDSA } from '@scure/btc-signer/utils.js';

const b58c = base58check(sha256);

export function keyFromSeed(seed, network = btc.NETWORK) {
  const priv = sha256(new TextEncoder().encode(`degent-test-${seed}`));
  const xonly = pubSchnorr(priv);
  const compressed = pubECDSA(priv, true);
  const tr = btc.p2tr(xonly, undefined, network);
  const wpkh = btc.p2wpkh(compressed, network);
  const prefix = network === btc.NETWORK ? 0x80 : 0xef;
  return {
    priv,
    xonly,
    publicKeyHex: hex.encode(compressed),
    tr,
    wpkh,
    wif: b58c.encode(new Uint8Array([prefix, ...priv, 0x01])),
    network,
  };
}

export const TXIDS = {
  inscription: 'a1'.repeat(32),
  dummy: 'b2'.repeat(32),
  pay1: 'c3'.repeat(32),
  pay2: 'd4'.repeat(32),
  pay3: 'e5'.repeat(32),
};

export const INSCRIPTION_ID = `${TXIDS.inscription}i0`;

/** Sign selected inputs of a PSBT with a private key (emulates the wallet). */
export function walletSign(psbtHex, priv, indexes, sighash, { finalize = false } = {}) {
  const tx = btc.Transaction.fromPSBT(hex.decode(psbtHex), { allowUnknownInputs: true, allowUnknownOutputs: true });
  for (const i of indexes) {
    tx.signIdx(priv, i, sighash === undefined ? undefined : [sighash]);
    if (finalize) tx.finalizeIdx(i);
  }
  return hex.encode(tx.toPSBT());
}

/** In-memory stand-in for mempool.space + indexer with controllable state. */
export function mockNetwork({ inscription, utxosByAddress = {}, fees = { fastestFee: 20, halfHourFee: 10, hourFee: 6, economyFee: 3, minimumFee: 1 } } = {}) {
  const state = {
    inscription, // { id, number, address, outpoint, offset, value, contentType }
    spent: new Map(), // 'txid:vout' -> { txid }
    txs: new Map(), // txid -> tx json
    utxosByAddress,
    broadcasts: [],
    inscribedOutpoints: new Set(),
  };
  const mempool = {
    async getOutspend(txid, vout) {
      const s = state.spent.get(`${txid}:${vout}`);
      return s ? { spent: true, txid: s.txid } : { spent: false };
    },
    async getTx(txid) { return state.txs.get(txid) || null; },
    async getAddressUtxos(address) { return (state.utxosByAddress[address] || []).map((u) => ({ ...u, confirmed: u.confirmed ?? true })); },
    async getFeePresets() { return fees; },
    async broadcast(rawHex) {
      const tx = btc.RawTx.decode(hex.decode(rawHex));
      const id = hex.encode(sha256(sha256(btc.RawTx.encode({ ...tx, witnesses: [], segwitFlag: false }))).reverse());
      state.broadcasts.push({ rawHex, txid: id });
      return id;
    },
  };
  const indexer = {
    kind: 'mock',
    async getInscription(id) {
      if (!state.inscription || state.inscription.id !== id) return null;
      return { ...state.inscription };
    },
    async getOutpointInscriptions(outpoint) {
      return state.inscribedOutpoints.has(outpoint) ? ['some-inscription'] : [];
    },
  };
  return { state, mempool, indexer };
}
