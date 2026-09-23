/**
 * Client-side helpers for talking to our own API routes, plus the file rules
 * shared between the browser and the server.
 */

/** Operator rule: images must be 200-400 KB. The floor is a house rule for the collection, not a protocol limit. */
export const MIN_FILE_BYTES = 200 * 1024;
export const MAX_FILE_BYTES = 400 * 1024;
/** Hard cap the proxy will ever accept, regardless of the collection rule. */
export const ABSOLUTE_MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

export const ACCEPTED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
export type AcceptedMime = (typeof ACCEPTED_MIME_TYPES)[number];

export function isAcceptedMime(type: string): type is AcceptedMime {
  return (ACCEPTED_MIME_TYPES as readonly string[]).includes(type);
}

export function isFileSizeValid(bytes: number): boolean {
  return bytes >= MIN_FILE_BYTES && bytes <= MAX_FILE_BYTES;
}

export function formatFileSize(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

export interface InscriptionResponse {
  payment_address: string;
  required_amount_in_sats: string;
  inscription_id: string;
}

export interface CommitQuote {
  paymentAddress: string;
  amountSats: number;
  inscriptionId: string;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly requestId?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface CreateCommitParams {
  file: File;
  recipientAddress: string;
  feeRate: number;
  senderAddress: string;
  signal?: AbortSignal;
}

export async function createInscriptionCommit(params: CreateCommitParams): Promise<CommitQuote> {
  const formData = new FormData();
  formData.append('file', params.file);
  formData.append('recipient_address', params.recipientAddress);
  formData.append('fee_rate', params.feeRate.toString());
  formData.append('sender_address', params.senderAddress);

  const res = await fetch('/api/inscriptions/create-commit', {
    method: 'POST',
    body: formData,
    signal: params.signal,
  });

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    const b = (body ?? {}) as { error?: unknown; requestId?: unknown };
    const message = typeof b.error === 'string' ? b.error : `Request failed (${res.status})`;
    throw new ApiError(message, res.status, typeof b.requestId === 'string' ? b.requestId : undefined);
  }

  const data = body as Partial<InscriptionResponse> | null;
  const amountSats = Number.parseInt(String(data?.required_amount_in_sats ?? ''), 10);
  if (!data?.payment_address || !Number.isInteger(amountSats) || amountSats <= 0) {
    throw new ApiError('The quote returned by the server was incomplete.', 502);
  }
  return {
    paymentAddress: data.payment_address,
    amountSats,
    inscriptionId: String(data.inscription_id ?? ''),
  };
}

/** SHA-256 of the file contents as hex; used to key quotes to exact bytes. */
export async function hashFile(file: Blob): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
