/**
 * Legacy membership manifest. A collection that predates parent/child provenance (degent.club's
 * first 4,112 items) lists its members here. The manifest only counts once it is itself inscribed
 * as a child of the collection parent: that parent link is the collection's signature.
 *
 * ```json
 * { "collection": "degent", "items": [{ "inscriptionId": "<txid>i0", "sha256": "…", "contentLength": 355975 }],
 *   "manifestInscriptionId": "<txid>i0" }
 * ```
 *
 * `manifestInscriptionId` is only meaningful in an off-chain copy (it points at where the manifest
 * was inscribed; an inscription cannot know its own id). It is excluded from `manifestSha256`.
 */
import { canonicalJson } from './canonical-json.js';
import { sha256Hex } from './hash.js';
import { INSCRIPTION_ID, SLUG } from './model.js';

export interface ManifestItem {
  inscriptionId: string;
  /** Hex sha256 of the content bytes; when present, the content is fetched and checked. */
  sha256?: string;
  /** Exact content length in bytes; when present, must equal ord's content_length. */
  contentLength?: number;
}

export interface Manifest {
  collection: string;
  items: ManifestItem[];
  manifestInscriptionId?: string;
}

export class ManifestError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(issues.length ? `${message}: ${issues.slice(0, 5).join('; ')}${issues.length > 5 ? ` (+${issues.length - 5} more)` : ''}` : message);
    this.name = 'ManifestError';
  }
}

const HEX32 = /^[0-9a-f]{64}$/;
const ITEM_KEYS = new Set(['inscriptionId', 'sha256', 'contentLength']);
const TOP_KEYS = new Set(['collection', 'items', 'manifestInscriptionId']);

/** Strict parse: unknown keys, bad ids, duplicates and malformed hashes are all errors. */
export function parseManifest(value: unknown): Manifest {
  const issues: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ManifestError('manifest must be a JSON object');
  const v = value as Record<string, unknown>;
  for (const k of Object.keys(v)) if (!TOP_KEYS.has(k)) issues.push(`unknown key "${k}"`);
  if (typeof v.collection !== 'string' || !SLUG.test(v.collection)) issues.push('collection must be a slug');
  if (v.manifestInscriptionId !== undefined && (typeof v.manifestInscriptionId !== 'string' || !INSCRIPTION_ID.test(v.manifestInscriptionId)))
    issues.push('manifestInscriptionId must be an inscription id');
  if (!Array.isArray(v.items)) issues.push('items must be an array');
  const items: ManifestItem[] = [];
  const seen = new Set<string>();
  if (Array.isArray(v.items))
    v.items.forEach((raw, i) => {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return void issues.push(`items[${i}] must be an object`);
      const it = raw as Record<string, unknown>;
      for (const k of Object.keys(it)) if (!ITEM_KEYS.has(k)) issues.push(`items[${i}]: unknown key "${k}"`);
      if (typeof it.inscriptionId !== 'string' || !INSCRIPTION_ID.test(it.inscriptionId))
        return void issues.push(`items[${i}].inscriptionId must be an inscription id`);
      if (seen.has(it.inscriptionId)) issues.push(`items[${i}]: duplicate ${it.inscriptionId}`);
      seen.add(it.inscriptionId);
      const out: ManifestItem = { inscriptionId: it.inscriptionId };
      if (it.sha256 !== undefined) {
        if (typeof it.sha256 !== 'string' || !HEX32.test(it.sha256)) issues.push(`items[${i}].sha256 must be 64 lowercase hex`);
        else out.sha256 = it.sha256;
      }
      if (it.contentLength !== undefined) {
        if (typeof it.contentLength !== 'number' || !Number.isSafeInteger(it.contentLength) || it.contentLength < 0)
          issues.push(`items[${i}].contentLength must be a non-negative integer`);
        else out.contentLength = it.contentLength;
      }
      items.push(out);
    });
  if (issues.length) throw new ManifestError('invalid manifest', issues);
  const m: Manifest = { collection: v.collection as string, items };
  if (typeof v.manifestInscriptionId === 'string') m.manifestInscriptionId = v.manifestInscriptionId;
  return m;
}

/** sha256 of the canonical JSON of `{collection, items}` (the part that gets inscribed). */
export function manifestSha256(m: Manifest): string {
  return sha256Hex(canonicalJson({ collection: m.collection, items: m.items }));
}

/**
 * The exact bytes to inscribe for a manifest: canonical JSON of `{collection, items}`. Inscribe
 * these with content type `application/json` as a child of the collection parent.
 */
export function manifestInscriptionBody(m: Manifest): string {
  return canonicalJson({ collection: m.collection, items: m.items });
}

// ---- Degent-Marketplace/collection.json conversion ----------------------------------------------

/** One entry of the hand-maintained `Degent-Marketplace/collection.json` array. */
export interface CollectionJsonEntry {
  name: string;
  inscription_id: string;
  inscription_number: number;
  sat: number;
  /** Rounded kilobytes; ambiguous (1000 vs 1024) and lossy, so never used as contentLength. */
  size_kb: number;
}

export interface ConversionReport {
  manifest: Manifest;
  entries: number;
  /** Informational only: sum of `size_kb` as the hand-maintained file states it. */
  declaredSizeKb: number;
}

/**
 * Converts `collection.json` (an array of {name, inscription_id, inscription_number, sat, size_kb})
 * to a manifest. Order is preserved. Fails loudly on a malformed entry or a duplicate id: a silently
 * dropped member would be certified as "not in the collection".
 */
export function manifestFromCollectionJson(json: unknown, collection: string): ConversionReport {
  if (!SLUG.test(collection)) throw new ManifestError(`collection slug "${collection}" is invalid`);
  if (!Array.isArray(json)) throw new ManifestError('collection.json must be a JSON array');
  const issues: string[] = [];
  const seen = new Map<string, number>();
  const items: ManifestItem[] = [];
  let declaredSizeKb = 0;
  json.forEach((e, i) => {
    const entry = e as Partial<CollectionJsonEntry> | null;
    const label = typeof entry?.name === 'string' ? `[${i}] "${entry.name}"` : `[${i}]`;
    if (!entry || typeof entry !== 'object') return void issues.push(`${label}: not an object`);
    const id = entry.inscription_id;
    if (typeof id !== 'string' || !INSCRIPTION_ID.test(id)) return void issues.push(`${label}: bad inscription_id ${JSON.stringify(id)}`);
    const prev = seen.get(id);
    if (prev !== undefined) return void issues.push(`${label}: duplicate of [${prev}] ${id}`);
    seen.set(id, i);
    if (typeof entry.size_kb === 'number' && Number.isFinite(entry.size_kb)) declaredSizeKb += entry.size_kb;
    items.push({ inscriptionId: id });
  });
  if (issues.length) throw new ManifestError('collection.json has invalid entries', issues);
  return { manifest: { collection, items }, entries: items.length, declaredSizeKb: Math.round(declaredSizeKb * 100) / 100 };
}
