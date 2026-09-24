/** Types for reconcile.mjs (plain ESM so reconcile-count.mjs runs with bare `node`). */
export interface Claim {
  label?: string;
  count: number;
  megabytes: number;
}
export const DEFAULT_CLAIMS: Readonly<Required<Claim>>;
export const INTERNAL_ANALYSIS: Readonly<Required<Claim>>;

export interface RosterRow {
  n: number;
  id: string;
  sizeKb: number | null;
  bytes: number | null;
}
export function normaliseRoster(raw: unknown): RosterRow[];
export function parseExport(text: string): string[];

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;
export interface OrdSizes {
  sizes: Map<string, number>;
  failures: Array<{ id: string; error: string }>;
  fetched: number;
  cached: number;
}
export function fetchOrdSizes(
  ids: string[],
  opts: { baseUrl: string; fetch?: FetchLike; cache?: Record<string, { content_length: number }>; concurrency?: number },
): Promise<OrdSizes>;

export interface Units {
  bytes: number;
  MB: number;
  MiB: number;
}
export interface Discrepancy {
  class: string;
  source?: string;
  count: number;
  explanation: string;
  examples: unknown;
}
export interface ClaimResult {
  source: string;
  count: { claimed: number; certified: number; delta: number; explanation: string };
  megabytes: {
    claimed: number;
    certified: Units;
    bytesSource: string;
    candidates: Array<{ label: string; value: number; relativeError: number }>;
    bestMatch: string;
    explanation: string;
  };
}
export interface Report {
  version: 1;
  kind: 'degent.club/count-reconciliation';
  inputs: { rosterRows: number; exportRows: number | null; ordUrl: string | null; claims: Array<Required<Claim>> };
  certified: { count: number; bytes: number; MB: number; MiB: number; bytesSource: string; statement: string };
  roster: {
    rows: number;
    uniqueIds: number;
    duplicateIds: Array<{ id: string; n: number[] }>;
    duplicateNumbers: number[];
    gaps: number[];
    malformed: Array<{ n: number; id: string }>;
    highestNumber: number;
  };
  export: null | {
    rows: number;
    unique: number;
    duplicates: Array<{ id: string; times: number }>;
    malformed: string[];
    missingFromExport: Array<{ n: number; id: string }>;
    extraInExport: string[];
  };
  bytes: {
    roster: { sizeKbSum: number; estimate: Units; fromSizeKbAsKB: Units; note: string };
    ord: null | {
      url: string | null;
      covered: number;
      of: number;
      fetched: number;
      cached: number;
      failures: Array<{ id: string; error: string }>;
      contentLength: Units;
      mismatches: Array<{ n: number; id: string; rosterBytes: number; ordContentLength: number; delta: number }>;
    };
  };
  claims: ClaimResult[];
  discrepancies: Discrepancy[];
}
export function reconcile(opts: { roster: unknown; exportIds?: string[] | null; ord?: OrdSizes | null; ordUrl?: string | null; claims?: Claim | Claim[] }): Report;
export function toMarkdown(report: Report): string;
