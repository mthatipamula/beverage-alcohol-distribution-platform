// Session handling and a small fetch wrapper. Locally the API takes X-API-Key; on AWS it takes a Cognito ID
// token, obtained here by calling Cognito's InitiateAuth directly (public app client, no secret).

export type Role = 'admin' | 'sales_rep' | 'retailer';

export interface AppConfig {
  authMode: 'api-key' | 'cognito';
  brandName: string;
  cognitoRegion?: string;
  cognitoClientId?: string;
}

export interface Session {
  name: string;
  roles: Role[];
  accountId?: string;
  apiKey?: string;
  idToken?: string;
  expiresAt?: number;
}

export const LOCAL_PERSONAS: { label: string; description: string; session: Session }[] = [
  {
    label: 'Retailer',
    description: 'Bayside Liquors, Florida: browse, order and track deliveries',
    session: { name: 'Bayside Liquors', roles: ['retailer'], accountId: 'ACC-FL-1001', apiKey: 'local-retailer-key' },
  },
  {
    label: 'Sales rep',
    description: 'Order on behalf of any account, apply discounts, pre-check compliance',
    session: { name: 'Sales rep', roles: ['sales_rep'], apiKey: 'local-rep-key' },
  },
  {
    label: 'Distributor operations',
    description: 'Inventory, supplier purchase orders, all orders and depletion reports',
    session: { name: 'Distributor operations', roles: ['admin'], apiKey: 'local-admin-key' },
  },
];

const KEY = 'bevdist.session';

export function loadSession(): Session | null {
  try {
    const s = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Session | null;
    if (s?.expiresAt && s.expiresAt < Date.now()) return null;
    return s;
  } catch {
    return null;
  }
}

export function saveSession(s: Session | null): void {
  try {
    if (s) sessionStorage.setItem(KEY, JSON.stringify(s));
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: session lasts for this page only */
  }
}

export const hasRole = (s: Session, ...roles: Role[]) => s.roles.some((r) => roles.includes(r));

export async function cognitoSignIn(config: AppConfig, email: string, password: string): Promise<Session> {
  const res = await fetch(`https://cognito-idp.${config.cognitoRegion}.amazonaws.com/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
    },
    body: JSON.stringify({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: config.cognitoClientId,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.message ?? 'Sign-in failed');
  const idToken: string | undefined = body.AuthenticationResult?.IdToken;
  if (!idToken) throw new Error('This account needs a password change; ask an administrator to reset it.');
  const claims = JSON.parse(atob(idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  return {
    name: claims.email ?? email,
    roles: ((claims['cognito:groups'] ?? []) as string[]).filter((g): g is Role => ['admin', 'sales_rep', 'retailer'].includes(g)),
    accountId: claims['custom:account_id'],
    idToken,
    expiresAt: claims.exp * 1000,
  };
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

let onUnauthorized: () => void = () => undefined;
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

export async function api<T = any>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> { // eslint-disable-line
  const s = loadSession();
  const headers: Record<string, string> = { ...init.headers };
  if (s?.apiKey) headers['X-API-Key'] = s.apiKey;
  if (s?.idToken) headers.Authorization = `Bearer ${s.idToken}`;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method: init.method ?? 'GET', headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
  const text = await res.text();
  const body = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (res.status === 401) onUnauthorized();
  if (!res.ok) {
    const detail = typeof body?.detail === 'string' ? body.detail : Array.isArray(body?.detail) ? body.detail.map((d: { msg: string }) => d.msg).join('; ') : res.statusText;
    throw new ApiError(res.status, body?.code ?? String(res.status), detail);
  }
  return body as T;
}

export const usd = (cents: number | null | undefined) =>
  cents == null ? '-' : (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export const shortDate = (iso: string | null | undefined) =>
  iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '-';

export const dateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '-';

/** YYYY-MM-DD of the next weekday after today (deliveries can't be same-day). */
export function nextWeekday(fromDays = 1): string {
  const d = new Date();
  d.setDate(d.getDate() + fromDays);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return isoDate(d);
}

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const newKey = () => crypto.randomUUID();
