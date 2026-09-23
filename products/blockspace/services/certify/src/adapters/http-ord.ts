/**
 * OrdPort over ord's HTTP server (JSON API, `Accept: application/json`):
 *
 *   GET /r/blockheight               → 912345                       (JSON number)
 *   GET /inscription/<id>            → { id, number, height, content_length, content_type, parents: [..], … }
 *                                      (ord < 0.19 used a single `parent` field; both are read)
 *   GET /r/children/<id>/<page>      → { ids: [..], more: bool, page: n }   (100 ids per page)
 *   GET /content/<id>                → raw bytes
 *   GET /tx/<txid>                   → { txid, transaction: { version, lock_time, input: [..], output: [..] }, … }
 *
 * Children are read from the recursive endpoint `/r/children/<id>/<page>` because it is the JSON
 * form in every ord release; `childrenPath: 'children'` switches to `/children/<id>/<page>` for ord
 * builds that serve JSON there. Shapes are checked; anything unexpected throws `OrdError` (502 at the
 * API) rather than being guessed at.
 */
import { OrdError, type OrdChildrenPage, type OrdInscription, type OrdPort } from '../ports/ord.js';

export interface HttpOrdOptions {
  baseUrl: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  /** Retries for network errors / 5xx / 429 on these idempotent GETs. Default 2. */
  retries?: number;
  childrenPath?: 'r/children' | 'children';
  sleep?: (ms: number) => Promise<void>;
}

const HEX_TXID = /^[0-9a-f]{64}$/;
const ID = /^[0-9a-f]{64}i\d+$/;

export class HttpOrd implements OrdPort {
  private readonly base: string;
  private readonly f: (url: string, init: RequestInit) => Promise<Response>;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly childrenPath: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(o: HttpOrdOptions) {
    this.base = o.baseUrl.replace(/\/+$/, '');
    this.f = o.fetch ?? ((u, i) => fetch(u, i));
    this.timeoutMs = o.timeoutMs ?? 20_000;
    this.retries = o.retries ?? 2;
    this.childrenPath = o.childrenPath ?? 'r/children';
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async request(path: string, accept: string): Promise<Response | null> {
    let last: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await this.sleep(Math.min(4_000, 200 * 2 ** (attempt - 1)));
      try {
        const res = await this.f(this.base + path, { headers: { accept }, signal: AbortSignal.timeout(this.timeoutMs) });
        if (res.status === 404) return null;
        if (res.ok) return res;
        last = new OrdError(`ord ${path} -> HTTP ${res.status}`, res.status);
        if (res.status !== 429 && res.status < 500) throw last;
      } catch (e) {
        if (e instanceof OrdError && e.status !== undefined && e.status !== 429 && e.status < 500) throw e;
        last = e;
      }
    }
    throw last instanceof OrdError ? last : new OrdError(`ord ${path} unreachable: ${last instanceof Error ? last.message : String(last)}`);
  }

