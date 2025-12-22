import { injectable } from '@inversifyjs/core';

/**
 * Options for the EverySeconds decorator.
 */
export interface EverySecondsOptions {
  /** If true, job starts paused and must be resumed manually via Scheduler.resume() */
  startPaused?: boolean;
}

/**
 * Decorator for jobs that run at a specific interval in seconds.
 * Unlike cron expressions which have minute-level granularity,
 * this decorator allows for second-level precision.
 *
 * @param seconds - The interval in seconds between job executions
 * @param options - Optional configuration (startPaused, etc.)
 *
 * @example
 * ```typescript
 * // Auto-starting job (default)
 * @EverySeconds(5)
 * export class MyJob implements IJob {
 *   async handle(context: JobContext) {
 *     console.log('Runs every 5 seconds');
 *   }
 * }
 *
 * // Paused job that must be manually resumed
 * @EverySeconds(2, { startPaused: true })
 * export class OnDemandJob implements IJob {
 *   async handle(context: JobContext) {
 *     console.log('Runs when resumed');
 *   }
 * }
 * ```
 */
export function EverySeconds(seconds: number, options?: EverySecondsOptions) {
  return function (constructor: any) {
    injectable()(constructor);
    Reflect.defineMetadata(
      'job:options',
      {
        delay: seconds * 1000,
        recurring: true,
        startPaused: options?.startPaused ?? false,
      },
      constructor,
    );
    return constructor;
  };
}
