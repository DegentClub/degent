/**
 * Side-effecting sequences of the mint, written against the service ports so their ORDER can be
 * asserted in tests. The money path is:
 *
 *   openOrder:        K_e generated → POST /orders (pubkey only) → PUT content → wait for review
 *   verifyCommit:     recompute commit address locally; must equal the service's quote
 *   preparePayment:   UTXOs → funding PSBT + txid → half-signed reveal (0x81, parent return signed
 *                     up front) → POST reveal → save recovery bundle (WITH K_e) → discard K_e from memory
 *   signAndBroadcast: wallet signs funding PSBT → txid re-checked → broadcast
 *   rescue:           GET /rescue inputs (or the bundle alone) → re-sign [commit] → [child] with K_e
 *                     from the bundle → broadcast
 *
 * Nothing asks the wallet to sign before the reveal is stored server-side AND the recovery bundle
 * is saved locally, so funds can never be sent to a commit address nobody can spend from.
 */
import type { Network, Order, RescueInputs, ServiceConfig, Tier } from '@bsh/degent-mint-sdk';
import { laneForWeight, type Lane } from '@bsh/degent-mint-sdk';
import { hex } from '@scure/base';
import type { Services, WalletSession, RescueTx, InscriptionContentInput } from '../services/types';
import { artworkQuote, orderEdition } from '../services/types';
import type { AppConfig } from '../config';
import type { Artwork } from './state';
import type { KeyVault } from './keyVault';
import { buildFundingPsbt, compareOutputs, extractSignedTx, type FundingPsbt } from '../lib/funding';
import {
  base64ToBytes,
  bytesToBase64,
  RECOVERY_NOTE,
  RECOVERY_WARNING,
  saveRecovery,
  type KeyValueStore,
  type RecoveryBundle,
} from '../lib/recovery';

export class MissingTokenError extends Error {
  constructor() {
    super(
      'This order’s access token is not available in this browser, so the mint service will not accept ' +
        'changes to it. If you paid, use the recovery bundle you saved (it contains the token). If you have ' +
        'not paid yet, start a fresh order: nothing has been spent.',
    );
    this.name = 'MissingTokenError';
  }
}

function requireToken(vault: KeyVault, orderId: string): string {
  const t = vault.token(orderId);
  if (!t) throw new MissingTokenError();
  return t;
}

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function envelopeContent(artwork: Pick<Artwork, 'contentType' | 'bytes'>, parentInscriptionId: string | null): InscriptionContentInput {
  return {
    contentType: artwork.contentType,
    body: artwork.bytes,
    ...(parentInscriptionId ? { parentId: parentInscriptionId } : {}),
  };
}

/**
 * Exact lane the reveal of this artwork will travel (ADR-0005 §3): decided by weight, not by tier.
 * A Standard Degent of ~397-400 KB comes back as 'block'.
 */
export function laneForArtwork(
  services: Services,
  args: { artwork: Pick<Artwork, 'contentType' | 'bytes'>; recipientAddress: string; config: Pick<ServiceConfig, 'parentInscriptionId'>; network: Network },
): { weight: number; lane: Lane | null } {
  const weight = services.inscription.revealWeight(envelopeContent(args.artwork, args.config.parentInscriptionId), args.recipientAddress, args.network);
  return { weight, lane: laneForWeight(weight) };
}

export async function openOrder(
  deps: { services: Services; vault: KeyVault; sleep?: Sleep; pollMs?: number; maxPolls?: number },
  args: {
    tier: Tier;
    artwork: Artwork;
    wallet: WalletSession;
    feeRate: number;
    /** Studio artwork being minted (ADR-0007): sent on the order; the service may skip the upload. */
    artworkId?: string | null;
  },
): Promise<Order> {
  const { mintApi, inscription } = deps.services;
  const key = inscription.generateEphemeralKey();
  const created = await mintApi.createOrder({
    tier: args.tier,
    contentType: args.artwork.contentType,
    contentLength: args.artwork.size,
    contentSha256: args.artwork.sha256,
    recipientAddress: args.wallet.ordinals.address,
    revealPubkey: key.pubkeyHex,
    feeRate: args.feeRate,
    ...(args.artworkId ? { artworkId: args.artworkId } : {}),
  });
  if (!created.orderToken) throw new MissingTokenError();
  let order = created.order;
  deps.vault.put(order.id, key.privkey);
  deps.vault.putToken(order.id, created.orderToken);
  // A studio artwork was reviewed at submission: the service may already hold the bytes and answer
  // `approved` with a binding quote (plan §3.1). Otherwise the exact bytes go up as for any Degent.
  const preReviewed = !!args.artworkId && order.status !== 'awaiting_content' && !!order.quote?.binding;
  if (!preReviewed) order = await mintApi.uploadContent(order.id, requireToken(deps.vault, order.id), args.artwork.bytes);
  const sleep = deps.sleep ?? realSleep;
  const maxPolls = deps.maxPolls ?? 60;
  for (let i = 0; i < maxPolls && (order.status === 'awaiting_content' || order.status === 'reviewing'); i++) {
    await sleep(deps.pollMs ?? 1000);
    order = await mintApi.getOrder(order.id);
  }
  if (order.status === 'rejected') deps.vault.discard(order.id);
  return order;
}

