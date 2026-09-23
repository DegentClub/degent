/** Real GateApi: a plain JSON POST to the configured Telegram gate service. */
import type { GateApi } from '../types';

export function createRealGate(fetchImpl: typeof fetch = (i, init) => globalThis.fetch(i, init)): GateApi {
  return {
    async submit(url, body) {
      const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
      const text = await res.text();
      let parsed: { invite?: string; message?: string; error?: { message?: string } } = {};
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = {};
      }
      if (!res.ok) return { ok: false, message: parsed.error?.message ?? parsed.message ?? `HTTP ${res.status}` };
      return { ok: true, ...(parsed.invite ? { invite: parsed.invite } : {}), ...(parsed.message ? { message: parsed.message } : {}) };
    },
  };
}
