/** Real ChainApi: esplora-compatible REST (mempool.space / blockstream / self-hosted) + ord /content. */
import type { ChainApi, InscriptionInfo, Utxo } from '../types';

interface OrdInscription {
  id?: string;
  content_type?: string | null;
  content_length?: number | null;
  fee?: number | null;
  height?: number | null;
  number?: number | null;
  /** unix seconds */
  timestamp?: number | null;
}

/** ord `/r/inscription/:id` JSON -> InscriptionInfo (tolerant of missing fields). */
export function parseOrdInscription(id: string, j: OrdInscription): InscriptionInfo {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const ts = num(j.timestamp);
  return {
    id: typeof j.id === 'string' ? j.id : id,
    contentType: typeof j.content_type === 'string' ? j.content_type : null,
    contentLength: num(j.content_length),
    fee: num(j.fee),
    height: num(j.height),
    number: num(j.number),
    timestamp: ts !== null ? new Date(ts * 1000).toISOString() : null,
  };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function createEsploraChain(esploraUrl: string, ordContentUrl: string, fetchImpl?: FetchLike): ChainApi {
  const f: FetchLike = fetchImpl ?? ((i, init) => globalThis.fetch(i, init));
  const check = async (res: Response, what: string) => {
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${what} failed (HTTP ${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    return res;
  };
  return {
    async getUtxos(address) {
      const res = await check(await f(`${esploraUrl}/address/${encodeURIComponent(address)}/utxo`), 'UTXO lookup');
      const list = (await res.json()) as Utxo[];
      return list.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, status: { confirmed: !!u.status?.confirmed } }));
    },
    async broadcast(hex) {
      const res = await check(
        await f(`${esploraUrl}/tx`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: hex }),
        'Broadcast',
      );
      return (await res.text()).trim();
    },
    async getInscriptionContent(id) {
      const res = await check(await f(`${ordContentUrl}/content/${encodeURIComponent(id)}`), 'Content fetch');
      return new Uint8Array(await res.arrayBuffer());
    },
    contentUrl(id) {
      return `${ordContentUrl}/content/${encodeURIComponent(id)}`;
    },
    async getInscriptionInfo(id) {
      const res = await check(await f(`${ordContentUrl}/r/inscription/${encodeURIComponent(id)}`, { headers: { accept: 'application/json' } }), 'Inscription lookup');
      return parseOrdInscription(id, (await res.json()) as OrdInscription);
    },
  };
}
