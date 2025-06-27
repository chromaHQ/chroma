export type MiddlewareFn = (ctx: any, next: () => Promise<any>) => Promise<any>;

/**
 * Registry for middleware functions that can be applied globally or per handler.
 * Middleware functions can be used to modify the request context or handle errors.
 */
class MiddlewareRegistryClass {
  private global: MiddlewareFn[] = [];
  private perHandler = new Map<string, MiddlewareFn[]>();

  registerGlobal(fn: MiddlewareFn) {
    this.global.push(fn);
  }

  registerForKey(key: string, fn: MiddlewareFn) {
    const arr = this.perHandler.get(key) ?? [];
    arr.push(fn);
    this.perHandler.set(key, arr);
  }

  pipeline(key: string): MiddlewareFn[] {
    return [...this.global, ...(this.perHandler.get(key) ?? [])];
  }
}
export const MiddlewareRegistry = new MiddlewareRegistryClass();
