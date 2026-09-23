import { addressToScript, encodeParentId, LIMITS, type InscriptionContent, type Network } from '@bsh/inscription';
import { rejected, usage, type FlagSpec, type ParsedArgs } from './args.js';
import type { CliIO } from './io.js';

export const NETWORKS: readonly Network[] = ['mainnet', 'testnet', 'signet', 'regtest'];

export const GLOBAL_FLAGS: Record<string, FlagSpec> = {
  json: { type: 'boolean', description: 'Print one JSON object on stdout (errors too)' },
  help: { type: 'boolean', short: 'h', description: 'Show help for this command' },
};

export const CONTENT_FLAGS: Record<string, FlagSpec> = {
  'content-type': { type: 'string', arg: '<mime>', description: 'MIME type (default: inferred from the file extension)' },
  parent: { type: 'string', arg: '<id>', description: 'Parent inscription id "<txid>i<index>" (adds the parent tag)' },
  metadata: { type: 'string', arg: '<file>', description: 'CBOR metadata file (tag 5)' },
};

export const NETWORK_FLAG: FlagSpec = { type: 'string', arg: '<net>', description: 'mainnet | testnet | signet | regtest' };

const MIME: Record<string, string> = {
  txt: 'text/plain;charset=utf-8',
  md: 'text/markdown;charset=utf-8',
  html: 'text/html;charset=utf-8',
  htm: 'text/html;charset=utf-8',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  pdf: 'application/pdf',
  wasm: 'application/wasm',
  cbor: 'application/cbor',
};

export function inferContentType(path: string): string | undefined {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return m ? MIME[m[1]!.toLowerCase()] : undefined;
}

export function parseNetwork(v: unknown, fallback?: Network): Network {
  if (v === undefined) {
    if (fallback) return fallback;
    throw usage('--network is required (mainnet | testnet | signet | regtest)');
  }
  if (typeof v !== 'string' || !(NETWORKS as readonly string[]).includes(v))
    throw usage(`invalid --network "${String(v)}" (mainnet | testnet | signet | regtest)`);
  return v as Network;
}

export async function readInput(io: CliIO, path: string, what = 'file'): Promise<Uint8Array> {
  try {
    return await io.readFile(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    throw rejected('file_unreadable', `cannot read ${what} ${path}${code ? ` (${code})` : ''}`);
  }
}

export interface LoadedContent {
  path: string;
  content: InscriptionContent;
  contentTypeInferred: boolean;
}

/** `<file>` positional + content flags -> InscriptionContent (validated: content type, parent id). */
export async function loadContent(io: CliIO, args: ParsedArgs, command: string): Promise<LoadedContent> {
  const [path, ...rest] = args.positionals;
  if (!path) throw usage(`missing <file>: scribbit ${command} <file> ...`);
  if (rest.length) throw usage(`unexpected argument "${rest[0]}"`);
  const explicit = args.flags['content-type'] as string | undefined;
  const contentType = explicit ?? inferContentType(path);
  if (!contentType) throw usage(`cannot infer the content type of ${path}; pass --content-type <mime>`);
  if (new TextEncoder().encode(contentType).length > LIMITS.MAX_SCRIPT_ELEMENT_SIZE)
    throw usage(`--content-type is longer than ${LIMITS.MAX_SCRIPT_ELEMENT_SIZE} bytes`);
  const parentId = args.flags.parent as string | undefined;
  if (parentId !== undefined) {
    try {
      encodeParentId(parentId);
    } catch (e) {
      throw usage(`invalid --parent "${parentId}": ${(e as Error).message}`);
    }
  }
  const body = await readInput(io, path);
  const content: InscriptionContent = { contentType, body };
  if (parentId !== undefined) content.parentId = parentId;
  const metaPath = args.flags.metadata as string | undefined;
  if (metaPath !== undefined) content.metadata = await readInput(io, metaPath, 'metadata file');
  return { path, content, contentTypeInferred: explicit === undefined };
}

export function parsePubkey(v: unknown): Uint8Array {
  if (typeof v !== 'string') throw usage('--pubkey <xonly> is required (32-byte x-only public key, 64 hex chars)');
  let h = v.trim().toLowerCase();
  if (/^0[23][0-9a-f]{64}$/.test(h)) h = h.slice(2); // accept a compressed key, use its x coordinate
  if (!/^[0-9a-f]{64}$/.test(h)) throw usage(`invalid --pubkey: expected 64 hex chars (x-only), got ${v.length} chars`);
  return fromHex(h);
}

/** P2TR scriptPubKey with a placeholder key: weight depends only on the script length. */
export const PLACEHOLDER_P2TR = Uint8Array.from([0x51, 0x20, ...new Uint8Array(32)]);

export function recipientScript(address: unknown, network: Network): { script: Uint8Array; kind: string } {
  if (address === undefined) return { script: PLACEHOLDER_P2TR, kind: 'p2tr (assumed)' };
  try {
    const script = addressToScript(String(address), network);
    return { script, kind: scriptKind(script) };
  } catch (e) {
    throw usage(`invalid --recipient for ${network}: ${(e as Error).message}`);
  }
}

function scriptKind(s: Uint8Array): string {
  if (s.length === 34 && s[0] === 0x51 && s[1] === 0x20) return 'p2tr';
  if (s.length === 22 && s[0] === 0x00 && s[1] === 0x14) return 'p2wpkh';
  if (s.length === 34 && s[0] === 0x00 && s[1] === 0x20) return 'p2wsh';
  if (s.length === 23 && s[0] === 0xa9) return 'p2sh';
  if (s.length === 25 && s[0] === 0x76) return 'p2pkh';
  return 'other';
}

export function parseSats(v: unknown, name: string): bigint {
  if (typeof v !== 'string' || !/^\d+$/.test(v)) throw usage(`--${name} must be a whole number of sats`);
  return BigInt(v);
}

export function parsePositiveNumber(v: unknown, name: string): number {
  const n = typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
  if (!(Number.isFinite(n) && n > 0)) throw usage(`--${name} must be a positive number (sat/vB), got "${String(v)}"`);
  return n;
}

export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function fromHex(h: string): Uint8Array {
  if (h.length % 2 || /[^0-9a-f]/i.test(h)) throw new Error('invalid hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** 1234567 -> "1,234,567" */
export const fmt = (n: number | bigint) => n.toLocaleString('en-US');

/** Aligned "key  value" block for human output. */
export function table(rows: Array<[string, string]>, indent = ''): string {
  const w = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `${indent}${k.padEnd(w)}  ${v}`).join('\n');
}
