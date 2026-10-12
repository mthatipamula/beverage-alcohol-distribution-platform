import { createHash } from 'node:crypto';

/** Unit price after a sales-rep discount, rounded to the cent. Amounts are integer cents throughout. */
export function unitPriceCents(listPriceCents: number, discountPct: number): number {
  return Math.round((listPriceCents * (100 - discountPct)) / 100);
}

export function lineTotalCents(unitPrice: number, quantityCases: number): number {
  return unitPrice * quantityCases;
}

/** Stable hash of a request body, used to detect an Idempotency-Key reused with a different order. */
export function requestHash(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Today's date (YYYY-MM-DD) in the business timezone. */
export function businessToday(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
