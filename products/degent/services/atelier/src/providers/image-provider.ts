/**
 * Generation provider port. One method; adapters for OpenAI Images, a generic HTTP provider and a
 * deterministic fake. Adapters must:
 *   - never log or throw the API key (wrap failures in ProviderError with a scrubbed `internal`);
 *   - return decoded bytes (never URLs) so the rest of the service is provider-agnostic;
 *   - report a cost estimate so the ledger can enforce the daily cap before spending.
 */
export interface GenerateRequest {
  prompt: string;
  /** Things the image must not contain; adapters without a negative-prompt field ignore it (the scaffold already inlines them). */
  negative?: string[];
  size: '1024x1024';
  /** 1..4 images. */
  n: number;
  /** Optional determinism hint; only some providers honour it. */
  seed?: number;
}

export interface GeneratedImage {
  bytes: Uint8Array;
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  /** Opaque provider reference (model + revised prompt / id), safe to persist and show. */
  providerRef: string;
}

export interface ImageProvider {
  readonly name: string;
  /** Estimated cost of a request in US cents, charged to the ledger before the call. */
  estimateCostCents(req: Pick<GenerateRequest, 'n' | 'size'>): number;
  generate(req: GenerateRequest): Promise<GeneratedImage[]>;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
