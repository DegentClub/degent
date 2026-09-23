/** Bitcoin limits and product constants used across the library. */
export const LIMITS = Object.freeze({
  /** Bitcoin Core policy: largest transaction relayed by default (MAX_STANDARD_TX_WEIGHT). */
  MAX_STANDARD_TX_WEIGHT: 400_000,
  /** Consensus: maximum block weight. */
  MAX_BLOCK_WEIGHT: 4_000_000,
  /** Largest reveal accepted in the block lane (headroom for header + coinbase). */
  BLOCK_LANE_MAX_TX_WEIGHT: 3_990_000,
  /** Consensus: largest single data push (applies to executed AND unexecuted pushes). */
  MAX_SCRIPT_ELEMENT_SIZE: 520,
  /** Dust threshold of a P2TR output at the default 3 sat/vB dust relay fee. */
  DUST_P2TR: 330n,
  /** Default inscription postage (ord's default). */
  DEFAULT_POSTAGE: 546n,
} as const) as {
  readonly MAX_STANDARD_TX_WEIGHT: 400_000;
  readonly MAX_BLOCK_WEIGHT: 4_000_000;
  readonly BLOCK_LANE_MAX_TX_WEIGHT: 3_990_000;
  readonly MAX_SCRIPT_ELEMENT_SIZE: 520;
  readonly DUST_P2TR: 330n;
  readonly DEFAULT_POSTAGE: 546n;
};

/** nVersion of every reveal transaction (identical in parent and rescue layouts). */
export const REVEAL_TX_VERSION = 2;
/** nLockTime of every reveal transaction. */
export const REVEAL_LOCKTIME = 0;
/** nSequence of every reveal input: RBF-signalling, no relative lock-time (ord's default). */
export const REVEAL_SEQUENCE = 0xfffffffd;
/** BIP342 tapscript leaf version. */
export const TAPSCRIPT_LEAF_VERSION = 0xc0;
/** SIGHASH_SINGLE | SIGHASH_ANYONECANPAY. */
export const SIGHASH_SINGLE_ANYONECANPAY = 0x83;
/** BIP341 SIGHASH_DEFAULT (64-byte signature, no trailing hash-type byte). */
export const SIGHASH_DEFAULT = 0x00;
