import { injectable } from '@inversifyjs/core';

export function Every(cron: string) {
  return function (constructor: any) {
    injectable()(constructor);
    Reflect.defineMetadata('job:options', { cron }, constructor);
    return constructor;
  };
}
