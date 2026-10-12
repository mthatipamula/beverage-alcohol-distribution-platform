import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, businessToday, lineTotalCents, requestHash, unitPriceCents } from '../src/pricing.js';

test('discount is applied and rounded to the cent', () => {
  assert.equal(unitPriceCents(32400, 0), 32400);
  assert.equal(unitPriceCents(32400, 10), 29160);
  assert.equal(unitPriceCents(2650, 7.5), 2451); // 2451.25 rounds down
});

test('line total is unit price times cases', () => {
  assert.equal(lineTotalCents(29160, 3), 87480);
});

test('request hash ignores key order but not values', () => {
  const a = { accountId: 'ACC-1', lines: [{ sku: 'X', quantityCases: 2 }] };
  const b = { lines: [{ quantityCases: 2, sku: 'X' }], accountId: 'ACC-1' };
  assert.equal(requestHash(a), requestHash(b));
  assert.notEqual(requestHash(a), requestHash({ ...a, lines: [{ sku: 'X', quantityCases: 3 }] }));
});

test('business date uses the configured timezone', () => {
  // 02:30 UTC on Oct 12 is still Oct 11 in New York.
  assert.equal(businessToday('America/New_York', new Date('2026-10-12T02:30:00Z')), '2026-10-11');
  assert.equal(addDays('2026-10-30', 3), '2026-11-02');
});
