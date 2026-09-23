import { describe, expect, it } from 'vitest';
import { hex } from '@scure/base';
import { buildInscriptionScript, encodeParentId, inscriptionScriptLength } from '../src/index.js';
import { bytes, decodeScript, pushOpcodeFor, REVEAL_PUB } from './helpers.js';

const utf8 = (s: string) => new TextEncoder().encode(s);
const TXID = '1f2e3d4c5b6a79880123456789abcdef0123456789abcdef0123456789abcdef';
const txidInternal = hex.decode(TXID).reverse();

describe('envelope', () => {
  for (const size of [0, 1, 519, 520, 521, 1040, 1041]) {
    it(`encodes a ${size}-byte body exactly as ord`, () => {
      const body = bytes(size, 99);
      const script = buildInscriptionScript(REVEAL_PUB, { contentType: 'text/plain;charset=utf-8', body });
      expect(script.length).toBe(inscriptionScriptLength({ contentType: 'text/plain;charset=utf-8', body }));
      const ops = decodeScript(script);
      // header
      expect(ops[0]).toEqual({ opcode: 32, data: REVEAL_PUB });
      expect(ops[1]).toEqual({ opcode: 0xac }); // OP_CHECKSIG
      expect(ops[2]).toEqual({ opcode: 0x00, data: new Uint8Array() }); // OP_FALSE
      expect(ops[3]).toEqual({ opcode: 0x63 }); // OP_IF
      expect(ops[4]).toEqual({ opcode: 3, data: utf8('ord') });
      expect(ops[5]).toEqual({ opcode: 1, data: Uint8Array.of(1) }); // tag 1 as PUSHBYTES_1, not OP_1
      expect(ops[6]).toEqual({ opcode: 24, data: utf8('text/plain;charset=utf-8') });
      expect(ops[7]).toEqual({ opcode: 0, data: new Uint8Array() }); // body tag OP_0
      const chunks = ops.slice(8, -1);
      expect(ops.at(-1)).toEqual({ opcode: 0x68 }); // OP_ENDIF
      expect(chunks.length).toBe(Math.ceil(size / 520));
      for (const c of chunks) {
        expect(c.data!.length).toBeLessThanOrEqual(520);
        expect(c.opcode).toBe(pushOpcodeFor(c.data!.length));
      }
      // all chunks but the last are full
      chunks.slice(0, -1).forEach((c) => expect(c.data!.length).toBe(520));
      const joined = new Uint8Array(chunks.reduce((n, c) => n + c.data!.length, 0));
      let o = 0;
      for (const c of chunks) {
        joined.set(c.data!, o);
        o += c.data!.length;
      }
      expect(joined).toEqual(body);
    });
  }

  it('uses PUSHDATA1 for 76..255 and PUSHDATA2 for 256..520 chunk remainders', () => {
    for (const [size, op] of [
      [75, 75],
      [76, 0x4c],
      [255, 0x4c],
      [256, 0x4d],
      [520 + 76, 0x4c],
    ] as const) {
      const ops = decodeScript(buildInscriptionScript(REVEAL_PUB, { contentType: 'a/b', body: bytes(size) }));
      expect(ops.at(-2)!.opcode).toBe(op);
    }
  });

  it('includes parent (tag 3) and metadata (tag 5, one tag per 520-byte chunk) in ord order', () => {
    const metadata = bytes(600, 5);
    const parentId = `${TXID}i256`;
    const ops = decodeScript(
      buildInscriptionScript(REVEAL_PUB, { contentType: 'image/png', body: bytes(10), parentId, metadata }),
    );
    expect(ops[5]!.data).toEqual(Uint8Array.of(1));
    expect(ops[7]).toEqual({ opcode: 1, data: Uint8Array.of(3) });
    expect(ops[8]!.data).toEqual(encodeParentId(parentId));
    expect(ops[9]).toEqual({ opcode: 1, data: Uint8Array.of(5) });
    expect(ops[10]!.data).toEqual(metadata.subarray(0, 520));
    expect(ops[11]).toEqual({ opcode: 1, data: Uint8Array.of(5) });
    expect(ops[12]!.data).toEqual(metadata.subarray(520));
    expect(ops[13]).toEqual({ opcode: 0, data: new Uint8Array() });
    expect(ops[14]!.data).toEqual(bytes(10));
    expect(ops[15]).toEqual({ opcode: 0x68 });
  });

  it('encodes parent ids like ord: reversed txid + LE index with trailing zeros trimmed', () => {
    expect(encodeParentId(`${TXID}i0`)).toEqual(txidInternal);
    expect(encodeParentId(`${TXID}i1`)).toEqual(new Uint8Array([...txidInternal, 0x01]));
    expect(encodeParentId(`${TXID}i255`)).toEqual(new Uint8Array([...txidInternal, 0xff]));
    expect(encodeParentId(`${TXID}i256`)).toEqual(new Uint8Array([...txidInternal, 0x00, 0x01]));
    expect(encodeParentId(`${TXID}i4294967295`)).toEqual(new Uint8Array([...txidInternal, 0xff, 0xff, 0xff, 0xff]));
    expect(encodeParentId(`${TXID}i0`)[0]).toBe(0xef); // last byte of display txid first
  });

  it('rejects malformed ids, bad keys and oversize content types', () => {
    expect(() => encodeParentId('xyz')).toThrow();
    expect(() => encodeParentId(`${TXID}i01`)).toThrow();
    expect(() => encodeParentId(`${TXID}i4294967296`)).toThrow();
    expect(() => buildInscriptionScript(new Uint8Array(33), { contentType: 'a', body: new Uint8Array() })).toThrow();
    expect(() => buildInscriptionScript(REVEAL_PUB, { contentType: 'a'.repeat(521), body: new Uint8Array() })).toThrow();
    expect(() => buildInscriptionScript(REVEAL_PUB, { contentType: '', body: new Uint8Array() })).toThrow();
  });

  it('a 0-byte body is just the OP_0 body tag (ord behaviour)', () => {
    const s = buildInscriptionScript(REVEAL_PUB, { contentType: 'a', body: new Uint8Array() });
    expect(hex.encode(s.subarray(-2))).toBe('0068');
  });
});
