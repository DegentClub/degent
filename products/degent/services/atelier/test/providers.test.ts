import { describe, expect, it } from 'vitest';
import { ProviderError, scrub } from '../src/domain/errors.js';
import { FakeImageProvider } from '../src/providers/fake.js';
import { HttpImageProvider } from '../src/providers/http.js';
import type { FetchLike } from '../src/providers/image-provider.js';
import { OpenAiImageProvider } from '../src/providers/openai.js';

const KEY = 'sk-test-SECRET-abcdefghijklmnop';
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64');
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function recorder(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit; body: any }> = [];
  const fetch: FetchLike = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : null });
    return handler(url, init);
  };
  return { calls, fetch };
}

describe('OpenAiImageProvider', () => {
  it('calls gpt-image-1 with the prompt, n and size, decodes b64 and sends the key only in the header', async () => {
    const r = recorder(() => json(200, { data: [{ b64_json: PNG_B64 }, { b64_json: PNG_B64 }] }));
    const p = new OpenAiImageProvider({ apiKey: KEY, fetch: r.fetch });
    const out = await p.generate({ prompt: 'a gentleman frog', size: '1024x1024', n: 2 });
    expect(out).toHaveLength(2);
    expect(out[0]!.mime).toBe('image/png');
    expect(out[0]!.providerRef).toBe('openai:gpt-image-1');
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.url).toBe('https://api.openai.com/v1/images/generations');
    expect(r.calls[0]!.body).toMatchObject({ model: 'gpt-image-1', prompt: 'a gentleman frog', n: 2, size: '1024x1024' });
    expect((r.calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(r.calls[0]!.body)).not.toContain(KEY);
    expect(p.estimateCostCents({ n: 3, size: '1024x1024' })).toBe(15);
  });

  it('falls back to dall-e-3 (one image per call, b64 response) when gpt-image-1 is not available to the key', async () => {
    const r = recorder((_u, init) => {
      const body = JSON.parse(String(init.body));
      if (body.model === 'gpt-image-1') return json(404, { error: { code: 'model_not_found', message: `The model gpt-image-1 does not exist (key ${KEY})` } });
      return json(200, { data: [{ b64_json: PNG_B64, revised_prompt: 'a dapper frog' }] });
    });
    const out = await new OpenAiImageProvider({ apiKey: KEY, fetch: r.fetch }).generate({ prompt: 'x', size: '1024x1024', n: 2 });
    expect(out).toHaveLength(2);
    expect(r.calls.map((c) => c.body.model)).toEqual(['gpt-image-1', 'dall-e-3', 'dall-e-3']);
    expect(r.calls[1]!.body).toMatchObject({ n: 1, response_format: 'b64_json' });
    expect(out[0]!.providerRef).toBe('openai:dall-e-3:a dapper frog');
  });

  it('does not fall back on content-policy or rate-limit errors, and never exposes the key or the raw message', async () => {
    const policy = recorder(() => json(400, { error: { code: 'moderation_blocked', type: 'image_generation_user_error', message: `blocked by safety system; key=${KEY}` } }));
    const e1 = await new OpenAiImageProvider({ apiKey: KEY, fetch: policy.fetch }).generate({ prompt: 'x', size: '1024x1024', n: 1 }).catch((e) => e);
    expect(e1).toBeInstanceOf(ProviderError);
    expect(e1.message).toBe('the image provider declined this brief; try different wording');
    expect(e1.retryable).toBe(false);
    expect(e1.internal).not.toContain(KEY);
    expect(policy.calls).toHaveLength(1);

    const limited = recorder(() => json(429, { error: { message: 'Rate limit reached' } }));
    const e2 = await new OpenAiImageProvider({ apiKey: KEY, fetch: limited.fetch }).generate({ prompt: 'x', size: '1024x1024', n: 1 }).catch((e) => e);
    expect(e2.message).toBe('image provider error');
    expect(e2.retryable).toBe(true);
    expect(limited.calls).toHaveLength(1);
  });

  it('wraps network failures without leaking the Authorization header', async () => {
    const fetch: FetchLike = async (_u, init) => {
      throw new Error(`connect ECONNREFUSED while sending ${(init?.headers as Record<string, string>).authorization}`);
    };
    const e = await new OpenAiImageProvider({ apiKey: KEY, fetch }).generate({ prompt: 'x', size: '1024x1024', n: 1 }).catch((x) => x);
    expect(e.message).toBe('image provider unreachable');
    expect(e.internal).not.toContain(KEY);
    expect(e.internal).toContain('[redacted]');
  });

  it('refuses to construct without a key', () => {
    expect(() => new OpenAiImageProvider({ apiKey: '' })).toThrow(/apiKey/);
  });
});

