export type HandlerConstructor = new (...args: any[]) => {
  handle: (ctx: any) => Promise<any> | any;
};

/**
 * Registry for bridge handlers.
 */
class BridgeRegistryClass {
  private map = new Map<string, HandlerConstructor>();

  add(key: string, ctor: HandlerConstructor) {
    if (this.map.has(key)) throw new Error(`Duplicate handler for "${key}"`);
    this.map.set(key, ctor);
  }

  get(key: string) {
    return this.map.get(key);
  }

  all() {
    return Array.from(this.map.entries());
  }
}

export const BridgeRegistry = new BridgeRegistryClass();
