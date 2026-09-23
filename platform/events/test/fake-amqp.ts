import { matchesPattern, type AmqpChannel, type AmqpMessage, type AmqpPublishOptions } from '../src/index.js';

interface Queue {
  name: string;
  args: Record<string, unknown>;
  messages: AmqpMessage[];
  consumers: Array<{ tag: string; fn: (m: AmqpMessage | null) => void }>;
}

/** Tiny in-process RabbitMQ model: topic/direct exchanges, default exchange, bindings, DLX on nack(requeue=false). */
export class FakeAmqpChannel implements AmqpChannel {
  exchanges = new Map<string, string>();
  queues = new Map<string, Queue>();
  bindings: Array<{ queue: string; exchange: string; pattern: string }> = [];
  published: Array<{ exchange: string; routingKey: string; options: AmqpPublishOptions; body: string }> = [];
  acked: AmqpMessage[] = [];
  nacked: Array<{ msg: AmqpMessage; requeue: boolean }> = [];
  prefetchCount = 0;
  confirms = 0;
  private tag = 0;
  private dtag = 0;

  async assertExchange(name: string, type: string) {
    this.exchanges.set(name, type);
    return {};
  }
  async assertQueue(name: string, options?: { arguments?: Record<string, unknown> }) {
    if (!this.queues.has(name)) this.queues.set(name, { name, args: options?.arguments ?? {}, messages: [], consumers: [] });
    return { queue: name };
  }
  async bindQueue(queue: string, exchange: string, pattern: string) {
    this.bindings.push({ queue, exchange, pattern });
    return {};
  }
  async prefetch(n: number) {
    this.prefetchCount = n;
    return {};
  }
  async waitForConfirms() {
    this.confirms++;
  }
  publish(exchange: string, routingKey: string, content: Buffer, options: AmqpPublishOptions = {}): boolean {
    this.published.push({ exchange, routingKey, options, body: content.toString('utf8') });
    this.route(exchange, routingKey, content, options, false);
    return true;
  }
  async consume(queue: string, fn: (m: AmqpMessage | null) => void) {
    const q = this.queues.get(queue)!;
    const tag = `ctag-${++this.tag}`;
    q.consumers.push({ tag, fn });
    for (const m of q.messages.splice(0)) fn(m);
    return { consumerTag: tag };
  }
  async cancel(tag: string) {
    for (const q of this.queues.values()) q.consumers = q.consumers.filter((c) => c.tag !== tag);
    return {};
  }
  ack(m: AmqpMessage) {
    this.acked.push(m);
  }
  nack(m: AmqpMessage, _all = false, requeue = true) {
    this.nacked.push({ msg: m, requeue });
    const q = this.queueOf(m);
    if (requeue) return this.deliver(q, { ...m, fields: { ...m.fields, redelivered: true } });
    const dlx = q.args['x-dead-letter-exchange'] as string | undefined;
    if (dlx) this.route(dlx, (q.args['x-dead-letter-routing-key'] as string) ?? m.fields.routingKey, Buffer.from(m.content), m.properties, false);
  }

  /** Messages sitting in a queue with no consumer (e.g. a DLQ). */
  depth(queue: string): AmqpMessage[] {
    return this.queues.get(queue)?.messages ?? [];
  }

  private queueOf(m: AmqpMessage): Queue {
    return this.queues.get((m as AmqpMessage & { queue: string }).queue)!;
  }

  private route(exchange: string, routingKey: string, content: Buffer, properties: AmqpPublishOptions, redelivered: boolean) {
    const targets =
      exchange === ''
        ? [routingKey]
        : this.bindings
            .filter((b) => b.exchange === exchange && (this.exchanges.get(exchange) === 'topic' ? matchesPattern(b.pattern, routingKey) : b.pattern === routingKey))
            .map((b) => b.queue);
    for (const name of new Set(targets)) {
      const q = this.queues.get(name);
      if (!q) continue;
      const msg = {
        queue: name,
        content: Buffer.from(content),
        fields: { deliveryTag: ++this.dtag, redelivered, routingKey, exchange },
        properties: { ...properties },
      } as AmqpMessage & { queue: string };
      this.deliver(q, msg);
    }
  }

  private deliver(q: Queue, m: AmqpMessage) {
    const c = q.consumers[0];
    if (c) c.fn(m);
    else q.messages.push(m);
  }
}