export function verifyCommit(
  services: Services,
  args: { order: Order; artwork: Artwork; config: Pick<ServiceConfig, 'parentInscriptionId'>; network: Network },
): { localAddress: string; match: boolean } {
  if (!args.order.quote) throw new Error('No quote on this order yet.');
  if (args.artwork.sha256 !== args.order.contentSha256) {
    return { localAddress: '(content hash differs from order)', match: false };
  }
  const localAddress = services.inscription.commitAddress(
    args.order.revealPubkey,
    envelopeContent(args.artwork, args.config.parentInscriptionId),
    args.network,
  );
  // An indicative quote (no commit address yet) can never be "verified".
  const serviceAddress = args.order.quote.binding ? args.order.quote.commitAddress : null;
  return { localAddress, match: serviceAddress !== null && localAddress === serviceAddress };
}

export class MissingKeyError extends Error {
  constructor() {
    super(
      'The one-time reveal key for this order is no longer in memory (the page was reloaded or the order ' +
        'was reopened). Nothing has been paid. Request a fresh quote to continue.',
    );
    this.name = 'MissingKeyError';
  }
}

export type PreparePhase = 'fetching-utxos' | 'building' | 'submitting-reveal' | 'recovery-saved';

export async function preparePayment(
  deps: { services: Services; vault: KeyVault; app: AppConfig; store: KeyValueStore | null },
  args: {
    order: Order;
    artwork: Artwork;
    wallet: WalletSession;
    config: ServiceConfig;
    onPhase?: (p: PreparePhase) => void;
  },
): Promise<{ funding: FundingPsbt; bundle: RecoveryBundle; order: Order; savedLocally: boolean }> {
  const { order, wallet, config } = args;
  const quote = order.quote;
  if (!quote || !quote.binding || !quote.commitAddress) throw new Error('No binding quote on this order.');
  const commitAddress = quote.commitAddress;
  const privkey = deps.vault.get(order.id);
  if (!privkey) throw new MissingKeyError();
  const orderToken = requireToken(deps.vault, order.id);
  if (!config.collectionAddress || !Number.isSafeInteger(config.parentValueSats) || config.parentValueSats <= 0) {
    throw new Error('The service config has no collection address / parent value: the reveal cannot be signed.');
  }
  const { chain, inscription, mintApi } = deps.services;

  args.onPhase?.('fetching-utxos');
  const utxos = await chain.getUtxos(wallet.payment.address);

  args.onPhase?.('building');
  // Studio artwork (ADR-0007 §5): output [1] pays the artist, output [2] the club; the reveal is untouched.
  const aq = artworkQuote(quote);
  const clubFee = aq ? aq.clubFeeSats : quote.serviceFeeSats;
  if (clubFee > 0 && !order.serviceFeeAddress) {
    throw new Error('The service quoted a fee but gave no fee address. Refusing to build the payment.');
  }
  if (aq && aq.artistRoyaltySats > 0 && !aq.artistAddress) {
    throw new Error('The service quoted an artist royalty but gave no artist payout address. Refusing to build the payment.');
  }
  const funding = buildFundingPsbt({
    network: deps.app.network,
    utxos,
    payment: wallet.payment,
    ordinalsAddress: wallet.ordinals.address,
    commitAddress,
    commitValue: quote.commitValueSats,
    artistRoyalty: aq && aq.artistRoyaltySats > 0 && aq.artistAddress ? { address: aq.artistAddress, value: aq.artistRoyaltySats } : null,
    serviceFee: clubFee > 0 && order.serviceFeeAddress ? { address: order.serviceFeeAddress, value: clubFee } : null,
    feeRate: quote.feeRate,
  });
  // ADR-0005 §1: SIGHASH_ALL|ANYONECANPAY over [parent return, child]. Output 0 is signed up front to
  // the collection address with the parent's constant value, so nobody holding the PSBT can add,
  // swap or resize an output.
  const reveal = inscription.buildHalfSignedReveal({
    network: deps.app.network,
    revealPrivkey: privkey,
    content: envelopeContent(args.artwork, config.parentInscriptionId),
    commitOutpoint: { txid: funding.txid, vout: funding.commitVout },
    commitValue: BigInt(quote.commitValueSats),
    recipientAddress: order.recipientAddress,
    postage: BigInt(quote.postageSats),
    parentReturnAddress: config.collectionAddress,
    parentValue: BigInt(config.parentValueSats),
  });

  args.onPhase?.('submitting-reveal');
  const updated = await mintApi.submitReveal(order.id, orderToken, {
    commitTxid: funding.txid,
    commitVout: funding.commitVout,
    halfSignedRevealPsbt: reveal.psbtBase64,
    commitAddress,
  });

  // ADR-0005 §2: the user keeps K_e. It only ever controls the commit output funded below.
  const bundle: RecoveryBundle = {
    kind: 'degent.club/recovery',
    version: 2,
    orderId: order.id,
    network: deps.app.network,
    mintApiUrl: deps.app.mintApiUrl,
    savedAt: new Date().toISOString(),
    commitTxid: funding.txid,
    commitVout: funding.commitVout,
    commitValueSats: quote.commitValueSats,
    recipientAddress: order.recipientAddress,
    postageSats: quote.postageSats,
    contentType: order.contentType,
    contentSha256: order.contentSha256,
    contentBase64: bytesToBase64(args.artwork.bytes),
    parentInscriptionId: config.parentInscriptionId,
    collectionAddress: config.collectionAddress,
    parentValueSats: config.parentValueSats,
    revealPrivkey: hex.encode(privkey),
    revealPubkey: order.revealPubkey,
    orderToken,
    ...(aq?.artworkId ? { artworkId: aq.artworkId } : {}),
    ...(orderEdition(order) !== null ? { edition: orderEdition(order)! } : {}),
    note: RECOVERY_NOTE,
    warning: RECOVERY_WARNING,
  };
  const savedLocally = saveRecovery(bundle, deps.store);
  // The reveal is signed and stored; K_e now lives in the bundle only, not in this tab's memory.
  deps.vault.discard(order.id);
  args.onPhase?.('recovery-saved');
  return { funding, bundle, order: updated, savedLocally };
}

