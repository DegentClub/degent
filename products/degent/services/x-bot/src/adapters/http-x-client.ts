/**
 * X API v2 `POST /2/tweets` with a user-context OAuth 2.0 access token (scope tweet.write). Injectable fetch; the
 * token is never logged or echoed in errors. Only the Publisher calls this, and only for drafts that passed the gate.
 */
import type { XClient } from '../ports/x-client.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class HttpXClient implements XClient {
  constructor(
    private readonly opts: { accessToken: string; baseUrl?: string; fetch?: FetchLike },
  ) {
    if (!opts.accessToken) throw new Error('HttpXClient: accessToken required');
  }

  async post(text: string): Promise<{ id: string }> {
    const f: FetchLike = this.opts.fetch ?? ((i, init) => globalThis.fetch(i, init));
    const res = await f(`${(this.opts.baseUrl ?? 'https://api.x.com').replace(/\/+$/, '')}/2/tweets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.opts.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const body = (await res.json().catch(() => null)) as { data?: { id?: string }; title?: string; detail?: string } | null;
    if (!res.ok || !body?.data?.id) throw new Error(`X API ${res.status}: ${body?.detail ?? body?.title ?? 'no tweet id in response'}`);
    return { id: body.data.id };
  }
}
