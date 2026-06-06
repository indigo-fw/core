/**
 * MCP request authentication.
 *
 * Resolves an `Authorization: Bearer <key>` header to an `McpInvocationContext`
 * by:
 *
 *   1. Validating the key via `verifyApiKey` from `@/core-api` (shared with
 *      the v2 REST API — same `saas_api_keys` table, same admin UI).
 *   2. Checking that the key carries the `mcp:invoke` scope (or is a superkey
 *      with `scopes === null`).
 *   3. Loading the user record for the key's `createdBy` — the agent acts as
 *      that user inside the organization the key is bound to.
 */

import { eq } from 'drizzle-orm';
import { db } from '@/server/db';
import { user as userTable } from '@/server/db/schema/auth';
import { saasApiKeys } from '@/core-api/schema/api-keys';
import { verifyApiKey, touchKeyLastUsed } from '@/core-api/lib/api-key-service';
import { hasScope, registerApiScopes } from '@/core-api/lib/api-scopes';
import { createLogger } from '@/core/lib/infra/logger';
import type { McpInvocationContext } from './types';

const logger = createLogger('mcp:auth');

/** The single MCP-level scope. Per-tool authorisation runs through tRPC middleware. */
export const MCP_SCOPE = 'mcp:invoke';

registerApiScopes([
  {
    id: MCP_SCOPE,
    label: 'Invoke MCP tools (agent access)',
    module: 'core',
  },
]);

export type McpAuthError = 'missing-bearer' | 'invalid-key' | 'missing-scope' | 'user-missing' | 'user-banned';

export interface McpAuthSuccess {
  ok: true;
  context: McpInvocationContext;
  /** Underlying API key id, useful for audit logging. */
  apiKeyId: string;
}

export interface McpAuthFailure {
  ok: false;
  error: McpAuthError;
  status: 401 | 403;
  message: string;
}

export type McpAuthResult = McpAuthSuccess | McpAuthFailure;

/**
 * Resolve an MCP request's Authorization header to an invocation context.
 * Side effect: bumps the key's `lastUsedAt` on success (fire-and-forget).
 */
export async function authenticateMcpRequest(request: Request): Promise<McpAuthResult> {
  const header = request.headers.get('authorization');
  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    return { ok: false, error: 'missing-bearer', status: 401, message: 'Missing Authorization: Bearer <key>' };
  }
  const token = header.slice(7).trim();
  if (!token) {
    return { ok: false, error: 'missing-bearer', status: 401, message: 'Empty bearer token' };
  }

  const verified = await verifyApiKey(token);
  if (!verified) {
    return { ok: false, error: 'invalid-key', status: 401, message: 'Invalid or expired API key' };
  }

  if (!hasScope(verified.scopes, MCP_SCOPE)) {
    return {
      ok: false,
      error: 'missing-scope',
      status: 403,
      message: `API key lacks required scope '${MCP_SCOPE}'`,
    };
  }

  // Resolve the user identity from the key's `createdBy`. We hit `saasApiKeys`
  // again because `verifyApiKey` doesn't return createdBy.
  const [keyRow] = await db
    .select({ createdBy: saasApiKeys.createdBy })
    .from(saasApiKeys)
    .where(eq(saasApiKeys.id, verified.id))
    .limit(1);

  if (!keyRow) {
    // Race: key deleted between verify and read. Treat as invalid.
    return { ok: false, error: 'invalid-key', status: 401, message: 'API key not found' };
  }

  const [u] = await db
    .select({
      id: userTable.id,
      email: userTable.email,
      role: userTable.role,
      banned: userTable.banned,
      emailVerified: userTable.emailVerified,
      createdAt: userTable.createdAt,
    })
    .from(userTable)
    .where(eq(userTable.id, keyRow.createdBy))
    .limit(1);

  if (!u) {
    logger.warn('MCP key references missing user', { apiKeyId: verified.id, userId: keyRow.createdBy });
    return { ok: false, error: 'user-missing', status: 401, message: 'API key owner not found' };
  }

  if (u.banned) {
    return { ok: false, error: 'user-banned', status: 403, message: 'API key owner is banned' };
  }

  touchKeyLastUsed(verified.id);

  const context: McpInvocationContext = {
    user: {
      id: u.id,
      email: u.email,
      role: u.role,
      banned: u.banned,
      emailVerified: u.emailVerified,
      createdAt: (u.createdAt instanceof Date ? u.createdAt : new Date(u.createdAt)).toISOString(),
    },
    organizationId: verified.organizationId,
    headers: request.headers,
  };

  return { ok: true, context, apiKeyId: verified.id };
}
