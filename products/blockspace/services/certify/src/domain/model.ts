/** Domain types. They mirror contracts/openapi/blockspace-collections.yaml exactly. */

export const INSCRIPTION_ID = /^[0-9a-f]{64}i\d+$/;
export const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const ATTESTATION_TAG = 'block.space/collection-attestation/v1';

export type SourceType = 'parent-children' | 'manifest';
export type Method = 'parent-children' | 'manifest' | 'parent-children+manifest';

export type ExclusionReason =
  | 'not_found'
  | 'parent_link_missing'
  | 'after_as_of_height'
  | 'content_length_mismatch'
  | 'sha256_mismatch'
  | 'content_unavailable';

export interface Exclusion {
  inscriptionId: string;
  source: SourceType;
  reason: ExclusionReason;
  detail?: string;
}

export interface CollectionRef {
  slug: string;
  name: string;
  parentInscriptionId: string | null;
}

export interface ParentSource {
  type: 'parent-children';
  parentInscriptionId: string;
  pages: number;
  listed: number;
  accepted: number;
  excluded: number;
}

export interface ManifestSource {
  type: 'manifest';
  manifestInscriptionId: string | null;
  manifestSha256: string;
  verified: boolean;
  listed: number;
  accepted: number;
  excluded: number;
}

export type Source = ParentSource | ManifestSource;

/** One certified member. `contentLength` is ord's content_length (null → 0: an empty body). */
export interface Item {
  inscriptionId: string;
  number: number;
  contentLength: number;
  contentType: string | null;
  height: number;
  sources: SourceType[];
}

export interface Stats {
  itemCount: number;
  excludedCount: number;
  totalContentBytes: number;
  minItemBytes: number | null;
  maxItemBytes: number | null;
  medianItemBytes: number | null;
  firstInscriptionNumber: number | null;
  lastInscriptionNumber: number | null;
  totalRevealVbytes: number | null;
  revealTxCount: number | null;
  itemsDigest: string;
}

export interface UnsignedAttestation {
  collection: CollectionRef;
  method: Method;
  sources: Source[];
  stats: Stats;
  asOfBlockHeight: number;
  issuedAt: string;
  keyId: string;
}

export interface Attestation extends UnsignedAttestation {
  /** BIP340 signature, 64 bytes hex. */
  signature: string;
}

/** What a refresh persists: the signed attestation plus the unsigned-but-digested detail. */
export interface Snapshot {
  attestation: Attestation;
  /** Hex of the signed 32-byte digest. */
  digest: string;
  /** Members, sorted by (number, inscriptionId). Their digest is `attestation.stats.itemsDigest`. */
  items: Item[];
  exclusions: Exclusion[];
}
