import { AlarmAdapter } from '../scheduler/adapters/AlarmAdapter';
import { TimeoutAdapter } from '../scheduler/adapters/TimeoutAdapter';
import { JobRegistry } from '../scheduler/JobRegistry';
import { JobOptions } from '../core/JobOptions';
import { IJob, JobState } from '../core/IJob';
import { getNextCronDate } from '../support/cron';
import { container } from '../../di/Container';
import { Logger } from '../../interfaces/Logger';

export class Scheduler {
  private readonly registry = JobRegistry.instance;
  private readonly alarm = new AlarmAdapter();
  private readonly timeout = new TimeoutAdapter();
  private readonly logger: Logger;

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
  }

  schedule(id: string, options: JobOptions): void {
    const context = this.registry.getContext(id);
    if (!context || context.isStopped()) {
      return;
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

    const adapter = when - now < 60_000 ? this.timeout : this.alarm;
    const timerId = adapter.schedule(id, when);

    if (adapter === this.timeout) {
      this.registry.setTimeoutId(id, timerId as unknown as NodeJS.Timeout);
    }

    this.logger.debug(
      `Job ${id} scheduled for ${new Date(when).toISOString()} (in ${Math.round((when - now) / 1000)}s)`,
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

    if (!job || !context) {
      this.logger.debug(`Job ${id} not found or no context`);
      return;
    }

    if (context.isPaused() || context.isStopped()) {
      this.logger.debug(`Job ${id} is paused or stopped, skipping execution`);
      return;
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

        const options = this.registry.meta(id);

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
      const options = this.registry.meta(id);
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
