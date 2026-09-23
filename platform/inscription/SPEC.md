# @bsh/inscription: public API specification

This is the contract other packages code against. Implementation lives in `src/`.
All byte values are `Uint8Array`; all amounts are **integer sats as `bigint`**; weights are integers (WU).

```ts
export type Network = 'mainnet' | 'testnet' | 'signet' | 'regtest';

export interface InscriptionContent {
  contentType: string;          // e.g. "image/webp"
  body: Uint8Array;             // exact bytes inscribed
  parentId?: string;            // "<txid>i<index>" parent inscription id (tag 3)
  metadata?: Uint8Array;        // optional CBOR (tag 5)
}

export const LIMITS: {
  MAX_STANDARD_TX_WEIGHT: 400_000;
  MAX_BLOCK_WEIGHT: 4_000_000;
  BLOCK_LANE_MAX_TX_WEIGHT: 3_990_000;   // headroom for header + coinbase
  MAX_SCRIPT_ELEMENT_SIZE: 520;
  DUST_P2TR: 330n;
  DEFAULT_POSTAGE: 546n;
};

export type Lane = 'standard' | 'block';

// Envelope + commit
export function buildInscriptionScript(revealPubkey: Uint8Array /*32-byte x-only*/, content: InscriptionContent): Uint8Array;
export function commitAddress(revealPubkey: Uint8Array, content: InscriptionContent, network: Network): {
  address: string; script: Uint8Array /* P2TR scriptPubKey */; leafScript: Uint8Array; controlBlock: Uint8Array; tapLeafHash: Uint8Array;
};
export function encodeParentId(id: string): Uint8Array;   // txid reversed + LE index, trailing zeros trimmed (ord format)

// Sizing (EXACT: tests assert == real signed tx weight)
export function estimateRevealWeight(args: { content: InscriptionContent; withParent: boolean; recipientScript: Uint8Array; parentReturnScript?: Uint8Array; parentInputScript?: Uint8Array }): number;
export function vsizeFromWeight(weight: number): number;  // ceil(weight/4)
export function laneFor(revealWeight: number): Lane | null; // null = too big for any lane

// Fees / quote maths
export function quoteReveal(args: { revealWeight: number; feeRate: number /* sat/vB, may be fractional */; postage: bigint }): {
  revealVsize: number; revealFee: bigint; commitValue: bigint /* = revealFee + postage */;
};

// Reveal construction (browser side). Signs input for the commit with SIGHASH_SINGLE|ANYONECANPAY (0x83).
export function buildHalfSignedReveal(args: {
  network: Network;
  revealPrivkey: Uint8Array;           // ephemeral K_e (32 bytes)
  content: InscriptionContent;
  commitOutpoint: { txid: string; vout: number };
  commitValue: bigint;
  recipientAddress: string;            // child output
  postage: bigint;
}): { psbtBase64: string; signature: Uint8Array /* 65 bytes incl. 0x83 */ };

// Service side: attach parent input/output (index 0) around the half-signed commit input (index 1).
export function attachParent(args: {
  network: Network;
  halfSignedPsbtBase64: string;
  parentOutpoint: { txid: string; vout: number };
  parentValue: bigint;
  parentScript: Uint8Array;            // scriptPubKey of the parent UTXO (P2TR)
  parentReturnAddress: string;
}): { psbtBase64: string };            // unsigned input 0, signed input 1

// Service side: sign the parent input (key-path P2TR) with the collection key. Used by the policy signer.
export function signParentInput(psbtBase64: string, parentPrivkey: Uint8Array): { psbtBase64: string };

// Finalize to raw hex. Throws if any input is unsigned.
export function finalizeReveal(psbtBase64: string): { hex: string; txid: string; weight: number; vsize: number };

// Self-rescue: [commit] -> [child] with the SAME 0x83 signature, no parent.
export function buildRescueReveal(args: { network: Network; halfSignedPsbtBase64: string }): { hex: string; txid: string; weight: number; vsize: number };

// Verification helpers (used by the service before storing a user-supplied half-signed reveal)
export function verifyHalfSignedReveal(args: {
  network: Network; psbtBase64: string; revealPubkey: Uint8Array; content: InscriptionContent;
  expectedCommitOutpoint: { txid: string; vout: number }; expectedCommitValue: bigint;
  expectedRecipientAddress: string; expectedPostage: bigint;
}): { ok: true } | { ok: false; reason: string };

// Utilities
export function sha256Hex(bytes: Uint8Array): string;
export function inscriptionIdFromReveal(revealTxid: string, index?: number): string; // "<txid>i0"
```

## Additions (implemented beyond the original contract; existing signatures unchanged)

```ts
export const REVEAL_TX_VERSION: 2; export const REVEAL_LOCKTIME: 0;
export const REVEAL_SEQUENCE: 0xfffffffd;          // nSequence of every reveal input (both layouts)
export const SIGHASH_SINGLE_ANYONECANPAY: 0x83; export const TAPSCRIPT_LEAF_VERSION: 0xc0;
export const NUMS_INTERNAL_KEY: Uint8Array;        // BIP341 H, internal key of every commit output
export function networkParams(network: Network): { bech32: string; pubKeyHash: number; scriptHash: number; wif: number };
export function inscriptionScriptLength(content: InscriptionContent): number;   // == buildInscriptionScript(...).length
export function addressToScript(address: string, network: Network): Uint8Array;
// Independent BIP341 digest of the commit input for hash type 0x83 (script path, no annex).
export function revealCommitSighash(args: {
  commitOutpoint: { txid: string; vout: number }; commitValue: bigint; commitScript: Uint8Array;
  childScript: Uint8Array; childValue: bigint; tapLeafHash: Uint8Array;
  version?: number; lockTime?: number; sequence?: number;
}): Uint8Array;
// buildRescueReveal additionally returns `vsize`.
```

Behavioural notes: `estimateRevealWeight` assumes a 34-byte P2TR parent return when
`parentReturnScript` is omitted and throws if `parentInputScript` is given and is not P2TR.
`attachParent` sets the parent return value to exactly `parentValue` (required for the child
inscription to land on output 1); `signParentInput` refuses otherwise. `buildHalfSignedReveal`
requires `postage >= DUST_P2TR` and `commitValue > postage`.

Funding PSBTs are built by `@bsh/wallet-kit` / the front end, not here.
