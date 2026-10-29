/**
 * Golden paths from skills/arc-next/SKILL.md (server-safe halves), type-checked against the built
 * dist: portal bootstrap and SDK core. A host supplies every origin and name; the package imports
 * nothing from `next`.
 */

import { createAuthProxy } from '@classytic/arc-next/auth-proxy';
import { createRequestClient } from '@classytic/arc-next/server';
import { createCrudApi } from '@classytic/arc-next/api';
import { contentSecurityPolicy, createProxy, TRUSTED_TYPES_DEFAULT_POLICY } from '@classytic/arc-next/csp';
import { csv, definePublicEnv, trimSlash } from '@classytic/arc-next/runtime';
import { defineCommitAction, defineRouteAction, runRouteAction } from '@classytic/arc-next/sdk/actions';
import { createDownloader, streamDownload } from '@classytic/arc-next/sdk/download';
import { configureMessages, listMessageKeys } from '@classytic/arc-next/sdk/messages';
import { defineSdkResource, invalidateRoots } from '@classytic/arc-next/sdk/resource';
import { createIsolatedClient } from '@classytic/arc-next/sdk/transport';

export const { publicEnv, publicEnvScript } = definePublicEnv({
  globalName: '__APP_ENV__',
  read: (source) => ({
    apiUrl: trimSlash(source.API_URL ?? 'http://localhost:4000'),
    storageOrigin: trimSlash(source.STORAGE_ORIGIN ?? ''),
    embedHosts: csv(source.EMBED_HOSTS),
  }),
});

// proxy.ts: NextResponse is passed in, structurally typed.
const NextResponse = {
  next: (init: { request: { headers: Headers } }) => ({ headers: init.request.headers }),
};
export const proxy = createProxy({
  NextResponse,
  policy: ({ nonce, dev }) =>
    contentSecurityPolicy({
      nonce,
      dev,
      apiOrigin: publicEnv.apiUrl,
      ...(publicEnv.storageOrigin ? { storageOrigin: publicEnv.storageOrigin } : {}),
    }),
});
export const headScripts = [publicEnvScript(), TRUSTED_TYPES_DEFAULT_POLICY];

// app/api/auth/[...path]/route.ts
export const { DELETE, GET, PATCH, POST, PUT } = createAuthProxy({
  upstream: () => publicEnv.apiUrl,
  internalUpstream: () => undefined,
});

interface Item extends Record<string, unknown> {
  _id: string;
  name: string;
}

export const items = defineSdkResource<Item>({
  path: 'catalog/items',
  singular: 'Item',
  plural: 'Items',
  permission: 'items',
});

export const publish = defineCommitAction<{ expectedVersion: number }, Item>('publish', {
  key: 'catalog.item.publish',
  fallback: { success: 'Published' },
});

export const sweep = defineRouteAction<{ id: string }, { ok: boolean }>({
  key: 'stock.sweep',
  method: 'POST',
  path: ({ id }) => `/${id}/sweep`,
  fallback: { success: 'Swept' },
});

export async function serverGoldenPath(headers: Headers) {
  const client = createRequestClient({ baseUrl: publicEnv.apiUrl, headers });
  const page = await createCrudApi<Item>('orders', { client }).getAll();
  const isolated = createIsolatedClient({ baseUrl: publicEnv.apiUrl, getToken: () => null });
  await runRouteAction(items.bind(isolated.client, isolated.transport.basePath), sweep, { id: '1' });
  const file = await createDownloader(isolated.transport)({ path: 'reports/summary/export' });
  await streamDownload({ path: 'reports/summary/export', params: { format: 'csv' } });
  return { page, truncated: file.truncated };
}

configureMessages((ctx) => (ctx.kind === 'crud' ? undefined : ctx.fallback), { keyPrefix: 'app' });
export const catalogKeys = listMessageKeys();
export const invalidate = invalidateRoots;
