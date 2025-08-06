import type { CentralStore } from './types.js';

/**
 * Register store in global registry for message handlers to find
 * This creates the bridge between auto-registration and core's file scanning system
 */
export function registerStoreGlobally<T>(store: CentralStore<T>, storeName: string) {
  if (typeof globalThis === 'undefined') return;

  // Create global store registry with proper typing
  const globalAny = globalThis as any;
  if (!globalAny.__chromaStores) {
    globalAny.__chromaStores = {};
  }

  globalAny.__chromaStores[storeName] = store;
  console.log(`Store "${storeName}" registered globally for message handlers`);
}