  private async json(path: string): Promise<unknown | null> {
    const res = await this.request(path, 'application/json');
    if (!res) return null;
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new OrdError(`ord ${path} returned non-JSON (is the server in JSON-API mode?)`);
    }
  }

  async blockHeight(): Promise<number> {
    const v = await this.json('/r/blockheight');
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new OrdError('ord /r/blockheight: expected a non-negative integer');
    return v;
  }

  async inscription(id: string): Promise<OrdInscription | null> {
    assertId(id);
    const v = (await this.json(`/inscription/${id}`)) as Record<string, unknown> | null;
    if (v === null) return null;
    const bad = (f: string) => new OrdError(`ord /inscription/${id}: unexpected ${f}`);
    if (typeof v !== 'object' || Array.isArray(v)) throw bad('body');
    if (v.id !== id) throw bad('id');
    if (typeof v.number !== 'number' || !Number.isSafeInteger(v.number)) throw bad('number');
    if (typeof v.height !== 'number' || !Number.isSafeInteger(v.height)) throw bad('height');
    const cl = v.content_length;
    if (cl !== null && cl !== undefined && (typeof cl !== 'number' || !Number.isSafeInteger(cl) || cl < 0)) throw bad('content_length');
    const ct = v.content_type;
    if (ct !== null && ct !== undefined && typeof ct !== 'string') throw bad('content_type');
    let parents: string[];
    if (Array.isArray(v.parents)) parents = v.parents as string[];
    else if (v.parents === undefined) parents = typeof v.parent === 'string' ? [v.parent] : [];
    else throw bad('parents');
    if (!parents.every((p) => typeof p === 'string' && ID.test(p))) throw bad('parents');
    return {
      id,
      number: v.number,
      height: v.height,
      contentLength: (cl as number | null | undefined) ?? null,
      contentType: (ct as string | null | undefined) ?? null,
      parents,
    };
  }

  async children(parentId: string, page: number): Promise<OrdChildrenPage> {
    assertId(parentId);
    const path = `/${this.childrenPath}/${parentId}/${page}`;
    const v = (await this.json(path)) as Record<string, unknown> | null;
    if (v === null) throw new OrdError(`ord ${path}: parent not found`, 404);
    if (!Array.isArray(v.ids) || !v.ids.every((x) => typeof x === 'string' && ID.test(x)) || typeof v.more !== 'boolean')
      throw new OrdError(`ord ${path}: unexpected body`);
    return { ids: v.ids as string[], more: v.more, page: typeof v.page === 'number' ? v.page : page };
  }

  async content(id: string): Promise<Uint8Array | null> {
    assertId(id);
    const res = await this.request(`/content/${id}`, '*/*');
    return res ? new Uint8Array(await res.arrayBuffer()) : null;
  }

  async txVsize(txid: string): Promise<number | null> {
    if (!HEX_TXID.test(txid)) throw new OrdError(`bad txid ${txid}`);
    const v = (await this.json(`/tx/${txid}`)) as { transaction?: unknown } | null;
    if (v === null) return null;
    return ordTransactionVsize(v.transaction);
  }
}

function assertId(id: string): void {
  if (!ID.test(id)) throw new OrdError(`bad inscription id ${JSON.stringify(id)}`);
}

// ---- transaction size from ord's JSON transaction ------------------------------------------------

/** Bitcoin CompactSize length prefix. */
function compactSizeLen(n: number): number {
  return n < 0xfd ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9;
}

function hexLen(h: unknown, what: string): number {
  if (typeof h !== 'string' || h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new OrdError(`ord /tx: bad ${what}`);
  return h.length / 2;
}

/**
 * vsize = ceil(weight / 4), weight = 4 × non-witness size + witness size (BIP141), computed from
 * ord's serde form of `bitcoin::Transaction`:
 * `{ version, lock_time, input: [{ previous_output, script_sig, sequence, witness: [hex] }], output: [{ value, script_pubkey }] }`.
 */
export function ordTransactionVsize(tx: unknown): number {
  const t = tx as { input?: unknown; output?: unknown } | null;
  if (!t || typeof t !== 'object' || !Array.isArray(t.input) || !Array.isArray(t.output)) throw new OrdError('ord /tx: unexpected transaction');
  let base = 4 + compactSizeLen(t.input.length) + compactSizeLen(t.output.length) + 4;
  let witness = 0;
  let hasWitness = false;
  for (const i of t.input as Record<string, unknown>[]) {
    const ss = hexLen(i.script_sig, 'script_sig');
    base += 32 + 4 + compactSizeLen(ss) + ss + 4;
    if (!Array.isArray(i.witness)) throw new OrdError('ord /tx: bad witness');
    witness += compactSizeLen(i.witness.length);
    for (const w of i.witness) {
      const l = hexLen(w, 'witness item');
      witness += compactSizeLen(l) + l;
    }
    if (i.witness.length) hasWitness = true;
  }
  for (const o of t.output as Record<string, unknown>[]) {
    const spk = hexLen(o.script_pubkey, 'script_pubkey');
    base += 8 + compactSizeLen(spk) + spk;
  }
  const weight = base * 4 + (hasWitness ? 2 + witness : 0);
  return Math.ceil(weight / 4);
}
