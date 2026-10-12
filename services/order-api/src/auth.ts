import type { FastifyReply, FastifyRequest } from 'fastify';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from './config.js';

export type Role = 'admin' | 'sales_rep' | 'retailer';

export interface Principal {
  subject: string;
  roles: Role[];
  /** Retail users may only order for, and see, their own account. */
  accountId?: string;
}

// Local API keys (AUTH_MODE=api-key). In AWS, users sign in with Cognito instead.
const API_KEYS: Record<string, Principal> = {
  'local-admin-key': { subject: 'local-admin', roles: ['admin'] },
  'local-rep-key': { subject: 'local-sales-rep', roles: ['sales_rep'] },
  'local-retailer-key': { subject: 'local-retailer', roles: ['retailer'], accountId: 'ACC-FL-1001' },
};

const jwks =
  config.auth.mode === 'jwt' && config.auth.cognitoIssuer
    ? createRemoteJWKSet(new URL(`${config.auth.cognitoIssuer}/.well-known/jwks.json`))
    : undefined;

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
  }
}

/**
 * Cognito ID tokens carry the user's groups (cognito:groups) and account (custom:account_id).
 * API Gateway already verifies the token; it is verified again here so the service never trusts
 * an unverified header if it is ever reached another way.
 */
async function fromJwt(token: string): Promise<Principal> {
  if (!jwks) throw new Error('JWT auth is not configured');
  const { payload } = await jwtVerify(token, jwks, {
    issuer: config.auth.cognitoIssuer,
    audience: config.auth.cognitoClientId,
  });
  const groups = (payload['cognito:groups'] as string[] | undefined) ?? [];
  const roles = groups.filter((g): g is Role => ['admin', 'sales_rep', 'retailer'].includes(g));
  return {
    subject: String(payload['email'] ?? payload.sub),
    roles,
    accountId: payload['custom:account_id'] as string | undefined,
  };
}

export async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    if (config.auth.mode === 'api-key') {
      const key = req.headers['x-api-key'];
      const principal = typeof key === 'string' ? API_KEYS[key] : undefined;
      if (!principal) return void reply.code(401).send(problem(401, 'UNAUTHENTICATED', 'Send a valid X-API-Key header'));
      req.principal = principal;
      return;
    }
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) {
      return void reply.code(401).send(problem(401, 'UNAUTHENTICATED', 'Send a Cognito ID token as a Bearer token'));
    }
    req.principal = await fromJwt(header.slice(7));
    if (req.principal.roles.length === 0) {
      return void reply.code(403).send(problem(403, 'NO_ROLE', 'User is not in the admin, sales_rep or retailer group'));
    }
  } catch {
    return void reply.code(401).send(problem(401, 'INVALID_TOKEN', 'Token is invalid or expired'));
  }
}

export const hasRole = (p: Principal, ...roles: Role[]) => p.roles.some((r) => roles.includes(r));

/** RFC 9457 problem details. */
export const problem = (status: number, code: string, detail: string) => ({
  type: 'about:blank',
  title: code.replace(/_/g, ' ').toLowerCase(),
  status,
  code,
  detail,
});
