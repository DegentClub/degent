/**
 * In-process fake of the `amqplib` module surface `@bsh/events` connectAmqpBus uses (connect ->
 * createConfirmChannel; confirm-callback publish; close/error events). The platform's own fake lives in its
 * test tree, which a product package may not import (relative-escape), so this is the minimal equivalent:
 * it records declared exchanges and every publish, and lets a test decide how the "broker" confirms.
 */
import type { AmqplibConfirmChannel, AmqplibConnection, AmqplibModule } from '@bsh/events';

type Listener = (...args: unknown[]) => void;

class Emitter {
  private readonly listeners = new Map<string, Listener[]>();
  on(event: string, fn: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const fn of this.listeners.get(event) ?? []) fn(...args);
  }
}

export interface Published {
  exchange: string;
  routingKey: string;
  body: { id: string; type: string; source: string; subject?: string; data: Record<string, unknown> };
  options: Record<string, unknown>;
}

export class FakeBroker {
  /** How the broker answers publishes: confirm, nack, or never answer. */
  confirm: 'ack' | 'nack' | 'never' = 'ack';
  /** connect() behaviour. */
  connectMode: 'ok' | 'refuse' | 'hang' = 'ok';
  readonly exchanges = new Map<string, string>();
  readonly published: Published[] = [];
  readonly connections: FakeConnection[] = [];
  readonly urls: string[] = [];

  readonly module: AmqplibModule = {
    connect: async (url) => {
      this.urls.push(String(url));
      if (this.connectMode === 'refuse') throw new Error('connect ECONNREFUSED 127.0.0.1:5672');
      if (this.connectMode === 'hang') return new Promise<never>(() => {});
      const c = new FakeConnection(this);
      this.connections.push(c);
      return c;
    },
  };

  get last(): FakeConnection {
    return this.connections.at(-1)!;
  }
}

export class FakeConnection extends Emitter implements AmqplibConnection {
  closed = false;
  channel: FakeChannel | null = null;
  constructor(readonly broker: FakeBroker) {
    super();
  }
  async createConfirmChannel(): Promise<AmqplibConfirmChannel> {
    this.channel = new FakeChannel(this.broker);
    return this.channel;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  /** Simulate the broker dropping the connection. */
  drop(error = new Error('Connection closed: 320 (CONNECTION-FORCED)')): void {
    this.emit('error', error);
    this.emit('close', error);
  }
}

export class FakeChannel extends Emitter implements AmqplibConfirmChannel {
  closed = false;
  constructor(private readonly broker: FakeBroker) {
    super();
  }
  async assertExchange(exchange: string, type: string) {
    this.broker.exchanges.set(exchange, type);
    return { exchange };
  }
  async assertQueue(queue: string) {
    return { queue, messageCount: 0, consumerCount: 0 };
  }
  async bindQueue() {
    return {};
  }
  publish(exchange: string, routingKey: string, content: Buffer, options: Record<string, unknown> = {}, cb?: (err: Error | null) => void): boolean {
    if (this.closed) throw new Error('Channel closed');
    const mode = this.broker.confirm;
    if (mode === 'ack') this.broker.published.push({ exchange, routingKey, body: JSON.parse(content.toString('utf8')), options });
    if (mode === 'ack') queueMicrotask(() => cb?.(null));
    else if (mode === 'nack') queueMicrotask(() => cb?.(new Error('message nacked')));
    return true;
  }
  async consume() {
    return { consumerTag: 'ctag' };
  }
  async cancel() {
    return {};
  }
  ack(): void {}
  nack(): void {}
  async prefetch() {
    return {};
  }
  async waitForConfirms(): Promise<void> {}
  async close(): Promise<void> {
    this.closed = true;
  }
}
