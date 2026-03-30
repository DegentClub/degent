const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');

const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Collection ──
const collectionData = JSON.parse(fs.readFileSync(path.join(__dirname, 'collection.json'), 'utf8'));
const collectionMap = new Map(collectionData.map(item => [item.inscription_id, item]));
console.log(`Loaded collection: ${collectionMap.size} items`);

// ── Middleware ──
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname)));

// ── Database ──
const db = new Database(path.join(__dirname, 'market.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS listings (
    id                TEXT PRIMARY KEY,
    inscription_number INTEGER,
    content_type      TEXT,
    output_value      INTEGER,
    location          TEXT NOT NULL,
    price_sats        INTEGER NOT NULL,
    seller_address    TEXT NOT NULL,
    seller_sig_hex    TEXT NOT NULL,
    signed_psbt_hex   TEXT NOT NULL,
    created_at        TEXT DEFAULT (datetime('now')),
    status            TEXT DEFAULT 'active'
  );
  CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
  CREATE INDEX IF NOT EXISTS idx_listings_seller ON listings(seller_address);
`);

// ── Prepared statements ──
const stmts = {
  getAll:    db.prepare(`SELECT * FROM listings WHERE status = 'active' ORDER BY created_at DESC`),
  getById:   db.prepare(`SELECT * FROM listings WHERE id = ?`),
  insert:    db.prepare(`
    INSERT INTO listings (id, inscription_number, content_type, output_value, location, price_sats, seller_address, seller_sig_hex, signed_psbt_hex)
    VALUES (@id, @inscription_number, @content_type, @output_value, @location, @price_sats, @seller_address, @seller_sig_hex, @signed_psbt_hex)
  `),
  remove:    db.prepare(`DELETE FROM listings WHERE id = ? AND seller_address = ?`),
  markSold:  db.prepare(`UPDATE listings SET status = 'sold' WHERE id = ?`),
  countActive: db.prepare(`SELECT COUNT(*) as count FROM listings WHERE status = 'active'`),
};

// ── Helper: convert DB row to JSON response ──
function rowToListing(row) {
  if (!row) return null;
  return {
    inscriptionId: row.id,
    inscriptionNumber: row.inscription_number,
    contentType: row.content_type,
    outputValue: row.output_value,
    location: row.location,
    priceSats: row.price_sats,
    sellerAddress: row.seller_address,
    sellerSigHex: row.seller_sig_hex,
    signedPsbtHex: row.signed_psbt_hex,
    createdAt: row.created_at,
    status: row.status,
  };
}

// ── Routes ──

// GET /api/collection — serve collection metadata
app.get('/api/collection', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json(collectionData);
});

// GET /api/listings — all active listings (filtered to collection only)
app.get('/api/listings', (req, res) => {
  try {
    const rows = stmts.getAll.all();
    const listings = rows
      .filter(row => collectionMap.has(row.id))
      .map(row => {
        const listing = rowToListing(row);
        const meta = collectionMap.get(row.id);
        if (meta) listing.name = meta.name;
        return listing;
      });
    res.json(listings);
  } catch (err) {
    console.error('GET /api/listings error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/listings/count — active listing count (collection only)
app.get('/api/listings/count', (req, res) => {
  try {
    const rows = stmts.getAll.all();
    const count = rows.filter(row => collectionMap.has(row.id)).length;
    res.json({ count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/listings/create?data=<base64json> — proxy-friendly create
app.get('/api/listings/create', (req, res) => {
  try {
    const b = JSON.parse(decodeURIComponent(escape(Buffer.from(req.query.data, 'base64').toString('binary'))));
    if (!b.inscriptionId || !b.priceSats || !b.sellerAddress || !b.sellerSigHex || !b.signedPsbtHex || !b.location) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!collectionMap.has(b.inscriptionId)) {
      return res.status(403).json({ error: 'Inscription is not part of the Degent collection' });
    }
    const priceSats = typeof b.priceSats === 'string' ? parseInt(b.priceSats) : b.priceSats;
    if (priceSats < 546) {
      return res.status(400).json({ error: 'Price must be >= 546 sats (dust limit)' });
    }
    stmts.insert.run({
      id: b.inscriptionId,
      inscription_number: b.inscriptionNumber || 0,
      content_type: b.contentType || '',
      output_value: b.outputValue || 546,
      location: b.location,
      price_sats: priceSats,
      seller_address: b.sellerAddress,
      seller_sig_hex: b.sellerSigHex,
      signed_psbt_hex: b.signedPsbtHex,
    });
    console.log(`Listed: ${b.inscriptionId} for ${priceSats} sats`);
    res.json({ ok: true, inscriptionId: b.inscriptionId });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'Inscription already listed' });
    }
    console.error('GET /api/listings/create error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/listings/:id — single listing (collection only)
app.get('/api/listings/:id', (req, res) => {
  try {
    if (!collectionMap.has(req.params.id)) {
      return res.status(403).json({ error: 'Inscription is not part of the Degent collection' });
    }
    const row = stmts.getById.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Listing not found' });
    const listing = rowToListing(row);
    const meta = collectionMap.get(req.params.id);
    if (meta) listing.name = meta.name;
    res.json(listing);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/listings — create a new listing
app.post('/api/listings', (req, res) => {
  const b = req.body;
  if (!b.inscriptionId || !b.priceSats || !b.sellerAddress || !b.sellerSigHex || !b.signedPsbtHex || !b.location) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (!collectionMap.has(b.inscriptionId)) {
    return res.status(403).json({ error: 'Inscription is not part of the Degent collection' });
  }
  if (b.priceSats < 546) {
    return res.status(400).json({ error: 'Price must be >= 546 sats (dust limit)' });
  }
  try {
    stmts.insert.run({
      id: b.inscriptionId,
      inscription_number: b.inscriptionNumber || 0,
      content_type: b.contentType || '',
      output_value: b.outputValue || 546,
      location: b.location,
      price_sats: b.priceSats,
      seller_address: b.sellerAddress,
      seller_sig_hex: b.sellerSigHex,
      signed_psbt_hex: b.signedPsbtHex,
    });
    console.log(`Listed: ${b.inscriptionId} for ${b.priceSats} sats`);
    res.status(201).json({ ok: true, inscriptionId: b.inscriptionId });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'Inscription already listed' });
    }
    console.error('POST /api/listings error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/listings/:id — cancel listing (seller only)
app.delete('/api/listings/:id', (req, res) => {
  const sellerAddress = req.query.seller || req.body?.sellerAddress;
  if (!sellerAddress) {
    return res.status(400).json({ error: 'seller address required' });
  }
  try {
    const result = stmts.remove.run(req.params.id, sellerAddress);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Listing not found or not owned by this address' });
    }
    console.log(`Cancelled: ${req.params.id}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/listings/:id/sold — mark as sold after successful purchase
app.patch('/api/listings/:id/sold', (req, res) => {
  try {
    const result = stmts.markSold.run(req.params.id);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    console.log(`Sold: ${req.params.id}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ──
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// ── GET-based alternatives (for proxies that don't forward POST/DELETE/PATCH) ──

// GET /api/listings/:id/cancel?seller=<address>
app.get('/api/listings/:id/cancel', (req, res) => {
  const sellerAddress = req.query.seller;
  if (!sellerAddress) {
    return res.status(400).json({ error: 'seller address required' });
  }
  try {
    const result = stmts.remove.run(req.params.id, sellerAddress);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Listing not found or not owned by this address' });
    }
    console.log(`Cancelled: ${req.params.id}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/listings/:id/sold — mark as sold
app.get('/api/listings/:id/sold', (req, res) => {
  try {
    const result = stmts.markSold.run(req.params.id);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    console.log(`Sold: ${req.params.id}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`Ordinals Marketplace API running on http://localhost:${PORT}`);
  const { count } = stmts.countActive.get();
  console.log(`Active listings: ${count}`);
});
