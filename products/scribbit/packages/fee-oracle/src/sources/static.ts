import type { FeeSource, SourceReading } from '../types.js';

/**
 * A fixed reading: regtest / dev, tests, or a deliberate policy fallback (e.g. the legacy Libre Relay
 * constants when no node is configured). Counts as a healthy source, so use it knowingly.
 */
export function staticSource(reading: SourceReading, id = 'static'): FeeSource {
  const frozen = structuredClone(reading);
  return { id, kind: 'static', fetch: async () => structuredClone(frozen) };
}
