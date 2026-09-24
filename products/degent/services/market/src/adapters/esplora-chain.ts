/**
 * MarketChain over an esplora / mempool.space-compatible REST API:
 * GET /tx/:txid/outspend/:vout, GET /tx/:txid, GET /address/:a/utxo, GET /v1/fees/recommended, POST /tx.
 */
import { BroadcastRejected, UpstreamError, type AddressUtxo, type ChainTx, type MarketChain, type Outspend } from '../ports/chain.js';
import { httpClient, trimSlash, type HttpOptions } from './http.js';

export class EsploraMarketChain implements MarketChain {
  private readonly http: ReturnType<typeof httpClient>;
  private readonly base: string;

  constructor(opts: { esploraUrl: string } & HttpOptions) {
    this.http = httpClient(opts);
    this.base = trimSlash(opts.esploraUrl);
  }

  private async json<T>(path: string): Promise<T | null> {
    let res: Response;
    try {
      res = await this.http(`${this.base}${path}`, { headers: { accept: 'application/json' } });
    } catch (e) {
      throw new UpstreamError(`esplora ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new UpstreamError(`esplora ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async getOutspend(txid: string, vout: number): Promise<Outspend | null> {
    const r = await this.json<{ spent: boolean; txid?: string }>(`/tx/${encodeURIComponent(txid)}/outspend/${vout}`);
    return r ? { spent: !!r.spent, txid: r.txid ?? null } : null;
  }

  async getTx(txid: string): Promise<ChainTx | null> {
    const t = await this.json<{ txid: string; vout: Array<{ scriptpubkey: string; scriptpubkey_address?: string; value: number }>; status?: { confirmed?: boolean } }>(
      `/tx/${encodeURIComponent(txid)}`,
    );
    if (!t) return null;
    return {
      txid: t.txid,
      vout: t.vout.map((o) => ({ value: BigInt(o.value), scriptHex: o.scriptpubkey, address: o.scriptpubkey_address ?? null })),
      confirmed: !!t.status?.confirmed,
    };
  }

  async getAddressUtxos(address: string): Promise<AddressUtxo[]> {
    const r = await this.json<Array<{ txid: string; vout: number; value: number; status?: { confirmed?: boolean } }>>(`/address/${encodeURIComponent(address)}/utxo`);
    return (r ?? []).map((u) => ({ txid: u.txid, vout: u.vout, value: BigInt(u.value), confirmed: !!u.status?.confirmed }));
  }

  async getFeeRecommendations(): Promise<Record<string, unknown> | null> {
    return this.json<Record<string, unknown>>('/v1/fees/recommended');
  }

  async broadcast(rawTxHex: string): Promise<string> {
    let res: Response;
    try {
      res = await this.http(`${this.base}/tx`, { method: 'POST', body: rawTxHex, headers: { 'content-type': 'text/plain' } });
    } catch (e) {
      throw new UpstreamError(`broadcast: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = (await res.text()).trim();
    if (res.status >= 500) throw new UpstreamError(`broadcast: HTTP ${res.status}`);
    if (!res.ok) throw new BroadcastRejected(text.slice(0, 300));
    if (!/^[0-9a-f]{64}$/.test(text)) throw new UpstreamError('broadcast: unexpected response');
    return text;
  }
}
