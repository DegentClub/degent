import type { HolderCheck, HolderRegistry } from '../ports/holder-registry.js';

/** In-memory HolderRegistry (tests, regtest dev): a plain map from address to Degent numbers. */
export class MemoryHolderRegistry implements HolderRegistry {
  private readonly byAddress = new Map<string, Set<number>>();
  private readonly byDegent = new Map<number, string>();

  set(address: string, degents: readonly number[]): void {
    for (const n of this.byAddress.get(address) ?? []) this.byDegent.delete(n);
    this.byAddress.set(address, new Set(degents));
    for (const n of degents) this.byDegent.set(n, address);
  }

  /** Move one Degent to another address (simulates a sale). */
  transfer(n: number, to: string): void {
    const from = this.byDegent.get(n);
    if (from) this.byAddress.get(from)?.delete(n);
    if (!this.byAddress.has(to)) this.byAddress.set(to, new Set());
    this.byAddress.get(to)!.add(n);
    this.byDegent.set(n, to);
  }

  async isHolder(address: string): Promise<HolderCheck> {
    return { degents: [...(this.byAddress.get(address) ?? [])].sort((a, b) => a - b) };
  }

  async holderOf(n: number): Promise<string | null> {
    return this.byDegent.get(n) ?? null;
  }
}
