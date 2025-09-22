import 'reflect-metadata';

export * from './persist.js';
export * from './types.js';
export * from './react.js';
export * from './bridge.js';
export * from './hookFactory.js';

export { createStore, StoreBuilder } from './StoreBuilder.js';

// Elegant hook factory (preferred approach)
export { createStoreHooks } from './hookFactory.js';

import { autoRegisterStoreHandlers } from './autoRegister.js';
// Auto-register global init function for @chromahq/core integration
import { createStore } from './StoreBuilder.js';
import type { StoreDefinition } from './types.js';

/**
 * Initialize a store from a store definition
 */
export async function init(storeDefinition: StoreDefinition): Promise<any> {
  try {
    let builder = createStore(storeDefinition.name);

    // Add slices
    if (storeDefinition.slices) {
      builder = builder.withSlices(...storeDefinition.slices);
    }

    const store = await builder.create();

    return {
      def: storeDefinition,
      store,
      classes: autoRegisterStoreHandlers(store),
    };
  } catch (error) {
    console.error(`Failed to initialize store "${storeDefinition.name}":`, error);
    throw error;
  }
}