export class FundingTxidMismatchError extends Error {
  constructor(expected: string, got: string, detail?: string) {
    super(
      `Your wallet changed the funding transaction (${detail ?? `expected txid ${expected}, got ${got}`}). ` +
        'It was NOT broadcast: the pre-signed reveal only spends the original transaction' +
        (detail ? ', and every output (commit, artist royalty, club fee, change) must stay exactly as quoted' : '') +
        '. Try again without editing the transaction in your wallet.',
    );
    this.name = 'FundingTxidMismatchError';
  }
}

/** The signed transaction's outputs differ from the PSBT's (script or value), not only its txid. */
export class FundingOutputsMismatchError extends FundingTxidMismatchError {
  constructor(expected: string, got: string, detail: string) {
    super(expected, got, detail);
    this.name = 'FundingOutputsMismatchError';
  }
}

/**
 * Check a wallet-signed funding transaction against the PSBT it was asked to sign: every output's
 * script and value (plan §3.2), then the txid the reveal was signed against.
 */
export function checkSignedFunding(funding: FundingPsbt, signed: { txid: string; outputs: Array<{ script: string; value: number }> }): void {
  const diff = compareOutputs(funding.outputs, signed.outputs);
  if (diff) throw new FundingOutputsMismatchError(funding.txid, signed.txid, diff);
  if (signed.txid !== funding.txid) throw new FundingTxidMismatchError(funding.txid, signed.txid);
}

/**
 * Ask the wallet to sign (not broadcast) the funding PSBT, check that the signed transaction is the
 * one the reveal was signed against (outputs and txid), then broadcast it (wallet relay if offered,
 * else esplora).
 */
