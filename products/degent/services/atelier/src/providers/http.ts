/**
 * Generic HTTP image provider for Stability / Replicate-style JSON APIs. Configured, not coded:
 * a URL, headers (the key goes into one of them), a body template with `{{prompt}}` / `{{negative}}`
 * / `{{seed}}` placeholders, and a response style. Images come back as base64 (inline) or as URLs
 * that are fetched (only from the provider's own host unless `allowedImageHosts` says otherwise).
 */
import { ProviderError, scrub } from '../domain/errors.js';
import { sniffMime } from './openai.js';
import type { FetchLike, GenerateRequest, GeneratedImage, ImageProvider } from './image-provider.js';

export type HttpProviderStyle = 'stability' | 'replicate' | 'generic';

export interface HttpImageProviderOptions {
  name?: string;
  url: string;
  /** Header name that carries the key, e.g. `authorization` -> `Bearer <key>`. */
  apiKey?: string | null;
  authHeader?: string;
  authScheme?: 'bearer' | 'raw';
  extraHeaders?: Record<string, string>;
  style?: HttpProviderStyle;
  /** JSON body; string values may use {{prompt}}, {{negative}}, {{seed}}, {{n}}. Defaults per style. */
  bodyTemplate?: Record<string, unknown>;
  /** Extract images from the response JSON. Defaults per style. */
  extract?: (json: unknown) => Array<{ b64?: string; url?: string; ref?: string }>;
  allowedImageHosts?: string[];
  fetch?: FetchLike;
  timeoutMs?: number;
  costCentsPerImage?: number;
  /** Replicate-style async predictions: poll `urls.get` until status is succeeded. */
  pollIntervalMs?: number;
}

const TEMPLATES: Record<HttpProviderStyle, Record<string, unknown>> = {
  stability: { prompt: '{{prompt}}', negative_prompt: '{{negative}}', aspect_ratio: '1:1', output_format: 'png', seed: '{{seed}}' },
  replicate: { input: { prompt: '{{prompt}}', negative_prompt: '{{negative}}', width: 1024, height: 1024, num_outputs: '{{n}}', seed: '{{seed}}' } },
  generic: { prompt: '{{prompt}}', negative_prompt: '{{negative}}', width: 1024, height: 1024, n: '{{n}}', seed: '{{seed}}' },
};

function fill(v: unknown, vars: Record<string, string | number | undefined>): unknown {
  if (typeof v === 'string') {
    const m = /^\{\{(\w+)\}\}$/.exec(v);
    if (m) return vars[m[1]!];
    return v.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(vars[k] ?? ''));
  }
  if (Array.isArray(v)) return v.map((x) => fill(x, vars));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const f = fill(x, vars);
      if (f !== undefined) out[k] = f;
    }
    return out;
  }
  return v;
}

