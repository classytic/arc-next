/**
 * One leader per browser, so one connection per browser.
 *
 * Mirrors Odoo's `multi_tab_fallback_service`: heartbeat in localStorage, claim
 * when stale, release on `pagehide`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTabLeader } from '../src/tab-leader.js';

const KEY = 'arc-next.leader.stream';

describe('useTabLeader', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('the first tab becomes leader', () => {
    const { result } = renderHook(() => useTabLeader({ key: 'stream' }));
    expect(result.current).toBe(true);
    expect(localStorage.getItem(KEY)).toBeTruthy();
  });

  it('a second tab does NOT lead while the first is alive', () => {
    const first = renderHook(() => useTabLeader({ key: 'stream' }));
    expect(first.result.current).toBe(true);

    const second = renderHook(() => useTabLeader({ key: 'stream' }));
    expect(second.result.current).toBe(false);
  });

  it('a survivor claims leadership once the heartbeat goes stale', () => {
    // A crashed tab leaves its record behind — nothing releases it.
    localStorage.setItem(KEY, JSON.stringify({ id: 'dead-tab', ts: Date.now() - 60_000 }));

    const { result } = renderHook(() => useTabLeader({ key: 'stream' }));
    expect(result.current).toBe(true);
  });

  it('releases on unmount so a sibling promotes immediately', () => {
    const { result, unmount } = renderHook(() => useTabLeader({ key: 'stream' }));
    expect(result.current).toBe(true);

    act(() => unmount());
    expect(localStorage.getItem(KEY)).toBeNull();

    const next = renderHook(() => useTabLeader({ key: 'stream' }));
    expect(next.result.current).toBe(true);
  });

  it('does not lead when disabled', () => {
    const { result } = renderHook(() => useTabLeader({ key: 'stream', enabled: false }));
    expect(result.current).toBe(false);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('keys are independent — different streams elect separately', () => {
    const a = renderHook(() => useTabLeader({ key: 'stream-a' }));
    const b = renderHook(() => useTabLeader({ key: 'stream-b' }));
    expect(a.result.current).toBe(true);
    expect(b.result.current).toBe(true);
  });
});
