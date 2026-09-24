/** Real InscriptionOps: delegates to @bsh/inscription (the same code the service runs). */
import { buildHalfSignedReveal, buildResignedRescue, commitAddress, sha256Hex } from '@bsh/inscription';
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
    publicKeyHex(privkey) {
      return hex.encode(schnorr.getPublicKey(privkey));
    },
    commitAddress(pubkeyHex, content, network) {
      return commitAddress(hex.decode(pubkeyHex), content, network).address;
    },
    buildHalfSignedReveal(args) {
      // 0x81 is the platform default; say so explicitly, and always sign the parent return output (the service
      // attaches the parent to every reveal and verifies exactly this layout).
      const r = buildHalfSignedReveal({ ...args, sighash: 'all_anyonecanpay', withParent: true });
      return { psbtBase64: r.psbtBase64 };
    },
    buildResignedRescue(args) {
      const r = buildResignedRescue(args);
      return { hex: r.hex, txid: r.txid, weight: r.weight, vsize: r.vsize, fee: r.fee };
    },
    sha256Hex,
  };
}
