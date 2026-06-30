/**
 * Preset COMPOSITION — the regression guard for the generic-preserving fix.
 *
 * Before the fix each `withX(api)` returned `BaseApi<TDoc> & XMethods`, which
 * widened away the input type — so chaining presets (or composing over a
 * subclass with custom methods) silently dropped every other method at the
 * TYPE level. This file proves both the runtime augmentation AND the type
 * preservation. The type-level assertions below fail to COMPILE if the bug
 * regresses (run via `npm run typecheck:tests`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseApi, createCrudApi } from '../../src/api.js';
import { configureClient } from '../../src/client.js';
import { withBulk } from '../../src/presets/bulk.js';
import { withSearchPreset } from '../../src/presets/search.js';
import { withSlugLookup } from '../../src/presets/slug.js';
import { withSoftDelete } from '../../src/presets/soft-delete.js';
import { withTree } from '../../src/presets/tree.js';

interface Doc {
  _id: string;
  name: string;
  slug: string;
}
interface CreateDoc {
  name: string;
}
interface UpdateDoc {
  name?: string;
}

/** A resource with a genuinely-custom (non-preset) endpoint — the `product` shape. */
class ThingApi extends BaseApi<Doc, CreateDoc, UpdateDoc> {
  constructor() {
    super('things', { basePath: '/api' });
  }
  reindex(args: { id: string }): Promise<Doc> {
    return this.request<Doc>('POST', `${this.baseUrl}/${args.id}/reindex`);
  }
}

let fetchMock: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  configureClient({ baseUrl: 'http://api.test' });
  fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ _id: '1', name: 'x', slug: 'x' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
});
afterEach(() => fetchMock.mockRestore());

describe('preset composition (generic-preserving)', () => {
  it('chained presets keep every preset method AND the resource custom method', () => {
    const api = withSearchPreset(
      withBulk(withTree(withSlugLookup(withSoftDelete(new ThingApi())))),
    );

    // Runtime: every layer's methods are actually present on the object.
    expect(typeof api.getAll).toBe('function'); // CRUD (base)
    expect(typeof api.getById).toBe('function');
    expect(typeof api.getDeleted).toBe('function'); // soft-delete
    expect(typeof api.restore).toBe('function');
    expect(typeof api.getBySlug).toBe('function'); // slug
    expect(typeof api.getTree).toBe('function'); // tree
    expect(typeof api.getChildren).toBe('function');
    expect(typeof api.bulkCreate).toBe('function'); // bulk
    expect(typeof api.bulkUpdate).toBe('function');
    expect(typeof api.searchEngine).toBe('function'); // search
    expect(typeof api.reindex).toBe('function'); // custom (survived composition)

    // Compile-time: this closure is type-checked but NEVER invoked (no real
    // requests fire). It fails to COMPILE if composition widened the type and
    // dropped a method or its return type — the regression we fixed.
    const _typeProof = async (): Promise<void> => {
      const _bySlug: Doc = await api.getBySlug({ slug: 'x' });
      const _custom: Doc = await api.reindex({ id: '1' });
      const _tree: Doc[] = await api.getTree();
      void _bySlug;
      void _custom;
      void _tree;
    };
    void _typeProof;
  });

  it('a single preset is unchanged (back-compat with the pre-fix return shape)', () => {
    const api = withSlugLookup(createCrudApi<Doc>('things', { basePath: '/api' }));
    expect(typeof api.getBySlug).toBe('function');
    expect(typeof api.getAll).toBe('function');
    const _doc: Promise<Doc> = api.getBySlug({ slug: 'x' });
    void _doc;
  });
});
