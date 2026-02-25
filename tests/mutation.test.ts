import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureToast } from '../src/mutation.js';

// ============================================================================
// configureToast
// ============================================================================

describe('configureToast', () => {
  it('accepts custom toast handler', () => {
    const handler = {
      success: vi.fn(),
      error: vi.fn(),
    };
    // Should not throw
    expect(() => configureToast(handler)).not.toThrow();
  });
});

// Note: useMutationWithTransition, useMutationWithOptimistic, createOptimisticMutation
// are React hooks that require a QueryClientProvider context.
// They are tested via the hooks.test.tsx integration tests with renderHook.
