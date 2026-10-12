import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { hasRole, type Principal } from './auth.js';
import { config } from './config.js';
import { pool, withTransaction } from './db.js';
import {
  envelope,
  Topics,
  type Allocation,
  type EventEnvelope,
  type OrderPlacedPayload,
  type Reason,
} from './events.js';
import { addDays, businessToday, lineTotalCents, requestHash, unitPriceCents } from './pricing.js';

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

export interface CreateOrderRequest {
  accountId: string;
  deliveryDate: string;
  paymentTerms: 'NET' | 'COD';
  lines: { sku: string; quantityCases: number; discountPct?: number }[];
}

export type OrderStatus = 'PENDING_COMPLIANCE' | 'PENDING_INVENTORY' | 'CONFIRMED' | 'REJECTED' | 'BACKORDERED';

// Events from different topics can arrive in any order, so an order only moves forward.
const RANK: Record<OrderStatus, number> = {
  PENDING_COMPLIANCE: 0,
  PENDING_INVENTORY: 1,
  CONFIRMED: 2,
  REJECTED: 2,
  BACKORDERED: 2,
};

const MAX_DISCOUNT_PCT = 30;

export async function createOrder(
  principal: Principal,
  idempotencyKey: string,
  req: CreateOrderRequest,
): Promise<{ order: Record<string, unknown>; replay: boolean }> {
  const hash = requestHash(req);
  const existing = await findByIdempotencyKey(idempotencyKey, hash);
  if (existing) return { order: existing, replay: true };

  if (hasRole(principal, 'retailer') && !hasRole(principal, 'admin', 'sales_rep') && principal.accountId !== req.accountId) {
    throw new ApiError(403, 'ACCOUNT_FORBIDDEN', 'Retail users can only order for their own account');
  }

  const account = (await pool.query('SELECT id, state, channel FROM orders.accounts WHERE id = $1', [req.accountId])).rows[0];
  if (!account) throw new ApiError(422, 'UNKNOWN_ACCOUNT', `Account ${req.accountId} does not exist`);

  const today = businessToday(config.timezone);
  if (req.deliveryDate <= today || req.deliveryDate > addDays(today, 30)) {
    throw new ApiError(422, 'INVALID_DELIVERY_DATE', 'Delivery date must be between tomorrow and 30 days from today');
  }

  const skus = [...new Set(req.lines.map((l) => l.sku))];
  const { rows: priced } = await pool.query(
    `SELECT p.sku, p.category, p.supplier_id,
            (SELECT pp.price_per_case_cents FROM orders.product_prices pp
             WHERE pp.sku = p.sku AND pp.state = $2 AND pp.effective_month <= $3::date
             ORDER BY pp.effective_month DESC LIMIT 1) AS price
     FROM orders.products p WHERE p.sku = ANY($1)`,
    [skus, account.state, req.deliveryDate],
  );
  const bySku = new Map(priced.map((p) => [p.sku, p]));

  const lines = req.lines.map((l, i) => {
    const product = bySku.get(l.sku);
    if (!product) throw new ApiError(422, 'UNKNOWN_SKU', `Line ${i + 1}: SKU ${l.sku} does not exist`);
    if (product.price == null) {
      throw new ApiError(422, 'NOT_PRICED', `Line ${i + 1}: ${l.sku} has no price in ${account.state} for ${req.deliveryDate}`);
    }
    const discountPct = l.discountPct ?? 0;
    if (discountPct > 0 && !hasRole(principal, 'admin', 'sales_rep')) {
      throw new ApiError(403, 'DISCOUNT_FORBIDDEN', 'Only sales reps can apply discounts');
    }
    if (discountPct < 0 || discountPct > MAX_DISCOUNT_PCT) {
      throw new ApiError(422, 'INVALID_DISCOUNT', `Line ${i + 1}: discount must be between 0 and ${MAX_DISCOUNT_PCT}%`);
    }
    const unit = unitPriceCents(product.price, discountPct);
    return {
      lineNo: i + 1,
      sku: l.sku,
      category: product.category as string,
      supplierId: product.supplier_id as string,
      quantityCases: l.quantityCases,
      listPriceCents: product.price as number,
      discountPct,
      unitPriceCents: unit,
      lineTotalCents: lineTotalCents(unit, l.quantityCases),
    };
  });
  const totalCents = lines.reduce((sum, l) => sum + l.lineTotalCents, 0);
  const orderId = randomUUID();

  const payload: OrderPlacedPayload = {
    orderId,
    accountId: account.id,
    state: account.state,
    channel: account.channel,
    paymentTerms: req.paymentTerms,
    deliveryDate: req.deliveryDate,
    totalCents,
    lines: lines.map(({ lineTotalCents: _t, ...l }) => l),
  };

  try {
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO orders.orders (id, account_id, state, channel, status, payment_terms, delivery_date, total_cents,
                                    idempotency_key, request_hash, created_by)
         VALUES ($1, $2, $3, $4, 'PENDING_COMPLIANCE', $5, $6, $7, $8, $9, $10)`,
        [orderId, account.id, account.state, account.channel, req.paymentTerms, req.deliveryDate, totalCents,
         idempotencyKey, hash, principal.subject],
      );
      for (const l of lines) {
        await client.query(
          `INSERT INTO orders.order_lines (order_id, line_no, sku, category, supplier_id, quantity_cases,
                                           list_price_cents, discount_pct, unit_price_cents, line_total_cents)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [orderId, l.lineNo, l.sku, l.category, l.supplierId, l.quantityCases, l.listPriceCents, l.discountPct,
           l.unitPriceCents, l.lineTotalCents],
        );
      }
      await recordEvent(client, orderId, null, 'PENDING_COMPLIANCE', 'order placed', principal.subject);
      await addToOutbox(client, Topics.orderPlaced, envelope('OrderPlaced', orderId, payload));
    });
  } catch (err) {
    // Two identical requests raced: the loser returns the winner's order.
    if ((err as { code?: string }).code === '23505') {
      const winner = await findByIdempotencyKey(idempotencyKey, hash);
      if (winner) return { order: winner, replay: true };
    }
    throw err;
  }
  return { order: (await getOrder(orderId))!, replay: false };
}

