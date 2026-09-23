/** Time source + timer port. Inject `ManualClock` in tests to drive retries and relay loops deterministically. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

interface Timer {
  id: number;
  due: number;
  fn: () => void;
}

/** Let pending promise chains (async handlers, awaited ports) settle. */
export const flushAsync = (): Promise<void> =>
  new Promise((r) => (typeof setImmediate === 'function' ? setImmediate(r) : setTimeout(r, 0)));

/** Deterministic fake clock: timers only fire inside `advance()`, in due order, with async work flushed between. */
export class ManualClock implements Clock {
  private t: number;
  private seq = 0;
  private timers: Timer[] = [];

  constructor(start: number | Date = 0) {
    this.t = typeof start === 'number' ? start : start.getTime();
  }

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const timer = { id: ++this.seq, due: this.t + Math.max(0, ms), fn };
    this.timers.push(timer);
    return timer.id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== handle);
  }

  /** Number of scheduled, not yet fired timers. */
  get pending(): number {
    return this.timers.length;
  }

  /** Move time forward by `ms`, firing every timer that falls due (including ones scheduled meanwhile). */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    await flushAsync();
    for (;;) {
      this.timers.sort((a, b) => a.due - b.due || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.due > target) break;
      this.timers.shift();
      this.t = next.due;
      next.fn();
      await flushAsync();
    }
    this.t = target;
    await flushAsync();
  }

  /** Fire timers until none remain (bounded to avoid runaway loops). */
  async runAll(maxSteps = 10_000): Promise<void> {
    for (let i = 0; i < maxSteps && this.timers.length; i++) {
      const due = Math.min(...this.timers.map((x) => x.due));
      await this.advance(due - this.t);
    }
  }
}
