// Listing lifecycle: read, prepare (server builds the seller PSBT), create
// (BIP-322 challenge + verified seller signature), cancel (BIP-322 challenge).
// There is deliberately no "sold" endpoint — see settlement-watcher.js.
import { parseBody } from '../validation.js';
import { rowToListing, LISTING_STATUS as S } from '../db.js';
import { checkListingValidity, ListingInvalid } from '../indexer.js';
import { buildSellerPsbt, extractSellerSignature, verifyInputSignature, INSCRIPTION_INPUT_INDEX } from '../psbt/index.js';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function listingRoutes(router, ctx) {
  const { stmts, schemas, auth, config, collectionMap, mempool, indexer, network, logger } = ctx;

  const requireCollection = (id) => {
    if (!collectionMap.has(id)) {
      const err = new Error('Inscription is not part of the Degent collection');
      err.status = 403;
      throw err;
    }
    return collectionMap.get(id);
  };

  router.get('/listings', (_req, res) => {
    const rows = stmts.listActive.all().filter((r) => collectionMap.has(r.id));
    res.json(rows.map((r) => rowToListing(r, collectionMap.get(r.id))));
  });

  router.get('/listings/count', (_req, res) => {
    const count = stmts.listActive.all().filter((r) => collectionMap.has(r.id)).length;
    res.json({ count });
  });

  router.get('/listings/:id', (req, res) => {
    const id = String(req.params.id);
    if (!collectionMap.has(id)) return res.status(403).json({ error: 'Inscription is not part of the Degent collection' });
    const row = stmts.getListing.get(id);
    if (!row) return res.status(404).json({ error: 'Listing not found' });
    res.json(rowToListing(row, collectionMap.get(id)));
  });

  // Step 0 of listing and cancelling: get a message to sign.
  router.post('/challenge', (req, res) => {
    const body = parseBody(schemas.challenge, req.body);
    requireCollection(body.inscriptionId);
    const challenge = auth.issueChallenge(body);
    res.json(challenge);
  });

  // Step 1 of listing: server checks ownership/location with the indexer and
  // returns the PSBT the seller must sign (input #2, SIGHASH_SINGLE|ANYONECANPAY).
  router.post('/listings/prepare', wrap(async (req, res) => {
    const body = parseBody(schemas.listingPrepare, req.body);
    requireCollection(body.inscriptionId);
    const existing = stmts.getListing.get(body.inscriptionId);
    if (existing && [S.ACTIVE, S.PENDING].includes(existing.status)) {
      return res.status(409).json({ error: 'Inscription already listed' });
    }
    const insc = await indexer.getInscription(body.inscriptionId);
    if (!insc) return res.status(404).json({ error: 'Inscription not found in indexer' });
    if (insc.address !== body.sellerAddress) {
      return res.status(403).json({ error: `Inscription is held by ${insc.address}, not ${body.sellerAddress}` });
    }
    const [txid, vout] = insc.outpoint.split(':');
    const inscriptionUtxo = { txid, vout: Number(vout), value: insc.value };
    await checkListingValidity({ indexer, mempool, inscriptionId: body.inscriptionId, location: insc.outpoint, address: body.sellerAddress });

    const built = buildSellerPsbt({
      inscriptionUtxo,
      sellerAddress: body.sellerAddress,
      sellerPublicKey: body.sellerPublicKey,
      priceSats: body.priceSats,
      network,
    });
    res.json({
      psbtHex: built.psbtHex,
      psbtBase64: built.psbtBase64,
      signIndex: built.signIndex,
      sighashType: built.sighashType,
      inscription: { outpoint: insc.outpoint, offset: insc.offset, value: insc.value, contentType: insc.contentType, number: insc.number },
      note: 'Sign input #2 only, with SIGHASH_SINGLE|ANYONECANPAY (0x83). Your wallet will show the inscription being spent: that is the listing.',
    });
  }));

  // Step 2 of listing: verify everything, then store.
  router.post('/listings', wrap(async (req, res) => {
    const body = parseBody(schemas.listingCreate, req.body);
    const meta = requireCollection(body.inscriptionId);

    auth.verify({
      nonce: body.nonce, signature: body.signature, action: 'list',
      address: body.sellerAddress, inscriptionId: body.inscriptionId, priceSats: body.priceSats,
    });

    const existing = stmts.getListing.get(body.inscriptionId);
    if (existing && [S.ACTIVE, S.PENDING].includes(existing.status)) {
      return res.status(409).json({ error: 'Inscription already listed' });
    }

    // Where the inscription is right now, according to the indexer + mempool.
    const insc = await indexer.getInscription(body.inscriptionId);
    if (!insc) return res.status(404).json({ error: 'Inscription not found in indexer' });
    const [txid, vout] = insc.outpoint.split(':');
    const inscriptionUtxo = { txid, vout: Number(vout), value: insc.value };
    await checkListingValidity({ indexer, mempool, inscriptionId: body.inscriptionId, location: insc.outpoint, address: body.sellerAddress });

    // Rebuild the template we expect and compare byte-for-byte.
    const expected = buildSellerPsbt({
      inscriptionUtxo, sellerAddress: body.sellerAddress, sellerPublicKey: body.sellerPublicKey,
      priceSats: body.priceSats, network,
    });
    const sig = extractSellerSignature(body.signedPsbt, {
      unsignedTxHex: expected.unsignedTxHex, inscriptionUtxo, sellerAddress: body.sellerAddress, priceSats: body.priceSats, network,
    });
    // Cryptographic check against the template transaction. The same signature
    // is re-verified against the real buy transaction before broadcast.
    const template = btc.Transaction.fromPSBT(hex.decode(expected.psbtHex), { allowUnknownInputs: true });
    if (!verifyInputSignature(template, INSCRIPTION_INPUT_INDEX, sig)) {
      return res.status(400).json({ error: 'Seller signature does not verify' });
    }

    const expiresAt = new Date(Date.now() + body.expiresInDays * 86_400_000).toISOString();
    stmts.deleteInactive.run(body.inscriptionId);
    stmts.insertListing.run({
      id: body.inscriptionId,
      inscription_number: insc.number ?? meta.inscription_number ?? null,
      content_type: insc.contentType || '',
      output_value: insc.value,
      location: insc.outpoint,
      sat_offset: insc.offset || 0,
      price_sats: body.priceSats,
      seller_address: body.sellerAddress,
      seller_pubkey: body.sellerPublicKey,
      seller_sig_hex: JSON.stringify(sig),
      seller_psbt_hex: body.signedPsbt,
      expires_at: expiresAt,
    });
    logger.info(`Listed ${body.inscriptionId} for ${body.priceSats} sats by ${body.sellerAddress}`);
    res.status(201).json({ ok: true, listing: rowToListing(stmts.getListing.get(body.inscriptionId), meta) });
  }));

  router.post('/listings/:id/cancel', (req, res) => {
    const id = String(req.params.id);
    requireCollection(id);
    const body = parseBody(schemas.listingCancel, req.body);
    const row = stmts.getListing.get(id);
    if (!row || ![S.ACTIVE, S.PENDING].includes(row.status)) return res.status(404).json({ error: 'No open listing for this inscription' });
    if (row.seller_address !== body.sellerAddress) return res.status(403).json({ error: 'Not the seller of this listing' });
    auth.verify({ nonce: body.nonce, signature: body.signature, action: 'cancel', address: body.sellerAddress, inscriptionId: id });
    stmts.setStatus.run({ id, status: S.CANCELLED, reason: 'cancelled by seller', txid: null, buyer: null });
    logger.info(`Cancelled ${id}`);
    res.json({ ok: true });
  });

  // Translate indexer failures into API errors.
  router.use((err, _req, res, next) => {
    if (err instanceof ListingInvalid) return res.status(409).json({ error: err.message, code: err.code, txid: err.txid });
    next(err);
  });
}
