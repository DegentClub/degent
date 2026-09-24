/**
 * OpenAI Images adapter: `gpt-image-1` first, `dall-e-3` as fallback when the primary model is not
 * available to the key (model_not_found / permission errors), never on content or rate errors.
 * fetch is injectable for tests; the key is only ever placed in the Authorization header and every
 * error message is scrubbed before it leaves this module.
 */
import { ProviderError, scrub } from '../domain/errors.js';
import type { FetchLike, GenerateRequest, GeneratedImage, ImageProvider } from './image-provider.js';

export interface OpenAiImageProviderOptions {
  apiKey: string;
  fetch?: FetchLike;
  baseUrl?: string;
  model?: string;
  fallbackModel?: string | null;
  /** gpt-image-1 quality knob; dall-e-3 maps it to 'standard' | 'hd'. */
  quality?: 'low' | 'medium' | 'high';
  timeoutMs?: number;
  /** Per-image cost estimate in cents (list price for 1024x1024 at the chosen quality). */
  costCentsPerImage?: number;
}

interface ImagesResponse {
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  error?: { message?: string; code?: string | null; type?: string };
}

/** List prices, 1024x1024: gpt-image-1 low 1.1c / medium 4.2c / high 16.7c; dall-e-3 standard 4c. */
const DEFAULT_COST: Record<string, number> = { low: 2, medium: 5, high: 17 };

export class OpenAiImageProvider implements ImageProvider {
  readonly name: string;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fallbackModel: string | null;
  private readonly quality: 'low' | 'medium' | 'high';
  private readonly timeoutMs: number;
  private readonly costCents: number;
  private readonly key: string;

  constructor(opts: OpenAiImageProviderOptions) {
    if (!opts.apiKey) throw new Error('OpenAiImageProvider needs an apiKey');
    this.key = opts.apiKey;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.model = opts.model ?? 'gpt-image-1';
    this.fallbackModel = opts.fallbackModel === undefined ? 'dall-e-3' : opts.fallbackModel;
    this.quality = opts.quality ?? 'medium';
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.costCents = opts.costCentsPerImage ?? DEFAULT_COST[this.quality]!;
    this.name = `openai:${this.model}`;
  }

  estimateCostCents(req: Pick<GenerateRequest, 'n' | 'size'>): number {
    return this.costCents * req.n;
  }

  async generate(req: GenerateRequest): Promise<GeneratedImage[]> {
    try {
      return await this.call(this.model, req);
    } catch (e) {
      if (e instanceof ModelUnavailable && this.fallbackModel && this.fallbackModel !== this.model) return this.call(this.fallbackModel, req);
      throw e;
    }
  }

  private async call(model: string, req: GenerateRequest): Promise<GeneratedImage[]> {
    // dall-e-3 only takes n=1; loop. gpt-image-1 takes n directly.
    const perCall = model.startsWith('dall-e') ? 1 : req.n;
    const out: GeneratedImage[] = [];
    while (out.length < req.n) {
      const n = Math.min(perCall, req.n - out.length);
      const body: Record<string, unknown> = { model, prompt: req.prompt, n, size: req.size };
      if (model.startsWith('dall-e')) {
        body.response_format = 'b64_json';
        body.quality = this.quality === 'high' ? 'hd' : 'standard';
      } else {
        body.quality = this.quality;
        body.output_format = 'png';
        body.moderation = 'auto';
      }
      const json = await this.post('/images/generations', body, model);
      const items = json.data ?? [];
      if (items.length === 0) throw new ProviderError('image provider returned no images', `openai ${model}: empty data`, true);
      for (const it of items) {
        if (!it.b64_json) throw new ProviderError('image provider returned an unusable image', `openai ${model}: item without b64_json`, true);
        const bytes = new Uint8Array(Buffer.from(it.b64_json, 'base64'));
        out.push({ bytes, mime: sniffMime(bytes), providerRef: `openai:${model}${it.revised_prompt ? `:${it.revised_prompt.slice(0, 200)}` : ''}` });
      }
    }
    return out.slice(0, req.n);
  }

  private async post(path: string, body: unknown, model: string): Promise<ImagesResponse> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key}` },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch (e) {
      throw new ProviderError('image provider unreachable', scrub(`openai ${model}: ${e instanceof Error ? e.message : String(e)}`), true);
    } finally {
      clearTimeout(timer);
    }
    let json: ImagesResponse = {};
    try {
      json = (await res.json()) as ImagesResponse;
    } catch {
      /* non-JSON body: handled by status below */
    }
    if (res.ok) return json;
    const code = json.error?.code ?? '';
    const internal = scrub(`openai ${model}: HTTP ${res.status} ${code} ${json.error?.message ?? ''}`.trim());
    if (res.status === 404 || code === 'model_not_found' || (res.status === 403 && /model|verif/i.test(json.error?.message ?? ''))) throw new ModelUnavailable(internal);
    if (res.status === 400 && /safety|moderation|content_policy/i.test(`${code} ${json.error?.type ?? ''} ${json.error?.message ?? ''}`))
      throw new ProviderError('the image provider declined this brief; try different wording', internal, false);
    if (res.status === 401) throw new ProviderError('image provider rejected our credentials', internal, false);
    throw new ProviderError('image provider error', internal, res.status === 429 || res.status >= 500);
  }
}

class ModelUnavailable extends ProviderError {
  constructor(internal: string) {
    super('image model unavailable', internal, false);
    this.name = 'ModelUnavailable';
  }
}

export function sniffMime(b: Uint8Array): GeneratedImage['mime'] {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'image/webp';
  return 'image/png';
}
