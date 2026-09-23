// Settlement watcher. "sold" is never a client call: this poller decides the
// fate of every open listing from chain/indexer facts.
//
//   active  --outpoint spent by tx paying seller the price-->  sold
//   active  --outpoint spent by anything else------------->  invalid (inscription moved)
//   active  --indexer says inscription elsewhere/other owner--> invalid
//   active  --expires_at passed---------------------------->  expired
//   pending --outpoint spent (any tx paying seller price)--> sold
//   pending --outpoint spent otherwise--------------------->  invalid
//   pending --nothing seen for pendingTimeoutMs------------>  active (buy tx dropped)
import { LISTING_STATUS as S } from './db.js';

/**
 * Pure transition function. `facts` is everything the tick collected:
 *   outspend   { spent, txid } | null
 *   spendingTx { vout:[{scriptpubkey_address, value}] } | undefined
 *   inscription { outpoint, address } | null | undefined (undefined = not checked)
 * Returns null when nothing changes.
 */
export function nextState(listing, facts, { now = Date.now(), pendingTimeoutMs = 6 * 3600e3 } = {}) {
  const { outspend, spendingTx, inscription } = facts;

  if (outspend?.spent) {
    const paysSeller = !!spendingTx?.vout?.some(
      (o) => o.scriptpubkey_address === listing.seller_address && Number(o.value) === Number(listing.price_sats),
    );
    if (paysSeller) {
      return { status: S.SOLD, reason: 'outpoint spent by a transaction paying the listed price', txid: outspend.txid };
    }
    return { status: S.INVALID, reason: 'inscription outpoint spent outside the marketplace', txid: outspend.txid };
  }

  if (inscription === null) {
    return { status: S.INVALID, reason: 'inscription no longer found in indexer' };
  }
  if (inscription) {
    if (inscription.outpoint && inscription.outpoint !== listing.location) {
      return { status: S.INVALID, reason: `inscription moved to ${inscription.outpoint}` };
    }
    if (inscription.address && inscription.address !== listing.seller_address) {
      return { status: S.INVALID, reason: `inscription now held by ${inscription.address}` };
    }
  }

  if (listing.status === S.ACTIVE && new Date(listing.expires_at).getTime() < now) {
    return { status: S.EXPIRED, reason: 'listing expiry reached' };
  }
  if (listing.status === S.PENDING) {
    const since = new Date(listing.updated_at).getTime();
    if (now - since > pendingTimeoutMs) {
      return { status: S.ACTIVE, reason: 'broadcast purchase never appeared; listing re-opened', txid: null };
    }
  }
  return null;
}

export function createSettlementWatcher({ db, stmts, mempool, indexer, intervalMs = 60_000, pendingTimeoutMs, logger = console, now = Date.now, checkIndexer = true }) {
  let timer = null;
  let running = false;

  async function inspect(listing) {
    const [txid, vout] = listing.location.split(':');
    const facts = {};
    facts.outspend = await mempool.getOutspend(txid, Number(vout));
    if (facts.outspend?.spent && facts.outspend.txid) {
      facts.spendingTx = await mempool.getTx(facts.outspend.txid);
    } else if (checkIndexer) {
      try {
        facts.inscription = await indexer.getInscription(listing.id);
      } catch (err) {
        logger.warn(`[watcher] indexer unavailable for ${listing.id}: ${err.message}`);
        facts.inscription = undefined; // not checked this round
      }
    }
    return facts;
  }

  async function tick() {
    if (running) return { skipped: true };
    running = true;
    const changes = [];
    try {
      const open = stmts.listOpen.all();
      for (const listing of open) {
        try {
          const facts = await inspect(listing);
          const next = nextState(listing, facts, { now: now(), pendingTimeoutMs });
          if (next) {
            stmts.setStatus.run({ id: listing.id, status: next.status, reason: next.reason, txid: next.txid ?? null, buyer: null });
            changes.push({ id: listing.id, from: listing.status, ...next });
            logger.info(`[watcher] ${listing.id}: ${listing.status} -> ${next.status} (${next.reason})`);
          } else {
            stmts.touchChecked.run(listing.id);
          }
        } catch (err) {
          logger.warn(`[watcher] ${listing.id}: check failed: ${err.message}`);
        }
      }
      stmts.purgeChallenges.run(new Date(now()).toISOString());
      stmts.purgeSessions.run(new Date(now()).toISOString());
    } finally {
      running = false;
    }
    return { checked: true, changes };
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { tick().catch((e) => logger.error('[watcher] tick error', e)); }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    tick().catch((e) => logger.error('[watcher] tick error', e));
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { tick, start, stop };
}