describe('HttpImageProvider', () => {
  it('stability style: fills the body template, raw auth header, reads base64 artifacts', async () => {
    const r = recorder(() => json(200, { artifacts: [{ base64: PNG_B64, seed: 42 }] }));
    const p = new HttpImageProvider({ url: 'https://api.stability.example/v2/generate', apiKey: KEY, authHeader: 'x-api-key', authScheme: 'raw', style: 'stability', fetch: r.fetch });
    const out = await p.generate({ prompt: 'frog', negative: ['text', 'logos'], size: '1024x1024', n: 1, seed: 42 });
    expect(out[0]!.providerRef).toBe('http:stability:seed:42');
    expect(r.calls[0]!.body).toEqual({ prompt: 'frog', negative_prompt: 'text, logos', aspect_ratio: '1:1', output_format: 'png', seed: 42 });
    expect((r.calls[0]!.init.headers as Record<string, string>)['x-api-key']).toBe(KEY);
  });

  it('replicate style: polls the prediction until it succeeds, then downloads outputs from the provider host only', async () => {
    let polls = 0;
    const r = recorder((url) => {
      if (url.endsWith('/predictions')) return json(201, { status: 'starting', urls: { get: 'https://api.replicate.example/v1/predictions/abc' } });
      if (url.endsWith('/predictions/abc')) return ++polls < 2 ? json(200, { status: 'processing', urls: { get: 'https://api.replicate.example/v1/predictions/abc' } }) : json(200, { status: 'succeeded', output: ['https://cdn.replicate.example/out/1.png'] });
      if (url === 'https://cdn.replicate.example/out/1.png') return new Response(Buffer.from(PNG_B64, 'base64'));
      return json(404, {});
    });
    const p = new HttpImageProvider({ url: 'https://api.replicate.example/v1/predictions', apiKey: KEY, style: 'replicate', pollIntervalMs: 1, fetch: r.fetch, allowedImageHosts: ['replicate.example'] });
    const out = await p.generate({ prompt: 'frog', size: '1024x1024', n: 1 });
    expect(out[0]!.mime).toBe('image/png');
    expect(r.calls[0]!.body.input).toMatchObject({ prompt: 'frog', num_outputs: 1, width: 1024 });
    const download = r.calls.find((c) => c.url.startsWith('https://cdn.'))!;
    expect((download.init.headers as Record<string, string>).authorization).toBeUndefined(); // key not sent to a different host

    const evil = recorder((url) => (url.endsWith('/predictions') ? json(200, { status: 'succeeded', output: ['https://evil.example/x.png'] }) : json(200, {})));
    const e = await new HttpImageProvider({ url: 'https://api.replicate.example/v1/predictions', style: 'replicate', fetch: evil.fetch }).generate({ prompt: 'f', size: '1024x1024', n: 1 }).catch((x) => x);
    expect(e.message).toBe('image provider returned an image from an unexpected host');
  });

  it('maps HTTP errors to safe messages', async () => {
    const r = recorder(() => new Response(`upstream exploded, token=${KEY}`, { status: 502 }));
    const e = await new HttpImageProvider({ url: 'https://gen.example/api', apiKey: KEY, fetch: r.fetch }).generate({ prompt: 'f', size: '1024x1024', n: 1 }).catch((x) => x);
    expect(e.message).toBe('image provider error');
    expect(e.retryable).toBe(true);
    expect(e.internal).not.toContain(KEY);
  });
});

describe('FakeImageProvider', () => {
  it('is deterministic per prompt/seed and varies across variations', async () => {
    const p = new FakeImageProvider();
    const a = await p.generate({ prompt: 'pharaoh', size: '1024x1024', n: 2 });
    const b = await p.generate({ prompt: 'pharaoh', size: '1024x1024', n: 2 });
    expect(Buffer.from(a[0]!.bytes).equals(Buffer.from(b[0]!.bytes))).toBe(true);
    expect(Buffer.from(a[0]!.bytes).equals(Buffer.from(a[1]!.bytes))).toBe(false);
    const c = await p.generate({ prompt: 'pharaoh', size: '1024x1024', n: 1, seed: 7 });
    expect(c[0]!.providerRef).toBe('fake:7');
  });
});

describe('scrub', () => {
  it('redacts bearer tokens, sk- keys and key=value secrets', () => {
    expect(scrub(`Authorization: Bearer ${KEY}`)).not.toContain('SECRET');
    expect(scrub(`use ${KEY} now`)).toBe('use sk-[redacted] now');
    expect(scrub('api_key=abcdef123456 rest')).toBe('api_key=[redacted] rest');
  });
});
