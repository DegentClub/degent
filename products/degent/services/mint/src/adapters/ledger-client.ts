/**
 * LedgerClient adapters. `HttpLedgerClient` calls the platform ledger (`X-API-Key`, scope `ledger`, owner =
 * product `degent`) with `Idempotency-Key` on every POST so worker retries never duplicate an order or an
 * intent. `MemoryLedgerClient` is the in-process fake.
 */
import { bytesToHex } from '@noble/hashes/utils.js';
import { addressToScript, type Network } from '@bsh/inscription';
import {
  LedgerClientError,
  type LedgerClient,
  type LedgerCreateOrderInput,
  type LedgerCreatePsbtPaymentInput,
  type LedgerExpectedOutput,
  type LedgerObservation,
  type LedgerObservationResult,
} from '../ports/ledger-client.js';
import { httpClient, trimSlash, type HttpOptions } from './http.js';

const retryableStatus = (status: number) => status >= 500 || status === 429 || status === 408;

export class HttpLedgerClient implements LedgerClient {
  readonly name = 'ledger-http';
  private readonly http: ReturnType<typeof httpClient>;
  private readonly base: string;

  constructor(private readonly opts: { ledgerUrl: string; apiKey: string | null; product?: string } & HttpOptions) {
    this.http = httpClient(opts);
    this.base = trimSlash(opts.ledgerUrl);
  }

  private async post<T>(path: string, body: unknown, idempotencyKey: string | null, what: string): Promise<T> {
    let res: Response;
    try {
      res = await this.http(`${this.base}${path}`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
          ...(this.opts.apiKey ? { 'x-api-key': this.opts.apiKey } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new LedgerClientError(`ledger ${what}: ${e instanceof Error ? e.message : String(e)}`, null, true);
    }
    if (res.status === 200 || res.status === 201) return (await res.json()) as T;
    let detail = '';
    try {
      const b = (await res.json()) as { error?: { code?: string; message?: string } };
      detail = b.error ? ` ${b.error.code ?? ''} ${b.error.message ?? ''}`.trimEnd() : '';
    } catch {
      /* no JSON body */
    }
    throw new LedgerClientError(`ledger ${what}: HTTP ${res.status}${detail}`, res.status, retryableStatus(res.status));
  }

  async createOrder(input: LedgerCreateOrderInput): Promise<{ id: string; totalSats: number }> {
    const o = await this.post<{ id: string; totalSats: number }>(
      '/v1/orders',
      { product: this.opts.product ?? 'degent', customerRef: input.customerRef, lineItems: input.lineItems, ...(input.metadata ? { metadata: input.metadata } : {}) },
      input.idempotencyKey,
      'order',
    );
    return { id: o.id, totalSats: o.totalSats };
  }

  async createPsbtPayment(ledgerOrderId: string, input: LedgerCreatePsbtPaymentInput): Promise<{ id: string; outputs: LedgerExpectedOutput[] }> {
    const p = await this.post<{ id: string; checkout?: { outputs?: LedgerExpectedOutput[] } }>(
      `/v1/orders/${encodeURIComponent(ledgerOrderId)}/payments`,
      { method: 'psbt', ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}) },
      input.idempotencyKey,
      'payment',
    );
    return { id: p.id, outputs: p.checkout?.outputs ?? [] };
  }

  async observePayment(paymentId: string, observation: LedgerObservation): Promise<LedgerObservationResult> {
    const r = await this.post<{ payment: { status: string }; applied: boolean; reason?: string; payouts?: LedgerObservationResult['payouts'] }>(
      `/v1/payments/${encodeURIComponent(paymentId)}/observations`,
      observation,
      null,
      'observation',
    );
    return { applied: r.applied, ...(r.reason ? { reason: r.reason } : {}), paymentStatus: r.payment?.status ?? 'unknown', payouts: r.payouts ?? [] };
  }
}

export interface MemoryLedgerOrder {
  id: string;
  input: LedgerCreateOrderInput;
  totalSats: number;
  payments: Array<{ id: string; input: LedgerCreatePsbtPaymentInput; outputs: LedgerExpectedOutput[]; status: string; observations: LedgerObservation[]; payouts: LedgerObservationResult['payouts'] }>;
}

/** In-memory ledger: records every order and psbt intent (idempotent on the keys); `down` simulates an outage. */
export class MemoryLedgerClient implements LedgerClient {
  readonly name = 'ledger-memory';
  readonly orders: MemoryLedgerOrder[] = [];
  down = false;
  private n = 0;

  constructor(private readonly network: Network = 'regtest') {}

  private guard() {
    if (this.down) throw new LedgerClientError('ledger unreachable', null, true);
  }

