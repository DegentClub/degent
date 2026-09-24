/** Real GateApi: JSON POSTs to the Telegram gate service (contracts/openapi/degent-telegram-gate.yaml). */
import type { GateApi, GateResult } from '../types';

export const GATE_CHALLENGE_PATH = '/gate/challenge';
export const GATE_VERIFY_PATH = '/gate/verify';

export function createRealGate(fetchImpl: typeof fetch = (i, init) => globalThis.fetch(i, init)): GateApi {
  async function postJson<T>(url: string, body: unknown): Promise<GateResult<T>> {
    let res: Response;
    try {
      res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : 'The gate could not be reached.' };
    }
    const text = await res.text();
    let parsed: Record<string, unknown> & { error?: { message?: string } } = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }
    if (!res.ok) return { ok: false, message: parsed.error?.message ?? (typeof parsed.message === 'string' ? parsed.message : `HTTP ${res.status}`) };
    return { ...(parsed as T), ok: true };
  }
  return {
    challenge: (base, body) => postJson(`${base}${GATE_CHALLENGE_PATH}`, body),
    submit: (base, body) => postJson(`${base}${GATE_VERIFY_PATH}`, body),
  };
}
