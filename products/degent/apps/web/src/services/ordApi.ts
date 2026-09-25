/**
 * Typed client for the few ord server reads the site needs beyond the mint (`GET /inscription/{id}` as
 * JSON, `/content/{id}` for images). ord is the chain's view of an inscription: the lightbox shows its
 * owner address, timestamp and fee next to what the block.space attestation certifies. Every field is
 * read defensively: an ord that omits one simply leaves it out of the lightbox.
 */

export interface OrdInscription {
  id: string;
  number: number | null;
  /** Current owner address (ord omits it for unspendable outputs). */
  address: string | null;
  contentType: string | null;
  contentLength: number | null;
  /** Unix seconds of the reveal block. */
  timestamp: number | null;
  height: number | null;
  /** Reveal fee in sats. */
  fee: number | null;
  sat: number | null;
}

export interface OrdApi {
  getInscription(id: string): Promise<OrdInscription>;
  /** URL of the inscribed bytes for <img>. */
  contentUrl(id: string): string;
  /** Human page on the ord explorer ("View on Ordinals.com"). */
  inscriptionUrl(id: string): string;
}

export class OrdApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'OrdApiError';
    this.status = status;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const INSCRIPTION_ID = /^[0-9a-f]{64}i[0-9]+$/;
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** ord's JSON (`/inscription/{id}` with `Accept: application/json`, or `/r/inscription/{id}`) → OrdInscription. */
export function parseOrdInscription(id: string, v: unknown): OrdInscription {
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  return {
    id: str(o.id) ?? id,
    number: int(o.number),
    address: str(o.address),
    contentType: str(o.content_type) ?? str(o.effective_content_type),
    contentLength: int(o.content_length),
    timestamp: int(o.timestamp),
    height: int(o.height),
    fee: int(o.fee),
    sat: int(o.sat),
  };
}

/** "View on Ordinals.com": the public explorer for the network (regtest has none: the configured ord). */
export function ordinalsExplorerBase(network: 'mainnet' | 'testnet' | 'signet' | 'regtest', fallback: string): string {
  switch (network) {
    case 'mainnet':
      return 'https://ordinals.com';
    case 'testnet':
      return 'https://testnet4.ordinals.com';
    case 'signet':
      return 'https://signet.ordinals.com';
    case 'regtest':
      return fallback.replace(/\/+$/, '');
  }
}

export function createOrdApi(opts: { baseUrl: string; network?: 'mainnet' | 'testnet' | 'signet' | 'regtest'; fetch?: FetchLike }): OrdApi {
  const explorer = ordinalsExplorerBase(opts.network ?? 'mainnet', opts.baseUrl);
  const f: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const base = opts.baseUrl.replace(/\/+$/, '');
  return {
    async getInscription(id) {
      if (!INSCRIPTION_ID.test(id)) throw new OrdApiError(400, `Not an inscription id: ${id}`);
      let res: Response;
      try {
        res = await f(`${base}/inscription/${id}`, { headers: { accept: 'application/json' } });
      } catch (e) {
        throw new OrdApiError(0, `ord could not be reached: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!res.ok) throw new OrdApiError(res.status, `ord request failed (HTTP ${res.status})`);
      return parseOrdInscription(id, await res.json());
    },
    contentUrl: (id) => `${base}/content/${id}`,
    inscriptionUrl: (id) => `${explorer}/inscription/${id}`,
  };
}
