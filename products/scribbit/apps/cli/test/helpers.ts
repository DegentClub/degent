import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { FetchLike } from '@bsh/scribbit-fee-oracle';
import { run, type CliIO } from '../src/index.js';

export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

export interface Harness {
  files?: Record<string, Uint8Array | string>;
  fetch?: FetchLike;
  stdin?: string;
}

/** Run the CLI in-process with a virtual FS (falling back to the real one for fixtures) and no network. */
export async function cli(argv: string[], h: Harness = {}) {
  let stdout = '';
  let stderr = '';
  const fetchCalls: string[] = [];
  const io: CliIO = {
    stdout: (t) => void (stdout += t),
    stderr: (t) => void (stderr += t),
    readFile: async (p) => {
      const v = h.files?.[p];
      if (v !== undefined) return typeof v === 'string' ? new TextEncoder().encode(v) : v;
      return new Uint8Array(await readFile(p));
    },
    readStdin: async () => h.stdin ?? '',
    fetch: async (url, init) => {
      fetchCalls.push(url);
      if (!h.fetch) throw new Error(`unexpected network access in test: ${url}`);
      return h.fetch(url, init);
    },
    env: {},
  };
  const code = await run(argv, io);
  const json = () => JSON.parse(stdout);
  return { code, stdout, stderr, json, fetchCalls };
}

/** Deterministic pseudo-random bytes (xorshift). */
export function bytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed | 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

export function fakeFetch(routes: Record<string, unknown | (() => unknown)>): FetchLike {
  return async (url) => {
    if (!(url in routes)) return new Response('not found', { status: 404 });
    const v = routes[url];
    const out = typeof v === 'function' ? (v as () => unknown)() : v;
    return out instanceof Response ? out : Response.json(out);
  };
}

export const PARENT_ID = `${'cc'.repeat(32)}i0`;
