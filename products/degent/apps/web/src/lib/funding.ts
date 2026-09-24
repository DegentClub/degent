/**
 * Funding PSBT construction (browser side; ADR-0002 §2 step 3).
 *
 * The funding transaction spends the user's payment UTXOs to (plan §3.2, ADR-0007 §5):
 *   [0] the commit address (commit value = reveal fee + postage)
 *   [1] the artist's proven payout address (studio artworks only; omitted when 0)
 *   [2] the club / service fee address, when the fee is > 0
 *   [n] change back to the payment address, when above dust
 * An output is omitted only when its value is 0; a royalty below the dust limit of the payout
 * script type is raised to it (and `notes` says so). The expected outputs (script + value) are
 * recorded so the wallet-signed transaction can be checked output by output, not only by txid.
 *
 * Its txid is computed from the unsigned transaction. That is only possible when every input is
 * segwit (witnesses are excluded from txids); nested segwit (p2sh-p2wpkh) contributes a
 * deterministic scriptSig which we include. Legacy (p2pkh) payment addresses are refused.
 */
import * as btc from '@scure/btc-signer';
import { base64, hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import type { Network } from '@bsh/degent-mint-sdk';
import type { AddressType, Utxo, WalletAccount } from '../services/types';

export const DUST_CHANGE = 546;

/** Dust limit (sats) of an output paying this address, by script type (Bitcoin Core policy). */
export function dustLimit(address: string): number {
  switch (classifyAddress(address)) {
    case 'p2tr':
      return 330;
    case 'p2wpkh':
      return 294;
    case 'p2sh-p2wpkh':
      return 540;
    default:
      return 546;
  }
}
/** When payment and ordinals share an address (e.g. UniSat), UTXOs at or below this may carry inscriptions. */
export const INSCRIPTION_GUARD_SATS = 10_000;

export class LegacyAddressError extends Error {
  constructor(address: string) {
    super(
      `Your payment address ${address} is a legacy (1…/m…/n…) address. The mint needs a SegWit or Taproot ` +
        'payment address so the funding transaction id is known before you sign. Switch your wallet to a ' +
        'Native SegWit (bc1q…), Nested SegWit (3…) or Taproot (bc1p…) account and reconnect.',
    );
    this.name = 'LegacyAddressError';
  }
}

export class InsufficientFundsError extends Error {
  constructor(
    public readonly needed: number,
    public readonly available: number,
  ) {
    super(`Not enough spendable funds: need ${needed} sats (incl. network fee), have ${available} sats available.`);
    this.name = 'InsufficientFundsError';
  }
}

export function scureNetwork(network: Network): typeof btc.NETWORK {
  if (network === 'mainnet') return btc.NETWORK;
  if (network === 'regtest') return { ...btc.TEST_NETWORK, bech32: 'bcrt' };
  return btc.TEST_NETWORK;
}

/** Address type from its encoding alone (no checksum validation; the wallet already gave it to us). */
export function classifyAddress(address: string): AddressType {
  const a = address.toLowerCase();
  if (/^(bc|tb|bcrt)1p/.test(a)) return 'p2tr';
  if (/^(bc|tb|bcrt)1q/.test(a)) return a.replace(/^(bc|tb|bcrt)1/, '').length <= 42 ? 'p2wpkh' : 'unknown';
  if (/^[23]/.test(address)) return 'p2sh-p2wpkh';
  if (/^[1mn]/.test(address)) return 'p2pkh';
  return 'unknown';
}

export function isLegacy(account: WalletAccount): boolean {
  const t = account.addressType === 'unknown' ? classifyAddress(account.address) : account.addressType;
  return t === 'p2pkh';
}

const INPUT_VBYTES: Record<'p2tr' | 'p2wpkh' | 'p2sh-p2wpkh', number> = {
  p2tr: 57.5,
  p2wpkh: 68,
  'p2sh-p2wpkh': 91,
};

export function outputVbytes(address: string): number {
  switch (classifyAddress(address)) {
    case 'p2tr':
      return 43;
    case 'p2wpkh':
      return 31;
    case 'p2sh-p2wpkh':
      return 32;
    case 'p2pkh':
      return 34;
    default:
      return 43;
  }
}

export function spendableType(account: WalletAccount): 'p2tr' | 'p2wpkh' | 'p2sh-p2wpkh' {
  const t = account.addressType === 'unknown' ? classifyAddress(account.address) : account.addressType;
  if (t === 'p2tr' || t === 'p2wpkh' || t === 'p2sh-p2wpkh') return t;
  if (t === 'p2pkh') throw new LegacyAddressError(account.address);
  throw new Error(`Unsupported payment address type for ${account.address}.`);
}

export type FundingLabel = 'commit' | 'artist-royalty' | 'service-fee' | 'change';

export interface FundingOutput {
  address: string;
  value: number;
  label: FundingLabel;
}

export const FUNDING_LABELS: Record<FundingLabel, string> = {
  commit: 'Commit (reveal fee + postage)',
  'artist-royalty': 'Artist royalty',
  'service-fee': 'Club fee',
  change: 'Change back to you',
};

export interface CoinSelection {
  inputs: Utxo[];
  outputs: FundingOutput[];
  fee: number;
  vsize: number;
  excluded: Utxo[];
}

/**
 * Largest-first selection. Confirmed coins are preferred; tiny coins are skipped when the payment
 * address doubles as the ordinals address, so we never burn an inscription as fee.
 */
export function selectCoins(args: {
  utxos: Utxo[];
  inputType: 'p2tr' | 'p2wpkh' | 'p2sh-p2wpkh';
  targets: Array<{ address: string; value: number; label: Exclude<FundingLabel, 'change'> }>;
  changeAddress: string;
  feeRate: number;
  guardInscriptions: boolean;
}): CoinSelection {
  const excluded = args.guardInscriptions ? args.utxos.filter((u) => u.value <= INSCRIPTION_GUARD_SATS) : [];
  const pool = args.utxos
    .filter((u) => !excluded.includes(u))
    .sort((a, b) => Number(b.status.confirmed) - Number(a.status.confirmed) || b.value - a.value);
  const targetSum = args.targets.reduce((s, t) => s + t.value, 0);
  const baseVb = 10.5 + args.targets.reduce((s, t) => s + outputVbytes(t.address), 0);
  const perInput = INPUT_VBYTES[args.inputType];
  const changeVb = outputVbytes(args.changeAddress);

  const chosen: Utxo[] = [];
  let total = 0;
  for (const u of pool) {
    chosen.push(u);
    total += u.value;
    const vbNoChange = baseVb + perInput * chosen.length;
    const feeNoChange = Math.ceil(vbNoChange * args.feeRate);
    if (total < targetSum + feeNoChange) continue;
    const vbChange = vbNoChange + changeVb;
    const feeChange = Math.ceil(vbChange * args.feeRate);
    const change = total - targetSum - feeChange;
    const outputs: FundingOutput[] = args.targets.map((t) => ({ ...t }));
    if (change >= DUST_CHANGE) {
      outputs.push({ address: args.changeAddress, value: change, label: 'change' });
      return { inputs: chosen, outputs, fee: feeChange, vsize: Math.ceil(vbChange), excluded };
    }
    // Change would be dust: it goes to the miner.
    return { inputs: chosen, outputs, fee: total - targetSum, vsize: Math.ceil(vbNoChange), excluded };
  }
  const needed = targetSum + Math.ceil((baseVb + perInput * Math.max(1, pool.length)) * args.feeRate);
  throw new InsufficientFundsError(needed, total);
}

/** One output as it must appear in the signed transaction: scriptPubKey (hex) and value (sats). */
export interface ExpectedOutput {
  script: string;
  value: number;
  label: FundingLabel;
}

export interface FundingPsbt {
  psbtBase64: string;
  txid: string;
  commitVout: number;
  /** Index of the artist royalty output (1) when there is one. */
  royaltyVout: number | null;
  selection: CoinSelection;
  /** Scripts and values the wallet-signed transaction must reproduce exactly, in order. */
  outputs: ExpectedOutput[];
  /** Things the user should know (e.g. a royalty raised to the dust limit). */
  notes: string[];
  inputsToSign: Array<{ index: number; address: string }>;
}

function xOnly(pubHex: string): Uint8Array {
  const b = hex.decode(pubHex);
  if (b.length === 32) return b;
  if (b.length === 33) return b.slice(1);
  throw new Error('Taproot payment account is missing a valid public key.');
}

function dsha256(b: Uint8Array): Uint8Array {
  return sha256(sha256(b));
}

/** txid of the unsigned funding transaction, including deterministic nested-segwit scriptSigs. */
export function unsignedTxid(tx: btc.Transaction, scriptSigs: Array<Uint8Array | undefined>): string {
  const inputs = Array.from({ length: tx.inputsLength }, (_, i) => {
    const inp = tx.getInput(i);
    return {
      txid: inp.txid!,
      index: inp.index!,
      sequence: inp.sequence ?? btc.DEFAULT_SEQUENCE,
      finalScriptSig: scriptSigs[i] ?? new Uint8Array(),
    };
  });
  const outputs = Array.from({ length: tx.outputsLength }, (_, i) => {
    const o = tx.getOutput(i);
    return { amount: o.amount!, script: o.script! };
  });
  const raw = btc.RawTx.encode({
    version: tx.version,
    lockTime: tx.lockTime,
    inputs,
    outputs,
    witnesses: [],
    segwitFlag: false,
  });
  return hex.encode(dsha256(raw).reverse());
}

export function buildFundingPsbt(args: {
  network: Network;
  utxos: Utxo[];
  payment: WalletAccount;
  ordinalsAddress: string;
  commitAddress: string;
  commitValue: number;
  /** Output [1]: the artist's royalty (ADR-0007 §5). Omitted when null or 0. */
  artistRoyalty?: { address: string; value: number } | null;
  /** Output [2] (or [1] without a royalty): the club / service fee. Omitted when null or 0. */
  serviceFee: { address: string; value: number } | null;
  feeRate: number;
}): FundingPsbt {
  const net = scureNetwork(args.network);
  const inputType = spendableType(args.payment);
  const notes: string[] = [];
  const targets: Array<{ address: string; value: number; label: Exclude<FundingLabel, 'change'> }> = [
    { address: args.commitAddress, value: args.commitValue, label: 'commit' },
  ];
  if (args.artistRoyalty && args.artistRoyalty.value > 0) {
    const dust = dustLimit(args.artistRoyalty.address);
    let value = args.artistRoyalty.value;
    if (value < dust) {
      notes.push(`The artist royalty of ${value} sats is below the ${dust}-sat dust limit of the payout address and was raised to ${dust} sats.`);
      value = dust;
    }
    targets.push({ address: args.artistRoyalty.address, value, label: 'artist-royalty' });
  }
  if (args.serviceFee && args.serviceFee.value > 0) {
    targets.push({ address: args.serviceFee.address, value: args.serviceFee.value, label: 'service-fee' });
  }
  const selection = selectCoins({
    utxos: args.utxos,
    inputType,
    targets,
    changeAddress: args.payment.address,
    feeRate: args.feeRate,
    guardInscriptions: args.payment.address === args.ordinalsAddress,
  });

  const tx = new btc.Transaction({ allowUnknownOutputs: false });
  const payScript = btc.OutScript.encode(btc.Address(net).decode(args.payment.address));
  const scriptSigs: Array<Uint8Array | undefined> = [];
  for (const u of selection.inputs) {
    const base = { txid: u.txid, index: u.vout, witnessUtxo: { script: payScript, amount: BigInt(u.value) } };
    if (inputType === 'p2tr') {
      tx.addInput({ ...base, tapInternalKey: xOnly(args.payment.publicKey) });
      scriptSigs.push(undefined);
    } else if (inputType === 'p2sh-p2wpkh') {
      const redeemScript = btc.p2wpkh(hex.decode(args.payment.publicKey), net).script;
      tx.addInput({ ...base, redeemScript });
      scriptSigs.push(btc.Script.encode([redeemScript]));
    } else {
      tx.addInput(base);
      scriptSigs.push(undefined);
    }
  }
  for (const o of selection.outputs) tx.addOutputAddress(o.address, BigInt(o.value), net);
  const outputs: ExpectedOutput[] = selection.outputs.map((o, i) => ({
    script: hex.encode(tx.getOutput(i).script!),
    value: o.value,
    label: o.label,
  }));
  const royaltyIndex = selection.outputs.findIndex((o) => o.label === 'artist-royalty');

  return {
    psbtBase64: base64.encode(tx.toPSBT()),
    txid: unsignedTxid(tx, scriptSigs),
    commitVout: 0,
    royaltyVout: royaltyIndex >= 0 ? royaltyIndex : null,
    selection,
    outputs,
    notes,
    inputsToSign: selection.inputs.map((_, index) => ({ index, address: args.payment.address })),
  };
}

export interface SignedOutput {
  script: string;
  value: number;
}

/** Finalize (if needed) a wallet-signed funding PSBT and return the raw tx, its txid and its outputs. */
export function extractSignedTx(psbtBase64: string): { hex: string; txid: string; outputs: SignedOutput[] } {
  const tx = btc.Transaction.fromPSBT(base64.decode(psbtBase64));
  if (!tx.isFinal) tx.finalize();
  const outputs: SignedOutput[] = Array.from({ length: tx.outputsLength }, (_, i) => {
    const o = tx.getOutput(i);
    return { script: hex.encode(o.script!), value: Number(o.amount!) };
  });
  return { hex: hex.encode(tx.extract()), txid: tx.id, outputs };
}

/**
 * Compare the outputs of the signed transaction with the ones the PSBT was built with, script
 * by script and value by value. Returns a description of the first difference, or null.
 */
export function compareOutputs(expected: ExpectedOutput[], actual: SignedOutput[]): string | null {
  if (actual.length !== expected.length) return `expected ${expected.length} outputs, the signed transaction has ${actual.length}`;
  for (let i = 0; i < expected.length; i++) {
    const e = expected[i]!;
    const a = actual[i]!;
    if (a.script !== e.script) return `output ${i} (${FUNDING_LABELS[e.label]}) pays a different script`;
    if (a.value !== e.value) return `output ${i} (${FUNDING_LABELS[e.label]}) value changed from ${e.value} to ${a.value} sats`;
  }
  return null;
}
