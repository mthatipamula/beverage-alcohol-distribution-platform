import type { FastifyInstance } from 'fastify';
import { authenticate, hasRole, problem } from '../auth.js';
import { pool } from '../db.js';

export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get('/v1/accounts', { schema: { tags: ['accounts'], summary: 'List retail accounts' } }, async (req) => {
    const own = hasRole(req.principal, 'admin', 'sales_rep') ? null : req.principal.accountId ?? '';
    const { rows } = await pool.query(
      `SELECT id, name, state, channel FROM orders.accounts WHERE ($1::text IS NULL OR id = $1) ORDER BY id`, [own]);
    return rows;
  });

  app.get<{ Params: { id: string } }>('/v1/accounts/:id', { schema: { tags: ['accounts'] } }, async (req, reply) => {
    if (!hasRole(req.principal, 'admin', 'sales_rep') && req.principal.accountId !== req.params.id) {
      return reply.code(403).send(problem(403, 'ACCOUNT_FORBIDDEN', 'You can only view your own account'));
    }
    const { rows } = await pool.query('SELECT id, name, state, channel FROM orders.accounts WHERE id = $1', [req.params.id]);
    return rows[0] ?? reply.code(404).send(problem(404, 'NOT_FOUND', 'Account not found'));
  });

  app.get<{ Querystring: { state: string } }>('/v1/products', {
    schema: {
      tags: ['catalog'],
      summary: 'Catalog with this month\'s case price for a state',
      querystring: {
        type: 'object',
        required: ['state'],
        properties: { state: { type: 'string', pattern: '^[A-Z]{2}$' } },
      },
    },
  }, async (req) => {
    const { rows } = await pool.query(
      `SELECT p.sku, p.name, p.category, p.supplier_id AS "supplierId", p.supplier_name AS "supplierName",
              p.units_per_case AS "unitsPerCase", p.abv_pct::float AS "abvPct",
              (SELECT pp.price_per_case_cents FROM orders.product_prices pp
               WHERE pp.sku = p.sku AND pp.state = $1 AND pp.effective_month <= current_date
               ORDER BY pp.effective_month DESC LIMIT 1) AS "pricePerCaseCents"
       FROM orders.products p ORDER BY p.sku`, [req.query.state]);
    return rows.filter((r) => r.pricePerCaseCents != null);
  });
}
