import { useEffect, useState } from 'react';
import { cognitoSignIn, hasRole, loadSession, LOCAL_PERSONAS, saveSession, setUnauthorizedHandler, type AppConfig, type Session } from './api';
import { Notice } from './components';
import Depletions from './views/Depletions';
import Inventory from './views/Inventory';
import Orders from './views/Orders';
import Purchasing from './views/Purchasing';
import Shop from './views/Shop';

type View = 'shop' | 'orders' | 'inventory' | 'purchasing' | 'depletions';

const NAV: { id: View; label: string; show: (s: Session) => boolean }[] = [
  { id: 'shop', label: 'Order', show: () => true },
  { id: 'orders', label: 'Orders', show: () => true },
  { id: 'inventory', label: 'Inventory', show: (s) => hasRole(s, 'admin') },
  { id: 'purchasing', label: 'Supplier purchasing', show: (s) => hasRole(s, 'admin') },
  { id: 'depletions', label: 'Depletion reports', show: (s) => hasRole(s, 'admin') },
];

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [session, setSession] = useState<Session | null>(loadSession());
  const [view, setView] = useState<View>(() => (loadSession() && hasRole(loadSession()!, 'admin') ? 'inventory' : 'shop'));
  const [openOrder, setOpenOrder] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<{ sku: string; warehouseId: string; supplierId: string } | null>(null);

  useEffect(() => {
    fetch('/config.json').then((r) => r.json()).then((c: AppConfig) => { setConfig(c); document.title = c.brandName; });
  }, []);
  useEffect(() => setUnauthorizedHandler(() => { saveSession(null); setSession(null); }), []);

  if (!config) return <div className="loading">Loading…</div>;
  if (!session) {
    return <SignIn config={config} onSignIn={(s) => {
      saveSession(s); setSession(s); setView(hasRole(s, 'admin') ? 'inventory' : 'shop');
    }} />;
  }

  const showOrder = (id: string) => { setOpenOrder(id); setView('orders'); };
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><img src="/favicon.svg" alt="" /> {config.brandName}</div>
        <nav aria-label="Main">
          {NAV.filter((n) => n.show(session)).map((n) => (
            <button key={n.id} className={view === n.id ? 'active' : ''} onClick={() => { setView(n.id); setOpenOrder(null); }}>{n.label}</button>
          ))}
        </nav>
        <div className="who">
          <span>{session.name}</span>
          <button className="link" onClick={() => { saveSession(null); setSession(null); }}>Sign out</button>
        </div>
      </header>
      <main>
        {view === 'shop' && <Shop session={session} onOrderPlaced={showOrder} />}
        {view === 'orders' && <Orders session={session} openId={openOrder} onOpen={setOpenOrder} />}
        {view === 'inventory' && <Inventory onReorder={(p) => { setPrefill(p); setView('purchasing'); }} />}
        {view === 'purchasing' && <Purchasing prefill={prefill} onPrefillUsed={() => setPrefill(null)} />}
        {view === 'depletions' && <Depletions />}
      </main>
    </div>
  );
}

function SignIn({ config, onSignIn }: { config: AppConfig; onSignIn: (s: Session) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <div className="signin">
      <div className="signin-card">
        <div className="brand big"><img src="/favicon.svg" alt="" /> {config.brandName}</div>
        <p className="muted">Wholesale ordering for licensed retailers, and operations for the distributor.</p>
        {config.authMode === 'api-key' ? (
          <>
            <h2>Choose who you are (local demo)</h2>
            <div className="personas">
              {LOCAL_PERSONAS.map((p) => (
                <button key={p.label} className="persona" onClick={() => onSignIn(p.session)}>
                  <strong>{p.label}</strong><span>{p.description}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <form onSubmit={async (e) => {
            e.preventDefault(); setBusy(true); setError('');
            try { onSignIn(await cognitoSignIn(config, email, password)); } catch (err) { setError((err as Error).message); }
            setBusy(false);
          }}>
            <label>Email<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
            <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
            <Notice>{error}</Notice>
            <button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          </form>
        )}
        <p className="fineprint">Alcohol sales to licensed businesses only. Brand names are shown for illustration.</p>
      </div>
    </div>
  );
}
