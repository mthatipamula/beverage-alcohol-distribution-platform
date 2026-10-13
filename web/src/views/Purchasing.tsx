import { useEffect, useState } from 'react';
import { api, dateTime, newKey, nextWeekday, shortDate, usd } from '../api';
import { Notice, SUBCATEGORY_LABEL, Tag, useLoad } from '../components';
import type { PurchaseOrder, Supplier, Warehouse } from '../types';

export default function Purchasing({ prefill, onPrefillUsed }: {
  prefill: { sku: string; warehouseId: string; supplierId: string } | null; onPrefillUsed: () => void;
}) {
  const [suppliers] = useLoad(() => api<Supplier[]>('/v1/suppliers'), []);
  const [warehouses] = useLoad(() => api<Warehouse[]>('/v1/inventory/warehouses'), []);
  const [orders, ordersError, reload] = useLoad(() => api<PurchaseOrder[]>('/v1/purchase-orders'), [], 5000);

  const [supplierId, setSupplierId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [expectedDate, setExpectedDate] = useState(nextWeekday(3));
  const [qty, setQty] = useState<Record<string, number>>({});
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (prefill) {
      setSupplierId(prefill.supplierId); setWarehouseId(prefill.warehouseId); setQty({ [prefill.sku]: 50 }); onPrefillUsed();
    }
  }, [prefill, onPrefillUsed]);
  useEffect(() => { if (!supplierId && suppliers?.length) setSupplierId(suppliers[0].id); }, [suppliers, supplierId]);
  useEffect(() => { if (!warehouseId && warehouses?.length) setWarehouseId(warehouses[0].id); }, [warehouses, warehouseId]);

  const supplier = suppliers?.find((s) => s.id === supplierId);
  const lines = (supplier?.products ?? []).filter((p) => (qty[p.sku] ?? 0) > 0);
  const total = lines.reduce((t, p) => t + p.supplierCostCents * qty[p.sku], 0);

  async function submit() {
    setBusy(true); setMessage(null);
    try {
      const po = await api<PurchaseOrder>('/v1/purchase-orders', {
        method: 'POST', headers: { 'Idempotency-Key': newKey() },
        body: { supplierId, warehouseId, expectedDate, lines: lines.map((p) => ({ sku: p.sku, quantityCases: qty[p.sku] })) },
      });
      setQty({});
      setMessage({ kind: 'ok', text: `Purchase order ${po.id.slice(0, 8)} sent to ${supplier?.name} for ${usd(po.totalCostCents)}.` });
      reload();
    } catch (e) { setMessage({ kind: 'error', text: (e as Error).message }); }
    setBusy(false);
  }

  async function receive(po: PurchaseOrder) {
    try {
      await api(`/v1/purchase-orders/${po.id}/receive`, { method: 'POST' });
      setMessage({ kind: 'ok', text: `Received ${po.cases} cases into ${po.warehouseId}. Inventory updates in a moment.` });
      reload();
    } catch (e) { setMessage({ kind: 'error', text: (e as Error).message }); }
  }

  return (
    <div>
      <h1>Supplier purchasing</h1>
      <p className="muted">Buy stock from suppliers into a warehouse. When the delivery arrives, mark it received and the cases are added to that warehouse's inventory.</p>
      <div className="po-layout">
        <section className="card">
          <h2>New purchase order</h2>
          <div className="form-row">
            <label>Supplier
              <select value={supplierId} onChange={(e) => { setSupplierId(e.target.value); setQty({}); }}>
                {suppliers?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <label>Deliver to warehouse
              <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                {warehouses?.map((w) => <option key={w.id} value={w.id}>{w.name}, {w.state}</option>)}
              </select>
            </label>
            <label>Expected<input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} /></label>
          </div>
          <table className="compact">
            <thead><tr><th>Product</th><th>Type</th><th className="num">Case cost</th><th className="num">Cases</th><th className="num">Total</th></tr></thead>
            <tbody>
              {supplier?.products.map((p) => (
                <tr key={p.sku}>
                  <td>{p.name}</td>
                  <td className="muted">{SUBCATEGORY_LABEL[p.subcategory]}</td>
                  <td className="num">{usd(p.supplierCostCents)}</td>
                  <td className="num">
                    <input className="qty" inputMode="numeric" aria-label={`Cases of ${p.name}`} value={qty[p.sku] ?? ''}
                      onChange={(e) => setQty({ ...qty, [p.sku]: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
                  </td>
                  <td className="num">{qty[p.sku] ? usd(p.supplierCostCents * qty[p.sku]) : ''}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td colSpan={4}>Total cost</td><td className="num">{usd(total)}</td></tr></tfoot>
          </table>
          {message && <Notice kind={message.kind}>{message.text}</Notice>}
          <button disabled={lines.length === 0 || busy} onClick={submit}>{busy ? 'Sending…' : 'Send purchase order'}</button>
        </section>

        <section>
          <h2>Purchase orders</h2>
          <Notice>{ordersError}</Notice>
          {orders?.length === 0 && <p className="muted">None yet.</p>}
          <ul className="po-list">
            {orders?.map((po) => (
              <li key={po.id} className="card">
                <div className="row-between">
                  <strong>{po.supplierName}</strong>
                  <Tag tone={po.status === 'RECEIVED' ? 'good' : 'info'}>{po.status === 'RECEIVED' ? 'Received' : 'On order'}</Tag>
                </div>
                <div className="muted small">{po.cases} cases to {po.warehouseId} · {usd(po.totalCostCents)} · expected {shortDate(po.expectedDate)}</div>
                <div className="row-between small">
                  <span className="muted">{po.receivedAt ? `Received ${dateTime(po.receivedAt)}` : `Sent ${dateTime(po.createdAt)}`}</span>
                  {po.status === 'SUBMITTED' && <button className="small" onClick={() => receive(po)}>Mark received</button>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
