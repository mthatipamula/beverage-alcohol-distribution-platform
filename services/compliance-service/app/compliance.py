"""Consumes placed orders, runs the state rules and publishes OrderValidated or OrderRejected."""
from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timezone

import asyncpg
from aiokafka import AIOKafkaProducer

from . import kafka
from .rules import Credit, Decision, License, Line, Order, StateRule, evaluate

log = logging.getLogger(__name__)

# Deterministic event IDs: re-sending the same decision produces the same eventId, which consumers dedupe.
EVENT_NAMESPACE = uuid.UUID("3f6d2a51-9c4e-4b0b-8a7e-6c2d9b1f4e10")


def order_from_payload(p: dict) -> Order:
    return Order(
        order_id=p["orderId"], account_id=p["accountId"], state=p["state"],
        payment_terms=p["paymentTerms"], delivery_date=date.fromisoformat(p["deliveryDate"]),
        lines=[Line(line_no=l["lineNo"], sku=l["sku"], category=l["category"],
                    quantity_cases=l["quantityCases"], unit_price_cents=l["unitPriceCents"]) for l in p["lines"]],
    )


async def load_context(conn: asyncpg.Connection, order: Order):
    rule_row = await conn.fetchrow("SELECT * FROM compliance.state_rules WHERE state = $1", order.state)
    lic_row = await conn.fetchrow("SELECT * FROM compliance.licenses WHERE account_id = $1", order.account_id)
    credit_row = await conn.fetchrow("SELECT * FROM compliance.account_credit WHERE account_id = $1", order.account_id)
    posted_rows = await conn.fetch(
        """SELECT DISTINCT ON (sku) sku, price_per_case_cents FROM compliance.posted_prices
           WHERE state = $1 AND effective_month <= $2 ORDER BY sku, effective_month DESC""",
        order.state, order.delivery_date)
    rule = StateRule(**{k: rule_row[k] for k in ("state", "name", "credit_law", "price_posting",
                                                 "sunday_delivery", "saturday_delivery")}) if rule_row else None
    license = License(**dict(lic_row)) if lic_row else None
    credit = Credit(credit_row["delinquent"], credit_row["outstanding_cents"]) if credit_row else None
    posted = {r["sku"]: r["price_per_case_cents"] for r in posted_rows}
    return rule, license, credit, posted


def decision_event(order: Order, decision: Decision, payload: dict) -> tuple[str, dict]:
    approved = decision.approved
    event_type = "OrderValidated" if approved else "OrderRejected"
    body = {"orderId": order.order_id, "checks": decision.checks}
    if approved:
        # Inventory only needs what to allocate and where.
        body.update(accountId=order.account_id, state=order.state, deliveryDate=payload["deliveryDate"],
                    lines=[{"lineNo": l.line_no, "sku": l.sku, "quantityCases": l.quantity_cases} for l in order.lines])
    else:
        body["reasons"] = decision.reasons
    event = {
        "eventId": str(uuid.uuid5(EVENT_NAMESPACE, f"{order.order_id}:{event_type}")),
        "eventType": event_type,
        "occurredAt": datetime.now(timezone.utc).isoformat(),
        "orderId": order.order_id,
        "source": "compliance-service",
        "payload": body,
    }
    return (kafka.TOPIC_ORDER_VALIDATED if approved else kafka.TOPIC_ORDER_REJECTED), event


class ComplianceHandler:
    def __init__(self, pool: asyncpg.Pool, producer: AIOKafkaProducer):
        self.pool = pool
        self.producer = producer

    async def __call__(self, event: dict) -> None:
        payload = event["payload"]
        order = order_from_payload(payload)
        async with self.pool.acquire() as conn:
            existing = await conn.fetchrow(
                "SELECT topic, event FROM compliance.decisions WHERE order_id = $1", uuid.UUID(order.order_id))
            if existing:
                # Redelivered (e.g. we crashed after deciding but before committing the offset): re-send it.
                topic, out = existing["topic"], existing["event"]
            else:
                rule, license, credit, posted = await load_context(conn, order)
                decision = evaluate(order, rule, license, credit, posted)
                topic, out = decision_event(order, decision, payload)
                await conn.execute(
                    """INSERT INTO compliance.decisions (order_id, account_id, state, approved, reasons, checks, topic, event)
                       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (order_id) DO NOTHING""",
                    uuid.UUID(order.order_id), order.account_id, order.state, decision.approved,
                    decision.reasons, decision.checks, topic, out)
                log.info("Order %s %s %s", order.order_id, "approved" if decision.approved else "rejected",
                         [r["code"] for r in decision.reasons])
        await self.producer.send_and_wait(topic, value=out, key=order.order_id)
