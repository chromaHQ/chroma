/**
 * @fileoverview Generic application-wide event bus.
 *
 * Provides a centralised pub/sub mechanism for decoupled communication
 * between services, jobs, and handlers. The bus is created once during
 * bootstrap, bound to the DI container, and can be injected into any
 * `@Service()` or job via `@Use(AppEventBus)`.
 *
 * The framework automatically wires methods decorated with `@Subscribe`
 * during the bootstrap phase, but manual subscriptions via {@link on}
 * are also supported.
 *
 * @module events/AppEventBus
 *
 * @example
 * ```typescript
 * import { Service, EventBus } from '@chromahq/core';
 * import type { AppEventBus } from '@chromahq/core';
 *
 * @Service()
 * class AuthService {
 *   constructor(@EventBus() private bus: AppEventBus) {}
 *
 *   async login(walletId: string) {
 *     // ... perform login ...
 *     await this.bus.emit('auth:login', { walletId });
 *   }
 * }
 * ```
 */

import { injectable } from '@inversifyjs/core';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Handler function signature for event subscriptions */
export type EventHandler<T = unknown> = (payload: T) => void | Promise<void>;

/**
 * Internal subscription record.
 *
 * @interface
 */
interface Subscription {
  /** Unique subscription id */
  id: number;

  /** The event name this subscription listens for */
  eventName: string;

  /** The handler function to invoke */
  handler: EventHandler;

  /** Human-readable name for logging / debugging */
  handlerName: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// DI Token & Decorator
// ─────────────────────────────────────────────────────────────────────────────

/** DI container token for resolving the AppEventBus singleton */
export const EventBusToken = Symbol.for('EventBus');

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generic application event bus.
 *
 * Implements a simple pub/sub pattern. Handlers are invoked in parallel
 * via `Promise.allSettled` — a failure in one handler never prevents
 * other handlers from executing.
 */
@injectable()
export class AppEventBus {
  /** Registry of all active subscriptions */
  private subscriptions: Subscription[] = [];

  /** Auto-incrementing ID counter */
  private nextId = 0;

  // ─────────────────────────────────────────────────────────────────────────
  // Subscribe
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Subscribe to a named event.
   *
   * @param eventName - the event to listen for
   * @param handler - callback invoked with the event payload
   * @param handlerName - human-readable name for logging
   * @returns an unsubscribe function
   */
  on<T = unknown>(eventName: string, handler: EventHandler<T>, handlerName: string): () => void {
    const id = ++this.nextId;

    this.subscriptions.push({
      id,
      eventName,
      handler: handler as EventHandler,
      handlerName,
    });

    return () => {
      this.subscriptions = this.subscriptions.filter((s) => s.id !== id);
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Emit
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Emit a named event to all matching subscribers.
   *
   * Handlers execute in parallel. Individual handler failures are caught
   * and logged — they do not propagate or block other handlers.
   *
   * @param eventName - the event to emit
   * @param payload - optional data passed to every handler
   */
  async emit<T = unknown>(eventName: string, payload?: T): Promise<void> {
    const matching = this.subscriptions.filter((s) => s.eventName === eventName);

    if (matching.length === 0) {
      return;
    }

    const results = await Promise.allSettled(
      matching.map(async (sub) => {
        try {
          await sub.handler(payload);
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error(
            `[AppEventBus] Handler "${sub.handlerName}" failed for event "${eventName}":`,
            error,
          );
          throw error;
        }
      }),
    );

    const failed = results.filter((r) => r.status === 'rejected').length;

    if (failed > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[AppEventBus] ${failed}/${matching.length} handler(s) failed for event "${eventName}"`,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Utilities
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get the total number of active subscriptions.
   * Useful for debugging and testing.
   */
  getSubscriptionCount(): number {
    return this.subscriptions.length;
  }

  /**
   * Get the number of subscriptions for a specific event.
   *
   * @param eventName - the event to count subscriptions for
   */
  getSubscriptionCountForEvent(eventName: string): number {
    return this.subscriptions.filter((s) => s.eventName === eventName).length;
  }

  /**
   * Remove all subscriptions. Primarily for testing.
   */
  clearAllSubscriptions(): void {
    this.subscriptions = [];
  }
}
