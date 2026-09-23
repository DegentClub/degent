/** Real InscriptionOps: delegates to @bsh/inscription (the same code the service runs). */
import {
  buildHalfSignedReveal,
  buildRescueReveal,
  commitAddress,
  sha256Hex,
} from '@bsh/inscription';
import { schnorr } from '@noble/curves/secp256k1.js';
import { hex } from '@scure/base';
import type { InscriptionOps } from '../types';

export function createRealInscription(): InscriptionOps {
  return {
    generateEphemeralKey() {
      // CSPRNG via crypto.getRandomValues. The key stays in this tab's memory (see flow/keyVault).
      const privkey = schnorr.utils.randomSecretKey();
      return { privkey, pubkeyHex: hex.encode(schnorr.getPublicKey(privkey)) };
    },
    commitAddress(pubkeyHex, content, network) {
      return commitAddress(hex.decode(pubkeyHex), content, network).address;
    },
    buildHalfSignedReveal(args) {
      const r = buildHalfSignedReveal(args);
      return { psbtBase64: r.psbtBase64 };
    },
    buildRescueReveal(args) {
      const r = buildRescueReveal(args);
      return { hex: r.hex, txid: r.txid };
    },
    sha256Hex,
  };
}
