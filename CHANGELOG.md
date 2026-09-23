# Changelog

## 2.0.0 — settlement engine rebuild (Phase 0 + Phase 3)

### Safety
- **Buying is paused by default.** New `BUYS_ENABLED` flag (env, default `false`).
  When off, `/api/buy/*` returns `503 BUYS_PAUSED`, the UI shows a banner and
  disables Buy buttons. Listings remain viewable, creatable and cancellable.

### Settlement engine (breaking)
- Replaced the hand-written browser PSBT encoder with a server-side engine in
  `src/psbt/` built on `@scure/btc-signer` / `@noble/curves`.
- Purchase layout is now `[dummy, dummy, inscription, payment…]` →
  `[dummy merge → buyer, postage → buyer, price → seller, royalty → treasury?, change → buyer]`.
  The seller signs input #2 with `SIGHASH_SINGLE|ANYONECANPAY`. A FIFO
  ordinal calculator asserts the inscribed sat reaches the buyer, in the
  builder and again before broadcast. The old layout gave the inscription to
  the seller.
- Seller signatures are verified cryptographically (Schnorr for taproot, ECDSA
  for P2WPKH) against the reconstructed sighash — previously only the length
  and trailing `0x83` byte were checked.
- Correct `tap_internal_key` (untweaked x-only key from `getPublicKey()`),
  verified to derive the seller's/buyer's address.
- No more dummy-input signing trick: the buyer signs the real transaction and
  the wallet's inscription warning is expected.
- Real fees: vsize estimation per script type × mempool.space presets
  (economy / normal / fast); multi-UTXO coin selection; dust-aware change;
  optional royalty output (`ROYALTY_BPS`, `TREASURY_ADDRESS`).
- Automatic dummy-UTXO creation round when the buyer lacks two small UTXOs.
- Old engine moved to `legacy/psbt-unsafe.js` with a header describing the defects; it is not served or imported.

### Listing lifecycle
- Listing create/cancel require a BIP-322 "simple" signature (`bip322-js`) over a
  single-use server-issued challenge (`POST /api/challenge`) bound to action,
  inscription, price, address, nonce and expiry.
- `sold` is no longer a client call. `src/settlement-watcher.js` polls
  mempool.space outspends and the inscription indexer and moves listings to
  `sold` / `invalid` / `expired` automatically; a broadcast buy is `pending`
  until seen.
- Listing validity (unspent outpoint, indexer location and owner) is checked on
  prepare, create, buy and periodically. Indexer selectable: ordinals.com
  recursive endpoints (`INDEXER=ord`) or Hiro (`INDEXER=hiro`).
- Listings expire after at most 30 days; price must be within 1 000 sats – 100 BTC.

### Server hardening
- Repo restructured: `public/` is the only static root (`market.db`, `src/`,
  `legacy/`, `package.json` are no longer downloadable); server code in `src/`;
  database defaults to `data/market.db`.
- `helmet` with CSP `script-src 'self'`; CORS restricted to `CORS_ORIGIN`
  (exact match) or same-origin only.
- All mutations are `POST` JSON validated with `zod`; the GET-based
  `create`/`cancel`/`sold` routes and `PATCH …/sold` are removed.
- The seller-signed PSBT is no longer exposed by the listings API.

### Client
- Every rendered field goes through `createElement`/`textContent`; no
  `innerHTML` with wallet or server data (fixes stored XSS via content type and
  other fields).
- Client no longer builds transactions; it calls `prepare`/`submit` endpoints
  and signs with UniSat. Fee tier selector with live presets; accurate totals.
- Removed the IndexedDB "local-only" listing store (server is the source of truth)
  and the unverified sign-in message on connect (ownership is proven per action).
- Fixed the `memepool.space` explorer link; network-aware mempool links.
- Fonts loaded via `<link>` (JetBrains Mono now actually loads); inline
  styles/handlers removed for CSP compatibility.

### Removed
- `buysamplecode.js`, `listsamplecode.js` (shelled out to `ord` with
  unescaped arguments), `ordinals-psbt-listing-reference.docx`.

### Tooling
- `vitest` test suite (`npm test`), GitHub Actions CI on Node 20/22,
  `.env.example`, `README.md`, `docs/SETTLEMENT.md`, `docs/API.md`.
