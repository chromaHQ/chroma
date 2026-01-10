import { AlarmAdapter } from '../scheduler/adapters/AlarmAdapter';
import { TimeoutAdapter } from '../scheduler/adapters/TimeoutAdapter';
import { JobRegistry } from '../scheduler/JobRegistry';
import { JobOptions } from '../core/JobOptions';
import { IJob, JobState } from '../core/IJob';
import { getNextCronDate } from '../support/cron';
import { container } from '../../di/Container';
import { Logger } from '../../interfaces/Logger';
import { PopupVisibilityService } from '../../services/PopupVisibilityService';

export class Scheduler {
  private readonly registry = JobRegistry.instance;
  private readonly alarm = new AlarmAdapter();
  private readonly timeout = new TimeoutAdapter();
  private readonly logger: Logger;
  private popupVisibilityUnsubscribe?: () => void;

  constructor(logger?: Logger) {
    this.logger = logger || {
      info: console.log,
      success: console.log,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
    };

    this.logger.info('Scheduler initialized');
    this.alarm.onTrigger(this.execute.bind(this));
    this.timeout.onTrigger(this.execute.bind(this));

    // Subscribe to popup visibility changes to pause/resume jobs
    this.setupPopupVisibilityListener();
  }

  /**
   * Setup listener for popup visibility changes.
   * When popup closes, pause all jobs with requiresPopup.
   * When popup opens, resume those jobs.
   */
  private setupPopupVisibilityListener(): void {
    const visibilityService = PopupVisibilityService.instance;

    this.popupVisibilityUnsubscribe = visibilityService.onVisibilityChange((isVisible) => {
      if (isVisible) {
        this.resumePopupDependentJobs();
      } else {
        this.pausePopupDependentJobs();
      }
    });
  }

  /**
   * Pause all jobs that have requiresPopup: true
   */
  private pausePopupDependentJobs(): void {
    const jobs = this.registry.listAll();
    let pausedCount = 0;

    for (const job of jobs) {
      if (job.options?.requiresPopup && !this.registry.getContext(job.id)?.isPaused()) {
        this.logger.debug(`Pausing popup-dependent job: ${job.id}`);
        this.alarm.cancel(job.id);
        this.timeout.cancel(job.id);
        this.registry.pause(job.id);
        pausedCount++;
      }
    }

    if (pausedCount > 0) {
      this.logger.info(`Paused ${pausedCount} popup-dependent jobs (popup closed)`);
    }
  }

  /**
   * Resume all jobs that have requiresPopup: true
   */
  private resumePopupDependentJobs(): void {
    const jobs = this.registry.listAll();
    let resumedCount = 0;

    for (const job of jobs) {
      if (job.options?.requiresPopup && this.registry.getContext(job.id)?.isPaused()) {
        this.logger.debug(`Resuming popup-dependent job: ${job.id}`);
        this.registry.resume(job.id);
        this.schedule(job.id, job.options);
        resumedCount++;
      }
    }

    if (resumedCount > 0) {
      this.logger.info(`Resumed ${resumedCount} popup-dependent jobs (popup opened)`);
    }
  }

  schedule(id: string, options: JobOptions): void {
    const context = this.registry.getContext(id);
    if (!context || context.isStopped()) {
      return;
    }

    // Don't schedule jobs that require popup if popup is not visible
    if (options?.requiresPopup) {
      const isPopupVisible = PopupVisibilityService.instance.isPopupVisible();
      if (!isPopupVisible) {
        this.logger.debug(
          `Job ${id} requires popup but popup is not visible, pausing instead of scheduling`,
        );
        if (!context.isPaused()) {
          this.registry.pause(id);
        }
        return;
      }
    }

    const when = this.getScheduleTime(options);
    const now = Date.now();

    // Prevent scheduling in the past - must be at least 1 second in the future
    if (when <= now) {
      this.logger.warn(`Job ${id} scheduled time is in the past, recalculating...`);
      // For cron jobs, this shouldn't happen, but if it does, get next occurrence
      if (options.cron) {
        const nextWhen = this.getScheduleTime(options);
        if (nextWhen <= now) {
          this.logger.error(`Job ${id} cannot be scheduled - cron expression may be invalid`);
          return;
        }
        return this.schedule(id, options);
      }
      return;
    }

    // Cancel any existing timers before scheduling new ones to prevent duplicates
    this.alarm.cancel(id);
    this.timeout.cancel(id);
    this.registry.clearTimers(id);

    const delayMs = when - now;
    // Use AlarmAdapter for delays >= 30 seconds (Chrome Alarms minimum is ~0.5 minutes)
    // This ensures jobs with second offsets like "50 */1 * * * *" still use Chrome Alarms
    const adapter = delayMs < 30_000 ? this.timeout : this.alarm;
    const timerId = adapter.schedule(id, when);

    // Only store timeout ID if we got one (Chrome alarms return null)
    if (adapter === this.timeout && timerId) {
      this.registry.setTimeoutId(id, timerId as unknown as NodeJS.Timeout);
    }

    this.logger.info(
      `[Scheduler] Job "${id}" scheduled for ${new Date(when).toISOString()} (in ${Math.round(delayMs / 1000)}s) → ${adapter === this.alarm ? '⏰ AlarmAdapter' : '⏱️ TimeoutAdapter'}`,
    );
  }

