/**
 * Environment + collections-file parsing (env.schema.json documents the variables). Collects every
 * problem and throws once, so a misconfigured deploy reports all of them.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseManifest } from './domain/manifest.js';
import { INSCRIPTION_ID, SLUG } from './domain/model.js';
import type { CollectionConfig } from './application/certify-service.js';

export interface Config {
  port: number;
  host: string;
  ord: { kind: 'http'; url: string; timeoutMs: number; childrenPath: 'r/children' | 'children' } | { kind: 'fake' };
  adminToken: string;
  /** null only in dev mode: a random key is generated per process. */
  signingKeyHex: string | null;
  collections: CollectionConfig[];
  concurrency: number;
  dev: boolean;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
}

/** Parses the collections file: `{ "collections": [ { slug, name, parentInscriptionId?, manifest?: { inscriptionId?, path? }, allowUnverifiedManifest?, revealVbytes? } ] }`. */
export function parseCollections(raw: unknown, baseDir: string, readFile: (p: string) => string = (p) => readFileSync(p, 'utf8')): CollectionConfig[] {
  const problems: string[] = [];
  const list = (raw as { collections?: unknown } | null)?.collections;
  if (!Array.isArray(list)) throw new ConfigError(['collections file must be { "collections": [...] }']);
  const out: CollectionConfig[] = [];
  const slugs = new Set<string>();
  list.forEach((c: Record<string, unknown>, i) => {
    const at = `collections[${i}]`;
    if (typeof c?.slug !== 'string' || !SLUG.test(c.slug)) return void problems.push(`${at}.slug must match ${SLUG}`);
    if (slugs.has(c.slug)) problems.push(`${at}: duplicate slug ${c.slug}`);
    slugs.add(c.slug);
    if (typeof c.name !== 'string' || !c.name) problems.push(`${at}.name is required`);
    const parent = c.parentInscriptionId ?? null;
    if (parent !== null && (typeof parent !== 'string' || !INSCRIPTION_ID.test(parent))) problems.push(`${at}.parentInscriptionId must be an inscription id`);
    const cfg: CollectionConfig = { slug: c.slug, name: String(c.name ?? ''), parentInscriptionId: parent as string | null };
    if (c.allowUnverifiedManifest !== undefined) cfg.allowUnverifiedManifest = c.allowUnverifiedManifest === true;
    if (c.revealVbytes !== undefined) cfg.revealVbytes = c.revealVbytes !== false;
    const m = c.manifest as { inscriptionId?: unknown; path?: unknown } | undefined;
    if (m !== undefined) {
      cfg.manifest = {};
      if (m.inscriptionId !== undefined) {
        if (typeof m.inscriptionId !== 'string' || !INSCRIPTION_ID.test(m.inscriptionId)) problems.push(`${at}.manifest.inscriptionId must be an inscription id`);
        else cfg.manifest.inscriptionId = m.inscriptionId;
      }
      if (m.path !== undefined) {
        try {
          cfg.manifest.document = parseManifest(JSON.parse(readFile(resolve(baseDir, String(m.path)))));
        } catch (e) {
          problems.push(`${at}.manifest.path: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (!cfg.manifest.inscriptionId && !cfg.manifest.document) problems.push(`${at}.manifest needs inscriptionId or path`);
    }
    if (!parent && !cfg.manifest) problems.push(`${at} needs a parentInscriptionId and/or a manifest`);
    out.push(cfg);
  });
  if (problems.length) throw new ConfigError(problems);
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv, readFile: (p: string) => string = (p) => readFileSync(p, 'utf8')): Config {
  const problems: string[] = [];
  const dev = env.CERTIFY_DEV === '1';
  const int = (name: string, dflt: number, min: number, max: number): number => {
    const v = env[name];
    if (v === undefined || v === '') return dflt;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${name} must be an integer ${min}..${max}`);
      return dflt;
    }
    return n;
  };

  let ord: Config['ord'] = { kind: 'fake' };
  if (env.CERTIFY_ORD === 'fake') {
    if (!dev) problems.push('CERTIFY_ORD=fake requires CERTIFY_DEV=1');
  } else {
    const url = env.CERTIFY_ORD_URL ?? '';
    if (!/^https?:\/\/\S+$/.test(url)) problems.push('CERTIFY_ORD_URL must be an http(s) URL');
    const cp = env.CERTIFY_ORD_CHILDREN_PATH ?? 'r/children';
    if (cp !== 'r/children' && cp !== 'children') problems.push('CERTIFY_ORD_CHILDREN_PATH must be r/children or children');
    ord = { kind: 'http', url, timeoutMs: int('CERTIFY_ORD_TIMEOUT_MS', 20_000, 100, 300_000), childrenPath: cp as 'r/children' };
  }

  const adminToken = env.CERTIFY_ADMIN_TOKEN ?? '';
  if (adminToken.length < 16) problems.push('CERTIFY_ADMIN_TOKEN must be at least 16 characters');

  let signingKeyHex: string | null = env.CERTIFY_SIGNING_KEY ?? null;
  if (signingKeyHex !== null && !/^[0-9a-fA-F]{64}$/.test(signingKeyHex)) problems.push('CERTIFY_SIGNING_KEY must be 64 hex characters');
  if (signingKeyHex === null && !dev) problems.push('CERTIFY_SIGNING_KEY is required (CERTIFY_DEV=1 generates an ephemeral key)');
  if (signingKeyHex) signingKeyHex = signingKeyHex.toLowerCase();

  let collections: CollectionConfig[] = [];
  const file = env.CERTIFY_COLLECTIONS_FILE;
  if (!file) problems.push('CERTIFY_COLLECTIONS_FILE is required');
  else {
    try {
      collections = parseCollections(JSON.parse(readFile(file)), dirname(resolve(file)), readFile);
    } catch (e) {
      if (e instanceof ConfigError) problems.push(...e.problems);
      else problems.push(`CERTIFY_COLLECTIONS_FILE: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const cfg: Config = {
    port: int('PORT', 8787, 1, 65535),
    host: env.HOST || '127.0.0.1',
    ord,
    adminToken,
    signingKeyHex,
    collections,
    concurrency: int('CERTIFY_CONCURRENCY', 8, 1, 64),
    dev,
  };
  if (problems.length) throw new ConfigError(problems);
  return cfg;
}
