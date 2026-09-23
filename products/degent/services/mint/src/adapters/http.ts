export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
}

export function httpClient(opts: HttpOptions = {}) {
  const f: FetchLike = opts.fetch ?? ((i, init) => globalThis.fetch(i, init));
  const timeoutMs = opts.timeoutMs ?? 15_000;
  return (url: string, init: RequestInit = {}) => f(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
}

export const trimSlash = (u: string) => u.replace(/\/+$/, '');
