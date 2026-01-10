import { injectable } from '@inversifyjs/core';

/**
 * Options for the Every decorator.
 */
export interface EveryOptions {
  /**
   * If true, the job will only execute when the popup (or extension view) is visible.
   * This reduces unnecessary background activity when the user isn't looking at the extension.
   */
  requiresPopup?: boolean;

  /**
   * Explicit job name (survives minification). Recommended for production builds.
   */
  name?: string;

  /**
   * If true, job starts paused and must be resumed manually via Scheduler.resume()
   */
  startPaused?: boolean;
}

/**
 * Decorator for scheduling jobs using cron expressions.
 *
 * @param cron - Cron expression (e.g., '0 *\/5 * * * *' for every 5 minutes)
 * @param options - Optional configuration for the job
 *
 * @example
 * ```typescript
 * // Basic usage - runs every 5 minutes
 * @Every('0 *\/5 * * * *')
 * export class MyJob { ... }
 *
 * // With options - only runs when popup is visible
 * @Every('0 *\/5 * * * *', { requiresPopup: true, name: 'MyJob' })
 * export class MyJob { ... }
 * ```
 */
export function Every(cron: string, options?: EveryOptions) {
  return function (constructor: any) {
    injectable()(constructor);

    // Set explicit name metadata to survive minification
    if (options?.name) {
      Reflect.defineMetadata('name', options.name, constructor);
    }

    Reflect.defineMetadata(
      'job:options',
      {
        cron,
        requiresPopup: options?.requiresPopup ?? false,
        startPaused: options?.startPaused ?? false,
      },
      constructor,
    );
    return constructor;
  };
}
