// Global type declarations for Chroma store integration

declare global {
  var __CHROMA__:
    | {
        init?: (storeDefinition: import('./types.js').StoreDefinition) => Promise<any>;
        stores?: any[];
      }
    | undefined;

  var init: ((storeDefinition: import('./types.js').StoreDefinition) => Promise<any>) | undefined;
}

export {};