async function findByIdempotencyKey(key: string, hash: string): Promise<Record<string, unknown> | undefined> {
  const { rows } = await pool.query('SELECT id, request_hash FROM orders.orders WHERE idempotency_key = $1', [key]);
  if (rows.length === 0) return undefined;
  if (rows[0].request_hash !== hash) {
    throw new ApiError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different order');
  }
  return getOrder(rows[0].id);
}

/** Applies a downstream event exactly once (by event ID) and moves the order forward. */
export async function applyEvent(event: EventEnvelope<Record<string, unknown>>): Promise<'applied' | 'duplicate' | 'stale'> {
  return withTransaction(async (client) => {
    const inserted = await client.query(
      'INSERT INTO orders.processed_events (event_id, event_type) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [event.eventId, event.eventType],
    );
    if (inserted.rowCount === 0) return 'duplicate';

    const { rows } = await client.query('SELECT status FROM orders.orders WHERE id = $1 FOR UPDATE', [event.orderId]);
    if (rows.length === 0) throw new UnknownOrderError(event.orderId);
    const current = rows[0].status as OrderStatus;

    const p = event.payload;
    switch (event.eventType) {
      case 'OrderValidated':
        return transition(client, event, current, 'PENDING_INVENTORY', [], 'passed state compliance checks');
      case 'OrderRejected':
        return transition(client, event, current, 'REJECTED', p.reasons as Reason[], 'failed state compliance checks');
      case 'InventoryReserved': {
        const result = await transition(client, event, current, 'CONFIRMED', [], 'inventory reserved');
        if (result === 'applied') await confirm(client, event.orderId, p.allocations as Allocation[]);
        return result;
      }
      case 'InventoryFailed':
        return transition(client, event, current, 'BACKORDERED', p.reasons as Reason[], 'insufficient inventory');
      default:
        return 'stale';
    }
  });
}

export class UnknownOrderError extends Error {
  constructor(orderId: string) {
    super(`Event refers to unknown order ${orderId}`);
  }
}

