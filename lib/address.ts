/**
 * Bitcoin address validation (mainnet only).
 *
 * Every decode path verifies a checksum:
 *  - bech32 (BIP 173) for segwit v0 (bc1q...)
 *  - bech32m (BIP 350) for segwit v1+ (bc1p... taproot)
 *  - base58check (double SHA-256) for legacy P2PKH (1...) and P2SH (3...)
 *
 * There is intentionally no "looks like an address" regex shortcut: a typo in
 * a recipient address must be rejected, not forwarded to the inscription API.
 */
import { bech32, bech32m, createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';

export type AddressKind = 'p2pkh' | 'p2sh' | 'p2wpkh' | 'p2wsh' | 'p2tr' | 'unknown-segwit';

export interface DecodedAddress {
  network: 'mainnet';
  kind: AddressKind;
  /** Only present for segwit addresses. */
  witnessVersion?: number;
}

const base58check = createBase58check(sha256);

const MAINNET_HRP = 'bc';
/** Human-readable parts we explicitly recognise so we can name the network in errors. */
const NON_MAINNET_HRPS = new Set(['tb', 'bcrt']);

export class AddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AddressError';
  }
}

function decodeSegwit(address: string): DecodedAddress {
  const lower = address.toLowerCase();
  const sepIndex = lower.lastIndexOf('1');
  if (sepIndex < 1) throw new AddressError('Malformed bech32 address');
  const hrp = lower.slice(0, sepIndex);

  if (hrp !== MAINNET_HRP) {
    if (NON_MAINNET_HRPS.has(hrp)) {
      throw new AddressError('This is a testnet/signet/regtest address. A mainnet (bc1...) address is required.');
    }
    throw new AddressError('Unknown address prefix');
  }

  // The witness version char determines which checksum variant is valid.
  const versionChar = lower[sepIndex + 1];
  const isV0 = versionChar === 'q';
  const codec = isV0 ? bech32 : bech32m;

  let decoded: { prefix: string; words: number[] };
  try {
    decoded = codec.decode(lower, 90);
  } catch {
    throw new AddressError('Invalid address checksum');
  }

  const [version, ...dataWords] = decoded.words;
  if (version === undefined || version > 16) throw new AddressError('Invalid witness version');
  if (isV0 !== (version === 0)) throw new AddressError('Invalid address checksum');

  let program: Uint8Array;
  try {
    program = codec.fromWords(dataWords);
  } catch {
    throw new AddressError('Invalid witness program');
  }
  if (program.length < 2 || program.length > 40) throw new AddressError('Invalid witness program length');

  if (version === 0) {
    if (program.length === 20) return { network: 'mainnet', kind: 'p2wpkh', witnessVersion: 0 };
    if (program.length === 32) return { network: 'mainnet', kind: 'p2wsh', witnessVersion: 0 };
    throw new AddressError('Invalid segwit v0 program length');
  }
  if (version === 1 && program.length === 32) {
    return { network: 'mainnet', kind: 'p2tr', witnessVersion: 1 };
  }
  return { network: 'mainnet', kind: 'unknown-segwit', witnessVersion: version };
}

function decodeLegacy(address: string): DecodedAddress {
  let payload: Uint8Array;
  try {
    payload = base58check.decode(address);
  } catch {
    throw new AddressError('Invalid address checksum');
  }
  if (payload.length !== 21) throw new AddressError('Invalid legacy address length');
  const versionByte = payload[0];
  if (versionByte === 0x00) return { network: 'mainnet', kind: 'p2pkh' };
  if (versionByte === 0x05) return { network: 'mainnet', kind: 'p2sh' };
  if (versionByte === 0x6f || versionByte === 0xc4) {
    throw new AddressError('This is a testnet address. A mainnet address is required.');
  }
  throw new AddressError('Unknown legacy address version');
}

/**
 * Decode and validate a Bitcoin mainnet address. Throws AddressError with a
 * user-presentable message on any failure (wrong network, bad checksum, etc.).
 */
export function decodeMainnetAddress(input: string): DecodedAddress {
  if (typeof input !== 'string') throw new AddressError('Address must be a string');
  const address = input.trim();
  if (address.length < 14 || address.length > 90) throw new AddressError('Invalid address length');

  // bech32 must be entirely one case; mixed case is invalid per BIP 173.
  const hasUpper = /[A-Z]/.test(address);
  const hasLower = /[a-z]/.test(address);
  const looksBech32 = /^(bc|tb|bcrt)1/i.test(address);

  if (looksBech32) {
    if (hasUpper && hasLower) throw new AddressError('Mixed-case bech32 address is invalid');
    return decodeSegwit(address);
  }
  if (/^[123mn]/.test(address)) return decodeLegacy(address);
  throw new AddressError('Unrecognised address format');
}

/** True when the string is a valid Bitcoin mainnet address of any type. */
export function validateMainnetAddress(input: string): boolean {
  try {
    decodeMainnetAddress(input);
    return true;
  } catch {
    return false;
  }
}

/** True only for a valid mainnet P2TR (bc1p...) address. */
export function isTaproot(input: string): boolean {
  try {
    return decodeMainnetAddress(input).kind === 'p2tr';
  } catch {
    return false;
  }
}

/**
 * Returns null when the address is a valid mainnet taproot address, otherwise a
 * human-readable reason. Used by both the client form and the API route.
 */
export function explainTaprootRequirement(input: string): string | null {
  try {
    const decoded = decodeMainnetAddress(input);
    if (decoded.kind === 'p2tr') return null;
    return 'Inscriptions must be delivered to a taproot (bc1p...) address.';
  } catch (err) {
    return err instanceof AddressError ? err.message : 'Invalid address';
  }
}
