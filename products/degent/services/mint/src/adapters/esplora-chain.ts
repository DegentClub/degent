/**
 * ChainPort over an esplora / mempool.space-compatible REST API plus ord's `/content/<id>`.
 * Endpoints: GET /tx/:txid, GET /tx/:txid/outspends, GET /address/:a/utxo, GET /blocks/tip/height.
 */
import type { AddressOutput, ChainOutspend, ChainPort, ChainTx } from '../ports/chain.js';
import { httpClient, trimSlash, type HttpOptions } from './http.js';

interface EsploraTx {
  txid: string;
  vout: Array<{ scriptpubkey: string; scriptpubkey_address?: string; value: number }>;
  status: { confirmed: boolean; block_height?: number };
}

export class EsploraChain implements ChainPort {
  private readonly http: ReturnType<typeof httpClient>;
  private readonly esplora: string;
  private readonly ord: string;

  constructor(opts: { esploraUrl: string; ordUrl: string } & HttpOptions) {
    this.http = httpClient(opts);
    this.esplora = trimSlash(opts.esploraUrl);
    this.ord = trimSlash(opts.ordUrl);
  }

  private async json<T>(path: string): Promise<T | null> {
    const res = await this.http(`${this.esplora}${path}`, { headers: { accept: 'application/json' } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`esplora ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async getTx(txid: string): Promise<ChainTx | null> {
    const t = await this.json<EsploraTx>(`/tx/${encodeURIComponent(txid)}`);
    if (!t) return null;
    return {
      txid: t.txid,
      vout: t.vout.map((o) => ({ value: BigInt(o.value), scriptHex: o.scriptpubkey, address: o.scriptpubkey_address ?? null })),
      confirmed: t.status.confirmed,
      blockHeight: t.status.block_height ?? null,
    };
  }

  async getTxOutspends(txid: string): Promise<ChainOutspend[] | null> {
    const r = await this.json<Array<{ spent: boolean; txid?: string; vin?: number }>>(`/tx/${encodeURIComponent(txid)}/outspends`);
    return r ? r.map((o) => ({ spent: o.spent, txid: o.txid ?? null, vin: o.vin ?? null })) : null;
  }

  async findOutputsPaying(address: string): Promise<AddressOutput[]> {
    const r = await this.json<Array<{ txid: string; vout: number; value: number; status: { confirmed: boolean } }>>(
      `/address/${encodeURIComponent(address)}/utxo`,
    );
    return (r ?? []).map((u) => ({ txid: u.txid, vout: u.vout, value: BigInt(u.value), confirmed: u.status.confirmed }));
  }

  async getTipHeight(): Promise<number> {
    const res = await this.http(`${this.esplora}/blocks/tip/height`);
    if (!res.ok) throw new Error(`esplora tip: HTTP ${res.status}`);
    const n = Number((await res.text()).trim());
    if (!Number.isSafeInteger(n)) throw new Error('esplora tip: not a number');
    return n;
  }

  async getInscriptionContent(inscriptionId: string): Promise<Uint8Array | null> {
    const res = await this.http(`${this.ord}/content/${encodeURIComponent(inscriptionId)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`ord content: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}
