/**
 * @fileoverview NonceService - Idempotency service for critical operations.
 *
 * Ensures that critical operations (transfers, signing, staking, etc.) are not
 * executed multiple times if the same request is retried. Uses nonces to track
 * operation state and caches results for duplicate detection.
 *
 * Key features:
 * - Nonce-based idempotency for critical operations
 * - Automatic TTL expiration for nonce entries
 * - Persistence to chrome.storage.local for SW restart recovery
 * - Memory limits to prevent unbounded growth
 * - Status tracking: pending → completed/failed
 *
 * @module @chromahq/core/services/NonceService
 *
 * @example
 * ```typescript
 * // In a message handler
 * @Message('transfer')
 * class TransferHandler {
 *   constructor(@Use(NonceService) private nonceService: NonceService) {}
 *
 *   async handle(payload: CriticalPayload) {
 *     // Check for duplicate (returns cached result if exists)
 *     const cached = await this.nonceService.checkNonce(payload.__nonce__);
 *     if (cached.exists) return cached.result;
 *
 *     // Mark as pending to prevent duplicate processing
 *     await this.nonceService.markPending(payload.__nonce__, payload.__timestamp__);
 *
 *     try {
 *       const result = await this.doTransfer(payload.data);
 *       await this.nonceService.storeResult(payload.__nonce__, result);
 *       return result;
 *     } catch (error) {
 *       await this.nonceService.storeError(payload.__nonce__, error.message);
 *       throw error;
 *     }
 *   }
 * }
 * ```
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const NONCE_STORE_STORAGE_KEY = '__CHROMA_NONCE_STORE__' as const;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Payload wrapper for critical operations.
 * Sent by BridgeProvider.sendCritical/sendWithNonce methods.
 *
 * @template T - The type of the wrapped data payload
 */
export interface CriticalPayload<T = unknown> {
  /** Marker indicating this is a critical operation */
  __critical__: true;
  /** Unique nonce for idempotency tracking */
  __nonce__: string;
  /** Unix timestamp when the request was created */
  __timestamp__: number;
  /** The actual operation payload */
  data: T;
}

/**
 * Internal storage entry for a tracked nonce.
 */
interface NonceEntry {
  /** Cached result of successful operation */
  result?: unknown;
  /** Error message if operation failed */
  error?: string;
  /** Unix timestamp when entry was created */
  timestamp: number;
  /** Unix timestamp when entry expires */
  expiresAt: number;
  /** Current status of the operation */
  status: 'pending' | 'completed' | 'failed';
}

/**
 * Result returned by checkNonce.
 * Contains cached operation state if the nonce was previously processed.
 */
export interface NonceCheckResult {
  /** Whether this nonce has been seen before */
  exists: boolean;
  /** Status of the operation (if exists) */
  status?: 'pending' | 'completed' | 'failed';
  /** Cached result (if completed) */
  result?: unknown;
  /** Error message (if failed) */
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// NonceService Class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Service for tracking nonces to ensure idempotent critical operations.
 *
 * Maintains an in-memory map of nonces with persistence to chrome.storage.local
 * for recovery after service worker restarts.
 */
export class NonceService {
  /** In-memory nonce store */
  private readonly nonceStore = new Map<string, NonceEntry>();

  /** Default TTL for completed/failed entries (24 hours) */
  private readonly DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

  /** TTL for pending entries (5 minutes) */
  private readonly PENDING_TTL_MS = 5 * 60 * 1000;

  /** Maximum entries to prevent unbounded growth */
  private readonly MAX_ENTRIES = 500;

  /** Interval handle for periodic cleanup */
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  /** Whether store has been loaded from persistence */
  private loaded = false;

  /** Promise for initial load operation */
  private loadPromise: Promise<void> | null = null;

  /** Debounce timer for persistence */
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  /** In-flight persistence promise */
  private persistInFlight: Promise<void> | null = null;

  constructor() {
    // Start cleanup interval to remove expired nonces
    this.startCleanup();
    // Best-effort async hydrate
    void this.ensureLoaded();
  }

  /**
   * Ensure nonce store has been loaded from storage.
   * Safe to call multiple times.
   */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = (async () => {
      this.loaded = true;

      // Only attempt persistence in extension contexts
      if (typeof chrome === 'undefined' || !chrome.storage?.local?.get) {
        return;
      }

      try {
        const result = await chrome.storage.local.get(NONCE_STORE_STORAGE_KEY);
        const raw = result?.[NONCE_STORE_STORAGE_KEY];
        if (!raw || typeof raw !== 'object') {
          return;
        }

        const now = Date.now();
        const entries = raw as Record<string, NonceEntry>;
        Object.entries(entries).forEach(([nonce, entry]) => {
          if (!entry || typeof entry !== 'object') return;
          if (typeof entry.expiresAt !== 'number' || now > entry.expiresAt) return;
          if (
            entry.status !== 'pending' &&
            entry.status !== 'completed' &&
            entry.status !== 'failed'
          )
            return;
          this.nonceStore.set(nonce, entry);
        });
      } catch {
        // Ignore storage load failures; runtime will still work (in-memory only)
      }
    })();

    return this.loadPromise;
  }

  /**
   * Check if a nonce has already been processed
   * @returns NonceCheckResult with cached data if exists
   */
  async checkNonce(nonce: string): Promise<NonceCheckResult> {
    await this.ensureLoaded();
    const entry = this.nonceStore.get(nonce);

    if (!entry) {
      return { exists: false };
    }

    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.nonceStore.delete(nonce);
      return { exists: false };
    }

