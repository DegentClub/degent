/**
 * Is this inscription a Degent? The same idea as the mint's HolderRegistry / Register (ADR-0007): a
 * Degent is a roster (Gallery) inscription or a child of the club parent (the parent link is only
 * applied after member approval). Adapters: memory (tests, regtest), roster + ord `/r/parents`, and the
 * mint's public Register API through `@bsh/degent-mint-sdk` (`GET /v1/register/verify/{id}`).
 */
import type { DegentRef } from '@bsh/degent-market-sdk';

export interface CollectionMembership {
  /** The Degent reference, or null when the inscription is not part of the collection. */
  lookup(inscriptionId: string): Promise<DegentRef | null>;
}
