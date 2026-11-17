import { randomUUID } from 'node:crypto';
import type { Principal } from './auth.js';
import { pool, withTransaction } from './db.js';
import { envelope, Topics } from './events.js';
import { ApiError } from './orders.js';

export interface CreatePurchaseOrderRequest {
  supplierId: string;
  warehouseId: string;
  expectedDate: string;
  lines: { sku: string; quantityCases: number }[];
}

/** Distributor buys from a supplier for one warehouse, at the supplier's case cost. */
export async function createPurchaseOrder(principal: Principal, idempotencyKey: string, req: CreatePurchaseOrderRequest) {
  const existing = (await pool.query('SELECT id FROM orders.purchase_orders WHERE idempotency_key = $1', [idempotencyKey])).rows[0];
  if (existing) return { purchaseOrder: await getPurchaseOrder(existing.id), replay: true };

  const { rows: products } = await pool.query(
    'SELECT sku, supplier_cost_cents FROM orders.products WHERE supplier_id = $1 AND sku = ANY($2)',
    [req.supplierId, req.lines.map((l) => l.sku)],
  );
  const cost = new Map(products.map((p) => [p.sku as string, p.supplier_cost_cents as number]));
  const lines = req.lines.map((l, i) => {
    const unit = cost.get(l.sku);
    if (unit === undefined) throw new ApiError(422, 'NOT_SUPPLIER_PRODUCT', `Line ${i + 1}: ${l.sku} is not sold by ${req.supplierId}`);
    return { lineNo: i + 1, sku: l.sku, quantityCases: l.quantityCases, unitCostCents: unit, lineTotalCents: unit * l.quantityCases };
  });
  const id = randomUUID();
  const total = lines.reduce((s, l) => s + l.lineTotalCents, 0);
  try {
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO orders.purchase_orders (id, supplier_id, warehouse_id, status, expected_date, total_cost_cents,
                                             idempotency_key, created_by)
         VALUES ($1, $2, $3, 'SUBMITTED', $4, $5, $6, $7)`,
        [id, req.supplierId, req.warehouseId, req.expectedDate, total, idempotencyKey, principal.subject]);
      for (const l of lines) {
        await client.query(
          `INSERT INTO orders.purchase_order_lines (purchase_order_id, line_no, sku, quantity_cases, unit_cost_cents, line_total_cents)
           VALUES ($1, $2, $3, $4, $5, $6)`, [id, l.lineNo, l.sku, l.quantityCases, l.unitCostCents, l.lineTotalCents]);
      }
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23503') throw new ApiError(422, 'UNKNOWN_SUPPLIER', `Supplier ${req.supplierId} does not exist`);
    if ((err as { code?: string }).code === '23505') {
      return { purchaseOrder: await getPurchaseOrder((await pool.query(
        'SELECT id FROM orders.purchase_orders WHERE idempotency_key = $1', [idempotencyKey])).rows[0].id), replay: true };
    }
    throw err;
  }
  return { purchaseOrder: await getPurchaseOrder(id), replay: false };
}

/**
 * Marks the purchase order received and publishes InventoryReceived through the outbox in the same
 * transaction. The inventory service adds the cases to the warehouse (idempotent per purchase order).
 */
export async function receivePurchaseOrder(principal: Principal, id: string) {
  await withTransaction(async (client) => {
    const po = (await client.query('SELECT status, supplier_id, warehouse_id FROM orders.purchase_orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!po) throw new ApiError(404, 'NOT_FOUND', 'Purchase order not found');
    if (po.status !== 'SUBMITTED') throw new ApiError(409, 'NOT_RECEIVABLE', `Purchase order is already ${po.status.toLowerCase()}`);
    await client.query(
      "UPDATE orders.purchase_orders SET status = 'RECEIVED', received_by = $2, received_at = now() WHERE id = $1",
      [id, principal.subject]);
    const { rows: lines } = await client.query(
      'SELECT sku, quantity_cases AS "quantityCases" FROM orders.purchase_order_lines WHERE purchase_order_id = $1 ORDER BY line_no', [id]);
    const event = envelope('InventoryReceived', id, {
      purchaseOrderId: id, supplierId: po.supplier_id, warehouseId: po.warehouse_id, lines,
    });
    await client.query('INSERT INTO orders.outbox (topic, message_key, payload) VALUES ($1, $2, $3)',
      [Topics.inventoryReceipts, po.warehouse_id, JSON.stringify(event)]);
  });
  return getPurchaseOrder(id);
}

export async function getPurchaseOrder(id: string) {
  const { rows } = await pool.query(
    `SELECT po.id, po.supplier_id AS "supplierId", s.name AS "supplierName", po.warehouse_id AS "warehouseId",
            po.status, po.expected_date AS "expectedDate", po.total_cost_cents AS "totalCostCents",
            po.created_by AS "createdBy", po.created_at AS "createdAt", po.received_by AS "receivedBy",
            po.received_at AS "receivedAt",
            (SELECT json_agg(json_build_object('lineNo', l.line_no, 'sku', l.sku, 'name', p.name,
                    'quantityCases', l.quantity_cases, 'unitCostCents', l.unit_cost_cents,
                    'lineTotalCents', l.line_total_cents) ORDER BY l.line_no)
             FROM orders.purchase_order_lines l JOIN orders.products p ON p.sku = l.sku
             WHERE l.purchase_order_id = po.id) AS lines
     FROM orders.purchase_orders po JOIN orders.suppliers s ON s.id = po.supplier_id WHERE po.id = $1`, [id]);
  return rows[0];
}

export async function listPurchaseOrders(limit: number) {
  const { rows } = await pool.query(
    `SELECT po.id, s.name AS "supplierName", po.warehouse_id AS "warehouseId", po.status,
            po.expected_date AS "expectedDate", po.total_cost_cents AS "totalCostCents", po.created_at AS "createdAt",
            po.received_at AS "receivedAt",
            (SELECT sum(quantity_cases)::int FROM orders.purchase_order_lines WHERE purchase_order_id = po.id) AS cases
     FROM orders.purchase_orders po JOIN orders.suppliers s ON s.id = po.supplier_id
     ORDER BY po.created_at DESC LIMIT $1`, [limit]);
  return rows;
}
