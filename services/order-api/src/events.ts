import { randomUUID } from 'node:crypto';

// Kafka topics. Every message is keyed by order ID, so all events for one order stay in order on one partition.
export const Topics = {
  orderPlaced: 'orders.placed',
  orderValidated: 'orders.validated',
  orderRejected: 'orders.rejected',
  inventoryReserved: 'inventory.reserved',
  inventoryFailed: 'inventory.failed',
  orderConfirmed: 'orders.confirmed',
  inventoryReceipts: 'inventory.receipts',
  orderApiDlq: 'order-api.dlq',
  complianceDlq: 'compliance-service.dlq',
  allocatorDlq: 'inventory-allocator.dlq',
} as const;

export interface EventEnvelope<T = unknown> {
  eventId: string;
  eventType: string;
  occurredAt: string;
  orderId: string;
  source: string;
  payload: T;
}

export interface Reason {
  code: string;
  message: string;
  lineNo?: number;
}

export interface OrderLinePayload {
  lineNo: number;
  sku: string;
  category: string;
  supplierId: string;
  quantityCases: number;
  listPriceCents: number;
  discountPct: number;
  unitPriceCents: number;
}

export interface OrderPlacedPayload {
  orderId: string;
  accountId: string;
  state: string;
  channel: string;
  paymentTerms: 'NET' | 'COD';
  deliveryDate: string;
  totalCents: number;
  lines: OrderLinePayload[];
}

export interface Allocation {
  lineNo: number;
  sku: string;
  warehouseId: string;
  quantityCases: number;
}

export const envelope = <T>(eventType: string, orderId: string, payload: T): EventEnvelope<T> => ({
  eventId: randomUUID(),
  eventType,
  occurredAt: new Date().toISOString(),
  orderId,
  source: 'order-api',
  payload,
});
