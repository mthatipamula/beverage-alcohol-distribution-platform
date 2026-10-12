import type { FastifyInstance } from 'fastify';
import { authenticate, hasRole, problem } from '../auth.js';
import { createOrder, getOrder, listOrders, type CreateOrderRequest } from '../orders.js';

const createOrderSchema = {
  tags: ['orders'],
  summary: 'Place an order (asynchronous: compliance and inventory checks follow over Kafka)',
  headers: {
    type: 'object',
    required: ['idempotency-key'],
    properties: { 'idempotency-key': { type: 'string', minLength: 8, maxLength: 100 } },
  },
  body: {
    type: 'object',
    required: ['accountId', 'deliveryDate', 'paymentTerms', 'lines'],
    additionalProperties: false,
    properties: {
      accountId: { type: 'string', minLength: 1, maxLength: 40 },
      deliveryDate: { type: 'string', format: 'date' },
      paymentTerms: { type: 'string', enum: ['NET', 'COD'] },
      lines: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: {
          type: 'object',
          required: ['sku', 'quantityCases'],
          additionalProperties: false,
          properties: {
            sku: { type: 'string', minLength: 1, maxLength: 40 },
            quantityCases: { type: 'integer', minimum: 1, maximum: 10000 },
            discountPct: { type: 'number', minimum: 0, maximum: 100 },
          },
        },
      },
    },
  },
};

export async function orderRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.post<{ Body: CreateOrderRequest; Headers: { 'idempotency-key': string } }>(
    '/v1/orders', { schema: createOrderSchema }, async (req, reply) => {
      const { order, replay } = await createOrder(req.principal, req.headers['idempotency-key'], req.body);
      reply.header('Location', `/v1/orders/${order.id}`);
      // 202: accepted for processing; a replay of the same request returns the original order.
      return reply.code(replay ? 200 : 202).send({ ...order, idempotentReplay: replay });
    });

  app.get<{ Querystring: { accountId?: string; status?: string; limit?: number } }>('/v1/orders', {
    schema: {
      tags: ['orders'],
      querystring: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          status: { type: 'string', enum: ['PENDING_COMPLIANCE', 'PENDING_INVENTORY', 'CONFIRMED', 'REJECTED', 'BACKORDERED'] },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        },
      },
    },
  }, async (req) => {
    const accountId = hasRole(req.principal, 'admin', 'sales_rep') ? req.query.accountId : req.principal.accountId ?? '';
    return listOrders({ accountId, status: req.query.status, limit: req.query.limit ?? 50 });
  });

  app.get<{ Params: { id: string } }>('/v1/orders/:id', {
    schema: { tags: ['orders'], params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } },
  }, async (req, reply) => {
    const order = await getOrder(req.params.id);
    if (!order) return reply.code(404).send(problem(404, 'NOT_FOUND', 'Order not found'));
    if (!hasRole(req.principal, 'admin', 'sales_rep') && order.accountId !== req.principal.accountId) {
      return reply.code(404).send(problem(404, 'NOT_FOUND', 'Order not found'));
    }
    return order;
  });
}
