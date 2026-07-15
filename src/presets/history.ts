import type { AnyBaseApi, DocOf, ScopedArgs } from '../api.js';

// ============================================================================
// Methods added by the history preset (arc 2.22 `history: true`)
// ============================================================================

/** One audit-trail entry — arc's `AuditEntry` wire shape for a single record. */
export interface HistoryEntry {
  id: string;
  resource: string;
  documentId: string;
  action: 'create' | 'update' | 'delete' | 'restore' | 'custom';
  userId?: string;
  organizationId?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  /** Field names that changed (updates). */
  changes?: string[];
  requestId?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

/** Wire shape of `GET /:resource/:id/history`. */
export interface HistoryPage {
  data: HistoryEntry[];
  limit: number;
  offset: number;
}

export interface HistoryMethods {
  /**
   * Per-record change timeline. Backend mounts `GET /:resource/:id/history`
   * when the resource declares `history: true` (arc 2.22) — audit-backed,
   * newest first, gated stricter than reads (update → get → auth).
   */
  history(args: ScopedArgs & { id: string; params?: { limit?: number; offset?: number } }): Promise<HistoryPage>;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Adds the per-record history method to a BaseApi.
 *
 * Mirrors arc's server-side `history: true` flag (2.22). Compose like every
 * other preset wrapper:
 *
 * @example
 * import { createCrudApi } from '@classytic/arc-next/api';
 * import { withHistory } from '@classytic/arc-next/presets/history';
 *
 * const orders = withHistory(createCrudApi<Order>('orders'));
 * const page = await orders.history({ id, params: { limit: 25 } });
 * // page.data[0] → { action: 'update', changes: ['status'], before, after, ... }
 */
export function withHistory<TApi extends AnyBaseApi>(api: TApi): TApi & HistoryMethods {
  type _TDoc = DocOf<TApi>; // preset carries no doc-typed payloads; timeline entries are envelope-typed
  const ext: HistoryMethods = {
    async history({ token = null, organizationId = null, id, params = {}, options = {} }) {
      if (!id) throw new Error('ID is required');
      return api.request<HistoryPage>('GET', `${api.baseUrl}/${id}/history`, {
        token,
        organizationId,
        params,
        options,
      });
    },
  };
  return Object.assign(api, ext) as TApi & HistoryMethods;
}
