'use client';

/**
 * Golden paths from skills/arc-next/SKILL.md (client halves), type-checked against the built dist.
 */

import { createCrudHooks } from '@classytic/arc-next/hooks';
import { withBulk } from '@classytic/arc-next/presets/bulk';
import { createCrudApi } from '@classytic/arc-next/api';
import { useQuietRouteAction, useResourceAction, useRouteAction, useRouteList, useRouteQuery } from '@classytic/arc-next/sdk/hooks';
import { initSDK } from '@classytic/arc-next/sdk/init';
import { publish, sweep } from './golden-server.js';

interface Product extends Record<string, unknown> {
  _id: string;
  name: string;
}

const api = withBulk(createCrudApi<Product>('products', { basePath: '/api' }));
export const hooks = createCrudHooks<Product>({ api, entityKey: 'products', singular: 'Product' });

export function boot(getToken: () => string | null) {
  initSDK({
    baseUrl: 'https://api.example.com',
    basePath: '/api',
    getToken,
    toast: { success: () => undefined, error: () => undefined },
    messages: (ctx) => ctx.fallback,
  });
}

export function useGoldenPaths(id: string) {
  const published = useResourceAction(hooks, publish);
  const swept = useRouteAction(hooks, api, sweep);
  const quiet = useQuietRouteAction(api, sweep);
  const summary = useRouteQuery(hooks, ['summary', id], async () => 1, { user: true, enabled: !!id });
  const list = useRouteList(hooks, { page: 1 }, async () => [] as string[], { user: true }, { enabled: true });
  return { published, swept, quiet, summary, list };
}
