/**
 * The bundled collection snapshot (`src/data/collection.json`, generated from the legacy
 * Degent-Marketplace `collection.json`: public on-chain data). It is loaded with a dynamic import so
 * the ~500 KB list is its own chunk and only fetched by pages that need it.
 *
 * It is a FALLBACK: stats shown from it are labelled "bundled manifest, not certified".
 */
import type { CollectionItem, CollectionStats } from './types';

export const COLLECTION_SUPPLY = 10_000;

let cache: Promise<CollectionItem[]> | null = null;

export function loadBundledCollection(): Promise<CollectionItem[]> {
  cache ??= import('../../data/collection.json').then((m) => {
    const rows = (m.default ?? m) as unknown as CollectionItem[];
    return [...rows].sort((a, b) => a.number - b.number);
  });
  return cache;
}

/** Summary of a membership list: count and total bytes (size_kb x 1000, rounded). */
export function summarise(items: readonly CollectionItem[]): { minted: number; bytes: number } {
  let bytes = 0;
  for (const it of items) bytes += Math.round((it.size_kb ?? 0) * 1000);
  return { minted: items.length, bytes };
}

export async function bundledStats(): Promise<CollectionStats> {
  const items = await loadBundledCollection();
  const { minted, bytes } = summarise(items);
  return { source: 'bundled', supply: COLLECTION_SUPPLY, minted, bytes, certifiedHeight: null, certifiedAt: null };
}
