export function Provider({
  imports = [],
  uses = [],
}: { imports?: (new (...args: any[]) => any)[]; uses?: (new (...args: any[]) => any)[] } = {}) {
  return function (constructor: new (...args: any[]) => any) {
    Reflect.defineMetadata('imports', imports, constructor);
    Reflect.defineMetadata('uses', uses, constructor);
  };
}
