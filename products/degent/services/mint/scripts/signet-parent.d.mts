/** Types for signet-parent.mjs (plain ESM so it runs bundled with bare `node` on the server). */
import type { InscriptionContent } from '@bsh/inscription';

export type TestNetwork = 'signet' | 'testnet' | 'regtest';
export const TEST_NETWORKS: string[];
export const DEFAULTS: { network: TestNetwork; esplora: string; ord: string; postage: bigint; minUtxo: bigint };

export interface Utxo {
  txid: string;
  vout: number;
  value: bigint;
  confirmed?: boolean;
}
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function keyAddress(keyHex: string, network: string): { key: Uint8Array; pubkey: Uint8Array; address: string; script: Uint8Array };
export function parentContent(): InscriptionContent;
export function memberContent(n: number): InscriptionContent;

export interface InscriptionPlan {
  address: string;
  destination: string;
  commitAddress: string;
  commitValue: bigint;
  postage: bigint;
  feeRate: number;
  inputs: Utxo[];
  commit: { hex: string; txid: string; vsize: number; fee: bigint };
  reveal: { hex: string; txid: string; vsize: number; fee: bigint };
  inscriptionId: string;
  outpoint: string;
  contentSha256: string;
  contentBytes: number;
}
export function planInscription(args: {
  network: string;
  keyHex: string;
  utxos: Utxo[];
  feeRate: number;
  content: InscriptionContent;
  destination: string;
  postage?: bigint;
}): InscriptionPlan;

export function esploraClient(
  baseUrl: string,
  fetchImpl: FetchLike,
): { utxos(address: string): Promise<Utxo[]>; feeRate(): Promise<number>; broadcast(hex: string): Promise<string | null> };
export function ordInscriptionsAt(ordUrl: string, outpoint: string, fetchImpl: FetchLike): Promise<string[]>;
export function appendRoster(existing: unknown, entry: { inscriptionId: string; bytes: number }): {
  version: 1;
  collection: string;
  network: 'signet';
  count: number;
  members: Array<{ n: number; inscriptionId: string; bytes: number }>;
};

export interface RunResult {
  ok: boolean;
  kind: 'parent' | 'member' | 'address';
  network: string;
  dryRun?: boolean;
  resumed?: boolean;
  commitTxid?: string;
  revealTxid?: string;
  inscriptionId?: string;
  outpoint?: string;
  destination?: string;
  fees?: { commit: bigint; reveal: bigint; feeRate: number };
  env?: Record<string, string>;
  roster?: { network: string; count: number; members: Array<{ n: number; inscriptionId: string; bytes: number }> };
}
export function run(argv: string[], opts?: { fetchImpl?: FetchLike; log?: (line: string) => void; env?: Record<string, string | undefined> }): Promise<RunResult>;
export class UsageError extends Error {}