/** Looks for the common shapes: data[].b64_json|url, artifacts[].base64, images[], output[]. */
export function defaultExtract(json: unknown): Array<{ b64?: string; url?: string; ref?: string }> {
  if (!json || typeof json !== 'object') return [];
  const j = json as Record<string, unknown>;
  const list = (j.artifacts ?? j.data ?? j.images ?? j.output ?? j.outputs) as unknown;
  if (typeof j.image === 'string') return [{ b64: j.image }];
  if (!Array.isArray(list)) return [];
  return list.flatMap((it): Array<{ b64?: string; url?: string; ref?: string }> => {
    if (typeof it === 'string') return [/^https?:\/\//.test(it) ? { url: it } : { b64: it }];
    if (it && typeof it === 'object') {
      const o = it as Record<string, unknown>;
      const b64 = (o.base64 ?? o.b64_json ?? o.b64 ?? o.image) as string | undefined;
      const url = (o.url ?? o.image_url) as string | undefined;
      const ref = (o.seed !== undefined ? `seed:${String(o.seed)}` : undefined) ?? (o.id as string | undefined);
      if (b64 || url) return [{ ...(b64 ? { b64 } : {}), ...(url ? { url } : {}), ...(ref ? { ref } : {}) }];
    }
    return [];
  });
}

export class HttpImageProvider implements ImageProvider {
  readonly name: string;
  private readonly o: Required<Pick<HttpImageProviderOptions, 'style' | 'timeoutMs' | 'pollIntervalMs' | 'authHeader' | 'authScheme'>> & HttpImageProviderOptions;
  private readonly fetchImpl: FetchLike;
  private readonly host: string;

  constructor(opts: HttpImageProviderOptions) {
    this.o = { style: 'generic', timeoutMs: 120_000, pollIntervalMs: 1500, authHeader: 'authorization', authScheme: 'bearer', ...opts };
    this.name = opts.name ?? `http:${this.o.style}`;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.host = new URL(opts.url).host;
  }

  estimateCostCents(req: Pick<GenerateRequest, 'n' | 'size'>): number {
    return (this.o.costCentsPerImage ?? 4) * req.n;
  }

  async generate(req: GenerateRequest): Promise<GeneratedImage[]> {
    const vars = { prompt: req.prompt, negative: (req.negative ?? []).join(', '), seed: req.seed, n: req.n };
    const body = fill(this.o.bodyTemplate ?? TEMPLATES[this.o.style], vars);
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json', ...(this.o.extraHeaders ?? {}) };
    if (this.o.apiKey) headers[this.o.authHeader] = this.o.authScheme === 'bearer' ? `Bearer ${this.o.apiKey}` : this.o.apiKey;
    let json = await this.request(this.o.url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (this.o.style === 'replicate') json = await this.pollPrediction(json, headers);
    const items = (this.o.extract ?? defaultExtract)(json);
    if (items.length === 0) throw new ProviderError('image provider returned no images', `${this.name}: no images in response`, true);
    const out: GeneratedImage[] = [];
    for (const it of items.slice(0, req.n)) {
      let bytes: Uint8Array;
      if (it.b64) bytes = new Uint8Array(Buffer.from(it.b64.replace(/^data:[^,]+,/, ''), 'base64'));
      else if (it.url) bytes = await this.download(it.url, headers);
      else continue;
      out.push({ bytes, mime: sniffMime(bytes), providerRef: `${this.name}${it.ref ? `:${it.ref}` : ''}` });
    }
    if (out.length === 0) throw new ProviderError('image provider returned no usable images', `${this.name}: items without b64/url`, true);
    return out;
  }

  private async pollPrediction(json: unknown, headers: Record<string, string>): Promise<unknown> {
    const deadline = Date.now() + this.o.timeoutMs;
    let cur = json as { status?: string; urls?: { get?: string }; error?: unknown };
    while (cur.status && !['succeeded', 'failed', 'canceled'].includes(cur.status)) {
      if (Date.now() > deadline) throw new ProviderError('image provider timed out', `${this.name}: prediction still ${cur.status}`, true);
      if (!cur.urls?.get) break;
      await new Promise((r) => setTimeout(r, this.o.pollIntervalMs));
      cur = (await this.request(cur.urls.get, { method: 'GET', headers })) as typeof cur;
    }
    if (cur.status === 'failed' || cur.status === 'canceled') throw new ProviderError('image provider could not generate this brief', scrub(`${this.name}: ${cur.status} ${String(cur.error ?? '')}`), false);
    return cur;
  }

  private async download(url: string, headers: Record<string, string>): Promise<Uint8Array> {
    const u = new URL(url);
    const allowed = [this.host, ...(this.o.allowedImageHosts ?? [])];
    if (u.protocol !== 'https:' || !allowed.some((h) => u.host === h || u.host.endsWith(`.${h}`)))
      throw new ProviderError('image provider returned an image from an unexpected host', `${this.name}: refused ${u.host}`, false);
    const res = await this.fetchImpl(u, { method: 'GET', headers: u.host === this.host ? headers : {} });
    if (!res.ok) throw new ProviderError('image provider image download failed', `${this.name}: HTTP ${res.status} fetching image`, true);
    return new Uint8Array(await res.arrayBuffer());
  }

  private async request(url: string, init: RequestInit): Promise<unknown> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.o.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, signal: ctl.signal });
    } catch (e) {
      throw new ProviderError('image provider unreachable', scrub(`${this.name}: ${e instanceof Error ? e.message : String(e)}`), true);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* handled below */
    }
    if (!res.ok) {
      const internal = scrub(`${this.name}: HTTP ${res.status} ${text.slice(0, 300)}`);
      if (res.status === 401 || res.status === 403) throw new ProviderError('image provider rejected our credentials', internal, false);
      if (res.status === 400 && /safety|moderation|nsfw|content/i.test(text)) throw new ProviderError('the image provider declined this brief; try different wording', internal, false);
      throw new ProviderError('image provider error', internal, res.status === 429 || res.status >= 500);
    }
    if (json === null) throw new ProviderError('image provider returned an unreadable response', `${this.name}: non-JSON body`, true);
    return json;
  }
}