  /** The script a payee is matched on, as the ledger does it: scriptHex as given, else the decoded address. */
  private scriptOf(payee: LedgerCreateOrderInput['lineItems'][number]['payee']): string {
    if (payee?.scriptHex) return payee.scriptHex.toLowerCase();
    if (payee?.address) return bytesToHex(addressToScript(payee.address, this.network));
    throw new LedgerClientError('ledger payment: HTTP 409 payee_required', 409, false);
  }

  async createOrder(input: LedgerCreateOrderInput): Promise<{ id: string; totalSats: number }> {
    this.guard();
    const existing = this.orders.find((o) => o.input.idempotencyKey === input.idempotencyKey);
    if (existing) return { id: existing.id, totalSats: existing.totalSats };
    const totalSats = input.lineItems.reduce((a, li) => a + li.quantity * li.unitSats, 0);
    const o: MemoryLedgerOrder = { id: `ord_mem${++this.n}`, input: structuredClone(input), totalSats, payments: [] };
    this.orders.push(o);
    return { id: o.id, totalSats };
  }

  async createPsbtPayment(ledgerOrderId: string, input: LedgerCreatePsbtPaymentInput): Promise<{ id: string; outputs: LedgerExpectedOutput[] }> {
    this.guard();
    const o = this.orders.find((x) => x.id === ledgerOrderId);
    if (!o) throw new LedgerClientError('ledger payment: HTTP 404 not_found', 404, false);
    const existing = o.payments.find((p) => p.input.idempotencyKey === input.idempotencyKey);
    if (existing) return { id: existing.id, outputs: existing.outputs };
    const missing = o.input.lineItems.filter((li) => !li.payee);
    if (missing.length) throw new LedgerClientError(`ledger payment: HTTP 409 payee_required (${missing.map((m) => m.sku).join(', ')})`, 409, false);
    // Same shape as the ledger's expectedOutputsFor: one output per payee SCRIPT, values summed.
    const outputs: LedgerExpectedOutput[] = [];
    for (const li of o.input.lineItems) {
      const scriptHex = this.scriptOf(li.payee);
      const cur = outputs.find((x) => x.scriptHex === scriptHex);
      if (cur) cur.valueSats += li.quantity * li.unitSats;
      else outputs.push({ scriptHex, valueSats: li.quantity * li.unitSats, ...(li.payee!.address ? { address: li.payee!.address } : {}) });
    }
    const p = { id: `pay_mem${++this.n}`, input: structuredClone(input), outputs, status: 'created', observations: [], payouts: [] };
    o.payments.push(p);
    return { id: p.id, outputs };
  }

  /**
   * Mirrors the ledger's psbt evaluation shape: pending while replaceable or unconfirmed, paid when every
   * expected output is present at or above its value at >= 1 confirmation (one payout per payee output),
   * underpaid otherwise. Matching is by script when the expected output has one, else by address.
   */
  async observePayment(paymentId: string, observation: LedgerObservation): Promise<LedgerObservationResult> {
    this.guard();
    const o = this.orders.find((x) => x.payments.some((p) => p.id === paymentId));
    const p = o?.payments.find((x) => x.id === paymentId);
    if (!o || !p) throw new LedgerClientError('ledger observation: HTTP 404 not_found', 404, false);
    p.observations.push(structuredClone(observation));
    if (observation.confirmations <= 0 && observation.rbfSignalled) return { applied: p.status !== 'pending', paymentStatus: (p.status = 'pending'), payouts: [] };
    if (observation.confirmations < 1) return { applied: p.status !== 'pending', paymentStatus: (p.status = 'pending'), payouts: [] };
    const paidFor = (li: LedgerCreateOrderInput['lineItems'][number]) => {
      const key = this.scriptOf(li.payee);
      return observation.outputs.map((out, vout) => ({ ...out, vout })).filter((out) => out.scriptHex.toLowerCase() === key);
    };
    const settlements = o.input.lineItems.map((li) => {
      const outs = paidFor(li);
      return { li, sats: outs.reduce((a, x) => a + x.valueSats, 0), vout: outs[0]?.vout ?? -1 };
    });
    if (settlements.every((s) => s.sats >= s.li.quantity * s.li.unitSats)) {
      if (p.status === 'paid') return { applied: false, reason: 'no change', paymentStatus: 'paid', payouts: p.payouts };
      p.status = 'paid';
      p.payouts = settlements.map((s) => ({ id: `pyo_mem${++this.n}`, payee: s.li.payee!, amountSats: s.sats, txid: observation.txid, vout: s.vout, status: 'settled' }));
      return { applied: true, paymentStatus: 'paid', payouts: p.payouts };
    }
    p.status = 'underpaid';
    return { applied: true, paymentStatus: 'underpaid', payouts: [] };
  }
}
