export interface Account { id: string; name: string; state: string; channel: 'OFF_PREMISE' | 'ON_PREMISE' }

export interface Product {
  sku: string; name: string; brand: string; category: 'BEER' | 'WINE' | 'SPIRITS'; subcategory: string;
  supplierId: string; supplierName: string; unitsPerCase: number; unitSize: string; abvPct: number;
  pricePerCaseCents: number;
}

export interface Reason { code: string; message: string; lineNo?: number }

export type OrderStatus = 'PENDING_COMPLIANCE' | 'PENDING_INVENTORY' | 'CONFIRMED' | 'REJECTED' | 'BACKORDERED';

export interface OrderSummary {
  id: string; accountId: string; accountName: string; state: string; status: OrderStatus;
  deliveryDate: string; totalCents: number; createdAt: string;
}

export interface Order extends OrderSummary {
  channel: string; paymentTerms: 'NET' | 'COD'; statusReasons: Reason[];
  allocations: { lineNo: number; sku: string; warehouseId: string; quantityCases: number }[] | null;
  createdBy: string;
  lines: { lineNo: number; sku: string; name: string; category: string; quantityCases: number; listPriceCents: number;
           discountPct: number; unitPriceCents: number; lineTotalCents: number }[];
  history: { from: string | null; to: string; detail: string; actor: string; at: string }[];
}

export interface StockRow {
  warehouseId: string; warehouse: string; state: string; sku: string;
  onHandCases: number; reservedCases: number; availableCases: number;
}

export interface Warehouse { id: string; name: string; state: string; priority: number }

export interface Supplier {
  id: string; name: string;
  products: { sku: string; name: string; subcategory: string; unitsPerCase: number; supplierCostCents: number }[];
}

export interface PurchaseOrder {
  id: string; supplierName: string; warehouseId: string; status: 'SUBMITTED' | 'RECEIVED' | 'CANCELLED';
  expectedDate: string; totalCostCents: number; createdAt: string; receivedAt: string | null; cases: number;
}

export interface License {
  license_number: string; license_type: string; status: string; expires_on: string;
  credit: { delinquent: boolean; outstanding_cents: number } | null;
}

export const STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING_COMPLIANCE: 'Compliance check',
  PENDING_INVENTORY: 'Reserving stock',
  CONFIRMED: 'Confirmed',
  REJECTED: 'Rejected',
  BACKORDERED: 'Backordered',
};
