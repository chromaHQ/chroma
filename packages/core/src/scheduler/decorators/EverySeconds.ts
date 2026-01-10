import { injectable } from '@inversifyjs/core';

/**
 * Options for the EverySeconds decorator.
 */
export interface EverySecondsOptions {
  /** If true, job starts paused and must be resumed manually via Scheduler.resume() */
  startPaused?: boolean;

  /** Explicit job name (survives minification). Required for production builds. */
  name?: string;

  /**
   * If true, the job will only execute when the popup (or extension view) is visible.
   * This reduces unnecessary background activity when the user isn't looking at the extension.
   */
  requiresPopup?: boolean;
}

/**
 * Decorator for jobs that run at a specific interval in seconds.
 * Unlike cron expressions which have minute-level granularity,
 * this decorator allows for second-level precision.
 *
 * @param seconds - The interval in seconds between job executions
 * @param options - Optional configuration (startPaused, name, requiresPopup, etc.)
 *
 * @example
 * ```typescript
 * // Auto-starting job (default)
 * @EverySeconds(5, { name: 'MyJob' })
 * export class MyJob implements IJob {
 *   async handle(context: JobContext) {
 *     console.log('Runs every 5 seconds');
 *   }
 * }
 *
 * // Job that only runs when popup is visible
 * @EverySeconds(10, { name: 'UiUpdateJob', requiresPopup: true })
 * export class UiUpdateJob implements IJob {
 *   async handle(context: JobContext) {
 *     console.log('Only runs when user is viewing extension');
 *   }
 * }
 *
 * // Paused job that must be manually resumed
 * @EverySeconds(2, { startPaused: true, name: 'OnDemandJob' })
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
    // Set explicit name metadata to survive minification
    if (options?.name) {
      Reflect.defineMetadata('name', options.name, constructor);
    }

    Reflect.defineMetadata(
      'job:options',
      {
        delay: seconds * 1000,
        recurring: true,
        startPaused: options?.startPaused ?? false,
        requiresPopup: options?.requiresPopup ?? false,
      },
      constructor,
    );
    return constructor;
  };
}
