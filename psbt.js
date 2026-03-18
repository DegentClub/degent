// psbt.js — Minimal PSBT builder for Ordinals inscription listings
// Handles: P2TR (Taproot) address decoding, PSBT construction, signature extraction
// Reference: BIP 174, BIP 371 (Taproot PSBT extensions)

const PSBT = (() => {

  // ── Hex / Binary ──

  function hexToBytes(hex) {
    if (hex.length % 2 !== 0) throw new Error('Invalid hex length');
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
  }

  function bytesToHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // ── Varint (Bitcoin compact size) ──

  function encodeVarint(n) {
    if (n < 0xfd) return new Uint8Array([n]);
    if (n <= 0xffff) return new Uint8Array([0xfd, n & 0xff, (n >> 8) & 0xff]);
    if (n <= 0xffffffff) return new Uint8Array([
      0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff
    ]);
    throw new Error('Varint value too large');
  }

  function readVarint(bytes, offset) {
    const first = bytes[offset];
    if (first < 0xfd) return { value: first, size: 1 };
    if (first === 0xfd) return {
      value: bytes[offset + 1] | (bytes[offset + 2] << 8), size: 3
    };
    if (first === 0xfe) return {
      value: (bytes[offset + 1]) | (bytes[offset + 2] << 8) |
             (bytes[offset + 3] << 16) | ((bytes[offset + 4] << 24) >>> 0),
      size: 5
    };
    throw new Error('64-bit varints not supported');
  }

  // ── Little-endian integer encoding ──

  function uint32LE(n) {
    return new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
  }

  function uint64LE(n) {
    const buf = new Uint8Array(8);
    buf[0] = n & 0xff;
    buf[1] = (n >> 8) & 0xff;
    buf[2] = (n >> 16) & 0xff;
    buf[3] = (n >> 24) & 0xff;
    const hi = Math.floor(n / 0x100000000);
    buf[4] = hi & 0xff;
    buf[5] = (hi >> 8) & 0xff;
    buf[6] = (hi >> 16) & 0xff;
    buf[7] = (hi >> 24) & 0xff;
    return buf;
  }

  // ── Uint8Array concatenation ──

  function concat(...arrays) {
    const totalLen = arrays.reduce((sum, a) => sum + a.length, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const arr of arrays) {
      result.set(arr instanceof Uint8Array ? arr : new Uint8Array(arr), offset);
      offset += arr.length;
    }
    return result;
  }

  // ── Bech32 / Bech32m decoder (BIP 173 / BIP 350) ──

  const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

  function bech32Decode(str) {
    str = str.toLowerCase();
    const pos = str.lastIndexOf('1');
    if (pos < 1) throw new Error('Invalid bech32 string');
    const data = [];
    for (let i = pos + 1; i < str.length; i++) {
      const idx = BECH32_CHARSET.indexOf(str[i]);
      if (idx === -1) throw new Error('Invalid bech32 character');
      data.push(idx);
    }
    const payload = data.slice(0, -6); // strip 6-char checksum
    const version = payload[0];
    const program = convertBits(payload.slice(1), 5, 8, false);
    return { version, program: new Uint8Array(program) };
  }

  function convertBits(data, fromBits, toBits, pad) {
    let acc = 0, bits = 0;
    const maxv = (1 << toBits) - 1;
    const result = [];
    for (const value of data) {
      acc = (acc << fromBits) | value;
      bits += fromBits;
      while (bits >= toBits) {
        bits -= toBits;
        result.push((acc >> bits) & maxv);
      }
    }
    if (pad && bits > 0) {
      result.push((acc << (toBits - bits)) & maxv);
    }
    return result;
  }

  // ── Address → scriptPubKey ──
  // P2TR (v1): OP_1 (0x51) + OP_PUSHBYTES_32 (0x20) + <32-byte x-only pubkey>
  // P2WPKH (v0): OP_0 (0x00) + OP_PUSHBYTES_20 (0x14) + <20-byte pubkey hash>

  function addressToScriptPubKey(address) {
    const { version, program } = bech32Decode(address);
    const opVersion = version === 0 ? 0x00 : 0x50 + version;
    const spk = new Uint8Array(2 + program.length);
    spk[0] = opVersion;
    spk[1] = program.length;
    spk.set(program, 2);
    return spk;
  }

  // ── Reverse txid hex → internal byte order ──

  function reverseTxid(txidHex) {
    const bytes = hexToBytes(txidHex);
    bytes.reverse();
    return bytes;
  }

  // ── PSBT key-value pair encoding (BIP 174) ──
  // Format: <varint key_len> <key_bytes> <varint value_len> <value_bytes>

  function kvPair(keyType, keyData, value) {
    const keyBytes = keyData
      ? concat(new Uint8Array([keyType]), keyData)
      : new Uint8Array([keyType]);
    return concat(
      encodeVarint(keyBytes.length), keyBytes,
      encodeVarint(value.length), value
    );
  }

  const SEPARATOR = new Uint8Array([0x00]);
  const PSBT_MAGIC = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff]); // "psbt" + 0xff

  // PSBT key types
  const PSBT_GLOBAL_UNSIGNED_TX   = 0x00;
  const PSBT_IN_WITNESS_UTXO      = 0x01;
  const PSBT_IN_SIGHASH_TYPE      = 0x03;
  const PSBT_IN_FINAL_SCRIPTWITNESS = 0x08;
  const PSBT_IN_TAP_KEY_SIG       = 0x13;
  const PSBT_IN_TAP_INTERNAL_KEY  = 0x17;

  const SIGHASH_SINGLE_ANYONECANPAY = 0x83;

  // ────────────────────────────────────────────────────────
  // buildSellerPsbt — Create a PSBT for the seller to sign
  // ────────────────────────────────────────────────────────
  // One input:  inscription UTXO (txid:vout)
  // One output: priceSats → sellerAddress
  //
  // The seller signs this with SIGHASH_SINGLE|ANYONECANPAY (0x83),
  // committing only to: this input + output[0] (their payment).
  // A buyer can later add inputs/outputs without invalidating the sig.

  function buildSellerPsbt({ txid, vout, utxoValue, inscriptionAddress, sellerAddress, priceSats }) {
    const sellerSpk = addressToScriptPubKey(sellerAddress);
    const inscSpk = addressToScriptPubKey(inscriptionAddress);

    // Unsigned transaction — non-witness serialization (BIP 174 §global)
    const unsignedTx = concat(
      uint32LE(2),                      // version
      encodeVarint(1),                  // 1 input
      reverseTxid(txid),                // prev txid (internal byte order)
      uint32LE(vout),                   // prev vout
      encodeVarint(0),                  // empty scriptSig
      uint32LE(0xffffffff),             // sequence
      encodeVarint(1),                  // 1 output
      uint64LE(priceSats),              // output value
      encodeVarint(sellerSpk.length),   // scriptPubKey length
      sellerSpk,                        // scriptPubKey
      uint32LE(0)                       // locktime
    );

    // witness_utxo for input 0: value + scriptPubKey of the UTXO being spent
    const witnessUtxo = concat(
      uint64LE(utxoValue),
      encodeVarint(inscSpk.length),
      inscSpk
    );

    // Sighash type hint for the signer
    const sighashType = uint32LE(SIGHASH_SINGLE_ANYONECANPAY);

    // Tap internal key — only for P2TR (taproot v1) addresses
    const decoded = bech32Decode(inscriptionAddress);

    let inputMap = concat(
      kvPair(PSBT_IN_WITNESS_UTXO, null, witnessUtxo),
      kvPair(PSBT_IN_SIGHASH_TYPE, null, sighashType)
    );
    if (decoded.version === 1) {
      inputMap = concat(inputMap,
        kvPair(PSBT_IN_TAP_INTERNAL_KEY, null, decoded.program)
      );
    }

    // Assemble PSBT
    return bytesToHex(concat(
      PSBT_MAGIC,
      // ── Global map ──
      kvPair(PSBT_GLOBAL_UNSIGNED_TX, null, unsignedTx),
      SEPARATOR,
      // ── Input 0 map ──
      inputMap,
      SEPARATOR,
      // ── Output 0 map ──
      SEPARATOR
    ));
  }

  // ────────────────────────────────────────────────────────
  // extractSignature — Parse signed PSBT, find seller sig
  // ────────────────────────────────────────────────────────
  // After signing, the PSBT will have either:
  //   - tap_key_sig (0x13) if autoFinalized=false
  //   - final_scriptwitness (0x08) if autoFinalized=true
  // We check both.

  function extractSignature(psbtHex) {
    const bytes = hexToBytes(psbtHex);
    let offset = 5; // skip magic

    // Skip global map
    while (offset < bytes.length) {
      const kl = readVarint(bytes, offset); offset += kl.size;
      if (kl.value === 0) break;
      offset += kl.value;
      const vl = readVarint(bytes, offset); offset += vl.size;
      offset += vl.value;
    }

    // Parse input 0 map — look for signature
    let sigHex = null;
    while (offset < bytes.length) {
      const kl = readVarint(bytes, offset); offset += kl.size;
      if (kl.value === 0) break;

      const keyType = bytes[offset];
      offset += kl.value;

      const vl = readVarint(bytes, offset); offset += vl.size;
      const valStart = offset;
      offset += vl.value;

      // PSBT_IN_TAP_KEY_SIG (partial, before finalization)
      if (keyType === PSBT_IN_TAP_KEY_SIG && kl.value === 1) {
        sigHex = bytesToHex(bytes.slice(valStart, valStart + vl.value));
      }

      // PSBT_IN_FINAL_SCRIPTWITNESS (after finalization)
      if (keyType === PSBT_IN_FINAL_SCRIPTWITNESS && kl.value === 1) {
        let wOff = valStart;
        const itemCount = readVarint(bytes, wOff); wOff += itemCount.size;
        if (itemCount.value >= 1) {
          const itemLen = readVarint(bytes, wOff); wOff += itemLen.size;
          sigHex = bytesToHex(bytes.slice(wOff, wOff + itemLen.value));
        }
      }
    }

    return sigHex;
  }

  // ────────────────────────────────────────────────────────
  // verifySellerSig — Check signature length + sighash byte
  // ────────────────────────────────────────────────────────
  // A valid SINGLE|ANYONECANPAY Schnorr sig is 65 bytes,
  // with the last byte = 0x83.

  function verifySellerSig(sigHex) {
    if (!sigHex) return { valid: false, error: 'No signature found in signed PSBT' };
    const len = sigHex.length / 2;
    if (len === 64) {
      return { valid: false, error: 'Signature is 64 bytes (default sighash). Expected 65 bytes with sighash 0x83.' };
    }
    if (len !== 65) {
      return { valid: false, error: `Expected 65 bytes, got ${len}` };
    }
    const sighashByte = sigHex.slice(-2);
    if (sighashByte !== '83') {
      return { valid: false, error: `Expected sighash 0x83 (SINGLE|ANYONECANPAY), got 0x${sighashByte}` };
    }
    return { valid: true, length: len, sighash: sighashByte };
  }

  // ────────────────────────────────────────────────────────
  // buildBuyerSigningPsbt — PSBT for buyer to sign
  // ────────────────────────────────────────────────────────
  // Uses a DUMMY input 0 (zeroed txid) so UniSat can't detect
  // the inscription and show the "Changing inscription" warning.
  // Buyer signs input 1 with SIGHASH_ALL|ANYONECANPAY (0x81).
  // With 0x81, the sig commits to: only buyer's input + all outputs.
  // It does NOT depend on input 0's data, so the dummy is fine.
  // After signing, we extract the buyer's witness and build a
  // separate final PSBT with the real inscription input.

  const SIGHASH_ALL_ANYONECANPAY = 0x81;

  function buildBuyerSigningPsbt({
    buyerTxid, buyerVout, buyerUtxoValue, buyerAddress,
    priceSats, sellerAddress, inscUtxoValue,
    deliveryAddress, changeSats,
  }) {
    const sellerSpk = addressToScriptPubKey(sellerAddress);
    const buyerSpk = addressToScriptPubKey(buyerAddress);
    const deliverySpk = addressToScriptPubKey(deliveryAddress);
    const postage = inscUtxoValue;

    // Unsigned tx: 2 inputs (dummy + buyer) + 3 outputs
    // Input 0 uses zeroed txid — UniSat won't find an inscription
    const dummyPrevout = new Uint8Array(32); // 32 zero bytes
    const unsignedTx = concat(
      uint32LE(2),                        // version
      encodeVarint(2),                    // 2 inputs
      // Input 0: dummy placeholder (zeroed txid:0)
      dummyPrevout,
      uint32LE(0),
      encodeVarint(0),
      uint32LE(0xffffffff),
      // Input 1: buyer's payment UTXO (real)
      reverseTxid(buyerTxid),
      uint32LE(buyerVout),
      encodeVarint(0),
      uint32LE(0xffffffff),
      encodeVarint(3),                    // 3 outputs
      // Output 0: price → seller
      uint64LE(priceSats),
      encodeVarint(sellerSpk.length),
      sellerSpk,
      // Output 1: postage → buyer delivery (inscription)
      uint64LE(postage),
      encodeVarint(deliverySpk.length),
      deliverySpk,
      // Output 2: change → buyer
      uint64LE(changeSats),
      encodeVarint(deliverySpk.length),
      deliverySpk,
      uint32LE(0)                         // locktime
    );

    // Only populate metadata for input 1 (buyer)
    const buyerWitnessUtxo = concat(
      uint64LE(buyerUtxoValue),
      encodeVarint(buyerSpk.length),
      buyerSpk
    );

    const buyerDecoded = bech32Decode(buyerAddress);

    let input1Map = concat(
      kvPair(PSBT_IN_WITNESS_UTXO, null, buyerWitnessUtxo),
      kvPair(PSBT_IN_SIGHASH_TYPE, null, uint32LE(SIGHASH_ALL_ANYONECANPAY))
    );
    if (buyerDecoded.version === 1) {
      input1Map = concat(input1Map,
        kvPair(PSBT_IN_TAP_INTERNAL_KEY, null, buyerDecoded.program)
      );
    }

    // Fake witness_utxo for dummy input 0 — required by UniSat parser.
    // Not part of buyer's sighash (ANYONECANPAY ignores other inputs).
    // Use OP_1 + 32 zero bytes as a generic P2TR scriptPubKey.
    const fakeSpk = new Uint8Array(34);
    fakeSpk[0] = 0x51; // OP_1
    fakeSpk[1] = 0x20; // PUSH 32
    // remaining 32 bytes are already zero
    const fakeWitnessUtxo = concat(uint64LE(0), encodeVarint(fakeSpk.length), fakeSpk);
    const input0Map = kvPair(PSBT_IN_WITNESS_UTXO, null, fakeWitnessUtxo);

    return bytesToHex(concat(
      PSBT_MAGIC,
      kvPair(PSBT_GLOBAL_UNSIGNED_TX, null, unsignedTx),
      SEPARATOR,
      // Input 0: fake witness_utxo (dummy)
      input0Map,
      SEPARATOR,
      // Input 1: buyer metadata
      input1Map,
      SEPARATOR,
      // Output maps (empty)
      SEPARATOR,
      SEPARATOR,
      SEPARATOR
    ));
  }

  // ────────────────────────────────────────────────────────
  // extractWitness — Get final_scriptwitness from signed PSBT
  // ────────────────────────────────────────────────────────

  function extractWitness(psbtHex, inputIndex) {
    const bytes = hexToBytes(psbtHex);
    let offset = 5; // skip magic

    // Skip global map
    while (offset < bytes.length) {
      const kl = readVarint(bytes, offset); offset += kl.size;
      if (kl.value === 0) break;
      offset += kl.value;
      const vl = readVarint(bytes, offset); offset += vl.size;
      offset += vl.value;
    }

    // Skip to target input map
    for (let i = 0; i < inputIndex; i++) {
      while (offset < bytes.length) {
        const kl = readVarint(bytes, offset); offset += kl.size;
        if (kl.value === 0) break;
        offset += kl.value;
        const vl = readVarint(bytes, offset); offset += vl.size;
        offset += vl.value;
      }
    }

    // Parse target input map — look for final_scriptwitness (0x08) or tap_key_sig (0x13)
    let witnessHex = null;
    let tapKeySigHex = null;

    while (offset < bytes.length) {
      const kl = readVarint(bytes, offset); offset += kl.size;
      if (kl.value === 0) break;
      const keyType = bytes[offset];
      offset += kl.value;
      const vl = readVarint(bytes, offset); offset += vl.size;
      const valStart = offset;
      offset += vl.value;

      if (kl.value === 1) {
        if (keyType === PSBT_IN_FINAL_SCRIPTWITNESS) {
          witnessHex = bytesToHex(bytes.slice(valStart, valStart + vl.value));
          console.log(`extractWitness[${inputIndex}]: found final_scriptwitness (${vl.value} bytes)`);
        }
        if (keyType === PSBT_IN_TAP_KEY_SIG) {
          tapKeySigHex = bytesToHex(bytes.slice(valStart, valStart + vl.value));
          console.log(`extractWitness[${inputIndex}]: found tap_key_sig (${vl.value} bytes)`);
        }
      }
    }

    // Prefer final_scriptwitness if present
    if (witnessHex) return witnessHex;

    // Fall back: wrap tap_key_sig as a witness stack (1 item)
    if (tapKeySigHex) {
      const sigBytes = hexToBytes(tapKeySigHex);
      const witness = concat(
        new Uint8Array([0x01]),
        encodeVarint(sigBytes.length),
        sigBytes
      );
      console.log(`extractWitness[${inputIndex}]: built witness from tap_key_sig (${witness.length} bytes)`);
      return bytesToHex(witness);
    }

    console.warn(`extractWitness[${inputIndex}]: no witness or sig found`);
    return null;
  }

  // ────────────────────────────────────────────────────────
  // buildFinalPsbt — Assemble broadcast PSBT with both sigs
  // ────────────────────────────────────────────────────────
  // Creates the REAL 2-input, 3-output PSBT with:
  //   Input 0: seller's inscription + seller's final_scriptwitness
  //   Input 1: buyer's payment    + buyer's final_scriptwitness

  function buildFinalPsbt({
    inscTxid, inscVout, inscUtxoValue, inscriptionAddress,
    buyerTxid, buyerVout, buyerUtxoValue, buyerAddress,
    priceSats, sellerAddress,
    deliveryAddress, changeSats,
    sellerSigHex, buyerWitnessHex,
  }) {
    const sellerSpk = addressToScriptPubKey(sellerAddress);
    const inscSpk = addressToScriptPubKey(inscriptionAddress);
    const buyerSpk = addressToScriptPubKey(buyerAddress);
    const deliverySpk = addressToScriptPubKey(deliveryAddress);
    const postage = inscUtxoValue;

    // Real unsigned transaction
    const unsignedTx = concat(
      uint32LE(2),
      encodeVarint(2),
      // Input 0: seller's inscription UTXO (real)
      reverseTxid(inscTxid),
      uint32LE(inscVout),
      encodeVarint(0),
      uint32LE(0xffffffff),
      // Input 1: buyer's payment UTXO (real)
      reverseTxid(buyerTxid),
      uint32LE(buyerVout),
      encodeVarint(0),
      uint32LE(0xffffffff),
      encodeVarint(3),
      // Output 0: price → seller
      uint64LE(priceSats),
      encodeVarint(sellerSpk.length),
      sellerSpk,
      // Output 1: postage → buyer delivery
      uint64LE(postage),
      encodeVarint(deliverySpk.length),
      deliverySpk,
      // Output 2: change → buyer
      uint64LE(changeSats),
      encodeVarint(deliverySpk.length),
      deliverySpk,
      uint32LE(0)
    );

    // Witness UTXOs (required for pushPsbt to verify amounts)
    const inscWitnessUtxo = concat(
      uint64LE(inscUtxoValue), encodeVarint(inscSpk.length), inscSpk
    );
    const buyerWitnessUtxo = concat(
      uint64LE(buyerUtxoValue), encodeVarint(buyerSpk.length), buyerSpk
    );

    // Build seller's final_scriptwitness (1-item stack: signature)
    const sellerSigBytes = hexToBytes(sellerSigHex);
    const sellerWitness = concat(
      new Uint8Array([0x01]),
      encodeVarint(sellerSigBytes.length),
      sellerSigBytes
    );
    const sellerInput = concat(
      kvPair(PSBT_IN_WITNESS_UTXO, null, inscWitnessUtxo),
      kvPair(PSBT_IN_FINAL_SCRIPTWITNESS, null, sellerWitness)
    );

    // Build buyer's final_scriptwitness (pass through raw witness data)
    const buyerWitnessBytes = hexToBytes(buyerWitnessHex);
    const buyerInput = concat(
      kvPair(PSBT_IN_WITNESS_UTXO, null, buyerWitnessUtxo),
      kvPair(PSBT_IN_FINAL_SCRIPTWITNESS, null, buyerWitnessBytes)
    );

    return bytesToHex(concat(
      PSBT_MAGIC,
      kvPair(PSBT_GLOBAL_UNSIGNED_TX, null, unsignedTx),
      SEPARATOR,
      // Input 0: seller witness_utxo + finalized witness
      sellerInput,
      SEPARATOR,
      // Input 1: buyer witness_utxo + finalized witness
      buyerInput,
      SEPARATOR,
      // Output maps (empty)
      SEPARATOR,
      SEPARATOR,
      SEPARATOR
    ));
  }

  // ── Public API ──
  return {
    buildSellerPsbt,
    buildBuyerSigningPsbt,
    buildFinalPsbt,
    extractSignature,
    extractWitness,
    verifySellerSig,
    addressToScriptPubKey,
    hexToBytes,
    bytesToHex,
    SIGHASH_SINGLE_ANYONECANPAY,
  };

})();