  pause(id: string): void {
    this.logger.info(`Pausing job ${id}`);
    // Cancel timers in adapters before pausing
    this.alarm.cancel(id);
    this.timeout.cancel(id);
    this.registry.pause(id);
  }

  resume(id: string): void {
    this.logger.info(`Resuming job ${id}`);
    this.registry.resume(id);

    const options = this.registry.meta(id);

    if (options) {
      this.schedule(id, options);
    }
  }

  stop(id: string): void {
    this.logger.info(`Stopping job ${id}`);
    // Cancel timers in adapters before stopping
    this.alarm.cancel(id);
    this.timeout.cancel(id);
    this.registry.stop(id);
  }

  private async execute(id: string) {
    const job = this.registry.resolve(id);
    const context = this.registry.getContext(id);
    const options = this.registry.meta(id);

    if (!job || !context) {
      this.logger.debug(`Job ${id} not found or no context`);
      return;
    }

    if (context.isPaused() || context.isStopped()) {
      this.logger.debug(`Job ${id} is paused or stopped, skipping execution`);
      return;
    }

    // Double-check popup visibility for requiresPopup jobs
    // (job might have been scheduled right before popup closed)
    if (options?.requiresPopup) {
      const isPopupVisible = PopupVisibilityService.instance.isPopupVisible();
      if (!isPopupVisible) {
        this.logger.debug(`Job ${id} requires popup but popup closed, pausing job`);
        this.registry.pause(id);
        return;
      }
    }

    try {
      this.registry.updateState(id, JobState.RUNNING);
      this.logger.info(`Executing job ${id}`);

      // get job instance from container
      const jobInstance = container.get(id) as IJob;

      this.logger.debug('Job instance:', { jobInstance });
      await jobInstance.handle.bind(jobInstance).call(jobInstance, context);

      if (!context.isStopped() && !context.isPaused()) {
        this.registry.updateState(id, JobState.COMPLETED);

        // Reschedule if it's a recurring job (cron or recurring delay)
        if (options?.cron || options?.recurring) {
          this.registry.updateState(id, JobState.SCHEDULED);
          this.schedule(id, options);
        }
      }
    } catch (error) {
      this.logger.error(`Job ${id} execution failed:`, error as Error);
      context.fail(error as Error);

      // Still reschedule recurring jobs even after failure
      if (options?.cron || options?.recurring) {
        this.logger.info(`Rescheduling failed recurring job ${id}`);
        this.registry.updateState(id, JobState.SCHEDULED);
        this.schedule(id, options);
      }
    }
  }

  private getScheduleTime(options: JobOptions): number {
    if (options.delay) return Date.now() + options.delay;
    if (options.cron) {
      const date = getNextCronDate(options.cron);
      if (!date) {
        throw new Error('Invalid cron expression');
      }
      return date.getTime();
    }
    return Date.now();
  }

  // Public API for job control
  getJobState(id: string): JobState | undefined {
    return this.registry.getContext(id)?.state;
  }

  listJobs(): Array<{ id: string; state: JobState; options: JobOptions }> {
    return this.registry.listAll();
  }

  /**
   * Gracefully shutdown the scheduler, clearing all timers
   */
  shutdown(): void {
    this.logger.info('Shutting down scheduler...');

    // Unsubscribe from popup visibility changes
    if (this.popupVisibilityUnsubscribe) {
      this.popupVisibilityUnsubscribe();
      this.popupVisibilityUnsubscribe = undefined;
    }

    this.alarm.clear();
    this.timeout.clear();
    this.registry.clear();
    this.logger.info('Scheduler shutdown complete');
  }

  /**
   * Get scheduler stats for monitoring
   */
  getStats(): { jobs: number; timeouts: number; alarms: number } {
    return {
      jobs: this.registry.size(),
      timeouts: this.timeout.size(),
      alarms: this.alarm.size(),
    };
  }
}
