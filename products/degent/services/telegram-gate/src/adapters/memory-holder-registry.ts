/** In-memory HolderRegistry: address -> Degent numbers, or an Error to simulate a Register outage. */
import type { HolderRegistry } from '../ports/holder-registry.js';

export class MemoryHolderRegistry implements HolderRegistry {
  readonly calls: Array<{ address: string; fresh: boolean }> = [];
  private readonly map = new Map<string, number[] | Error>();

  constructor(initial: Record<string, number[] | Error> = {}) {
    for (const [k, v] of Object.entries(initial)) this.map.set(k, v);
  }

  set(address: string, value: number[] | Error): void {
    this.map.set(address, value);
  }

  async getHoldings(address: string, opts: { fresh?: boolean } = {}): Promise<number[]> {
    this.calls.push({ address, fresh: opts.fresh === true });
    const v = this.map.get(address);
    if (v instanceof Error) throw v;
    return v ? [...v] : [];
  }
}
