-- Inventory schema: warehouses, stock per warehouse and SKU, and one allocation per order.
CREATE SCHEMA IF NOT EXISTS inventory;

CREATE TABLE IF NOT EXISTS inventory.warehouses (
    id       TEXT PRIMARY KEY,
    name     TEXT    NOT NULL,
    state    CHAR(2) NOT NULL,   -- alcohol ships to retailers from licensed in-state warehouses only
    priority INT     NOT NULL    -- lower ships first
);

CREATE TABLE IF NOT EXISTS inventory.stock (
    warehouse_id   TEXT   NOT NULL REFERENCES inventory.warehouses (id),
    sku            TEXT   NOT NULL,
    on_hand_cases  BIGINT NOT NULL CHECK (on_hand_cases >= 0),
    reserved_cases BIGINT NOT NULL DEFAULT 0 CHECK (reserved_cases >= 0 AND reserved_cases <= on_hand_cases),
    PRIMARY KEY (warehouse_id, sku)
);

-- One row per order. Storing the published event makes redelivery safe: the same event is re-sent.
CREATE TABLE IF NOT EXISTS inventory.allocations (
    order_id   UUID PRIMARY KEY,
    status     TEXT        NOT NULL CHECK (status IN ('RESERVED', 'FAILED')),
    topic      TEXT        NOT NULL,
    event      JSONB       NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory.allocation_lines (
    order_id       UUID   NOT NULL REFERENCES inventory.allocations (order_id),
    line_no        INT    NOT NULL,
    sku            TEXT   NOT NULL,
    warehouse_id   TEXT   NOT NULL,
    quantity_cases BIGINT NOT NULL,
    PRIMARY KEY (order_id, line_no, warehouse_id)
);

-- Purchase-order receipts already applied (Kafka delivers at least once, so each is applied once).
CREATE TABLE IF NOT EXISTS inventory.receipts (
    purchase_order_id UUID PRIMARY KEY,
    warehouse_id      TEXT        NOT NULL REFERENCES inventory.warehouses (id),
    cases             BIGINT      NOT NULL,
    received_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
