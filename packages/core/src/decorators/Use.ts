import { MiddlewareFn, MiddlewareRegistry } from '../internal/MiddlewareRegistry';

export function Use(...fns: MiddlewareFn[]) {
  return function (target: any) {
    const key = Reflect.getMetadata('chroma:bridge:key', target);
    if (!key) throw new Error('@Use must be placed *after* @Message.');

    fns.forEach((fn) => MiddlewareRegistry.registerForKey(key, fn));
  };
}
