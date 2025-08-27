import { injectable } from '@inversifyjs/core';
import { JobOptions } from '../core/JobOptions';

export function JobConfig<T extends new (...args: any[]) => any>(options: JobOptions = {}) {
  return function (constructor: any) {
    injectable()(constructor);
    Reflect.defineMetadata('job:options', { options }, constructor);
    return constructor;
  };
}
