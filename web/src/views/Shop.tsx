import { useEffect, useMemo, useState } from 'react';
import { api, hasRole, newKey, nextWeekday, usd, type Session } from '../api';
import { LICENSE_LABEL, Notice, SUBCATEGORY_LABEL, SUBCATEGORY_ORDER, Tag, useLoad } from '../components';
import type { Account, License, Product, Reason, StockRow } from '../types';

const CATEGORIES = ['ALL', 'SCOTCH', 'VODKA', 'WINE', 'BEER'];

interface CartLine { sku: string; quantityCases: number; discountPct: number }

export default function Shop({ session, onOrderPlaced }: { session: Session; onOrderPlaced: (id: string) => void }) {
  const isRep = hasRole(session, 'admin', 'sales_rep');
  const [accounts] = useLoad(() => api<Account[]>('/v1/accounts'), []);
  const [accountId, setAccountId] = useState(session.accountId ?? '');
  useEffect(() => { if (!accountId && accounts?.length) setAccountId(accounts[0].id); }, [accounts, accountId]);
  const account = accounts?.find((a) => a.id === accountId);

  const [products, productError] = useLoad(
    () => (account ? api<Product[]>(`/v1/products?state=${account.state}`) : Promise.resolve([])), [account?.state]);
  const [stock] = useLoad(
    () => (account ? api<StockRow[]>(`/v1/inventory?state=${account.state}`) : Promise.resolve([])), [account?.state], 15000);
  const [license] = useLoad(
    () => (account ? api<License>(`/v1/compliance/licenses/${account.id}`).catch(() => null) : Promise.resolve(null)), [account?.id]);

  const available = useMemo(() => {
    const m = new Map<string, number>();
    stock?.forEach((s) => m.set(s.sku, (m.get(s.sku) ?? 0) + s.availableCases));
    return m;
  }, [stock]);

  const [category, setCategory] = useState('ALL');
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  useEffect(() => setCart([]), [accountId]);
  const [deliveryDate, setDeliveryDate] = useState(nextWeekday());
  const [terms, setTerms] = useState<'NET' | 'COD'>('NET');
  const [error, setError] = useState('');
  const [check, setCheck] = useState<{ approved: boolean; reasons: Reason[] } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setCheck(null), [cart, deliveryDate, terms, accountId]);

  const shown = (products ?? [])
    .filter((p) => (category === 'ALL' || p.subcategory === category) && `${p.brand} ${p.name}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => SUBCATEGORY_ORDER.indexOf(a.subcategory) - SUBCATEGORY_ORDER.indexOf(b.subcategory) || a.name.localeCompare(b.name));
  const bySku = new Map((products ?? []).map((p) => [p.sku, p]));
  const unitPrice = (l: CartLine) => Math.round((bySku.get(l.sku)!.pricePerCaseCents * (100 - l.discountPct)) / 100);
  const total = cart.reduce((s, l) => s + unitPrice(l) * l.quantityCases, 0);

  const setQty = (sku: string, qty: number) => setCart((c) =>
    qty <= 0 ? c.filter((l) => l.sku !== sku)
      : c.some((l) => l.sku === sku) ? c.map((l) => (l.sku === sku ? { ...l, quantityCases: qty } : l))
        : [...c, { sku, quantityCases: qty, discountPct: 0 }]);
  const qtyOf = (sku: string) => cart.find((l) => l.sku === sku)?.quantityCases ?? 0;

  async function precheck() {
    if (!account) return;
    try {
      setCheck(await api('/v1/compliance/check', {
        method: 'POST',
        body: {
          accountId: account.id, state: account.state, paymentTerms: terms, deliveryDate,
          lines: cart.map((l) => ({ sku: l.sku, category: bySku.get(l.sku)!.category, quantityCases: l.quantityCases, unitPriceCents: unitPrice(l) })),
        },
      }));
    } catch (e) { setError((e as Error).message); }
  }

  async function placeOrder() {
    if (!account) return;
    setBusy(true); setError('');
    try {
      const order = await api<{ id: string }>('/v1/orders', {
        method: 'POST',
        headers: { 'Idempotency-Key': newKey() },
        body: {
          accountId: account.id, deliveryDate, paymentTerms: terms,
          lines: cart.map((l) => ({ sku: l.sku, quantityCases: l.quantityCases, ...(l.discountPct ? { discountPct: l.discountPct } : {}) })),
        },
      });
      setCart([]);
      onOrderPlaced(order.id);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }

  return (
    <div className="shop">
      <section className="catalog">
        <div className="account-bar">
          {isRep ? (
            <label className="inline">Ordering for
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {accounts?.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.state})</option>)}
              </select>
            </label>
          ) : <h1>{account?.name ?? 'Loading…'}</h1>}
          {account && <Tag>{account.state} · {account.channel === 'OFF_PREMISE' ? 'Off-premise' : 'On-premise'}</Tag>}
          {license && <Tag tone={license.status === 'ACTIVE' ? 'good' : 'bad'}>
            {LICENSE_LABEL[license.license_type] ?? license.license_type} license · {license.status.toLowerCase()} · expires {license.expires_on}</Tag>}
          {license?.credit?.delinquent && <Tag tone="warn">Past due {usd(license.credit.outstanding_cents)}: cash on delivery only</Tag>}
        </div>

        <div className="filters">
          <div className="segmented" role="tablist">
            {CATEGORIES.map((c) => (
              <button key={c} role="tab" aria-selected={category === c} className={category === c ? 'active' : ''} onClick={() => setCategory(c)}>
                {c === 'ALL' ? 'All' : SUBCATEGORY_LABEL[c]}
              </button>
            ))}
          </div>
          <input type="search" placeholder="Search brands" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search brands" />
        </div>
        <Notice>{productError}</Notice>

        <div className="grid">
          {shown.map((p) => {
            const avail = available.get(p.sku);
            const qty = qtyOf(p.sku);
            return (
              <article key={p.sku} className={`product ${p.subcategory.toLowerCase()}`}>
                <div className="product-top">
                  <span className="kind">{SUBCATEGORY_LABEL[p.subcategory]}</span>
                  {avail !== undefined && (
                    <span className={`stock ${avail === 0 ? 'out' : avail < 25 ? 'low' : ''}`}>
                      {avail === 0 ? 'Out of stock' : avail < 25 ? `Only ${avail} cases` : `${avail} cases in ${account?.state}`}
                    </span>
                  )}
                </div>
                <h3>{p.name}</h3>
                <p className="muted small">{p.unitsPerCase} × {p.unitSize} · {p.abvPct}% ABV · {p.supplierName}</p>
                <div className="product-bottom">
                  <div><strong>{usd(p.pricePerCaseCents)}</strong><span className="muted small"> / case</span></div>
                  {qty === 0 ? (
                    <button className="secondary" onClick={() => setQty(p.sku, 1)}>Add</button>
                  ) : (
                    <div className="stepper" aria-label={`Cases of ${p.name}`}>
                      <button onClick={() => setQty(p.sku, qty - 1)} aria-label="One less">−</button>
                      <input inputMode="numeric" value={qty} onChange={(e) => setQty(p.sku, Number(e.target.value.replace(/\D/g, '')) || 0)} />
                      <button onClick={() => setQty(p.sku, qty + 1)} aria-label="One more">+</button>
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <aside className="cart" aria-label="Order">
        <h2>Order</h2>
        {cart.length === 0 ? <p className="muted">Add cases from the catalog.</p> : (
          <ul className="cart-lines">
            {cart.map((l) => {
              const p = bySku.get(l.sku);
              if (!p) return null;
              return (
                <li key={l.sku}>
                  <div className="row-between"><span>{p.name}</span><button className="link" onClick={() => setQty(l.sku, 0)}>Remove</button></div>
                  <div className="row-between muted small">
                    <span>{l.quantityCases} cs × {usd(unitPrice(l))}</span><span>{usd(unitPrice(l) * l.quantityCases)}</span>
                  </div>
                  {isRep && (
                    <label className="inline small">Discount %
                      <input type="number" min={0} max={30} step={0.5} value={l.discountPct}
                        onChange={(e) => setCart((c) => c.map((x) => (x.sku === l.sku ? { ...x, discountPct: Number(e.target.value) } : x)))} />
                    </label>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <label>Delivery date<input type="date" value={deliveryDate} min={nextWeekday(1)} onChange={(e) => setDeliveryDate(e.target.value)} /></label>
        <label>Payment terms
          <select value={terms} onChange={(e) => setTerms(e.target.value as 'NET' | 'COD')}>
            <option value="NET">Net terms (invoice)</option><option value="COD">Cash on delivery</option>
          </select>
        </label>
        <div className="total"><span>Total</span><strong>{usd(total)}</strong></div>
        {check && (
          <Notice kind={check.approved ? 'ok' : 'error'}>
            {check.approved ? 'Passes state compliance checks.' : <ul>{check.reasons.map((r, i) => <li key={i}>{r.message}</li>)}</ul>}
          </Notice>
        )}
        <Notice>{error}</Notice>
        {isRep && <button className="secondary" disabled={cart.length === 0} onClick={precheck}>Check compliance</button>}
        <button disabled={cart.length === 0 || busy} onClick={placeOrder}>{busy ? 'Placing…' : 'Place order'}</button>
        <p className="fineprint">Orders are checked against {account?.state ?? 'state'} rules and stock is reserved from in-state warehouses. You'll see the result in a few seconds.</p>
      </aside>
    </div>
  );
}
