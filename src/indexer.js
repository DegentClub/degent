// Network clients: mempool.space (Esplora API) for UTXO state, fees and
// broadcast; an inscription indexer (ord recursive endpoints or Hiro) for
// "where is this inscription right now". Both take an injectable `fetch` so
// the settlement watcher and routes can be tested without the network.

export class UpstreamError extends Error {
  constructor(msg, status = 502) { super(msg); this.name = 'UpstreamError'; this.status = status; }
}

async function getJson(fetchFn, url, init) {
  const res = await fetchFn(url, { ...init, headers: { accept: 'application/json', ...(init?.headers || {}) } });
  if (res.status === 404) return null;
  if (!res.ok) throw new UpstreamError(`${url} -> ${res.status}`);
  return res.json();
}

export function createMempoolClient({ baseUrl, fetch: fetchFn = globalThis.fetch }) {
  const base = baseUrl.replace(/\/$/, '');
  return {
    baseUrl: base,
    /** { spent:boolean, txid?, vin?, status? } or null when the outpoint is unknown */
    async getOutspend(txid, vout) {
      return getJson(fetchFn, `${base}/tx/${txid}/outspend/${vout}`);
    },
    async getTx(txid) {
      return getJson(fetchFn, `${base}/tx/${txid}`);
    },
    async getAddressUtxos(address) {
      const list = await getJson(fetchFn, `${base}/address/${address}/utxo`);
      return (list || []).map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, confirmed: !!u.status?.confirmed }));
    },
    async getFeePresets() {
      return getJson(fetchFn, `${base}/v1/fees/recommended`);
    },
    async broadcast(rawTxHex) {
      const res = await fetchFn(`${base}/tx`, { method: 'POST', body: rawTxHex, headers: { 'content-type': 'text/plain' } });
      const text = await res.text();
      if (!res.ok) throw new UpstreamError(`Broadcast rejected: ${text.slice(0, 300)}`, 502);
      return text.trim();
    },
  };
}

/**
 * Normalised inscription record:
 *   { id, number, address, outpoint: 'txid:vout', offset, value, contentType, satpoint }
 */
export function createInscriptionIndexer({ kind, ordApi, hiroApi, fetch: fetchFn = globalThis.fetch }) {
  if (kind === 'hiro') {
    const base = hiroApi.replace(/\/$/, '');
    return {
      kind,
      async getInscription(id) {
        const j = await getJson(fetchFn, `${base}/ordinals/v1/inscriptions/${id}`);
        if (!j) return null;
        const [txid, vout, offset] = String(j.location || '').split(':');
        return {
          id: j.id,
          number: j.number,
          address: j.address,
          outpoint: j.output || `${txid}:${vout}`,
          offset: Number(j.offset ?? offset ?? 0),
          value: Number(j.value),
          contentType: j.content_type || j.mime_type || '',
          satpoint: j.location,
        };
      },
      /** ids of inscriptions sitting on an outpoint */
      async getOutpointInscriptions(outpoint) {
        const j = await getJson(fetchFn, `${base}/ordinals/v1/inscriptions?output=${outpoint}&limit=60`);
        return (j?.results || []).map((r) => r.id);
      },
    };
  }
  const base = ordApi.replace(/\/$/, '');
  return {
    kind: 'ord',
    async getInscription(id) {
      const j = await getJson(fetchFn, `${base}/r/inscription/${id}`);
      if (!j) return null;
      const [txid, vout, offset] = String(j.satpoint || '').split(':');
      return {
        id: j.id,
        number: j.number,
        address: j.address,
        outpoint: j.output || `${txid}:${vout}`,
        offset: Number(offset ?? 0),
        value: Number(j.value),
        contentType: j.content_type || '',
        satpoint: j.satpoint,
      };
    },
    async getOutpointInscriptions(outpoint) {
      const j = await getJson(fetchFn, `${base}/r/utxo/${outpoint}`);
      // ord returns 404 for unknown/spent outpoints; treat as "no inscriptions known"
      return (j?.inscriptions || []);
    },
  };
}

/**
 * Verify that `inscriptionId` currently sits at `location` (txid:vout), is held
 * by `address`, and the outpoint is unspent. Throws ListingInvalid on mismatch.
 */
export async function checkListingValidity({ indexer, mempool, inscriptionId, location, address }) {
  const [txid, voutStr] = location.split(':');
  const vout = Number(voutStr);
  const outspend = await mempool.getOutspend(txid, vout);
  if (!outspend) throw new ListingInvalid('Listed outpoint is unknown to the mempool API', 'UNKNOWN_OUTPOINT');
  if (outspend.spent) throw new ListingInvalid(`Listed outpoint already spent in ${outspend.txid}`, 'SPENT', outspend.txid);
  const insc = await indexer.getInscription(inscriptionId);
  if (!insc) throw new ListingInvalid('Inscription not found in indexer', 'NOT_INDEXED');
  if (insc.outpoint !== location) throw new ListingInvalid(`Inscription is at ${insc.outpoint}, not ${location}`, 'MOVED');
  if (address && insc.address && insc.address !== address) {
    throw new ListingInvalid(`Inscription is held by ${insc.address}, not the seller`, 'WRONG_OWNER');
  }
  return insc;
}

export class ListingInvalid extends Error {
  constructor(msg, code, txid) { super(msg); this.name = 'ListingInvalid'; this.status = 409; this.code = code; this.txid = txid; }
}
