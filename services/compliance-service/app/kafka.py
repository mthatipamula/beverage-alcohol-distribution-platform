"""Kafka clients and a consumer loop with retries, manual offset commits and a dead-letter topic."""
from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable

from aiokafka import AIOKafkaConsumer, AIOKafkaProducer, TopicPartition
from aiokafka.helpers import create_ssl_context

from . import config

log = logging.getLogger(__name__)

TOPIC_ORDER_PLACED = "orders.placed"
TOPIC_ORDER_VALIDATED = "orders.validated"
TOPIC_ORDER_REJECTED = "orders.rejected"
TOPIC_ORDER_CONFIRMED = "orders.confirmed"
TOPIC_DLQ = "compliance-service.dlq"

MAX_ATTEMPTS = 5


def _security() -> dict:
    if not config.KAFKA_SASL_USERNAME:
        return {}
    return {
        "security_protocol": "SASL_SSL",
        "sasl_mechanism": "SCRAM-SHA-512",
        "sasl_plain_username": config.KAFKA_SASL_USERNAME,
        "sasl_plain_password": config.KAFKA_SASL_PASSWORD,
        "ssl_context": create_ssl_context(),
    }


def new_producer() -> AIOKafkaProducer:
    return AIOKafkaProducer(
        bootstrap_servers=config.KAFKA_BROKERS, acks="all", enable_idempotence=True,
        value_serializer=lambda v: json.dumps(v).encode(), key_serializer=lambda k: k.encode(), **_security(),
    )


def new_consumer(topic: str, group_id: str) -> AIOKafkaConsumer:
    return AIOKafkaConsumer(
        topic, bootstrap_servers=config.KAFKA_BROKERS, group_id=group_id, enable_auto_commit=False,
        auto_offset_reset="earliest", **_security(),
    )


async def consume(
    consumer: AIOKafkaConsumer,
    producer: AIOKafkaProducer,
    handler: Callable[[dict], Awaitable[None]],
) -> None:
    """Processes one message at a time and commits its offset only after it was handled.

    Transient failures are retried with backoff. A message that cannot be parsed, or still fails after
    MAX_ATTEMPTS, goes to the dead-letter topic with the error, so one bad message never blocks the partition.
    """
    async for msg in consumer:
        tp = TopicPartition(msg.topic, msg.partition)
        try:
            event = json.loads(msg.value)
            if not event.get("eventId") or not event.get("orderId"):
                raise ValueError("missing eventId or orderId")
        except ValueError as err:
            await _dead_letter(producer, msg, f"unparseable event: {err}")
            await consumer.commit({tp: msg.offset + 1})
            continue

        for attempt in range(1, MAX_ATTEMPTS + 1):
            try:
                await handler(event)
                break
            except Exception as err:  # noqa: BLE001 - every failure is retried, then dead-lettered
                if attempt == MAX_ATTEMPTS:
                    log.exception("Giving up on event %s after %d attempts", event["eventId"], attempt)
                    await _dead_letter(producer, msg, f"{type(err).__name__}: {err}")
                else:
                    log.warning("Attempt %d for event %s failed: %s", attempt, event["eventId"], err)
                    await asyncio.sleep(min(30, 0.5 * 2 ** attempt))
        await consumer.commit({tp: msg.offset + 1})


async def _dead_letter(producer: AIOKafkaProducer, msg, reason: str) -> None:
    log.error("Dead-lettering message from %s[%d]@%d: %s", msg.topic, msg.partition, msg.offset, reason)
    await producer.send_and_wait(
        TOPIC_DLQ, value={"sourceTopic": msg.topic, "error": reason, "raw": msg.value.decode(errors="replace")},
        key=(msg.key or b"").decode(errors="replace"),
        headers=[("source-topic", msg.topic.encode()), ("error", reason.encode()[:1000])],
    )
