// Generates throwaway Bitcoin keys and BIP-322 signatures for tests.
import { ECPairFactory } from 'ecpair';
import * as ecc from '@bitcoinerlab/secp256k1';
import * as bitcoin from 'bitcoinjs-lib';
import { Signer, Verifier } from 'bip322-js';

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);

export function makeWallet(kind = 'p2wpkh') {
  const kp = ECPair.makeRandom();
  const pubkey = Buffer.from(kp.publicKey);
  const address = kind === 'p2tr'
    ? bitcoin.payments.p2tr({ internalPubkey: pubkey.subarray(1, 33) }).address
    : bitcoin.payments.p2wpkh({ pubkey }).address;
  return {
    address,
    wif: kp.toWIF(),
    sign: (message) => Signer.sign(kp.toWIF(), address, message),
  };
}

export const verifyBip322 = (address, message, signature) => {
  try {
    return Verifier.verifySignature(address, message, signature);
  } catch {
    return false;
  }
};
