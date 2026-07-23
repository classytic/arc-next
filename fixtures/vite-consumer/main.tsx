/**
 * Vite / plain-browser consumer fixture — the SPA story, type-checked
 * against the built dist via package self-reference. Proves the browser
 * entry points compile with zero Next-specific requirements: global
 * configure* singletons, bearer auth, hooks, SSE/WS helpers.
 */

import { createCrudApi } from '@classytic/arc-next/api';
import {
  configureAuth,
  configureClient,
  createAuthAwareClient,
  isArcApiError,
} from '@classytic/arc-next/client';
import { createCrudHooks } from '@classytic/arc-next/hooks';
import { buildSseUrl } from '@classytic/arc-next/sse';
import { buildWsUrl } from '@classytic/arc-next/ws';

interface Todo extends Record<string, unknown> {
  _id: string;
  title: string;
  done: boolean;
}

export function initApp(): void {
  configureClient({
    baseUrl: 'https://api.example.com',
    retry: { attempts: 3, backoff: 'exponential' },
    autoIdempotency: true,
  });
  configureAuth({
    getToken: () => localStorage.getItem('token'),
    getOrgId: () => localStorage.getItem('org'),
  });
}

const todosApi = createCrudApi<Todo>('todos', { client: createAuthAwareClient() });
const todosHooks = createCrudHooks<Todo>({ api: todosApi, entityKey: 'todos', singular: 'Todo' });

export function useTodosScreen(): { total: number; toggle: (t: Todo) => Promise<Todo> } {
  const { items } = todosHooks.useList();
  const { update } = todosHooks.useActions();
  return {
    total: items.length,
    toggle: (t) =>
      update({ id: t._id, data: { done: !t.done } }).catch((err: unknown) => {
        if (isArcApiError(err) && err.code === 'arc.not_found') {
          throw new Error('gone');
        }
        throw err;
      }),
  };
}

export const streamUrls = {
  sse: (): string => buildSseUrl('/api/v1/events/stream'),
  ws: (): string => buildWsUrl('/ws'),
};
