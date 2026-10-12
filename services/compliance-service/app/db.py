import json
import logging
import ssl
from pathlib import Path

import asyncpg

from . import config

log = logging.getLogger(__name__)
SQL_DIR = Path(__file__).resolve().parent.parent / "sql"


async def _init_connection(conn: asyncpg.Connection) -> None:
    await conn.set_type_codec("jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")


async def create_pool() -> asyncpg.Pool:
    tls = ssl.create_default_context(cafile=config.DB_SSL_CA) if config.DB_SSL_CA else None
    return await asyncpg.create_pool(
        host=config.DB_HOST, port=config.DB_PORT, database=config.DB_NAME,
        user=config.DB_USER, password=config.DB_PASSWORD, ssl=tls,
        min_size=1, max_size=10, init=_init_connection,
    )


async def migrate(pool: asyncpg.Pool) -> None:
    """Creates the schema (idempotent) and loads demo data when the tables are empty."""
    async with pool.acquire() as conn:
        await conn.execute((SQL_DIR / "schema.sql").read_text())
        if config.SEED_DEMO_DATA and await conn.fetchval("SELECT count(*) FROM compliance.state_rules") == 0:
            await conn.execute((SQL_DIR / "seed.sql").read_text())
            log.info("Loaded demo state rules, licenses, credit status and posted prices")
