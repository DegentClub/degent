import { describe, expect, it } from 'vitest';
import { isPattern, isRoutingKey, matchesPattern, templateToPattern } from '../src/index.js';

// [pattern, routing key, expected] — RabbitMQ topic exchange semantics
const TABLE: Array<[string, string, boolean]> = [
  ['block.indexed.mainnet', 'block.indexed.mainnet', true],
  ['block.indexed.mainnet', 'block.indexed.testnet', false],
  ['block.indexed.*', 'block.indexed.mainnet', true],
  ['block.indexed.*', 'block.indexed', false],
  ['block.indexed.*', 'block.indexed.mainnet.extra', false],
  ['block.*.mainnet', 'block.indexed.mainnet', true],
  ['*.*', 'batch.created', true],
  ['*', 'batch.created', false],
  ['#', 'anything.at.all', true],
  ['#', 'x', true],
  ['block.#', 'block', true],
  ['block.#', 'block.indexed.mainnet', true],
  ['block.#', 'blocks.indexed', false],
  ['#.mainnet', 'block.indexed.mainnet', true],
  ['#.mainnet', 'mainnet', true],
  ['#.mainnet', 'block.indexed.testnet', false],
  ['degent.#.paid', 'degent.mint.order.paid', true],
  ['degent.#.paid', 'degent.paid', true],
  ['degent.#.paid', 'degent.mint.order.paid.v2', false],
  ['degent.mint.order.*', 'degent.mint.order.awaiting_content', true],
  ['#.order.#', 'degent.mint.order.paid', true],
  ['*.#', 'collection', true],
  ['*.*.#', 'collection', false],
  ['collection.*', 'collection.minted', true],
  ['collection.*', 'collection.minted.v2', false],
  ['collection.#', 'collection.minted.v2', true],
];

describe('matchesPattern (AMQP topic semantics)', () => {
  it.each(TABLE)('%s ~ %s → %s', (p, k, want) => {
    expect(matchesPattern(p, k)).toBe(want);
  });

  it('converts topic templates to binding keys', () => {
    expect(templateToPattern('block.indexed.{network}')).toBe('block.indexed.*');
    expect(templateToPattern('degent.mint.order.{status}')).toBe('degent.mint.order.*');
    expect(templateToPattern('collection.minted')).toBe('collection.minted');
  });

  it('validates keys and patterns', () => {
    expect(isRoutingKey('block.indexed.mainnet')).toBe(true);
    expect(isRoutingKey('block.*')).toBe(false);
    expect(isRoutingKey('')).toBe(false);
    expect(isPattern('block.#')).toBe(true);
    expect(isPattern('block..x')).toBe(false);
    expect(isPattern('block.a*')).toBe(false);
  });
});
