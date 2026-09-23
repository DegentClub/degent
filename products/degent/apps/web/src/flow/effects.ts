/**
 * Side-effecting sequences of the mint, written against the service ports so their ORDER can be
 * asserted in tests. The money path is:
 *
 *   openOrder:        K_e generated → POST /orders (pubkey only) → PUT content → wait for review
 *   verifyCommit:     recompute commit address locally; must equal the service's quote
 *   preparePayment:   UTXOs → funding PSBT + txid → half-signed reveal → POST reveal
 *                     → save recovery bundle → discard K_e
 *   signAndBroadcast: wallet signs funding PSBT → txid re-checked → broadcast
 *
 * Nothing asks the wallet to sign before the reveal is stored server-side AND the recovery bundle
 * is saved locally, so funds can never be sent to a commit address nobody can spend from.
 */
import type { CollectionConfig, Network, Order, Tier } from '@bsh/degent-mint-sdk';
import type { Services, WalletSession, RescueTx } from '../services/types';
import type { AppConfig } from '../config';
import type { Artwork } from './state';
import type { KeyVault } from './keyVault';
import { buildFundingPsbt, extractSignedTx, type FundingPsbt } from '../lib/funding';
import { RECOVERY_NOTE, RECOVERY_WARNING, saveRecovery, type KeyValueStore, type RecoveryBundle } from '../lib/recovery';

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

export async function openOrder(
  deps: { services: Services; vault: KeyVault; sleep?: Sleep; pollMs?: number; maxPolls?: number },
  args: { tier: Tier; artwork: Artwork; wallet: WalletSession; feeRate: number },
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
  });
  if (!created.orderToken) throw new MissingTokenError();
  let order = created.order;
  deps.vault.put(order.id, key.privkey);
  deps.vault.putToken(order.id, created.orderToken);
  order = await mintApi.uploadContent(order.id, requireToken(deps.vault, order.id), args.artwork.bytes);
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
  args: { order: Order; artwork: Artwork; config: CollectionConfig; network: Network },
): { localAddress: string; match: boolean } {
  if (!args.order.quote) throw new Error('No quote on this order yet.');
  if (args.artwork.sha256 !== args.order.contentSha256) {
    return { localAddress: '(content hash differs from order)', match: false };
  }
  const content = {
    contentType: args.artwork.contentType,
    body: args.artwork.bytes,
    ...(args.config.parentInscriptionId ? { parentId: args.config.parentInscriptionId } : {}),
  };
  const localAddress = services.inscription.commitAddress(args.order.revealPubkey, content, args.network);
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
    config: CollectionConfig;
    onPhase?: (p: PreparePhase) => void;
  },
): Promise<{ funding: FundingPsbt; bundle: RecoveryBundle; order: Order; savedLocally: boolean }> {
  const { order, wallet } = args;
  const quote = order.quote;
  if (!quote || !quote.binding || !quote.commitAddress) throw new Error('No binding quote on this order.');
  const commitAddress = quote.commitAddress;
  const privkey = deps.vault.get(order.id);
  if (!privkey) throw new MissingKeyError();
  const orderToken = requireToken(deps.vault, order.id);
  const { chain, inscription, mintApi } = deps.services;

  args.onPhase?.('fetching-utxos');
  const utxos = await chain.getUtxos(wallet.payment.address);

  args.onPhase?.('building');
  if (quote.serviceFeeSats > 0 && !order.serviceFeeAddress) {
    throw new Error('The service quoted a fee but gave no fee address. Refusing to build the payment.');
  }
  const funding = buildFundingPsbt({
    network: deps.app.network,
    utxos,
    payment: wallet.payment,
    ordinalsAddress: wallet.ordinals.address,
    commitAddress,
    commitValue: quote.commitValueSats,
    serviceFee:
      quote.serviceFeeSats > 0 && order.serviceFeeAddress
        ? { address: order.serviceFeeAddress, value: quote.serviceFeeSats }
        : null,
    feeRate: quote.feeRate,
  });
  const reveal = inscription.buildHalfSignedReveal({
    network: deps.app.network,
    revealPrivkey: privkey,
    content: {
      contentType: args.artwork.contentType,
      body: args.artwork.bytes,
      ...(args.config.parentInscriptionId ? { parentId: args.config.parentInscriptionId } : {}),
    },
    commitOutpoint: { txid: funding.txid, vout: funding.commitVout },
    commitValue: BigInt(quote.commitValueSats),
    recipientAddress: order.recipientAddress,
    postage: BigInt(quote.postageSats),
  });

  args.onPhase?.('submitting-reveal');
  const updated = await mintApi.submitReveal(order.id, orderToken, {
    commitTxid: funding.txid,
    commitVout: funding.commitVout,
    halfSignedRevealPsbt: reveal.psbtBase64,
    commitAddress,
  });

  const bundle: RecoveryBundle = {
    kind: 'degent.club/recovery',
    version: 1,
    orderId: order.id,
    network: deps.app.network,
    mintApiUrl: deps.app.mintApiUrl,
    savedAt: new Date().toISOString(),
    commitTxid: funding.txid,
    commitVout: funding.commitVout,
    commitValueSats: quote.commitValueSats,
    recipientAddress: order.recipientAddress,
    contentType: order.contentType,
    contentSha256: order.contentSha256,
    halfSignedRevealPsbt: reveal.psbtBase64,
    orderToken,
    note: RECOVERY_NOTE,
    warning: RECOVERY_WARNING,
  };
  const savedLocally = saveRecovery(bundle, deps.store);
  // The reveal is signed and stored in two places; K_e has no further purpose.
  deps.vault.discard(order.id);
  args.onPhase?.('recovery-saved');
  return { funding, bundle, order: updated, savedLocally };
}

