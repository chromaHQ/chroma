import { injectable } from '@inversifyjs/core';

/**
 * Decorator for jobs that run at a specific interval in seconds.
 * Unlike cron expressions which have minute-level granularity,
 * this decorator allows for second-level precision.
 *
 * @param seconds - The interval in seconds between job executions
 *
 * @example
 * ```typescript
 * @EverySeconds(5)
 * export class MyJob implements IJob {
 *   async handle(context: JobContext) {
 *     console.log('Runs every 5 seconds');
 *   }
 * }
 * ```
 */
export function EverySeconds(seconds: number) {
  return function (constructor: any) {
    injectable()(constructor);
    Reflect.defineMetadata(
      'job:options',
      {
        delay: seconds * 1000,
        recurring: true,
      },
      constructor,
    );
    return constructor;
  };
}
