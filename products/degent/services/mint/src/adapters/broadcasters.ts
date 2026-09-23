/**
 * Lane broadcasters.
 *   standard: EsploraBroadcaster  (POST <esplora>/tx, body = raw hex, response = txid)
 *   block:    LibreRelayBroadcaster (bitcoind JSON-RPC `sendrawtransaction`, basic auth) and/or
 *             SlipstreamBroadcaster (MARA Slipstream HTTP: POST <url>/api/transactions {tx_hex})
 *   FanoutBroadcaster pushes to several paths; success if any accepts.
 * None of them throw on relay rejection; they classify the error as retryable or not.
 */
import type { BroadcastResult, Broadcaster } from '../ports/broadcaster.js';
import { httpClient, trimSlash, type HttpOptions } from './http.js';

/** Errors that will not go away by retrying the same bytes. */
const PERMANENT = [/bad-txns/i, /non-mandatory-script-verify-flag/i, /mandatory-script-verify-flag/i, /txn-mempool-conflict/i, /missingorspent/i, /tx-size/i, /dust/i];
/** Already in the mempool / chain counts as success for idempotent re-broadcasts. */
const ALREADY = [/txn-same-nonwitness-data-in-mempool/i, /txn-already-in-mempool/i, /txn-already-known/i, /transaction already in block chain/i, /already have transaction/i];

function classify(via: string, message: string, txidHint: string | null): BroadcastResult {
  if (ALREADY.some((r) => r.test(message)) && txidHint) return { ok: true, txid: txidHint, via };
  return { ok: false, error: message.slice(0, 500), retryable: !PERMANENT.some((r) => r.test(message)), via };
}

export class EsploraBroadcaster implements Broadcaster {
  readonly name = 'esplora';
  private readonly http: ReturnType<typeof httpClient>;
  constructor(private readonly opts: { esploraUrl: string; txid?: (hex: string) => string } & HttpOptions) {
    this.http = httpClient(opts);
  }
  async broadcast(txHex: string): Promise<BroadcastResult> {
    try {
      const res = await this.http(`${trimSlash(this.opts.esploraUrl)}/tx`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: txHex,
      });
      const text = (await res.text()).trim();
      if (res.ok && /^[0-9a-f]{64}$/i.test(text)) return { ok: true, txid: text.toLowerCase(), via: this.name };
      return classify(this.name, text || `HTTP ${res.status}`, this.opts.txid?.(txHex) ?? null);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), retryable: true, via: this.name };
    }
  }
}

export class LibreRelayBroadcaster implements Broadcaster {
  readonly name = 'libre-relay';
  private readonly http: ReturnType<typeof httpClient>;
  constructor(
    private readonly opts: { rpcUrl: string; user: string; password: string; txid?: (hex: string) => string } & HttpOptions,
  ) {
    this.http = httpClient(opts);
  }
  async broadcast(txHex: string): Promise<BroadcastResult> {
    try {
      const auth = Buffer.from(`${this.opts.user}:${this.opts.password}`).toString('base64');
      const res = await this.http(this.opts.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Basic ${auth}` },
        // maxfeerate 0: the policy signer already bounded the fee rate; large reveals would
        // otherwise trip bitcoind's default 0.10 BTC/kvB absurd-fee guard only at extreme rates.
        body: JSON.stringify({ jsonrpc: '1.0', id: 'degent-mint', method: 'sendrawtransaction', params: [txHex, 0] }),
      });
      const body = (await res.json().catch(() => null)) as { result?: string; error?: { message?: string } | null } | null;
      if (body?.result && /^[0-9a-f]{64}$/i.test(body.result)) return { ok: true, txid: body.result.toLowerCase(), via: this.name };
      return classify(this.name, body?.error?.message ?? `HTTP ${res.status}`, this.opts.txid?.(txHex) ?? null);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), retryable: true, via: this.name };
    }
  }
}

export class SlipstreamBroadcaster implements Broadcaster {
  readonly name = 'slipstream';
  private readonly http: ReturnType<typeof httpClient>;
  constructor(private readonly opts: { url: string; apiKey?: string; txid?: (hex: string) => string } & HttpOptions) {
    this.http = httpClient(opts);
  }
  async broadcast(txHex: string): Promise<BroadcastResult> {
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
      const res = await this.http(`${trimSlash(this.opts.url)}/api/transactions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ tx_hex: txHex }),
      });
      const text = await res.text();
      let body: { message?: string; txid?: string; error?: string } = {};
      try {
        body = JSON.parse(text);
      } catch {
        /* non-JSON */
      }
      const txid = body.txid ?? this.opts.txid?.(txHex) ?? null;
      if (res.ok && txid) return { ok: true, txid: txid.toLowerCase(), via: this.name };
      return classify(this.name, body.error ?? body.message ?? (text || `HTTP ${res.status}`), this.opts.txid?.(txHex) ?? null);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), retryable: true, via: this.name };
    }
  }
}

export class FanoutBroadcaster implements Broadcaster {
  readonly name: string;
  constructor(private readonly targets: Broadcaster[]) {
    if (targets.length === 0) throw new Error('FanoutBroadcaster needs at least one target');
    this.name = targets.map((t) => t.name).join('+');
  }
  async broadcast(txHex: string): Promise<BroadcastResult> {
    const results = await Promise.all(this.targets.map((t) => t.broadcast(txHex)));
    const ok = results.find((r) => r.ok);
    if (ok) return ok;
    const failures = results as Array<Extract<BroadcastResult, { ok: false }>>;
    return {
      ok: false,
      via: this.name,
      error: failures.map((r) => `${r.via}: ${r.error}`).join(' | '),
      retryable: failures.some((r) => r.retryable),
    };
  }
}
