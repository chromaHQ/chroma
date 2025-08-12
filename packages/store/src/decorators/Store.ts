import { container } from '@chromahq/core';

/**
 * Property decorator to inject a store instance from DI container if available
 * Usage:
 *   @Store() store: CentralStore<any>
 *   @Store('myStoreName') store: CentralStore<MyState>
 */
export function Store(storeName?: string) {
  return function (target: any, propertyKey: string) {
    Object.defineProperty(target, propertyKey, {
      get() {
        // Try DI container first
        try {
          const diKey = storeName ? `CentralStore:${storeName}` : 'CentralStore';

          if (container && container.isBound(diKey)) {
            return container.get(diKey);
          }
        } catch {}
      },
      enumerable: true,
      configurable: true,
    });
  };
}
