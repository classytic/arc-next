'use client';

/**
 * Next.js App Router CLIENT fixture — hooks factory + presets + optimistic
 * actions, type-checked against the built dist via package self-reference.
 */

import { createCrudApi } from '@classytic/arc-next/api';
import { createCrudHooks } from '@classytic/arc-next/hooks';
import { withBulk } from '@classytic/arc-next/presets/bulk';
import type { Order } from './server.js';

const ordersApi = withBulk(createCrudApi<Order>('orders'));
const ordersHooks = createCrudHooks<Order>({
  api: ordersApi,
  entityKey: 'orders',
  singular: 'Order',
});

export function useOrdersView(): {
  count: number;
  add: () => Promise<Order>;
  pay: (id: string) => Promise<Order>;
} {
  const { items } = ordersHooks.useList();
  const { create, update } = ordersHooks.useActions();
  const { bulkCreate, isBulkCreating } = ordersHooks.useBulkActions();
  void bulkCreate;
  void isBulkCreating;

  return {
    count: items.length,
    add: () => create({ data: { total: 1, status: 'pending' } }),
    pay: (id: string) => update({ id, data: { status: 'paid' } }),
  };
}
