export function Every(cron: string) {
  return function (constructor: any) {
    Reflect.defineMetadata('job:options', { cron }, constructor);
    return constructor;
  };
}
