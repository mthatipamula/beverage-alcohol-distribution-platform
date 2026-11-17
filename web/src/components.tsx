import { useEffect, useState, type ReactNode } from 'react';
import { STATUS_LABEL, type OrderStatus } from './types';

const STATUS_TONE: Record<OrderStatus, string> = {
  PENDING_COMPLIANCE: 'info', PENDING_INVENTORY: 'info', CONFIRMED: 'good', REJECTED: 'bad', BACKORDERED: 'warn',
};

export const StatusPill = ({ status }: { status: OrderStatus }) => (
  <span className={`pill ${STATUS_TONE[status]}`}>
    {(status === 'PENDING_COMPLIANCE' || status === 'PENDING_INVENTORY') && <span className="spinner" aria-hidden />}
    {STATUS_LABEL[status]}
  </span>
);

export const Tag = ({ children, tone = '' }: { children: ReactNode; tone?: string }) => <span className={`tag ${tone}`}>{children}</span>;

export function Notice({ kind = 'error', children }: { kind?: 'error' | 'ok' | 'info'; children: ReactNode }) {
  return children ? <div className={`notice ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div> : null;
}

/** Loads data with optional polling; returns [data, error, reload]. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[], pollMs = 0): [T | null, string, () => void] {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const run = () => load().then((d) => alive && (setData(d), setError('')), (e: Error) => alive && setError(e.message));
    run();
    const t = pollMs ? setInterval(run, pollMs) : undefined;
    return () => { alive = false; if (t) clearInterval(t); };
  }, [...deps, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  return [data, error, () => setTick((n) => n + 1)];
}

export const SUBCATEGORY_LABEL: Record<string, string> = { SCOTCH: 'Scotch whisky', VODKA: 'Vodka', WINE: 'Wine', BEER: 'Beer' };

export const LICENSE_LABEL: Record<string, string> = { BEER_ONLY: 'Beer only', BEER_WINE: 'Beer & wine', FULL_LIQUOR: 'Full liquor' };
export const SUBCATEGORY_ORDER = ['SCOTCH', 'VODKA', 'WINE', 'BEER'];
