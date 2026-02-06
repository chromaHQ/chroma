/**
 * @fileoverview Method decorator for subscribing to application events.
 *
 * The `@Subscribe` decorator marks a method as an event handler. During
 * bootstrap, the framework scans all registered services and jobs for
 * methods decorated with `@Subscribe` and wires them to the {@link AppEventBus}.
 *
 * @module events/Subscribe
 *
 * @example
 * ```typescript
 * import { Service, Subscribe } from '@chromahq/core';
 *
 * @Service()
 * class MyService {
 *   @Subscribe('auth:login')
 *   async onLogin(payload: { walletId: string }) {
 *     console.log('User logged in:', payload.walletId);
 *   }
 *
 *   @Subscribe('wallet:selected')
 *   onWalletSelected(payload: { walletId: string }) {
 *     // handle wallet selection change
 *   }
 * }
 * ```
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Reflect metadata key used to store subscription info on a class */
export const SUBSCRIBE_METADATA_KEY = 'chroma:subscribe';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Metadata entry stored by the @Subscribe decorator.
 *
 * @interface
 */
export interface SubscribeMetadata {
  /** The event name to subscribe to (e.g. 'auth:login') */
  eventName: string;

  /** The method name on the class prototype */
  methodName: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Decorator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Method decorator that subscribes the decorated method to a named event.
 *
 * The method will be called with the event payload whenever the event is
 * emitted through the {@link AppEventBus}. Multiple methods on the same
 * class can subscribe to different (or the same) events.
 *
 * @param eventName - the event identifier to subscribe to (e.g. 'auth:login')
 * @returns MethodDecorator
 *
 * @example
 * ```typescript
 * @Subscribe('auth:login')
 * async onLogin(payload: { walletId: string }) {
 *   await this.refreshData(payload.walletId);
 * }
 * ```
 */
export function Subscribe(eventName: string) {
  return function (target: object, propertyKey: string, _descriptor: PropertyDescriptor): void {
    const key = 'chroma:subscribe';
    const constructor = target.constructor;
    const existing: SubscribeMetadata[] = Reflect.getMetadata(key, constructor) || [];

    existing.push({ eventName, methodName: propertyKey });

    Reflect.defineMetadata(key, existing, constructor);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read all @Subscribe metadata entries from a class constructor.
 *
 * @param constructor - the class constructor to inspect
 * @returns array of subscription metadata (empty if none)
 */
export function getSubscribeMetadata(constructor: Function): SubscribeMetadata[] {
  return Reflect.getMetadata('chroma:subscribe', constructor) || [];
}
