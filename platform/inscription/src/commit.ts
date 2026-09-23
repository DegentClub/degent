import { Address, OutScript, TAPROOT_UNSPENDABLE_KEY, utils } from '@scure/btc-signer';
import { tapLeafHash } from '@scure/btc-signer/payment.js';
import { assertBytes, concatBytes } from './bytes.js';
import { TAPSCRIPT_LEAF_VERSION } from './constants.js';
import { buildInscriptionScript, type InscriptionContent } from './envelope.js';
import { networkParams, type Network } from './network.js';

/** BIP341 NUMS point H (lift_x(sha256(G))): the internal key of every commit output. */
export const NUMS_INTERNAL_KEY: Uint8Array = Uint8Array.from(TAPROOT_UNSPENDABLE_KEY);

export interface CommitInfo {
  address: string;
  /** P2TR scriptPubKey (OP_1 <32-byte output key>). */
  script: Uint8Array;
  leafScript: Uint8Array;
  /** 33 bytes: (0xc0 | parity) || NUMS internal key (single leaf => empty merkle path). */
  controlBlock: Uint8Array;
  tapLeafHash: Uint8Array;
}

/** Commit output from an already-built leaf script. */
export function commitFromLeaf(leafScript: Uint8Array, network: Network): CommitInfo {
  const leafHash = tapLeafHash(leafScript, TAPSCRIPT_LEAF_VERSION);
  // Single-leaf tree: merkle root == leaf hash.
  const [outputKey, parity] = utils.taprootTweakPubkey(NUMS_INTERNAL_KEY, leafHash);
  const script = OutScript.encode({ type: 'tr', pubkey: outputKey });
  const address = Address(networkParams(network)).encode({ type: 'tr', pubkey: outputKey });
  const controlBlock = concatBytes(Uint8Array.of(TAPSCRIPT_LEAF_VERSION | parity), NUMS_INTERNAL_KEY);
  return { address, script, leafScript, controlBlock, tapLeafHash: leafHash };
}

export function commitAddress(revealPubkey: Uint8Array, content: InscriptionContent, network: Network): CommitInfo {
  assertBytes(revealPubkey, 32, 'revealPubkey');
  return commitFromLeaf(buildInscriptionScript(revealPubkey, content), network);
}

/** scriptPubKey for an address on the given network (throws on wrong network / invalid address). */
export function addressToScript(address: string, network: Network): Uint8Array {
  const decoded = Address(networkParams(network)).decode(address);
  return OutScript.encode(decoded as Parameters<typeof OutScript.encode>[0]);
}
