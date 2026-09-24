/** Records posts instead of sending them. `fail` makes the next post throw. */
import type { XClient } from '../ports/x-client.js';

export class MemoryXClient implements XClient {
  readonly posts: Array<{ id: string; text: string }> = [];
  private failures: string[] = [];

  failNext(message = 'X API error'): void {
    this.failures.push(message);
  }

  async post(text: string): Promise<{ id: string }> {
    const f = this.failures.shift();
    if (f !== undefined) throw new Error(f);
    const id = String(1_900_000_000_000_000_000n + BigInt(this.posts.length + 1));
    this.posts.push({ id, text });
    return { id };
  }
}
