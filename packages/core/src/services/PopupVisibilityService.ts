/**
 * @fileoverview Popup Visibility Service for Chrome Extensions.
 *
 * Tracks whether the extension popup (or any extension view) is currently visible
 * by monitoring connected ports. This allows jobs to conditionally run only when
 * a user is actively viewing the extension, reducing unnecessary background activity.
 *
 * @module services/PopupVisibilityService
 *
 * @example
 * ```typescript
 * import { PopupVisibilityService } from '@chromahq/core';
 *
 * // Check if popup is visible
 * if (PopupVisibilityService.instance.isPopupVisible()) {
 *   // Run UI-related tasks
 * }
 *
 * // Listen for visibility changes
 * PopupVisibilityService.instance.onVisibilityChange((isVisible) => {
 *   console.log('Popup visibility changed:', isVisible);
 * });
 * ```
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Callback type for visibility change events */
type VisibilityChangeCallback = (isVisible: boolean) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Service Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Service that tracks popup/extension view visibility.
 *
 * Uses a singleton pattern to ensure consistent state across the application.
 * The service is updated by the BridgeRuntime when ports connect/disconnect.
 */
export class PopupVisibilityService {
  private static _instance: PopupVisibilityService | null = null;

  /** Number of currently connected ports (popup views) */
  private connectedPortCount: number = 0;

  /** Listeners for visibility changes */
  private listeners: Set<VisibilityChangeCallback> = new Set();

  /** Timestamp of last visibility change */
  private lastVisibilityChangeAt: number = 0;

  /**
   * Private constructor - use PopupVisibilityService.instance instead.
   */
  private constructor() {}

  /**
   * Get the singleton instance of the service.
   */
  static get instance(): PopupVisibilityService {
    if (!PopupVisibilityService._instance) {
      PopupVisibilityService._instance = new PopupVisibilityService();
    }
    return PopupVisibilityService._instance;
  }

  /**
   * Reset the singleton instance (primarily for testing).
   * @internal
   */
  static resetInstance(): void {
    if (PopupVisibilityService._instance) {
      PopupVisibilityService._instance.listeners.clear();
    }
    PopupVisibilityService._instance = null;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Check if the popup (or any extension view) is currently visible.
   *
   * @returns true if at least one port is connected (popup is open)
   */
  isPopupVisible(): boolean {
    return this.connectedPortCount > 0;
  }

  /**
   * Get the number of connected ports.
   *
   * @returns The current count of connected extension views
   */
  getConnectedPortCount(): number {
    return this.connectedPortCount;
  }

  /**
   * Get the timestamp of the last visibility change.
   *
   * @returns Unix timestamp in milliseconds, or 0 if never changed
   */
  getLastVisibilityChangeAt(): number {
    return this.lastVisibilityChangeAt;
  }

  /**
   * Register a callback to be notified when visibility changes.
   *
   * @param callback - Function to call when visibility changes
   * @returns Unsubscribe function to remove the listener
   */
  onVisibilityChange(callback: VisibilityChangeCallback): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Internal API (called by BridgeRuntime)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Called when a port connects (popup opens).
   * @internal
   */
  onPortConnected(): void {
    const wasVisible = this.isPopupVisible();
    this.connectedPortCount++;

    if (!wasVisible && this.isPopupVisible()) {
      this.lastVisibilityChangeAt = Date.now();
      this.notifyListeners(true);
    }
  }

  /**
   * Called when a port disconnects (popup closes).
   * @internal
   */
  onPortDisconnected(): void {
    const wasVisible = this.isPopupVisible();
    this.connectedPortCount = Math.max(0, this.connectedPortCount - 1);

    if (wasVisible && !this.isPopupVisible()) {
      this.lastVisibilityChangeAt = Date.now();
      this.notifyListeners(false);
    }
  }

  /**
   * Sync the port count with the actual connected ports set.
   * Called by BridgeRuntime to ensure consistency.
   * @internal
   */
  syncPortCount(count: number): void {
    const wasVisible = this.isPopupVisible();
    this.connectedPortCount = count;
    const isNowVisible = this.isPopupVisible();

    if (wasVisible !== isNowVisible) {
      this.lastVisibilityChangeAt = Date.now();
      this.notifyListeners(isNowVisible);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Notify all registered listeners of a visibility change.
   */
  private notifyListeners(isVisible: boolean): void {
    this.listeners.forEach((callback) => {
      try {
        callback(isVisible);
      } catch (error) {
        console.error('[PopupVisibilityService] Listener error:', error);
      }
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience Export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the PopupVisibilityService singleton instance.
 * Convenience function for cleaner imports.
 */
export function getPopupVisibilityService(): PopupVisibilityService {
  return PopupVisibilityService.instance;
}
