/** Types for chain-prep.mjs (plain ESM so the prepare-* scripts run with bare `node`). */
export const CLUB_NAME: string;
export const CHARTER_SIZE: number;
export const GALLERY_SIZE: number;
export const DEFAULT_POSTAGE_SATS: number;
export const MAX_CHARTER_BYTES: number;
export const MAX_GALLERY_BYTES: number;
export const MAX_METADATA_BYTES: number;
export const NETWORKS: string[];

export type CborValue = null | boolean | number | string | Uint8Array | CborValue[] | { [k: string]: CborValue | undefined };

export function parseArgs(argv: string[]): Record<string, string | true>;
export function sha256Hex(bytes: Uint8Array | string): string;
export function utf8(s: string): Uint8Array;
export function encodeCbor(value: CborValue): Uint8Array;
export function decodeCbor(bytes: Uint8Array): unknown;

export function charterHtml(opts?: { name?: string; charter?: number; gallerySize?: number }): string;
export function parentMetadata(opts?: { name?: string; charter?: number }): { name: string; charter: string };

export interface Gallery {
  version: 1;
  members: Array<{ n: number; id: string }>;
}
export function buildGallery(roster: unknown, count?: number): Gallery;
export function galleryBytes(gallery: Gallery): Uint8Array;
export function galleryMessage(sha256hex: string, parent: unknown, count?: number): string;
export function galleryMetadata(opts: { parent: string; sha256: string; count?: number; signingAddress: string; signature: string }): Record<string, string | number>;

export function shq(s: string | number): string;
export function ordInscribeCommand(opts: {
  network: string;
  feeRate: number;
  postage: number;
  file: string;
  cborMetadata: string;
  destination: string;
  parent?: string;
}): string;
export function ordSendCommand(opts: { network: string; feeRate: number; address: string; inscription: string }): string;
export function isInscriptionId(s: unknown): boolean;
export function fileEntry(path: string, bytes: Uint8Array): { path: string; bytes: number; sha256: string };

export interface PlanStep {
  id: string;
  who: 'owner';
  run: string | null;
  expect: string;
  after?: string[];
  message?: string;
  done?: boolean;
  verify?: Array<{ run: string; expect: unknown }>;
}
export interface Plan {
  version: 1;
  kind: 'degent.club/chain-setup/parent' | 'degent.club/chain-setup/gallery';
  network: string;
  cwd: string;
  inputs: Record<string, unknown>;
  files: Array<{ path: string; bytes: number; sha256: string }>;
  limits: Array<{ name: string; value: number; max: number; ok: boolean }>;
  fees: string;
  steps: PlanStep[];
  env: Record<string, { from?: string; value?: string; how: string }>;
  gallery?: { count: number; sha256: string; bytes: number; message: string };
  next?: string;
}
export interface Prepared {
  files: Record<string, Uint8Array>;
  plan: Plan;
}
export function prepareParent(opts: {
  network: string;
  feeRate: number | string;
  postage?: number | string;
  destination?: string;
  collectionAddress?: string;
  name?: string;
  charter?: number | string;
}): Prepared;
export function prepareGallery(opts: {
  network: string;
  feeRate: number | string;
  postage?: number | string;
  parent: string;
  signingAddress: string;
  signature?: string;
  destination?: string;
  count?: number;
  roster: unknown;
  /** Only echoed into the pass-2 command of the plan. */
  rosterPath?: string;
}): Prepared;
