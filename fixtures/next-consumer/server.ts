/**
 * Next.js App Router SERVER fixture — type-checked against the built dist via
 * package self-reference. Proves the server story compiles with NO `next`
 * dependency: request-scoped client, server-safe cache helpers, and the
 * `next: { tags, revalidate }` fetch passthrough (plain typed options — the
 * SDK never imports next).
 */

import { createCrudApi } from '@classytic/arc-next/api';
import { createQueryKeys, prependToListCache } from '@classytic/arc-next/cache';
import { createServerClient } from '@classytic/arc-next/client';
import type { PaginatedResult } from '@classytic/repo-core/pagination';

export interface Order extends Record<string, unknown> {
  _id: string;
  total: number;
  status: 'pending' | 'paid';
}

export async function loadOrders(
  sessionToken: string | null,
  orgId: string | null,
): Promise<PaginatedResult<Order>> {
  // Request-scoped: credentials live in this instance only — no module
  // singletons, safe under concurrent server requests. The host reads
  // cookies()/headers() itself and passes plain values in.
  const client = createServerClient({
    baseUrl: 'https://api.example.com',
    token: sessionToken,
    organizationId: orgId,
  });
  const orders = createCrudApi<Order>('orders', { client });

  // Idiomatic Next fetch-cache passthrough — typed without importing next.
  return orders.getAll({
    options: { next: { revalidate: 60, tags: ['orders'] } },
  });
}

export function serverCacheHelpers(): unknown {
  const KEYS = createQueryKeys('orders');
  const seeded = prependToListCache(
    { data: [], total: 0 },
    { _id: '1', total: 5, status: 'pending' },
  );
  return { KEYS, seeded };
}