async function transition(
  client: pg.PoolClient,
  event: EventEnvelope,
  current: OrderStatus,
  next: OrderStatus,
  reasons: Reason[],
  detail: string,
): Promise<'applied' | 'stale'> {
  if (RANK[current] >= RANK[next] || RANK[current] === 2) return 'stale';
  await client.query(
    'UPDATE orders.orders SET status = $2, status_reasons = $3, updated_at = now() WHERE id = $1',
    [event.orderId, next, JSON.stringify(reasons ?? [])],
  );
  const why = reasons?.length ? `${detail}: ${reasons.map((r) => r.message).join('; ')}` : detail;
  await recordEvent(client, event.orderId, current, next, why, event.source);
  return 'applied';
}

/** Confirmed orders are published for downstream consumers (supplier depletion reporting). */
async function confirm(client: pg.PoolClient, orderId: string, allocations: Allocation[]): Promise<void> {
  await client.query('UPDATE orders.orders SET allocations = $2 WHERE id = $1', [orderId, JSON.stringify(allocations)]);
  const { rows: [o] } = await client.query(
    'SELECT account_id, state, channel, delivery_date, total_cents FROM orders.orders WHERE id = $1', [orderId]);
  const { rows: lines } = await client.query(
    `SELECT line_no AS "lineNo", sku, category, supplier_id AS "supplierId", quantity_cases AS "quantityCases",
            unit_price_cents AS "unitPriceCents"
     FROM orders.order_lines WHERE order_id = $1 ORDER BY line_no`, [orderId]);
  await addToOutbox(client, Topics.orderConfirmed, envelope('OrderConfirmed', orderId, {
    orderId,
    accountId: o.account_id,
    state: o.state,
    channel: o.channel,
    deliveryDate: o.delivery_date,
    totalCents: o.total_cents,
    lines,
    allocations,
  }));
}

async function recordEvent(client: pg.PoolClient, orderId: string, from: string | null, to: string, detail: string, actor: string) {
  await client.query(
    'INSERT INTO orders.order_events (order_id, from_status, to_status, detail, actor) VALUES ($1, $2, $3, $4, $5)',
    [orderId, from, to, detail, actor],
  );
}

async function addToOutbox(client: pg.PoolClient, topic: string, event: EventEnvelope): Promise<void> {
  await client.query('INSERT INTO orders.outbox (topic, message_key, payload) VALUES ($1, $2, $3)',
    [topic, event.orderId, JSON.stringify(event)]);
}

export async function getOrder(id: string): Promise<Record<string, unknown> | undefined> {
  const { rows } = await pool.query(
    `SELECT o.id, o.account_id AS "accountId", a.name AS "accountName", o.state, o.channel, o.status,
            o.status_reasons AS "statusReasons", o.payment_terms AS "paymentTerms", o.delivery_date AS "deliveryDate",
            o.total_cents AS "totalCents", o.allocations, o.created_by AS "createdBy", o.created_at AS "createdAt",
            o.updated_at AS "updatedAt"
     FROM orders.orders o JOIN orders.accounts a ON a.id = o.account_id WHERE o.id = $1`, [id]);
  if (rows.length === 0) return undefined;
  const lines = await pool.query(
    `SELECT l.line_no AS "lineNo", l.sku, p.name, l.category, l.quantity_cases AS "quantityCases",
            l.list_price_cents AS "listPriceCents", l.discount_pct::float AS "discountPct",
            l.unit_price_cents AS "unitPriceCents", l.line_total_cents AS "lineTotalCents"
     FROM orders.order_lines l JOIN orders.products p ON p.sku = l.sku WHERE l.order_id = $1 ORDER BY l.line_no`, [id]);
  const history = await pool.query(
    `SELECT from_status AS "from", to_status AS "to", detail, actor, created_at AS "at"
     FROM orders.order_events WHERE order_id = $1 ORDER BY id`, [id]);
  return { ...rows[0], lines: lines.rows, history: history.rows };
}

export async function listOrders(filter: { accountId?: string; status?: string; limit: number }) {
  const { rows } = await pool.query(
    `SELECT o.id, o.account_id AS "accountId", a.name AS "accountName", o.state, o.status,
            o.delivery_date AS "deliveryDate", o.total_cents AS "totalCents", o.created_at AS "createdAt"
     FROM orders.orders o JOIN orders.accounts a ON a.id = o.account_id
     WHERE ($1::text IS NULL OR o.account_id = $1) AND ($2::text IS NULL OR o.status = $2)
     ORDER BY o.created_at DESC LIMIT $3`,
    [filter.accountId ?? null, filter.status ?? null, filter.limit],
  );
  return rows;
}