export class FundingTxidMismatchError extends Error {
  constructor(expected: string, got: string) {
    super(
      `Your wallet changed the funding transaction (expected txid ${expected}, got ${got}). ` +
        'It was NOT broadcast: the pre-signed reveal only spends the original transaction. Try again ' +
        'without editing the transaction in your wallet.',
    );
    this.name = 'FundingTxidMismatchError';
  }
}

/**
 * Ask the wallet to sign (not broadcast) the funding PSBT, check that the signed transaction is the
 * one the reveal was signed against, then broadcast it (wallet relay if offered, else esplora).
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
  const { hex, txid } = extractSignedTx(signed.psbtBase64);
  if (txid !== args.funding.txid) throw new FundingTxidMismatchError(args.funding.txid, txid);
  args.onPhase?.('broadcasting');
  const pushed = args.wallet.pushTx ? await args.wallet.pushTx(hex) : await deps.services.chain.broadcast(hex);
  return pushed || txid;
}

/**
 * Self-rescue (ADR-0002 §2): prefer the service's rescue transaction; if the service is gone, build
 * it locally from the recovery bundle. Broadcast via the wallet if it can relay, else esplora.
 */
export async function rescue(
  deps: { services: Services },
  args: {
    orderId: string;
    orderToken: string | null;
    bundle: RecoveryBundle | null;
    wallet: WalletSession | null;
    network: Network;
  },
): Promise<{ txid: string; source: 'service' | 'local' }> {
  let tx: RescueTx;
  let source: 'service' | 'local' = 'service';
  const token = args.orderToken ?? args.bundle?.orderToken ?? null;
  try {
    if (!token) throw new MissingTokenError();
    tx = await deps.services.mintApi.getRescue(args.orderId, token);
  } catch (e) {
    // The half-signed reveal alone is enough to rescue; the token is only needed for the service path.
    if (!args.bundle) throw e;
    tx = deps.services.inscription.buildRescueReveal({
      network: args.network,
      halfSignedPsbtBase64: args.bundle.halfSignedRevealPsbt,
    });
    source = 'local';
  }
  const txid = args.wallet?.pushTx ? await args.wallet.pushTx(tx.hex) : await deps.services.chain.broadcast(tx.hex);
  return { txid: txid || tx.txid, source };
}
