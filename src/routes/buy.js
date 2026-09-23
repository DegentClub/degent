// Purchase flow. Server builds, client signs, server verifies + broadcasts.
// Every route here is behind BUYS_ENABLED.
import crypto from 'node:crypto';
import { parseBody } from '../validation.js';
import { LISTING_STATUS as S } from '../db.js';
import { checkListingValidity, ListingInvalid } from '../indexer.js';
import {
  buildBuyerPsbt, buildDummySplitPsbt, assembleBuyerSignedPsbt, presetsFromMempool,
  computeOrdinalDestination, INSCRIPTION_INPUT_INDEX, INSCRIPTION_OUTPUT_INDEX, BuildError,
} from '../psbt/index.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function buyRoutes(router, ctx) {
  const { stmts, schemas, config, collectionMap, mempool, indexer, network, logger } = ctx;

  router.get('/fees', wrap(async (_req, res) => {
    const rec = await mempool.getFeePresets();
    res.json(presetsFromMempool(rec));
  }));

  const paused = (_req, res, next) => {
    if (!config.buysEnabled) {
      return res.status(503).json({
        error: 'Buying is paused while the settlement engine is rebuilt and verified on signet.',
        code: 'BUYS_PAUSED',
      });
    }
    next();
  };
  router.use('/buy', paused);

  /**
   * Classify the buyer's UTXOs. Anything the wallet flagged as inscribed, and
   * (when the indexer covers this network) anything the indexer says carries an
   * inscription, is never spent as payment or dummy.
   */
  async function safeUtxos(address, excludeOutpoints) {
    const all = await mempool.getAddressUtxos(address);
    const excluded = new Set(excludeOutpoints);
    const out = [];
    for (const u of all) {
      if (!u.confirmed) continue;
      const key = `${u.txid}:${u.vout}`;
      if (excluded.has(key)) continue;
      if (config.utxoSafetyCheck) {
        const ids = await indexer.getOutpointInscriptions(key);
        if (ids.length) continue;
      }
      out.push(u);
    }
    return out;
  }

  function pickDummies(utxos) {
    const small = utxos
      .filter((u) => u.value >= config.dummyValueSats && u.value <= 1000)
      .sort((a, b) => a.value - b.value);
    return small.slice(0, 2);
  }

  router.post('/buy/prepare', wrap(async (req, res) => {
    const body = parseBody(schemas.buyPrepare, req.body);
    if (!collectionMap.has(body.inscriptionId)) return res.status(403).json({ error: 'Not a Degent' });
    const row = stmts.getListing.get(body.inscriptionId);
    if (!row || row.status !== S.ACTIVE) return res.status(409).json({ error: 'Listing is not active', code: 'NOT_ACTIVE' });
    if (row.seller_address === body.buyerAddress) return res.status(400).json({ error: 'You cannot buy your own listing' });
    if (new Date(row.expires_at).getTime() < Date.now()) return res.status(409).json({ error: 'Listing expired', code: 'EXPIRED' });

    // Re-validate the seller side right before building.
    await checkListingValidity({ indexer, mempool, inscriptionId: row.id, location: row.location, address: row.seller_address });

    const presets = presetsFromMempool(await mempool.getFeePresets());
    const feeRate = presets[body.feeTier];
    const utxos = await safeUtxos(body.buyerAddress, body.excludeOutpoints);
    const dummies = pickDummies(utxos);
    const dummyKeys = new Set(dummies.map((u) => `${u.txid}:${u.vout}`));
    const payment = utxos.filter((u) => !dummyKeys.has(`${u.txid}:${u.vout}`));

    const sessionId = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + config.buySessionTtlSec * 1000).toISOString();

    if (dummies.length < 2) {
      // Buyer needs two small UTXOs first. Build that tx; the buy itself is a second round.
      const split = buildDummySplitPsbt({
        buyerAddress: body.buyerAddress, buyerPublicKey: body.buyerPublicKey,
        paymentUtxos: payment, feeRate, dummyValue: config.dummyValueSats, network,
      });
      stmts.insertSession.run({
        id: sessionId, listing_id: row.id, buyer_address: body.buyerAddress, kind: 'dummies',
        psbt_hex: split.psbtHex, summary_json: JSON.stringify({ ...split.summary, buyerInputIndexes: split.buyerInputIndexes }), expires_at: expiresAt,
      });
      return res.json({
        needsDummies: true,
        sessionId,
        psbtHex: split.psbtHex,
        toSignInputs: split.toSignInputs,
        summary: split.summary,
        note: 'Your wallet has no two small (600–1000 sat) UTXOs to pad the purchase. Sign this transaction to create them, wait for one confirmation, then buy.',
      });
    }

    const [txid, vout] = row.location.split(':');
    const listing = {
      inscriptionUtxo: { txid, vout: Number(vout), value: row.output_value },
      satOffset: row.sat_offset,
      sellerAddress: row.seller_address,
      priceSats: row.price_sats,
      sellerSignature: JSON.parse(row.seller_sig_hex),
    };
    const built = buildBuyerPsbt({
      listing, buyerAddress: body.buyerAddress, buyerPublicKey: body.buyerPublicKey,
      dummyUtxos: dummies, paymentUtxos: payment, feeRate,
      royaltyBps: config.royaltyBps, treasuryAddress: config.treasuryAddress, network,
    });
    stmts.insertSession.run({
      id: sessionId, listing_id: row.id, buyer_address: body.buyerAddress, kind: 'buy',
      psbt_hex: built.psbtHex, summary_json: JSON.stringify({ ...built.summary, buyerInputIndexes: built.buyerInputIndexes }), expires_at: expiresAt,
    });
    res.json({
      needsDummies: false,
      sessionId,
      psbtHex: built.psbtHex,
      toSignInputs: built.toSignInputs,
      summary: built.summary,
      ordinalDestination: built.ordinalDestination,
      note: 'Your wallet will show an inscription input being spent. That is the seller\'s Degent moving to you in output #1.',
    });
  }));

  router.post('/buy/submit', wrap(async (req, res) => {
    const body = parseBody(schemas.buySubmit, req.body);
    const session = stmts.getSession.get(body.sessionId);
    if (!session || session.status !== 'open') return res.status(404).json({ error: 'Unknown or closed buy session' });
    if (new Date(session.expires_at).getTime() < Date.now()) return res.status(410).json({ error: 'Buy session expired, prepare again' });
    const summary = JSON.parse(session.summary_json);

    const assembled = assembleBuyerSignedPsbt({
      sessionPsbtHex: session.psbt_hex, signedPsbtHex: body.signedPsbt, buyerInputIndexes: summary.buyerInputIndexes,
    });

    if (session.kind === 'buy') {
      const row = stmts.getListing.get(session.listing_id);
      if (!row || row.status !== S.ACTIVE) return res.status(409).json({ error: 'Listing is no longer active', code: 'NOT_ACTIVE' });
      // Final FIFO assertion on the exact bytes we are about to broadcast.
      const tx = assembled.tx;
      const ins = [];
      for (let i = 0; i < tx.inputsLength; i++) ins.push({ value: tx.getInput(i).witnessUtxo.amount });
      const outs = [];
      for (let i = 0; i < tx.outputsLength; i++) outs.push({ value: tx.getOutput(i).amount });
      const dest = computeOrdinalDestination(ins, outs, INSCRIPTION_INPUT_INDEX, row.sat_offset);
      if (dest.outputIndex !== INSCRIPTION_OUTPUT_INDEX) {
        throw new BuildError('Refusing to broadcast: ordinal would not reach the buyer', 'ORDINAL_MISROUTED');
      }
      await checkListingValidity({ indexer, mempool, inscriptionId: row.id, location: row.location, address: row.seller_address });
    }

    const txid = await mempool.broadcast(assembled.rawTxHex);
    stmts.closeSession.run({ id: session.id, status: 'broadcast', txid });
    if (session.kind === 'buy') {
      stmts.setStatus.run({ id: session.listing_id, status: S.PENDING, reason: 'purchase broadcast', txid, buyer: session.buyer_address });
      logger.info(`Purchase broadcast ${txid} for ${session.listing_id} by ${session.buyer_address}`);
    } else {
      logger.info(`Dummy split broadcast ${txid} for ${session.buyer_address}`);
    }
    res.json({ ok: true, txid, kind: session.kind, vsize: assembled.vsize, feeSats: assembled.fee.toString(), explorer: `${config.mempoolWeb}/tx/${txid}` });
  }));

  router.use((err, _req, res, next) => {
    if (err instanceof ListingInvalid) return res.status(409).json({ error: err.message, code: err.code, txid: err.txid });
    next(err);
  });
}
