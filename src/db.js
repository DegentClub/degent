// SQLite persistence. The file lives outside public/ so it can never be served.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export const LISTING_STATUS = Object.freeze({
  ACTIVE: 'active',        // seller-signed, UTXO unspent, inscription still at listed outpoint
  PENDING: 'pending',      // a buy tx was broadcast by this server; awaiting the spend to be seen
  SOLD: 'sold',            // listed outpoint spent by a tx paying the seller the listed price
  INVALID: 'invalid',      // outpoint spent by something else, or inscription no longer there
  EXPIRED: 'expired',      // expires_at passed while still active
  CANCELLED: 'cancelled',  // seller cancelled (BIP-322 signed)
});

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS listings (
    id                 TEXT PRIMARY KEY,           -- inscription id
    inscription_number INTEGER,
    content_type       TEXT,
    output_value       INTEGER NOT NULL,           -- sats in the inscription UTXO (postage)
    location           TEXT NOT NULL,              -- txid:vout
    sat_offset         INTEGER NOT NULL DEFAULT 0, -- inscription offset inside the UTXO
    price_sats         INTEGER NOT NULL,
    seller_address     TEXT NOT NULL,
    seller_pubkey      TEXT NOT NULL,              -- 33-byte compressed pubkey (hex)
    seller_sig_hex     TEXT NOT NULL,              -- signature for input #2, SINGLE|ANYONECANPAY
    seller_psbt_hex    TEXT NOT NULL,              -- seller-signed template PSBT
    status             TEXT NOT NULL DEFAULT 'active',
    status_reason      TEXT,
    settlement_txid    TEXT,
    buyer_address      TEXT,
    created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    expires_at         TEXT NOT NULL,
    last_checked_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
  CREATE INDEX IF NOT EXISTS idx_listings_seller ON listings(seller_address);

  CREATE TABLE IF NOT EXISTS challenges (
    nonce          TEXT PRIMARY KEY,
    address        TEXT NOT NULL,
    action         TEXT NOT NULL,
    inscription_id TEXT NOT NULL,
    price_sats     INTEGER,
    message        TEXT NOT NULL,
    expires_at     TEXT NOT NULL,
    used           INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS buy_sessions (
    id             TEXT PRIMARY KEY,
    listing_id     TEXT NOT NULL,
    buyer_address  TEXT NOT NULL,
    kind           TEXT NOT NULL,              -- 'buy' | 'dummies'
    psbt_hex       TEXT NOT NULL,
    summary_json   TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'open',
    txid           TEXT,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    expires_at     TEXT NOT NULL
  );
`;

export function openDb(dbPath = ':memory:') {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export function prepareStatements(db) {
  return {
    listActive: db.prepare(`SELECT * FROM listings WHERE status = 'active' ORDER BY created_at DESC`),
    listOpen: db.prepare(`SELECT * FROM listings WHERE status IN ('active','pending')`),
    getListing: db.prepare(`SELECT * FROM listings WHERE id = ?`),
    insertListing: db.prepare(`
      INSERT INTO listings (id, inscription_number, content_type, output_value, location, sat_offset,
        price_sats, seller_address, seller_pubkey, seller_sig_hex, seller_psbt_hex, expires_at)
      VALUES (@id, @inscription_number, @content_type, @output_value, @location, @sat_offset,
        @price_sats, @seller_address, @seller_pubkey, @seller_sig_hex, @seller_psbt_hex, @expires_at)
    `),
    // A listing can be re-created after it left the 'active' state.
    deleteInactive: db.prepare(`DELETE FROM listings WHERE id = ? AND status NOT IN ('active','pending')`),
    setStatus: db.prepare(`
      UPDATE listings SET status = @status, status_reason = @reason,
        settlement_txid = COALESCE(@txid, settlement_txid),
        buyer_address = COALESCE(@buyer, buyer_address),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        last_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = @id
    `),
    touchChecked: db.prepare(`UPDATE listings SET last_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`),
    countActive: db.prepare(`SELECT COUNT(*) AS count FROM listings WHERE status = 'active'`),

    insertChallenge: db.prepare(`
      INSERT INTO challenges (nonce, address, action, inscription_id, price_sats, message, expires_at)
      VALUES (@nonce, @address, @action, @inscription_id, @price_sats, @message, @expires_at)
    `),
    getChallenge: db.prepare(`SELECT * FROM challenges WHERE nonce = ?`),
    useChallenge: db.prepare(`UPDATE challenges SET used = 1 WHERE nonce = ? AND used = 0`),
    purgeChallenges: db.prepare(`DELETE FROM challenges WHERE expires_at < ? OR used = 1`),

    insertSession: db.prepare(`
      INSERT INTO buy_sessions (id, listing_id, buyer_address, kind, psbt_hex, summary_json, expires_at)
      VALUES (@id, @listing_id, @buyer_address, @kind, @psbt_hex, @summary_json, @expires_at)
    `),
    getSession: db.prepare(`SELECT * FROM buy_sessions WHERE id = ?`),
    closeSession: db.prepare(`UPDATE buy_sessions SET status = @status, txid = @txid WHERE id = @id`),
    purgeSessions: db.prepare(`DELETE FROM buy_sessions WHERE expires_at < ? AND status = 'open'`),
  };
}

// Public projection of a listing row. Never leaks the seller-signed PSBT: the
// server is the only party that assembles buy transactions.
export function rowToListing(row, meta) {
  if (!row) return null;
  return {
    inscriptionId: row.id,
    inscriptionNumber: row.inscription_number,
    name: meta?.name ?? null,
    contentType: row.content_type || '',
    outputValue: row.output_value,
    location: row.location,
    satOffset: row.sat_offset,
    priceSats: row.price_sats,
    sellerAddress: row.seller_address,
    status: row.status,
    statusReason: row.status_reason,
    settlementTxid: row.settlement_txid,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}
