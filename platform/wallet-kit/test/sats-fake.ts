import { Recorder } from './helpers.js';

export type Handler = (params: unknown) => unknown;

/**
 * A sats-connect style provider: `request(method, params)` resolves JSON-RPC
 * envelopes. Unknown methods resolve `{ error: { code: -32601 } }` like the
 * real providers; handlers may throw to simulate a rejecting provider.
 */
export function fakeRpcProvider(handlers: Record<string, Handler>, envelope = true) {
  const rec = new Recorder();
  const listeners = new Map<string, Set<() => void>>();
  const p = {
    async request(method: string, params?: unknown) {
      rec.record(method, [params]);
      const h = handlers[method];
      if (!h) return { jsonrpc: '2.0', id: '1', error: { code: -32601, message: 'Method not found' } };
      let result: unknown;
      try {
        result = await h(params);
      } catch (e) {
        const env = (e as { __envelope?: unknown }).__envelope;
        if (env) return { jsonrpc: '2.0', id: '1', error: env };
        throw e;
      }
      return envelope ? { jsonrpc: '2.0', id: '1', result } : result;
    },
    addListener(ev: string, cb: () => void) {
      rec.record('addListener', [ev]);
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev)!.add(cb);
      return () => listeners.get(ev)!.delete(cb);
    },
  };
  const emit = (ev: string) => listeners.get(ev)?.forEach((cb) => cb());
  return { p, rec, emit, listeners, handlers };
}

/** sats-connect providers resolve errors as envelopes rather than rejecting. */
export function rpcError(code: number, message: string): never {
  throw Object.assign(new Error(message), { __envelope: { code, message } });
}
