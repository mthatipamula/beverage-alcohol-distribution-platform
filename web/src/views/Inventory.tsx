import { useMemo, useState } from 'react';
import { api } from '../api';
import { Notice, SUBCATEGORY_LABEL, useLoad } from '../components';
import type { Product, StockRow } from '../types';

const LOW = 25;
const STATES = ['ALL', 'FL', 'TX', 'NY', 'CA', 'GA'];

export default function Inventory({ onReorder }: { onReorder: (p: { sku: string; warehouseId: string; supplierId: string }) => void }) {
  const [state, setState] = useState('ALL');
  const [onlyLow, setOnlyLow] = useState(false);
  const [stock, error] = useLoad(() => api<StockRow[]>(`/v1/inventory${state === 'ALL' ? '' : `?state=${state}`}`), [state], 5000);
  const [catalog] = useLoad(() => api<Product[]>('/v1/products?state=FL'), []);
  const product = useMemo(() => new Map((catalog ?? []).map((p) => [p.sku, p])), [catalog]);

  const rows = (stock ?? []).filter((r) => !onlyLow || r.availableCases < LOW);
  const lowCount = (stock ?? []).filter((r) => r.availableCases < LOW).length;
  const totals = (stock ?? []).reduce((t, r) => ({ onHand: t.onHand + r.onHandCases, reserved: t.reserved + r.reservedCases }), { onHand: 0, reserved: 0 });

  return (
    <div>
      <h1>Inventory</h1>
      <div className="kpis">
        <div className="kpi"><span>On hand</span><strong>{totals.onHand.toLocaleString()} cs</strong></div>
        <div className="kpi"><span>Reserved for orders</span><strong>{totals.reserved.toLocaleString()} cs</strong></div>
        <div className={`kpi ${lowCount ? 'warn' : ''}`}><span>Low or out of stock</span><strong>{lowCount} item{lowCount === 1 ? '' : 's'}</strong></div>
      </div>
      <div className="filters">
        <div className="segmented">
          {STATES.map((s) => <button key={s} className={state === s ? 'active' : ''} onClick={() => setState(s)}>{s === 'ALL' ? 'All states' : s}</button>)}
        </div>
        <label className="inline"><input type="checkbox" checked={onlyLow} onChange={(e) => setOnlyLow(e.target.checked)} /> Only low stock (under {LOW} cases)</label>
      </div>
      <Notice>{error}</Notice>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Warehouse</th><th>Product</th><th>Type</th><th className="num">On hand</th><th className="num">Reserved</th><th className="num">Available</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => {
              const p = product.get(r.sku);
              const low = r.availableCases < LOW;
              return (
                <tr key={r.warehouseId + r.sku}>
                  <td>{r.warehouse} <span className="muted">({r.state})</span></td>
                  <td>{p?.name ?? r.sku}</td>
                  <td className="muted">{p ? SUBCATEGORY_LABEL[p.subcategory] : ''}</td>
                  <td className="num">{r.onHandCases}</td>
                  <td className="num">{r.reservedCases}</td>
                  <td className="num"><span className={low ? 'low-stock' : ''}>{r.availableCases}</span></td>
                  <td>{low && p && <button className="small secondary" onClick={() => onReorder({ sku: r.sku, warehouseId: r.warehouseId, supplierId: p.supplierId })}>Reorder</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
