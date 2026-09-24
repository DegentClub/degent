/** Real InscriptionOps: delegates to @bsh/inscription (the same code the service runs). */
import {
  addressToScript,
  buildHalfSignedReveal,
  buildResignedRescue,
  commitAddress,
  estimateRevealWeight,
  sha256Hex,
} from '@bsh/inscription';
import { schnorr } from '@noble/curves/secp256k1.js';
import { hex } from '@scure/base';
import type { InscriptionOps } from '../types';

export function createRealInscription(): InscriptionOps {
  return {
    generateEphemeralKey() {
      // CSPRNG via crypto.getRandomValues. The key stays in this tab's memory (see flow/keyVault)
      // until the recovery bundle is saved, where the user keeps it (ADR-0005 §2).
      const privkey = schnorr.utils.randomSecretKey();
      return { privkey, pubkeyHex: hex.encode(schnorr.getPublicKey(privkey)) };
    },
    commitAddress(pubkeyHex, content, network) {
      return commitAddress(hex.decode(pubkeyHex), content, network).address;
    },
    revealWeight(content, recipientAddress, network) {
      // Parent return and parent input default to P2TR (the collection address is taproot).
      return estimateRevealWeight({ content, withParent: true, recipientScript: addressToScript(recipientAddress, network) });
    },
    buildHalfSignedReveal(args) {
      const r = buildHalfSignedReveal({ ...args, sighash: 'all_anyonecanpay', withParent: true });
      return { psbtBase64: r.psbtBase64 };
    },
    buildResignedRescue(args) {
      const r = buildResignedRescue(args);
      return { hex: r.hex, txid: r.txid, weight: r.weight, fee: r.fee };
    },
    sha256Hex,
  };
}
