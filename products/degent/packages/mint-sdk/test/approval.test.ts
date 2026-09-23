import { describe, expect, it } from 'vitest';
import { degentNumberForRank, parseVoteStatement, voteReference, voteStatement } from '../src/index.js';

describe('vote statements', () => {
  const id = 'dgt_4f1c2a9b0e6d7c8a1b2c3d4e';
  const sha = 'a'.repeat(64);
  it('is a single printable line naming the vote, the order and the content', () => {
    expect(voteStatement('approve', id, sha)).toBe(`Approve Degent order ${id} (${sha})`);
    expect(voteStatement('decline', id, `${sha}i0`)).toBe(`Decline Degent order ${id} (${sha}i0)`);
    expect(voteStatement('approve', id, sha)).not.toMatch(/[\n\r]/);
  });
  it('round-trips through the parser and rejects anything else', () => {
    expect(parseVoteStatement(voteStatement('approve', id, sha))).toEqual({ vote: 'approve', orderId: id, ref: sha });
    expect(parseVoteStatement(voteStatement('decline', id, `${sha}i3`))).toEqual({ vote: 'decline', orderId: id, ref: `${sha}i3` });
    expect(parseVoteStatement('Approve Degent order x (nothex)')).toBeNull();
    expect(parseVoteStatement(`approve Degent order ${id} (${sha})`)).toBeNull();
    expect(parseVoteStatement(`${voteStatement('approve', id, sha)}\n`)).toBeNull();
  });
  it('prefers the inscription id over the content hash as the reference', () => {
    expect(voteReference({ inscriptionId: null, contentSha256: sha })).toBe(sha);
    expect(voteReference({ inscriptionId: `${sha}i0`, contentSha256: sha })).toBe(`${sha}i0`);
  });
});

describe('Degent numbering', () => {
  it('continues after the 4,112-strong Gallery', () => {
    expect(degentNumberForRank(1)).toBe(4113);
    expect(degentNumberForRank(5888)).toBe(10_000);
    expect(() => degentNumberForRank(0)).toThrow(RangeError);
  });
});
