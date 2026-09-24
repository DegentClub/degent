/**
 * Inscription destination, decided by @bsh/inscription (ord's FIFO rule); this service only asserts.
 * Ports the intent of the legacy tests/ordinals.test.js onto the platform implementation.
 */
import { describe, expect, it } from 'vitest';
import { checkInscriptionCoverage, inscriptionDestination } from '@bsh/inscription';
import { assertInscriptionToBuyer, assertRawInscriptionToBuyer } from '../src/domain/settlement/index.js';
import { SettlementError } from '../src/domain/errors.js';

const buyerScript = new Uint8Array([0x51, 0x20, ...new Array(32).fill(1)]);
const sellerScript = new Uint8Array([0x51, 0x20, ...new Array(32).fill(2)]);
const guard = { satOffset: 0, buyerScript, postage: 10_000n };

/** The legacy engine's purchase: [inscription, payment] → [price → seller, postage → buyer, change]. */
const OLD_UNSAFE = { inputs: [{ value: 10_000 }, { value: 300_000 }], outputs: [{ value: 250_000 }, { value: 10_000 }, { value: 49_000 }] };
/** The padding layout: [pad, pad, inscription, payment] → [pad merge, postage, price, royalty, change]. */
const NEW_LAYOUT = { inputs: [{ value: 600 }, { value: 600 }, { value: 10_000 }, { value: 300_000 }], outputs: [{ value: 1_200 }, { value: 10_000 }, { value: 250_000 }, { value: 6_250 }, { value: 40_000 }] };
const scripts = [buyerScript, buyerScript, sellerScript, sellerScript, buyerScript];

describe('inscription destination (FIFO via @bsh/inscription)', () => {
  it('REGRESSION FIXTURE, old unsafe layout: inscription at input 0, price at output 0 → the SELLER gets the inscription', () => {
    expect(inscriptionDestination(OLD_UNSAFE, 0, 0)).toEqual({ vout: 0, offset: 0n });
    // and the guard refuses that layout outright
    const shape = { ...OLD_UNSAFE, outputScripts: [sellerScript, buyerScript, buyerScript] };
    const inputs = [{ value: 600 }, { value: 600 }, ...OLD_UNSAFE.inputs]; // even padded to put *something* at input 2
    expect(() => assertInscriptionToBuyer({ ...shape, inputs }, guard)).toThrow(SettlementError);
  });

  it('new layout: two padding inputs ahead → the inscription lands in output 1 (buyer) at offset 0', () => {
    expect(inscriptionDestination(NEW_LAYOUT, 2, 0)).toEqual({ vout: 1, offset: 0n });
    expect(assertInscriptionToBuyer({ ...NEW_LAYOUT, outputScripts: scripts }, guard)).toEqual({ vout: 1, offset: 0n });
  });

  it('respects a non-zero inscription offset inside the UTXO', () => {
    expect(assertInscriptionToBuyer({ ...NEW_LAYOUT, outputScripts: scripts }, { ...guard, satOffset: 9_999 })).toEqual({ vout: 1, offset: 9_999n });
  });

  it('refuses when the sat would be burned as fee', () => {
    const burn = { inputs: NEW_LAYOUT.inputs, outputs: [{ value: 1_000 }], outputScripts: [buyerScript] };
    expect(() => assertInscriptionToBuyer(burn, guard)).toThrow(/burned/);
  });

  it('refuses when an oversized padding merge output steals the sat', () => {
    const steal = { inputs: NEW_LAYOUT.inputs, outputs: [{ value: 11_200 }, { value: 10_000 }], outputScripts: [buyerScript, buyerScript] };
    expect(() => assertInscriptionToBuyer(steal, guard)).toThrow(/output 0/);
  });

  it('refuses when output 1 is not the buyer or not exactly the postage', () => {
    expect(() => assertInscriptionToBuyer({ ...NEW_LAYOUT, outputScripts: [buyerScript, sellerScript, sellerScript, sellerScript, buyerScript] }, guard)).toThrow(/does not pay the buyer/);
    const bigger = { ...NEW_LAYOUT, outputs: [{ value: 1_200 }, { value: 10_001 }, { value: 250_000 }], outputScripts: scripts };
    expect(() => assertInscriptionToBuyer(bigger, guard)).toThrow(/exactly the postage/);
  });

  it('refuses a missing inscription input and an offset outside the UTXO', () => {
    expect(() => assertInscriptionToBuyer({ inputs: [{ value: 600 }], outputs: [], outputScripts: [] }, guard)).toThrow(/no inscription input/);
    expect(() => assertInscriptionToBuyer({ ...NEW_LAYOUT, outputScripts: scripts }, { ...guard, satOffset: 10_000 })).toThrow(SettlementError);
  });

  it('why the explicit guard: the padding layout fails the platform burn-proof invariant by design', () => {
    const withInsc = NEW_LAYOUT.inputs.map((v, i) => (i === 2 ? { ...v, inscriptions: [{ id: 'x', offset: 0 }] } : v));
    expect(checkInscriptionCoverage(withInsc, NEW_LAYOUT.outputs).ok).toBe(false);
  });

  it('raw guard: refuses a final transaction whose inputs differ from the session prevouts', () => {
    // minimal raw tx is exercised end to end in settlement-assemble; here only the outpoint check
    expect(() => assertRawInscriptionToBuyer('00', new Map(), guard)).toThrow(SettlementError);
  });
});
