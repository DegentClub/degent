// Address / key helpers built on @scure/btc-signer.
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { equalBytes } from '@scure/btc-signer/utils.js';

export const SIGHASH = Object.freeze({
  DEFAULT: 0x00,
  ALL: 0x01,
  NONE: 0x02,
  SINGLE: 0x03,
  ANYONECANPAY: 0x80,
  SINGLE_ANYONECANPAY: 0x83,
  ALL_ANYONECANPAY: 0x81,
});

export function networkFor(name) {
  switch (name) {
    case 'mainnet': return btc.NETWORK;
    case 'testnet':
    case 'signet': return btc.TEST_NETWORK;
    default: throw new Error(`Unknown network ${name}`);
  }
}

/**
 * Decode a bech32/bech32m address into its scriptPubKey and type.
 * Returns { type: 'tr'|'wpkh'|'wsh'|'pkh'|'sh', script, address }.
 */
export function decodeAddress(address, network) {
  let decoded;
  try {
    decoded = btc.Address(network).decode(address);
  } catch (err) {
    throw new AddressError(`Invalid address for ${networkName(network)}: ${address}`);
  }
  const script = btc.OutScript.encode(decoded);
  return { type: decoded.type, script, address, decoded };
}

export function networkName(network) {
  return network === btc.NETWORK ? 'mainnet' : 'testnet/signet';
}

export class AddressError extends Error {
  constructor(msg) { super(msg); this.name = 'AddressError'; this.status = 400; }
}

/** 33-byte compressed pubkey (hex) -> 32-byte x-only internal key. */
export function xOnlyFromPublicKey(publicKeyHex) {
  const pk = hex.decode(publicKeyHex);
  if (pk.length === 33 && (pk[0] === 0x02 || pk[0] === 0x03)) return pk.subarray(1);
  if (pk.length === 32) return pk;
  throw new AddressError('Public key must be 33-byte compressed or 32-byte x-only');
}

/**
 * Prove that `address` is the key-path P2TR (no script tree) of `publicKeyHex`,
 * or the P2WPKH of it. This is what UniSat produces for its taproot / native
 * segwit accounts. Returns the payment descriptor including the correct
 * tapInternalKey (the *untweaked* x-only key — the old code wrongly used the
 * tweaked output key from the address, which makes wallets tweak twice).
 */
export function paymentForOwner(address, publicKeyHex, network) {
  const { type, script } = decodeAddress(address, network);
  const pk = hex.decode(publicKeyHex);
  if (type === 'tr') {
    const internal = xOnlyFromPublicKey(publicKeyHex);
    const p = btc.p2tr(internal, undefined, network);
    if (!equalBytes(p.script, script)) {
      throw new AddressError('Public key does not derive the given taproot address (key-path spend expected)');
    }
    return { type, script, tapInternalKey: internal, tweakedPubkey: p.tweakedPubkey, publicKey: pk };
  }
  if (type === 'wpkh') {
    if (pk.length !== 33) throw new AddressError('Segwit address requires a 33-byte compressed public key');
    const p = btc.p2wpkh(pk, network);
    if (!equalBytes(p.script, script)) {
      throw new AddressError('Public key does not derive the given segwit address');
    }
    return { type, script, publicKey: pk };
  }
  throw new AddressError(`Unsupported address type "${type}" — use a taproot (bc1p) or native segwit (bc1q) account`);
}

/** Dust threshold per output type (Bitcoin Core policy). */
export function dustFor(type) {
  return type === 'tr' || type === 'wsh' ? 330 : type === 'wpkh' ? 294 : 546;
}