export async function signAndBroadcast(
  deps: { services: Services },
  args: { wallet: WalletSession; funding: FundingPsbt; onPhase?: (p: 'awaiting-wallet' | 'broadcasting') => void },
): Promise<string> {
  args.onPhase?.('awaiting-wallet');
  const signed = await args.wallet.signPsbt(args.funding.psbtBase64, {
    inputsToSign: args.funding.inputsToSign,
    finalize: true,
    broadcast: false,
  });
  const extracted = extractSignedTx(signed.psbtBase64);
  checkSignedFunding(args.funding, extracted);
  const { hex: rawHex, txid } = extracted;
  args.onPhase?.('broadcasting');
  const pushed = args.wallet.pushTx ? await args.wallet.pushTx(rawHex) : await deps.services.chain.broadcast(rawHex);
  return pushed || txid;
}

export class MissingBundleError extends Error {
  constructor() {
    super(
      'Self-rescue needs your recovery bundle: it holds the one-time reveal key that can spend your commit ' +
        'output. Paste the bundle you saved when you paid. Without it nobody, including the mint, can move those sats.',
    );
    this.name = 'MissingBundleError';
  }
}

export class RescueInputsMismatchError extends Error {
  constructor(field: string) {
    super(`The mint’s rescue inputs disagree with your recovery bundle (${field}). Refusing to sign; check the bundle.`);
    this.name = 'RescueInputsMismatchError';
  }
}

/**
 * Self-rescue (ADR-0005 §2). The service returns INPUTS (it holds nothing broadcastable without the
 * parent); the transaction is built and signed HERE with K_e from the recovery bundle, so the rescue
 * works with or without the service. When both are available they must agree.
 */
export async function rescue(
  deps: { services: Services },
  args: {
    orderId: string;
    orderToken: string | null;
    bundle: RecoveryBundle | null;
    wallet: WalletSession | null;
    network: Network;
    /** Local bytes, if still in memory; otherwise the bundle's copy is used. */
    artwork?: Pick<Artwork, 'bytes' | 'sha256'> | null;
  },
): Promise<{ txid: string; source: 'service' | 'local'; tx: RescueTx }> {
  const { bundle } = args;
  if (!bundle) throw new MissingBundleError();
  const token = args.orderToken ?? bundle.orderToken ?? null;
  let inputs: RescueInputs | null = null;
  try {
    if (!token) throw new MissingTokenError();
    inputs = await deps.services.mintApi.getRescue(args.orderId, token);
  } catch (e) {
    // Service gone: the bundle alone is enough. A 409 (not rescue_available) is a real answer though.
    const msg = e instanceof Error ? e.message : String(e);
    if (/409|rescue_unavailable/.test(msg)) throw e;
    inputs = null;
  }
  if (inputs) {
    const check: Array<[string, unknown, unknown]> = [
      ['commitTxid', inputs.commitTxid, bundle.commitTxid],
      ['commitVout', inputs.commitVout, bundle.commitVout],
      ['commitValueSats', inputs.commitValueSats, bundle.commitValueSats],
      ['contentSha256', inputs.contentSha256, bundle.contentSha256],
      ['recipientAddress', inputs.recipientAddress, bundle.recipientAddress],
      ['postageSats', inputs.postageSats, bundle.postageSats],
      ['revealPubkey', inputs.revealPubkey, bundle.revealPubkey],
    ];
    for (const [field, a, b] of check) if (a !== b) throw new RescueInputsMismatchError(field);
  }
  const bytes = args.artwork && args.artwork.sha256 === bundle.contentSha256 ? args.artwork.bytes : base64ToBytes(bundle.contentBase64);
  if (deps.services.inscription.sha256Hex(bytes) !== bundle.contentSha256) throw new RescueInputsMismatchError('content bytes');
  const tx = deps.services.inscription.buildResignedRescue({
    network: args.network,
    revealPrivkey: hex.decode(bundle.revealPrivkey),
    content: envelopeContent({ contentType: bundle.contentType, bytes }, bundle.parentInscriptionId),
    commitOutpoint: { txid: bundle.commitTxid, vout: bundle.commitVout },
    commitValue: BigInt(bundle.commitValueSats),
    recipientAddress: bundle.recipientAddress,
    postage: BigInt(bundle.postageSats),
  });
  const txid = args.wallet?.pushTx ? await args.wallet.pushTx(tx.hex) : await deps.services.chain.broadcast(tx.hex);
  return { txid: txid || tx.txid, source: inputs ? 'service' : 'local', tx };
}
