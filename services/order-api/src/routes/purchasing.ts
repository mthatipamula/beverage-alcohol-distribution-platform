import type { FastifyInstance } from 'fastify';
import { authenticate, hasRole, problem } from '../auth.js';
import {
  createPurchaseOrder, getPurchaseOrder, listPurchaseOrders, receivePurchaseOrder, type CreatePurchaseOrderRequest,
} from '../purchasing.js';

export async function purchasingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', async (req, reply) => {
    if (!hasRole(req.principal, 'admin')) return reply.code(403).send(problem(403, 'FORBIDDEN', 'Distributor staff only'));
  });

  app.post<{ Body: CreatePurchaseOrderRequest; Headers: { 'idempotency-key': string } }>('/v1/purchase-orders', {
    schema: {
      tags: ['purchasing'],
      summary: 'Order stock from a supplier for a warehouse',
      headers: { type: 'object', required: ['idempotency-key'], properties: { 'idempotency-key': { type: 'string', minLength: 8 } } },
      body: {
        type: 'object',
        required: ['supplierId', 'warehouseId', 'expectedDate', 'lines'],
        additionalProperties: false,
        properties: {
          supplierId: { type: 'string' },
          warehouseId: { type: 'string', pattern: '^WH-[A-Z]{2}-[A-Z]{2,5}$' },
          expectedDate: { type: 'string', format: 'date' },
          lines: {
            type: 'array', minItems: 1, maxItems: 100,
            items: {
              type: 'object', required: ['sku', 'quantityCases'], additionalProperties: false,
              properties: { sku: { type: 'string' }, quantityCases: { type: 'integer', minimum: 1, maximum: 100000 } },
            },
          },
        },
      },
    },
  }, async (req, reply) => {
    const { purchaseOrder, replay } = await createPurchaseOrder(req.principal, req.headers['idempotency-key'], req.body);
    return reply.code(replay ? 200 : 201).send({ ...purchaseOrder, idempotentReplay: replay });
  });

  app.get<{ Querystring: { limit?: number } }>('/v1/purchase-orders', {
    schema: { tags: ['purchasing'], querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } } } },
  }, async (req) => listPurchaseOrders(req.query.limit ?? 50));

  app.get<{ Params: { id: string } }>('/v1/purchase-orders/:id', {
    schema: { tags: ['purchasing'], params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } },
  }, async (req, reply) => (await getPurchaseOrder(req.params.id)) ?? reply.code(404).send(problem(404, 'NOT_FOUND', 'Purchase order not found')));

  app.post<{ Params: { id: string } }>('/v1/purchase-orders/:id/receive', {
    schema: { tags: ['purchasing'], summary: 'Receive the goods: stock is added to the warehouse', params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } },
  }, async (req) => receivePurchaseOrder(req.principal, req.params.id));
}
