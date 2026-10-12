-- Order API schema: accounts, catalog and state price lists, orders, outbox and consumer idempotency.
CREATE SCHEMA IF NOT EXISTS orders;

CREATE TABLE IF NOT EXISTS orders.accounts (
    id          TEXT PRIMARY KEY,                 -- e.g. ACC-FL-1001
    name        TEXT        NOT NULL,
    state       CHAR(2)     NOT NULL,
    channel     TEXT        NOT NULL CHECK (channel IN ('OFF_PREMISE', 'ON_PREMISE')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders.products (
    sku            TEXT PRIMARY KEY,
    name           TEXT    NOT NULL,
    category       TEXT    NOT NULL CHECK (category IN ('BEER', 'WINE', 'SPIRITS')),
    supplier_id    TEXT    NOT NULL,
    supplier_name  TEXT    NOT NULL,
    units_per_case INT     NOT NULL,
    abv_pct        NUMERIC(4, 1) NOT NULL
);

-- Price per case for each state and month. In price-posting states these must match the posted prices.
CREATE TABLE IF NOT EXISTS orders.product_prices (
    sku                  TEXT    NOT NULL REFERENCES orders.products (sku),
    state                CHAR(2) NOT NULL,
    effective_month      DATE    NOT NULL,
    price_per_case_cents BIGINT  NOT NULL CHECK (price_per_case_cents > 0),
    PRIMARY KEY (sku, state, effective_month)
);

CREATE TABLE IF NOT EXISTS orders.orders (
    id              UUID PRIMARY KEY,
    account_id      TEXT        NOT NULL REFERENCES orders.accounts (id),
    state           CHAR(2)     NOT NULL,
    channel         TEXT        NOT NULL,
    status          TEXT        NOT NULL,      -- PENDING_COMPLIANCE | PENDING_INVENTORY | CONFIRMED | REJECTED | BACKORDERED
    status_reasons  JSONB       NOT NULL DEFAULT '[]',
    payment_terms   TEXT        NOT NULL CHECK (payment_terms IN ('NET', 'COD')),
    delivery_date   DATE        NOT NULL,
    total_cents     BIGINT      NOT NULL,
    allocations     JSONB,
    idempotency_key TEXT        NOT NULL UNIQUE,
    request_hash    TEXT        NOT NULL,
    created_by      TEXT        NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_orders_account ON orders.orders (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_orders_status ON orders.orders (status, created_at DESC);

CREATE TABLE IF NOT EXISTS orders.order_lines (
    order_id         UUID    NOT NULL REFERENCES orders.orders (id),
    line_no          INT     NOT NULL,
    sku              TEXT    NOT NULL,
    category         TEXT    NOT NULL,
    supplier_id      TEXT    NOT NULL,
    quantity_cases   INT     NOT NULL CHECK (quantity_cases > 0),
    list_price_cents BIGINT  NOT NULL,
    discount_pct     NUMERIC(5, 2) NOT NULL DEFAULT 0,
    unit_price_cents BIGINT  NOT NULL,
    line_total_cents BIGINT  NOT NULL,
    PRIMARY KEY (order_id, line_no)
);

-- Status history (audit trail).
CREATE TABLE IF NOT EXISTS orders.order_events (
    id          BIGSERIAL PRIMARY KEY,
    order_id    UUID        NOT NULL REFERENCES orders.orders (id),
    from_status TEXT,
    to_status   TEXT        NOT NULL,
    detail      TEXT,
    actor       TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_order_events_order ON orders.order_events (order_id, id);

-- Transactional outbox: written in the same transaction as the order change, then relayed to Kafka.
CREATE TABLE IF NOT EXISTS orders.outbox (
    id           BIGSERIAL PRIMARY KEY,
    topic        TEXT        NOT NULL,
    message_key  TEXT        NOT NULL,
    payload      JSONB       NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_outbox_unpublished ON orders.outbox (id) WHERE published_at IS NULL;

-- Events this service has already applied (Kafka delivers at least once).
CREATE TABLE IF NOT EXISTS orders.processed_events (
    event_id     UUID PRIMARY KEY,
    event_type   TEXT        NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
