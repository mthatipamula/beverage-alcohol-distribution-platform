import Fastify, { type FastifyError } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { problem } from './auth.js';
import { config } from './config.js';
import { migrate, pool } from './db.js';
import { Topics, type EventEnvelope } from './events.js';
import { ensureTopics, kafka, newProducer, OutboxRelay, outboxBacklog } from './kafka.js';
import { ApiError, applyEvent, UnknownOrderError } from './orders.js';
import { catalogRoutes } from './routes/catalog.js';
import { orderRoutes } from './routes/orders.js';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization', 'req.headers["x-api-key"]'] },
  ajv: { customOptions: { coerceTypes: 'array', removeAdditional: false } },
});

await app.register(swagger, {
  openapi: {
    info: { title: 'Order API', version: '1.0.0', description: 'B2B ordering for licensed retail accounts' },
    components: {
      securitySchemes: {
        apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
    },
    security: [{ apiKey: [] }, { bearer: [] }],
  },
});
await app.register(swaggerUi, { routePrefix: '/docs' });

app.setErrorHandler((err: FastifyError, req, reply) => {
  if (err instanceof ApiError) return reply.code(err.status).send(problem(err.status, err.code, err.message));
  if (err.validation) return reply.code(400).send(problem(400, 'INVALID_REQUEST', err.message));
  req.log.error({ err }, 'Unhandled error');
  return reply.code(500).send(problem(500, 'INTERNAL_ERROR', 'Something went wrong'));
});

app.get('/health', { schema: { hide: true } }, async (_req, reply) => {
  try {
    await pool.query('SELECT 1');
    return { status: 'UP', outboxBacklog: await outboxBacklog() };
  } catch {
    return reply.code(503).send({ status: 'DOWN' });
  }
});

await app.register(catalogRoutes);
await app.register(orderRoutes);

// ---- Startup: schema, topics, outbox relay, downstream event consumer ----
await migrate(app.log);
await ensureTopics();

const producer = newProducer();
await producer.connect();
const relay = new OutboxRelay(producer, app.log);
relay.start();

const consumer = kafka.consumer({ groupId: 'order-api' });
await consumer.connect();
await consumer.subscribe({
  topics: [Topics.orderValidated, Topics.orderRejected, Topics.inventoryReserved, Topics.inventoryFailed],
});
await consumer.run({
  eachMessage: async ({ topic, message }) => {
    let event: EventEnvelope<Record<string, unknown>>;
    try {
      event = JSON.parse(message.value?.toString() ?? '');
      if (!event.eventId || !event.orderId) throw new Error('missing eventId or orderId');
    } catch (err) {
      await deadLetter(topic, message.value, `unparseable event: ${(err as Error).message}`);
      return;
    }
    try {
      const result = await applyEvent(event);
      app.log.info({ orderId: event.orderId, eventType: event.eventType, result }, 'Applied event');
    } catch (err) {
      if (err instanceof UnknownOrderError) {
        await deadLetter(topic, message.value, err.message);
        return;
      }
      throw err; // transient (e.g. database): kafkajs retries the message
    }
  },
});

async function deadLetter(topic: string, value: Buffer | null, reason: string): Promise<void> {
  app.log.error({ topic, reason }, 'Sending message to dead-letter topic');
  await producer.send({
    topic: Topics.orderApiDlq,
    messages: [{ value, headers: { 'source-topic': topic, error: reason } }],
  });
}

const shutdown = async () => {
  relay.stop();
  await consumer.disconnect().catch(() => undefined);
  await producer.disconnect().catch(() => undefined);
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ host: '0.0.0.0', port: config.port });
