import { useState } from 'react';
import { api, isoDate, nextWeekday } from '../api';
import { Notice, useLoad } from '../components';
import type { Product, Supplier } from '../types';

interface Row { supplier_id: string; sku: string; state: string; cases: number; orders: number }
interface Feed { supplierId: string; rows: number; location: string }

export default function Depletions() {
  const [date, setDate] = useState(nextWeekday());
  const [rows, error] = useLoad(() => api<Row[]>(`/v1/depletions/summary?date=${date}`), [date], 10000);
  const [feeds, setFeeds] = useState<Feed[] | null>(null);
  const [catalog] = useLoad(() => api<Product[]>('/v1/products?state=FL'), []);
  const [suppliers] = useLoad(() => api<Supplier[]>('/v1/suppliers'), []);
  const productName = (sku: string) => catalog?.find((p) => p.sku === sku)?.name ?? sku;
  const supplierName = (id: string) => suppliers?.find((s) => s.id === id)?.name ?? id;
  const [message, setMessage] = useState('');

  const bySupplier = new Map<string, number>();
  rows?.forEach((r) => bySupplier.set(r.supplier_id, (bySupplier.get(r.supplier_id) ?? 0) + r.cases));

  return (
    <div>
      <h1>Depletion reports</h1>
      <p className="muted">Cases sold to retailers, by supplier, SKU and state, for the delivery date. Suppliers receive one file per day.</p>
      <div className="filters">
        <label className="inline">Delivery date<input type="date" value={date} onChange={(e) => { setDate(e.target.value); setFeeds(null); }} /></label>
        <button className="secondary" onClick={() => setDate(isoDate(new Date()))}>Today</button>
        <button disabled={!rows?.length} onClick={async () => {
          try { setFeeds((await api<{ feeds: Feed[] }>(`/v1/depletions/feeds?date=${date}`, { method: 'POST' })).feeds); setMessage(''); }
          catch (e) { setMessage((e as Error).message); }
        }}>Generate supplier files</button>
      </div>
      <Notice>{error || message}</Notice>
      {feeds && <Notice kind="ok">Wrote {feeds.length} file{feeds.length === 1 ? '' : 's'}: {feeds.map((f) => `${supplierName(f.supplierId)} (${f.rows} rows)`).join(', ')}</Notice>}
      {rows?.length === 0 && <p className="muted">No confirmed deliveries on this date.</p>}
      {rows && rows.length > 0 && (
        <>
          <div className="kpis">
            {[...bySupplier].map(([s, cases]) => <div className="kpi" key={s}><span>{supplierName(s)}</span><strong>{cases} cs</strong></div>)}
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Supplier</th><th>Product</th><th>State</th><th className="num">Cases</th><th className="num">Orders</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.supplier_id + r.sku + r.state}><td>{supplierName(r.supplier_id)}</td><td>{productName(r.sku)}</td><td>{r.state}</td>
                  <td className="num">{r.cases}</td><td className="num">{r.orders}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
