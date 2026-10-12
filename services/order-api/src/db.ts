import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from './config.js';

const sqlDir = fileURLToPath(new URL('../sql/', import.meta.url));

export const pool = new pg.Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  max: 10,
  ssl: config.db.sslCa ? { ca: readFileSync(config.db.sslCa, 'utf8'), rejectUnauthorized: true } : undefined,
});

// BIGINT comes back as a string by default; amounts here fit safely in a JS number.
pg.types.setTypeParser(20, (v) => Number(v));
// DATE stays a plain YYYY-MM-DD string (no timezone shifts).
pg.types.setTypeParser(1082, (v) => v);

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Creates the schema (idempotent) and loads demo data into an empty catalog. */
export async function migrate(log: { info: (msg: string) => void }): Promise<void> {
  await pool.query(readFileSync(`${sqlDir}schema.sql`, 'utf8'));
  if (config.seedDemoData) {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM orders.products');
    if (rows[0].n === 0) {
      await pool.query(readFileSync(`${sqlDir}seed.sql`, 'utf8'));
      log.info('Loaded demo accounts, products and price lists');
    }
  }
}
