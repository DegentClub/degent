/**
 * Who is a member right now. Until the on-chain Register exists (ADR-0007 §4) a "member" is the
 * current holder of a roster Degent (the 4,112 Gallery members) or of a delivered, parent-linked
 * child. Adapters: in-memory (tests, regtest) and roster-chain (roster JSON + ord/esplora lookups).
 */
export interface HolderCheck {
  /** Degent numbers held by the address (empty = not a member). */
  degents: number[];
}

export interface HolderRegistry {
  isHolder(address: string): Promise<HolderCheck>;
  /** Current owner address of Degent #n, null when unknown to the indexer. */
  holderOf(n: number): Promise<string | null>;
}
