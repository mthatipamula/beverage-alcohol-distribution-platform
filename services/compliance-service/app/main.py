"""Compliance service: state compliance checks (Kafka consumer + REST) and supplier depletion feeds."""
from __future__ import annotations

import asyncio
import logging
import uuid
from contextlib import asynccontextmanager
from datetime import date

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import config, kafka
from .auth import Principal, principal, require
from .compliance import ComplianceHandler, load_context, order_from_payload
from .db import create_pool, migrate
from .depletion import DepletionRecorder, daily_feed_scheduler, generate_feeds
from .rules import evaluate

logging.basicConfig(level=logging.INFO, format='{"time":"%(asctime)s","level":"%(levelname)s","logger":"%(name)s","message":"%(message)s"}')
log = logging.getLogger("compliance-service")
state: dict = {}


@asynccontextmanager
async def lifespan(_: FastAPI):
    pool = await create_pool()
    await migrate(pool)
    producer = kafka.new_producer()
    await producer.start()
    compliance_consumer = kafka.new_consumer(kafka.TOPIC_ORDER_PLACED, "compliance-service")
    depletion_consumer = kafka.new_consumer(kafka.TOPIC_ORDER_CONFIRMED, "depletion-recorder")
    await compliance_consumer.start()
    await depletion_consumer.start()
    tasks = [
        asyncio.create_task(kafka.consume(compliance_consumer, producer, ComplianceHandler(pool, producer))),
        asyncio.create_task(kafka.consume(depletion_consumer, producer, DepletionRecorder(pool))),
    ]
    if config.FEED_SCHEDULE_ENABLED:
        tasks.append(asyncio.create_task(daily_feed_scheduler(pool)))
    for t in tasks:
        t.add_done_callback(lambda t: t.cancelled() or not t.exception() or log.error("Background task died: %r", t.exception()))
    state.update(pool=pool, tasks=tasks)
    yield
    for t in tasks:
        t.cancel()
    await compliance_consumer.stop()
    await depletion_consumer.stop()
    await producer.stop()
    await pool.close()


app = FastAPI(title="Compliance Service", version="1.0.0", lifespan=lifespan,
              description="State alcohol compliance checks and supplier depletion feeds")


@app.exception_handler(HTTPException)
async def problem_details(_, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code,
                        content={"type": "about:blank", "status": exc.status_code, "detail": exc.detail})


@app.get("/health", include_in_schema=False)
async def health():
    dead = [t for t in state.get("tasks", []) if t.done()]
    try:
        await state["pool"].fetchval("SELECT 1")
    except Exception:  # noqa: BLE001
        return JSONResponse({"status": "DOWN", "reason": "database"}, status_code=503)
    if dead:
        return JSONResponse({"status": "DOWN", "reason": "a Kafka consumer stopped"}, status_code=503)
    return {"status": "UP"}


@app.get("/v1/compliance/states")
async def states(p: Principal = Depends(principal)):
    require(p, "admin", "sales_rep")
    rows = await state["pool"].fetch("SELECT * FROM compliance.state_rules ORDER BY state")
    return [dict(r) for r in rows]


@app.get("/v1/compliance/licenses/{account_id}")
async def license_status(account_id: str, p: Principal = Depends(principal)):
    if not (p.roles & {"admin", "sales_rep"}) and p.account_id != account_id:
        raise HTTPException(403, "You can only view your own license")
    async with state["pool"].acquire() as conn:
        lic = await conn.fetchrow("SELECT * FROM compliance.licenses WHERE account_id = $1", account_id)
        credit = await conn.fetchrow("SELECT delinquent, outstanding_cents FROM compliance.account_credit WHERE account_id = $1", account_id)
    if lic is None:
        raise HTTPException(404, "No license on file")
    return {**dict(lic), "credit": dict(credit) if credit else None}


@app.get("/v1/compliance/decisions/{order_id}")
async def decision(order_id: uuid.UUID, p: Principal = Depends(principal)):
    require(p, "admin", "sales_rep")
    row = await state["pool"].fetchrow(
        "SELECT order_id, account_id, state, approved, reasons, checks, created_at FROM compliance.decisions WHERE order_id = $1",
        order_id)
    if row is None:
        raise HTTPException(404, "No decision yet for this order")
    return dict(row)


class DraftLine(BaseModel):
    sku: str
    category: str = Field(pattern="^(BEER|WINE|SPIRITS)$")
    quantityCases: int = Field(ge=1)
    unitPriceCents: int = Field(ge=1)


class DraftOrder(BaseModel):
    accountId: str
    state: str = Field(pattern="^[A-Z]{2}$")
    paymentTerms: str = Field(pattern="^(NET|COD)$")
    deliveryDate: date
    lines: list[DraftLine] = Field(min_length=1, max_length=100)


@app.post("/v1/compliance/check")
async def check(draft: DraftOrder, p: Principal = Depends(principal)):
    """Dry run for sales reps: which rules would this order break? Nothing is stored or published."""
    require(p, "admin", "sales_rep")
    payload = {"orderId": "draft", "accountId": draft.accountId, "state": draft.state,
               "paymentTerms": draft.paymentTerms, "deliveryDate": draft.deliveryDate.isoformat(),
               "lines": [{"lineNo": i + 1, **l.model_dump()} for i, l in enumerate(draft.lines)]}
    order = order_from_payload(payload)
    async with state["pool"].acquire() as conn:
        rule, license, credit, posted = await load_context(conn, order)
    d = evaluate(order, rule, license, credit, posted)
    return {"approved": d.approved, "reasons": d.reasons, "checks": d.checks}


@app.get("/v1/depletions/summary")
async def depletion_summary(feed_date: date = Query(alias="date"), p: Principal = Depends(principal)):
    require(p, "admin")
    rows = await state["pool"].fetch(
        """SELECT supplier_id, sku, state, sum(quantity_cases)::int AS cases, count(DISTINCT order_id)::int AS orders
           FROM compliance.depletions WHERE delivery_date = $1 GROUP BY supplier_id, sku, state ORDER BY 1, 2, 3""",
        feed_date)
    return [dict(r) for r in rows]


@app.post("/v1/depletions/feeds")
async def depletion_feeds(feed_date: date = Query(alias="date"), p: Principal = Depends(principal)):
    """Writes the supplier depletion feeds for one delivery date (normally run nightly by the scheduler)."""
    require(p, "admin")
    return {"date": feed_date.isoformat(), "feeds": await generate_feeds(state["pool"], feed_date)}