    return {
      exists: true,
      status: entry.status,
      result: entry.result,
      error: entry.error,
    };
  }

  /**
   * Mark a nonce as pending (operation started but not completed)
   * This prevents duplicate submissions while operation is in progress
   */
  async markPending(nonce: string, timestamp: number): Promise<void> {
    await this.ensureLoaded();
    this.nonceStore.set(nonce, {
      status: 'pending',
      timestamp,
      expiresAt: Date.now() + this.PENDING_TTL_MS,
    });

    this.enforceLimits();
    this.schedulePersist();
  }

  /**
   * Store the result of a completed operation
   */
  async storeResult(nonce: string, result: unknown, ttlMs?: number): Promise<void> {
    await this.ensureLoaded();
    const existing = this.nonceStore.get(nonce);
    const timestamp = existing?.timestamp || Date.now();

    this.nonceStore.set(nonce, {
      result,
      status: 'completed',
      timestamp,
      expiresAt: Date.now() + (ttlMs || this.DEFAULT_TTL_MS),
    });

    this.enforceLimits();
    this.schedulePersist();
  }

  /**
   * Store an error result (operation failed)
   * We store failures too so retries get the same error
   */
  async storeError(nonce: string, error: string, ttlMs?: number): Promise<void> {
    await this.ensureLoaded();
    const existing = this.nonceStore.get(nonce);
    const timestamp = existing?.timestamp || Date.now();

    this.nonceStore.set(nonce, {
      error,
      status: 'failed',
      timestamp,
      expiresAt: Date.now() + (ttlMs || this.DEFAULT_TTL_MS),
    });

    this.enforceLimits();
    this.schedulePersist();
  }

  /**
   * Remove a nonce (e.g., if operation was cancelled before starting)
   */
  async removeNonce(nonce: string): Promise<void> {
    await this.ensureLoaded();
    this.nonceStore.delete(nonce);
    this.schedulePersist();
  }

  /**
   * Check if a payload is a critical operation
   */
  isCriticalPayload(payload: unknown): payload is CriticalPayload {
    if (!payload || typeof payload !== 'object') {
      return false;
    }
    const p = payload as Record<string, unknown>;
    return p.__critical__ === true && typeof p.__nonce__ === 'string';
  }

  /**
   * Get statistics about the nonce store (for debugging)
   */
  getStats(): { total: number; pending: number; completed: number; failed: number } {
    let pending = 0;
    let completed = 0;
    let failed = 0;

    this.nonceStore.forEach((entry) => {
      switch (entry.status) {
        case 'pending':
          pending++;
          break;
        case 'completed':
          completed++;
          break;
        case 'failed':
          failed++;
          break;
      }
    });

    return { total: this.nonceStore.size, pending, completed, failed };
  }

  /**
   * Start periodic cleanup of expired nonces
   */
  private startCleanup(): void {
    if (this.cleanupInterval) return;

    // Clean up every 5 minutes
    this.cleanupInterval = setInterval(
      () => {
        this.cleanup();
      },
      5 * 60 * 1000,
    );
  }

  /**
   * Remove expired nonces
   */
  private cleanup(): void {
    const now = Date.now();
    let removed = 0;

    this.nonceStore.forEach((entry, nonce) => {
      if (now > entry.expiresAt) {
        this.nonceStore.delete(nonce);
        removed++;
      }
    });

    if (removed > 0) {
      console.log(`[NonceService] Cleaned up ${removed} expired nonces`);
    }
  }

  /**
   * Destroy the service (stop cleanup interval)
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.nonceStore.clear();
  }

  private enforceLimits(): void {
    if (this.nonceStore.size <= this.MAX_ENTRIES) return;

    // Remove oldest entries by timestamp
    const sorted = Array.from(this.nonceStore.entries()).sort(
      (a, b) => (a[1].timestamp ?? 0) - (b[1].timestamp ?? 0),
    );
    const toRemove = this.nonceStore.size - this.MAX_ENTRIES;
    for (let index = 0; index < toRemove; index++) {
      this.nonceStore.delete(sorted[index][0]);
    }
  }

  private schedulePersist(): void {
    // Only persist in extension contexts
    if (typeof chrome === 'undefined' || !chrome.storage?.local?.set) {
      return;
    }

    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }

    // Debounce writes to avoid churn
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, 250);
  }

  private async persist(): Promise<void> {
    if (this.persistInFlight) {
      return this.persistInFlight;
    }

    if (typeof chrome === 'undefined' || !chrome.storage?.local?.set) {
      return;
    }

    this.persistInFlight = (async () => {
      try {
        const now = Date.now();
        const obj: Record<string, NonceEntry> = {};
        this.nonceStore.forEach((entry, nonce) => {
          if (now <= entry.expiresAt) {
            obj[nonce] = entry;
          }
        });

        await chrome.storage.local.set({ [NONCE_STORE_STORAGE_KEY]: obj });
      } catch {
        // Ignore persistence failures
      } finally {
        this.persistInFlight = null;
      }
    })();

    return this.persistInFlight;
  }
}

// Export singleton instance for non-DI usage
let nonceServiceInstance: NonceService | null = null;

export function getNonceService(): NonceService {
  if (!nonceServiceInstance) {
    nonceServiceInstance = new NonceService();
  }
  return nonceServiceInstance;
}
