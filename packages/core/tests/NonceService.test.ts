/**
 * @fileoverview Unit tests for NonceService.
 *
 * Tests cover:
 * - Nonce checking and storage
 * - Idempotency behavior (duplicate detection)
 * - TTL expiration handling
 * - Pending/completed/failed status transitions
 * - Critical payload detection
 * - Cleanup and memory management
 *
 * @module packages/core/tests/NonceService.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  NonceService,
  type CriticalPayload,
  type NonceCheckResult,
} from '../src/services/NonceService';

// ─────────────────────────────────────────────────────────────────────────────
// Test Setup
// ─────────────────────────────────────────────────────────────────────────────

// Mock chrome.storage.local for persistence tests
const mockStorage: Record<string, unknown> = {};
const mockChromeStorage = {
  local: {
    get: vi.fn((key: string) => Promise.resolve({ [key]: mockStorage[key] })),
    set: vi.fn((data: Record<string, unknown>) => {
      Object.assign(mockStorage, data);
      return Promise.resolve();
    }),
  },
};

// Store original chrome object
const originalChrome = globalThis.chrome;

describe('NonceService', () => {
  let nonceService: NonceService;

  beforeEach(() => {
    // Setup chrome mock
    (globalThis as any).chrome = mockChromeStorage;

    // Clear mock storage
    Object.keys(mockStorage).forEach((key) => delete mockStorage[key]);

    // Create fresh instance for each test
    nonceService = new NonceService();
  });

  afterEach(() => {
    // Cleanup
    nonceService.destroy();
    globalThis.chrome = originalChrome;
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Nonce Checking Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe('checkNonce', () => {
    it('returns exists: false for unknown nonce', async () => {
      const result = await nonceService.checkNonce('unknown-nonce');

      expect(result.exists).toBe(false);
      expect(result.status).toBeUndefined();
      expect(result.result).toBeUndefined();
    });

    it('returns cached result for completed nonce', async () => {
      const nonce = 'completed-nonce';
      const storedResult = { txHash: '0x123', success: true };

      await nonceService.storeResult(nonce, storedResult);
      const result = await nonceService.checkNonce(nonce);

      expect(result.exists).toBe(true);
      expect(result.status).toBe('completed');
      expect(result.result).toEqual(storedResult);
    });

    it('returns pending status for in-progress nonce', async () => {
      const nonce = 'pending-nonce';

      await nonceService.markPending(nonce, Date.now());
      const result = await nonceService.checkNonce(nonce);

      expect(result.exists).toBe(true);
      expect(result.status).toBe('pending');
      expect(result.result).toBeUndefined();
    });

    it('returns error for failed nonce', async () => {
      const nonce = 'failed-nonce';
      const errorMessage = 'Transaction failed';

      await nonceService.storeError(nonce, errorMessage);
      const result = await nonceService.checkNonce(nonce);

      expect(result.exists).toBe(true);
      expect(result.status).toBe('failed');
      expect(result.error).toBe(errorMessage);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Idempotency Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe('idempotency behavior', () => {
    it('returns same result for duplicate requests', async () => {
      const nonce = 'idempotent-nonce';
      const result = { txHash: '0xabc', amount: '1000' };

      // First request completes
      await nonceService.storeResult(nonce, result);

      // Duplicate request should get cached result
      const check = await nonceService.checkNonce(nonce);

      expect(check.exists).toBe(true);
      expect(check.result).toEqual(result);
    });

    it('prevents duplicate processing for pending operations', async () => {
      const nonce = 'pending-op';

      // Mark as pending (first request started)
      await nonceService.markPending(nonce, Date.now());

      // Duplicate request should see pending status
      const check = await nonceService.checkNonce(nonce);

      expect(check.exists).toBe(true);
      expect(check.status).toBe('pending');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // TTL Expiration Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe('TTL expiration', () => {
    it('removes expired nonces on check', async () => {
      const nonce = 'expired-nonce';

      // Store with very short TTL
      await nonceService.storeResult(nonce, { data: 'test' }, 1); // 1ms TTL

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should not find expired nonce
      const result = await nonceService.checkNonce(nonce);

      expect(result.exists).toBe(false);
    });

    it('keeps non-expired nonces', async () => {
      const nonce = 'valid-nonce';

      // Store with long TTL
      await nonceService.storeResult(nonce, { data: 'test' }, 60000); // 60s TTL

      const result = await nonceService.checkNonce(nonce);

      expect(result.exists).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Status Transition Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe('status transitions', () => {
    it('transitions from pending to completed', async () => {
      const nonce = 'transition-nonce';
      const timestamp = Date.now();

      // Start operation
      await nonceService.markPending(nonce, timestamp);
      let result = await nonceService.checkNonce(nonce);
      expect(result.status).toBe('pending');

      // Complete operation
      await nonceService.storeResult(nonce, { success: true });
      result = await nonceService.checkNonce(nonce);
      expect(result.status).toBe('completed');
    });

    it('transitions from pending to failed', async () => {
      const nonce = 'fail-transition-nonce';
      const timestamp = Date.now();

      // Start operation
      await nonceService.markPending(nonce, timestamp);

      // Fail operation
      await nonceService.storeError(nonce, 'Network error');
      const result = await nonceService.checkNonce(nonce);

      expect(result.status).toBe('failed');
      expect(result.error).toBe('Network error');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Critical Payload Detection Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe('isCriticalPayload', () => {
    it('returns true for valid critical payload', () => {
      const payload: CriticalPayload = {
        __critical__: true,
        __nonce__: 'test-nonce',
        __timestamp__: Date.now(),
        data: { amount: '1000' },
      };

      expect(nonceService.isCriticalPayload(payload)).toBe(true);
    });

    it('returns false for regular payload', () => {
      const payload = { amount: '1000', to: '0x123' };

      expect(nonceService.isCriticalPayload(payload)).toBe(false);
    });

    it('returns false for null/undefined', () => {
      expect(nonceService.isCriticalPayload(null)).toBe(false);
      expect(nonceService.isCriticalPayload(undefined)).toBe(false);
    });

    it('returns false for payload missing __nonce__', () => {
      const payload = { __critical__: true, __timestamp__: Date.now() };

      expect(nonceService.isCriticalPayload(payload)).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Nonce Removal Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe('removeNonce', () => {
    it('removes existing nonce', async () => {
      const nonce = 'removable-nonce';

      await nonceService.storeResult(nonce, { data: 'test' });
      let result = await nonceService.checkNonce(nonce);
      expect(result.exists).toBe(true);

      await nonceService.removeNonce(nonce);
      result = await nonceService.checkNonce(nonce);
      expect(result.exists).toBe(false);
    });

    it('handles removal of non-existent nonce gracefully', async () => {
      // Should not throw
      await expect(nonceService.removeNonce('non-existent')).resolves.not.toThrow();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Statistics Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe('getStats', () => {
    it('returns correct statistics', async () => {
      // Add various nonces
      await nonceService.markPending('pending-1', Date.now());
      await nonceService.markPending('pending-2', Date.now());
      await nonceService.storeResult('completed-1', { data: 'test' });
      await nonceService.storeError('failed-1', 'error');

      const stats = nonceService.getStats();

      expect(stats.total).toBe(4);
      expect(stats.pending).toBe(2);
      expect(stats.completed).toBe(1);
      expect(stats.failed).toBe(1);
    });

    it('returns zeros for empty store', () => {
      const stats = nonceService.getStats();

      expect(stats.total).toBe(0);
      expect(stats.pending).toBe(0);
      expect(stats.completed).toBe(0);
      expect(stats.failed).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Memory Management Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe('memory management', () => {
    it('enforces max entries limit', async () => {
      // Add more than MAX_ENTRIES (500)
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 510; i++) {
        promises.push(nonceService.storeResult(`nonce-${i}`, { index: i }));
      }
      await Promise.all(promises);

      const stats = nonceService.getStats();

      // Should be capped at MAX_ENTRIES (500)
      expect(stats.total).toBeLessThanOrEqual(500);
    });

    it('cleans up on destroy', async () => {
      await nonceService.storeResult('test-nonce', { data: 'test' });

      nonceService.destroy();

      // Create new instance to verify cleanup
      const newService = new NonceService();
      const stats = newService.getStats();

      // In-memory store should be empty after destroy
      // Note: Persisted storage may still have data
      expect(stats.total).toBe(0);

      newService.destroy();
    });
  });
});
