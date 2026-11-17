//! Kafka consumer for two topics:
//! - orders.validated: reserves stock and publishes InventoryReserved or InventoryFailed;
//! - inventory.receipts: adds received purchase-order cases to a warehouse's stock.
//!
//! Delivery is at least once. Each order's outcome is stored with the event that was published, so a
//! redelivered message re-sends the same event (same eventId) instead of reserving stock twice. Offsets are
//! committed only after the outcome is published. Messages that cannot be parsed, or keep failing, go to a
//! dead-letter topic so they never block the partition.

use std::time::Duration;

use anyhow::Context;
use deadpool_postgres::Pool;
use rdkafka::{
    consumer::{CommitMode, Consumer, StreamConsumer},
    message::{Header, OwnedHeaders},
    producer::{FutureProducer, FutureRecord},
    ClientConfig, Message,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    allocate::{allocate, Line, Stock},
    config::Config,
};

pub const TOPIC_VALIDATED: &str = "orders.validated";
pub const TOPIC_RESERVED: &str = "inventory.reserved";
pub const TOPIC_FAILED: &str = "inventory.failed";
pub const TOPIC_RECEIPTS: &str = "inventory.receipts";
pub const TOPIC_DLQ: &str = "inventory-allocator.dlq";
const MAX_ATTEMPTS: u32 = 5;
const EVENT_NAMESPACE: Uuid = Uuid::from_u128(0x6a1f_3c2e_8d4b_4f7a_9b0c_2e5d_7f81_a3c4);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    event_id: Uuid,
    order_id: Uuid,
    payload: ValidatedOrder,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ValidatedOrder {
    state: String,
    lines: Vec<Line>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReceiptEnvelope {
    payload: Receipt,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    purchase_order_id: Uuid,
    warehouse_id: String,
    lines: Vec<ReceiptLine>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReceiptLine {
    sku: String,
    quantity_cases: i64,
}

enum Incoming {
    Order(Envelope),
    Receipt(ReceiptEnvelope),
}

/// A failure that retrying cannot fix (e.g. an unknown warehouse): dead-lettered at once.
#[derive(Debug)]
struct Permanent(String);

impl std::fmt::Display for Permanent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Permanent {}

fn client_config(cfg: &Config) -> ClientConfig {
    let mut c = ClientConfig::new();
    c.set("bootstrap.servers", &cfg.kafka_brokers);
    if let Some((user, pass)) = &cfg.kafka_sasl {
        c.set("security.protocol", "SASL_SSL")
            .set("sasl.mechanisms", "SCRAM-SHA-512")
            .set("sasl.username", user)
            .set("sasl.password", pass)
            .set("ssl.ca.location", "/etc/ssl/certs/ca-certificates.crt");
    }
    c
}

pub fn producer(cfg: &Config) -> anyhow::Result<FutureProducer> {
    Ok(client_config(cfg).set("enable.idempotence", "true").set("acks", "all").create()?)
}

pub async fn run(cfg: Config, pool: Pool, producer: FutureProducer) -> anyhow::Result<()> {
    let consumer: StreamConsumer = client_config(&cfg)
        .set("group.id", "inventory-allocator")
        .set("enable.auto.commit", "false")
        .set("auto.offset.reset", "earliest")
        .create()?;
    consumer.subscribe(&[TOPIC_VALIDATED, TOPIC_RECEIPTS])?;
    tracing::info!(topics = ?[TOPIC_VALIDATED, TOPIC_RECEIPTS], "Consuming");

    loop {
        // Broker errors (e.g. the topic not created yet at first deploy) are logged, not fatal.
        let msg = match consumer.recv().await {
            Ok(msg) => msg,
            Err(err) => {
                tracing::warn!(error = %err, "Kafka receive error; retrying");
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
        };
        let raw = msg.payload().unwrap_or_default();
        let parsed = match msg.topic() {
            TOPIC_RECEIPTS => serde_json::from_slice(raw).map(Incoming::Receipt),
            _ => serde_json::from_slice(raw).map(Incoming::Order),
        };
        match parsed {
            Err(err) => dead_letter(&producer, msg.topic(), raw, &format!("unparseable event: {err}")).await?,
            Ok(incoming) => {
                let mut attempt = 1;
                loop {
                    let result = match &incoming {
                        Incoming::Order(event) => handle(&pool, &producer, event).await,
                        Incoming::Receipt(event) => handle_receipt(&pool, &event.payload).await,
                    };
                    match result {
                        Ok(()) => break,
                        Err(err) if attempt >= MAX_ATTEMPTS || err.downcast_ref::<Permanent>().is_some() => {
                            tracing::error!(topic = msg.topic(), error = %err, "Giving up; dead-lettering");
                            dead_letter(&producer, msg.topic(), raw, &format!("{err:#}")).await?;
                            break;
                        }
                        Err(err) => {
                            tracing::warn!(topic = msg.topic(), attempt, error = %err, "Retrying");
                            tokio::time::sleep(Duration::from_millis(500 * 2u64.pow(attempt))).await;
                            attempt += 1;
                        }
                    }
                }
            }
        }
        consumer.commit_message(&msg, CommitMode::Async)?;
    }
}

/// Adds received cases to the warehouse, once per purchase order.
async fn handle_receipt(pool: &Pool, receipt: &Receipt) -> anyhow::Result<()> {
    let mut client = pool.get().await.context("database connection")?;
    let tx = client.transaction().await?;
    let known = tx
        .query_opt("SELECT 1 FROM inventory.warehouses WHERE id = $1", &[&receipt.warehouse_id])
        .await?;
    if known.is_none() {
        return Err(Permanent(format!("unknown warehouse {}", receipt.warehouse_id)).into());
    }
    let cases: i64 = receipt.lines.iter().map(|l| l.quantity_cases).sum();
    let inserted = tx
        .execute(
            "INSERT INTO inventory.receipts (purchase_order_id, warehouse_id, cases) VALUES ($1, $2, $3)
             ON CONFLICT (purchase_order_id) DO NOTHING",
            &[&receipt.purchase_order_id, &receipt.warehouse_id, &cases],
        )
        .await?;
    if inserted == 0 {
        tracing::info!(purchase_order_id = %receipt.purchase_order_id, "Receipt already applied");
        return Ok(());
    }
    for line in &receipt.lines {
        tx.execute(
            "INSERT INTO inventory.stock (warehouse_id, sku, on_hand_cases) VALUES ($1, $2, $3)
             ON CONFLICT (warehouse_id, sku) DO UPDATE SET on_hand_cases = inventory.stock.on_hand_cases + EXCLUDED.on_hand_cases",
            &[&receipt.warehouse_id, &line.sku, &line.quantity_cases],
        )
        .await?;
    }
    tx.commit().await?;
    tracing::info!(purchase_order_id = %receipt.purchase_order_id, warehouse = %receipt.warehouse_id, cases, "Stock received");
    Ok(())
}

async fn handle(pool: &Pool, producer: &FutureProducer, event: &Envelope) -> anyhow::Result<()> {
    let mut client = pool.get().await.context("database connection")?;
    let order_id = event.order_id;

    // Redelivery: publish the stored outcome again (same eventId, so consumers ignore the copy).
    if let Some(row) = client
        .query_opt("SELECT topic, event FROM inventory.allocations WHERE order_id = $1", &[&order_id])
        .await?
    {
        let (topic, out): (String, Value) = (row.get(0), row.get(1));
        return publish(producer, &topic, order_id, &out).await;
    }

    let skus: Vec<String> = event.payload.lines.iter().map(|l| l.sku.clone()).collect();
    let tx = client.transaction().await?;
    // Lock the stock rows in a fixed order (priority, warehouse, SKU) so concurrent orders cannot deadlock.
    let rows = tx
        .query(
            "SELECT s.warehouse_id, s.sku, s.on_hand_cases - s.reserved_cases
             FROM inventory.stock s JOIN inventory.warehouses w ON w.id = s.warehouse_id
             WHERE w.state = $1 AND s.sku = ANY($2)
             ORDER BY w.priority, s.warehouse_id, s.sku
             FOR UPDATE OF s",
            &[&event.payload.state, &skus],
        )
        .await?;
    let stock: Vec<Stock> = rows
        .iter()
        .map(|r| Stock { warehouse_id: r.get(0), sku: r.get(1), available: r.get(2) })
        .collect();

    let (status, topic, event_type, payload) = match allocate(&event.payload.lines, &stock) {
        Ok(allocations) => {
            for a in &allocations {
                tx.execute(
                    "UPDATE inventory.stock SET reserved_cases = reserved_cases + $3 WHERE warehouse_id = $1 AND sku = $2",
                    &[&a.warehouse_id, &a.sku, &a.quantity_cases],
                )
                .await?;
            }
            ("RESERVED", TOPIC_RESERVED, "InventoryReserved", json!({ "orderId": order_id, "allocations": allocations }))
        }
        Err(shortages) => ("FAILED", TOPIC_FAILED, "InventoryFailed", json!({ "orderId": order_id, "reasons": shortages })),
    };

    let out = json!({
        "eventId": Uuid::new_v5(&EVENT_NAMESPACE, format!("{order_id}:{event_type}").as_bytes()),
        "eventType": event_type,
        "occurredAt": chrono::Utc::now().to_rfc3339(),
        "orderId": order_id,
        "source": "inventory-allocator",
        "payload": payload,
        "causationId": event.event_id,
    });
    tx.execute(
        "INSERT INTO inventory.allocations (order_id, status, topic, event) VALUES ($1, $2, $3, $4)",
        &[&order_id, &status, &topic, &out],
    )
    .await?;
    if let Some(allocations) = out["payload"]["allocations"].as_array() {
        for a in allocations {
            tx.execute(
                "INSERT INTO inventory.allocation_lines (order_id, line_no, sku, warehouse_id, quantity_cases)
                 VALUES ($1, $2, $3, $4, $5)",
                &[
                    &order_id,
                    &(a["lineNo"].as_i64().unwrap_or_default() as i32),
                    &a["sku"].as_str().unwrap_or_default(),
                    &a["warehouseId"].as_str().unwrap_or_default(),
                    &a["quantityCases"].as_i64().unwrap_or_default(),
                ],
            )
            .await?;
        }
    }
    tx.commit().await?;
    tracing::info!(%order_id, status, "Allocation decided");
    publish(producer, topic, order_id, &out).await
}

async fn publish(producer: &FutureProducer, topic: &str, order_id: Uuid, event: &Value) -> anyhow::Result<()> {
    let key = order_id.to_string();
    let body = event.to_string();
    producer
        .send(FutureRecord::to(topic).key(&key).payload(&body), Duration::from_secs(30))
        .await
        .map_err(|(err, _)| anyhow::anyhow!("publishing to {topic}: {err}"))?;
    Ok(())
}

async fn dead_letter(producer: &FutureProducer, source: &str, raw: &[u8], reason: &str) -> anyhow::Result<()> {
    tracing::error!(source, reason, "Sending message to dead-letter topic");
    let headers = OwnedHeaders::new()
        .insert(Header { key: "source-topic", value: Some(source) })
        .insert(Header { key: "error", value: Some(reason) });
    producer
        .send(FutureRecord::<(), _>::to(TOPIC_DLQ).payload(raw).headers(headers), Duration::from_secs(30))
        .await
        .map_err(|(err, _)| anyhow::anyhow!("publishing to {TOPIC_DLQ}: {err}"))?;
    Ok(())
}
