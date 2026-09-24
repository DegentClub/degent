/**
 * The platform ledger as the mint's client (deps/scribbit/contracts/openapi/ledger.yaml, plan §3.5,
 * ADR-0009). The mint creates one ledger order per artwork order with payee line items and a `psbt`
 * payment intent; the ledger observes the funding transaction itself and records payouts. The ledger never
 * moves money and the mint never blocks on it.
 */
export type LedgerPayeeKind = 'artist' | 'club' | 'platform' | 'other';

export interface LedgerPayee {
  kind: LedgerPayeeKind;
  /** Opaque, never PII (an address is fine: it is on chain). */
  ref: string;
  address?: string;
  scriptHex?: string;
}

export interface LedgerLineItem {
  sku: string;
  description: string;
  quantity: number;
  unitSats: number;
  payee?: LedgerPayee;
}

export interface LedgerCreateOrderInput {
  customerRef: string;
  lineItems: LedgerLineItem[];
  metadata?: Record<string, string>;
  /** `Idempotency-Key`: replays return the original order. */
  idempotencyKey: string;
}

export interface LedgerExpectedOutput {
  scriptHex: string;
  valueSats: number;
  address?: string;
}

export interface LedgerCreatePsbtPaymentInput {
  expiresAt?: string;
  idempotencyKey: string;
}

/** `POST /v1/payments/{id}/observations` (ledger 1.2): the funding transaction as the mint saw it. */
export interface LedgerObservation {
  txid: string;
  /** Every output of the transaction, in vout order. */
  outputs: Array<{ scriptHex: string; valueSats: number }>;
  confirmations: number;
  rbfSignalled: boolean;
}

export interface LedgerObservationResult {
  applied: boolean;
  reason?: string;
  paymentStatus: string;
  /** Payouts recorded for the payment so far (one per payee output once paid). */
  payouts: Array<{ id: string; payee: LedgerPayee; amountSats: number; txid: string; vout: number; status: string }>;
}

export class LedgerClientError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'LedgerClientError';
  }
}

export interface LedgerClient {
  readonly name: string;
  createOrder(input: LedgerCreateOrderInput): Promise<{ id: string; totalSats: number }>;
  /** `POST /v1/orders/{id}/payments` with `method: psbt`; returns the outputs the ledger expects. */
  createPsbtPayment(ledgerOrderId: string, input: LedgerCreatePsbtPaymentInput): Promise<{ id: string; outputs: LedgerExpectedOutput[] }>;
  /** Report the observed funding transaction; the ledger evaluates it and records payouts once paid. Reporting twice is harmless. */
  observePayment(paymentId: string, observation: LedgerObservation): Promise<LedgerObservationResult>;
}
