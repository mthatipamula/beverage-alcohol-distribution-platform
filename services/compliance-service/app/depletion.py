"""Supplier depletion reporting: records confirmed order lines and writes a daily CSV feed per supplier."""
from __future__ import annotations

import asyncio
import csv
import io
import logging
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import asyncpg

from . import config

log = logging.getLogger(__name__)

FEED_COLUMNS = ["distributor_id", "supplier_id", "invoice_date", "order_id", "account_id", "account_state",
                "channel", "sku", "cases"]


class DepletionRecorder:
    """Consumes OrderConfirmed. Inserting by (order, line) makes redelivery harmless."""

    def __init__(self, pool: asyncpg.Pool):
        self.pool = pool

    async def __call__(self, event: dict) -> None:
        p = event["payload"]
        rows = [(uuid.UUID(p["orderId"]), l["lineNo"], l["supplierId"], l["sku"], p["accountId"], p["state"],
                 p["channel"], l["quantityCases"], date.fromisoformat(p["deliveryDate"])) for l in p["lines"]]
        async with self.pool.acquire() as conn:
            await conn.executemany(
                """INSERT INTO compliance.depletions (order_id, line_no, supplier_id, sku, account_id, state, channel,
                                                      quantity_cases, delivery_date)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING""", rows)
        log.info("Recorded %d depletion lines for order %s", len(rows), p["orderId"])


async def generate_feeds(pool: asyncpg.Pool, feed_date: date) -> list[dict]:
    """Writes one CSV per supplier for orders delivered on feed_date (to S3, or a local folder)."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT supplier_id, delivery_date, order_id, account_id, state, channel, sku, quantity_cases
               FROM compliance.depletions WHERE delivery_date = $1 ORDER BY supplier_id, order_id, line_no""",
            feed_date)
    by_supplier: dict[str, list] = {}
    for r in rows:
        by_supplier.setdefault(r["supplier_id"], []).append(r)

    results = []
    for supplier_id, supplier_rows in by_supplier.items():
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(FEED_COLUMNS)
        for r in supplier_rows:
            writer.writerow([config.DISTRIBUTOR_ID, supplier_id, r["delivery_date"].isoformat(), r["order_id"],
                             r["account_id"], r["state"], r["channel"], r["sku"], r["quantity_cases"]])
        key = f"depletions/{supplier_id}/{feed_date.isoformat()}.csv"
        location = await _store(key, buf.getvalue())
        async with pool.acquire() as conn:
            await conn.execute(
                """INSERT INTO compliance.depletion_feeds (supplier_id, feed_date, location, row_count)
                   VALUES ($1, $2, $3, $4)
                   ON CONFLICT (supplier_id, feed_date) DO UPDATE
                   SET location = EXCLUDED.location, row_count = EXCLUDED.row_count, generated_at = now()""",
                supplier_id, feed_date, location, len(supplier_rows))
        results.append({"supplierId": supplier_id, "rows": len(supplier_rows), "location": location})
    return results


async def _store(key: str, content: str) -> str:
    if config.FEEDS_BUCKET:
        import boto3  # imported lazily: only needed on AWS

        def put() -> None:
            boto3.client("s3").put_object(Bucket=config.FEEDS_BUCKET, Key=key, Body=content.encode(),
                                          ContentType="text/csv", ServerSideEncryption="AES256")

        await asyncio.to_thread(put)
        return f"s3://{config.FEEDS_BUCKET}/{key}"
    path = Path(config.FEEDS_DIR) / key
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    return str(path)


async def daily_feed_scheduler(pool: asyncpg.Pool) -> None:
    """At 02:00 business time, writes yesterday's feeds. Re-running overwrites the same files."""
    tz = ZoneInfo(config.BUSINESS_TIMEZONE)
    while True:
        now = datetime.now(tz)
        next_run = now.replace(hour=2, minute=0, second=0, microsecond=0)
        if next_run <= now:
            next_run += timedelta(days=1)
        await asyncio.sleep((next_run - now).total_seconds())
        try:
            results = await generate_feeds(pool, (next_run - timedelta(days=1)).date())
            log.info("Generated %d supplier depletion feeds", len(results))
        except Exception:  # noqa: BLE001 - keep the scheduler alive
            log.exception("Daily depletion feed generation failed")
