import { Kafka, logLevel, Partitioners, type Consumer, type Producer, type SASLOptions } from 'kafkajs';
import { config } from './config.js';
import { pool, withTransaction } from './db.js';
import { Topics } from './events.js';

const sasl: SASLOptions | undefined = config.kafka.saslUsername
  ? { mechanism: 'scram-sha-512', username: config.kafka.saslUsername, password: config.kafka.saslPassword ?? '' }
  : undefined;

export const kafka = new Kafka({
  clientId: 'order-api',
  brokers: config.kafka.brokers,
  ssl: sasl ? true : undefined,
  sasl,
  logLevel: logLevel.WARN,
  retry: { retries: 10 },
});

/** This service owns topic creation, so every topic exists before any consumer subscribes. */
export async function ensureTopics(): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    const existing = new Set(await admin.listTopics());
    const missing = Object.values(Topics).filter((t) => !existing.has(t));
    if (missing.length > 0) {
      await admin.createTopics({
        waitForLeaders: true,
        topics: missing.map((topic) => ({
          topic,
          numPartitions: config.kafka.partitions,
          replicationFactor: config.kafka.replicationFactor,
        })),
      });
    }
  } finally {
    await admin.disconnect();
  }
}

/**
 * Relays outbox rows to Kafka. Rows are locked with SKIP LOCKED so several API instances can relay in
 * parallel without sending the same row twice; a row is marked published only after Kafka acknowledges it.
 * A crash between send and commit can resend a row, which downstream consumers ignore by event ID.
 */
export class OutboxRelay {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly producer: Producer, private readonly log: { error: (o: unknown, msg: string) => void }) {}

  start(intervalMs = 250): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await withTransaction(async (client) => {
        const { rows } = await client.query(
          `SELECT id, topic, message_key, payload FROM orders.outbox
           WHERE published_at IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`,
        );
        if (rows.length === 0) return;
        await this.producer.sendBatch({
          acks: -1,
          topicMessages: rows.map((r) => ({
            topic: r.topic,
            messages: [{ key: r.message_key, value: JSON.stringify(r.payload) }],
          })),
        });
        await client.query('UPDATE orders.outbox SET published_at = now() WHERE id = ANY($1)', [rows.map((r) => r.id)]);
      });
    } catch (err) {
      this.log.error({ err }, 'Outbox relay failed; will retry');
    } finally {
      this.running = false;
    }
  }
}

export async function outboxBacklog(): Promise<number> {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM orders.outbox WHERE published_at IS NULL');
  return rows[0].n;
}

export const newProducer = (): Producer =>
  kafka.producer({ idempotent: true, maxInFlightRequests: 1, createPartitioner: Partitioners.DefaultPartitioner });

export type { Consumer, Producer };
