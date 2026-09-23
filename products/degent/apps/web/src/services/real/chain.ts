/** Real ChainApi: esplora-compatible REST (mempool.space / blockstream / self-hosted) + ord /content. */
import type { ChainApi, Utxo } from '../types';

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
  };
}
