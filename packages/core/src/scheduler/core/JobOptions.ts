/**
 * Configuration options for scheduled jobs.
 */
export interface JobOptions {
  /** Unique identifier for the job */
  id?: string;

  /** Delay in milliseconds before first execution (for delay-based jobs) */
  delay?: number;

  /** Cron expression for scheduling (e.g., '0 */5 * * * *' for every 5 minutes) */
  cron?: string;

  /** Whether the job should persist across service worker restarts */
  persistent?: boolean;

  /** Whether the job should repeat after each execution (for delay-based jobs) */
  recurring?: boolean;

  /** If true, job starts paused and must be resumed manually via Scheduler.resume() */
  startPaused?: boolean;

  /**
   * If true, the job will only execute when the popup (or extension view) is visible.
   * This reduces unnecessary background activity when the user isn't looking at the extension.
   *
   * When the popup is closed:
   * - The job will be skipped silently
   * - It will be rescheduled for its next occurrence
   *
   * @example
   * ```typescript
   * @Every('0 *\/5 * * * *', { requiresPopup: true })
   * export class AllocationFetchJob {
   *   // Only runs when popup is open
   * }
   * ```
   */
  requiresPopup?: boolean;
}
