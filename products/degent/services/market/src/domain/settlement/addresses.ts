/**
 * Address / key helpers on @scure/btc-signer, and PSBT (de)serialisation that accepts hex or base64.
 */
import * as btc from '@scure/btc-signer';
import { base64, hex } from '@scure/base';
import { equalBytes } from '@scure/btc-signer/utils.js';
import { networkParams, type Network } from '@bsh/inscription';
import type { ScriptType } from '@bsh/degent-market-sdk';
import { SettlementError } from '../errors.js';

export type BtcNetwork = ReturnType<typeof networkParams>;

export const btcNetwork = (network: Network): BtcNetwork => networkParams(network);

/** Transaction options for every PSBT this service builds or parses: no unknown scripts. */
export const STRICT_TX = { allowUnknownInputs: false, allowUnknownOutputs: false } as const;

export interface DecodedAddress {
  address: string;
  type: ScriptType;
  script: Uint8Array;
}

export function decodeAddress(address: string, network: Network): DecodedAddress {
  let decoded: ReturnType<ReturnType<typeof btc.Address>['decode']>;
  try {
    decoded = btc.Address(btcNetwork(network)).decode(address);
  } catch {
    throw new SettlementError('validation_failed', `not a valid ${network} address: ${address}`);
  }
  const type = decoded.type;
  if (type !== 'tr' && type !== 'wpkh' && type !== 'wsh' && type !== 'pkh' && type !== 'sh')
    throw new SettlementError('validation_failed', `unsupported address type ${type}`);
  return { address, type, script: btc.OutScript.encode(decoded) };
}

export function isAddress(address: string, network: Network): boolean {
  try {
    decodeAddress(address, network);
    return true;
  } catch {
    return false;
  }
}

/** 33-byte compressed pubkey (hex) → 32-byte x-only internal key. */
export function xOnlyFromPublicKey(publicKeyHex: string): Uint8Array {
  const pk = hex.decode(publicKeyHex);
  if (pk.length === 33 && (pk[0] === 0x02 || pk[0] === 0x03)) return pk.subarray(1);
  if (pk.length === 32) return pk;
  throw new SettlementError('validation_failed', 'public key must be 33-byte compressed or 32-byte x-only');
}

export interface Owner {
  type: 'tr' | 'wpkh';
  script: Uint8Array;
  address: string;
  publicKey: Uint8Array;
  /** Untweaked x-only internal key (taproot only): what the PSBT's tap_internal_key must carry. */
  tapInternalKey?: Uint8Array;
}

/**
 * Prove that `address` is the key-path P2TR (no script tree) or the P2WPKH of `publicKeyHex`. This is
 * what UniSat and friends produce for taproot / native segwit accounts. Returns the untweaked internal
 * key for taproot (the legacy engine used the tweaked output key, which makes wallets tweak twice).
 */
export function paymentForOwner(address: string, publicKeyHex: string, network: Network): Owner {
  const { type, script } = decodeAddress(address, network);
  let pk: Uint8Array;
  try {
    pk = hex.decode(publicKeyHex);
  } catch {
    throw new SettlementError('validation_failed', 'public key is not hex');
  }
  if (type === 'tr') {
    const internal = xOnlyFromPublicKey(publicKeyHex);
    let p: { script: Uint8Array };
    try {
      p = btc.p2tr(internal, undefined, btcNetwork(network));
    } catch {
      throw new SettlementError('validation_failed', 'public key is not a valid curve point');
    }
    if (!equalBytes(p.script, script)) throw new SettlementError('validation_failed', 'public key does not derive the given taproot address (key-path spend expected)');
    return { type, script, address, publicKey: pk, tapInternalKey: internal };
  }
  if (type === 'wpkh') {
    if (pk.length !== 33) throw new SettlementError('validation_failed', 'a native segwit address requires a 33-byte compressed public key');
    let p: { script: Uint8Array };
    try {
      p = btc.p2wpkh(pk, btcNetwork(network));
    } catch {
      throw new SettlementError('validation_failed', 'public key is not a valid curve point');
    }
    if (!equalBytes(p.script, script)) throw new SettlementError('validation_failed', 'public key does not derive the given segwit address');
    return { type, script, address, publicKey: pk };
  }
  throw new SettlementError('validation_failed', `unsupported address type "${type}": use a taproot (bc1p) or native segwit (bc1q) account`);
}

/** Hex or base64 PSBT → bytes (hex is what UniSat returns, base64 what Xverse / Leather return). */
export function decodePsbt(s: string): Uint8Array {
  try {
    if (/^(?:[0-9a-fA-F]{2})+$/.test(s)) return hex.decode(s.toLowerCase());
    return base64.decode(s);
  } catch {
    throw new SettlementError('bad_psbt', 'PSBT is neither hex nor base64');
  }
}

export function parsePsbt(s: string | Uint8Array, opts: { allowUnknownInputs?: boolean; allowUnknownOutputs?: boolean } = STRICT_TX): btc.Transaction {
  const bytes = typeof s === 'string' ? decodePsbt(s) : s;
  try {
    return btc.Transaction.fromPSBT(bytes, opts);
  } catch (e) {
    throw new SettlementError('bad_psbt', `cannot parse PSBT: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export const encodePsbt = (tx: btc.Transaction) => {
  const bytes = tx.toPSBT();
  return { psbtHex: hex.encode(bytes), psbtBase64: base64.encode(bytes) };
};

export const outpointKey = (u: { txid: string; vout: number }) => `${u.txid}:${u.vout}`;

export function scriptAddress(script: Uint8Array, network: Network): string {
  try {
    return btc.Address(btcNetwork(network)).encode(btc.OutScript.decode(script));
  } catch {
    return hex.encode(script);
  }
}
