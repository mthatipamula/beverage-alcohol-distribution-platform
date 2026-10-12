-- Compliance schema: licenses, credit status, state rules, posted prices, decisions, depletions and feeds.
CREATE SCHEMA IF NOT EXISTS compliance;

CREATE TABLE IF NOT EXISTS compliance.state_rules (
    state             CHAR(2) PRIMARY KEY,
    name              TEXT    NOT NULL,
    credit_law        BOOLEAN NOT NULL,   -- delinquent retailers may only buy cash on delivery
    price_posting     BOOLEAN NOT NULL,   -- distributors must sell at prices filed with the state
    sunday_delivery   BOOLEAN NOT NULL,
    saturday_delivery BOOLEAN NOT NULL,
    notes             TEXT
);

CREATE TABLE IF NOT EXISTS compliance.licenses (
    account_id     TEXT PRIMARY KEY,
    license_number TEXT    NOT NULL,
    state          CHAR(2) NOT NULL,
    license_type   TEXT    NOT NULL CHECK (license_type IN ('BEER_ONLY', 'BEER_WINE', 'FULL_LIQUOR')),
    status         TEXT    NOT NULL CHECK (status IN ('ACTIVE', 'SUSPENDED', 'EXPIRED')),
    expires_on     DATE    NOT NULL
);

CREATE TABLE IF NOT EXISTS compliance.account_credit (
    account_id        TEXT PRIMARY KEY,
    delinquent        BOOLEAN NOT NULL DEFAULT FALSE,
    outstanding_cents BIGINT  NOT NULL DEFAULT 0,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS compliance.posted_prices (
    state                CHAR(2) NOT NULL,
    sku                  TEXT    NOT NULL,
    effective_month      DATE    NOT NULL,
    price_per_case_cents BIGINT  NOT NULL,
    PRIMARY KEY (state, sku, effective_month)
);

-- One decision per order. Storing the published event makes redelivery safe: the same event is re-sent.
CREATE TABLE IF NOT EXISTS compliance.decisions (
    order_id   UUID PRIMARY KEY,
    account_id TEXT        NOT NULL,
    state      CHAR(2)     NOT NULL,
    approved   BOOLEAN     NOT NULL,
    reasons    JSONB       NOT NULL,
    checks     JSONB       NOT NULL,
    topic      TEXT        NOT NULL,
    event      JSONB       NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_decisions_created ON compliance.decisions (created_at DESC);

-- Confirmed order lines, reported to suppliers as depletions (sales out of the distributor).
CREATE TABLE IF NOT EXISTS compliance.depletions (
    order_id       UUID    NOT NULL,
    line_no        INT     NOT NULL,
    supplier_id    TEXT    NOT NULL,
    sku            TEXT    NOT NULL,
    account_id     TEXT    NOT NULL,
    state          CHAR(2) NOT NULL,
    channel        TEXT    NOT NULL,
    quantity_cases INT     NOT NULL,
    delivery_date  DATE    NOT NULL,
    confirmed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (order_id, line_no)
);
CREATE INDEX IF NOT EXISTS ix_depletions_date ON compliance.depletions (delivery_date, supplier_id);

CREATE TABLE IF NOT EXISTS compliance.depletion_feeds (
    supplier_id  TEXT NOT NULL,
    feed_date    DATE NOT NULL,
    location     TEXT NOT NULL,
    row_count    INT  NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (supplier_id, feed_date)
);
