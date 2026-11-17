import { api, dateTime, hasRole, shortDate, usd, type Session } from '../api';
import { Notice, StatusPill, useLoad } from '../components';
import type { Order, OrderSummary } from '../types';

const PENDING = new Set(['PENDING_COMPLIANCE', 'PENDING_INVENTORY']);

export default function Orders({ session, openId, onOpen }: { session: Session; openId: string | null; onOpen: (id: string | null) => void }) {
  const [orders, error] = useLoad(() => api<OrderSummary[]>('/v1/orders?limit=100'), [], 2000);
  const staff = hasRole(session, 'admin', 'sales_rep');
  return (
    <div className="orders-layout">
      <section>
        <h1>{staff ? 'Orders' : 'My orders'}</h1>
        <Notice>{error}</Notice>
        {orders?.length === 0 && <p className="muted">No orders yet.</p>}
        {orders && orders.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Placed</th>{staff && <th>Account</th>}<th>Delivery</th><th className="num">Total</th><th>Status</th></tr></thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} className={`clickable ${o.id === openId ? 'selected' : ''}`} onClick={() => onOpen(o.id)}>
                    <td>{dateTime(o.createdAt)}</td>
                    {staff && <td>{o.accountName} <span className="muted">({o.state})</span></td>}
                    <td>{shortDate(o.deliveryDate)}</td>
                    <td className="num">{usd(o.totalCents)}</td>
                    <td><StatusPill status={o.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {openId && <OrderDetail id={openId} onClose={() => onOpen(null)} />}
    </div>
  );
}

function OrderDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [order, error] = useLoad(() => api<Order>(`/v1/orders/${id}`), [id], 1500);
  if (error) return <aside className="detail"><Notice>{error}</Notice></aside>;
  if (!order) return <aside className="detail"><p className="muted">Loading…</p></aside>;
  const pending = PENDING.has(order.status);
  return (
    <aside className="detail" aria-label="Order detail">
      <div className="row-between">
        <h2>{order.accountName}</h2>
        <button className="link" onClick={onClose}>Close</button>
      </div>
      <p className="muted small">Order {order.id.slice(0, 8)} · placed by {order.createdBy} · {order.paymentTerms === 'COD' ? 'cash on delivery' : 'net terms'}</p>
      <div className="status-row"><StatusPill status={order.status} /><span>Delivery {shortDate(order.deliveryDate)}</span></div>
      {pending && <p className="muted small">Checking {order.state} rules and reserving stock. This updates automatically.</p>}
      {order.statusReasons.length > 0 && (
        <Notice kind={order.status === 'BACKORDERED' ? 'info' : 'error'}>
          <ul>{order.statusReasons.map((r, i) => <li key={i}>{r.lineNo ? `Line ${r.lineNo}: ` : ''}{r.message}</li>)}</ul>
        </Notice>
      )}
      <table className="compact">
        <thead><tr><th>Product</th><th className="num">Cases</th><th className="num">Price</th><th className="num">Total</th></tr></thead>
        <tbody>
          {order.lines.map((l) => (
            <tr key={l.lineNo}>
              <td>{l.name}{l.discountPct > 0 && <span className="muted small"> ({l.discountPct}% off)</span>}</td>
              <td className="num">{l.quantityCases}</td>
              <td className="num">{usd(l.unitPriceCents)}</td>
              <td className="num">{usd(l.lineTotalCents)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr><td colSpan={3}>Total</td><td className="num">{usd(order.totalCents)}</td></tr></tfoot>
      </table>
      {order.allocations && order.allocations.length > 0 && (
        <>
          <h3>Ships from</h3>
          <ul className="plain">
            {order.allocations.map((a, i) => (
              <li key={i}>{order.lines.find((l) => l.lineNo === a.lineNo)?.name}: {a.quantityCases} cs from {a.warehouseId}</li>
            ))}
          </ul>
        </>
      )}
      <h3>History</h3>
      <ol className="timeline">
        {order.history.map((h, i) => (
          <li key={i}><span className="muted small">{dateTime(h.at)} · {h.actor}</span><div>{h.detail}</div></li>
        ))}
      </ol>
    </aside>
  );
}
