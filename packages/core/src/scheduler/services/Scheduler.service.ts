import { AlarmAdapter } from '../scheduler/adapters/AlarmAdapter';
import { TimeoutAdapter } from '../scheduler/adapters/TimeoutAdapter';
import { JobRegistry } from '../scheduler/JobRegistry';
import { JobOptions } from '../core/JobOptions';
import { IJob, JobState } from '../core/IJob';
import { getNextCronDate } from '../support/cron';
import { container } from '../../di/Container';

export class Scheduler {
  private readonly registry = JobRegistry.instance;
  private readonly alarm = new AlarmAdapter();
  private readonly timeout = new TimeoutAdapter();

  constructor() {
    console.log('Scheduler initialized');
    this.alarm.onTrigger(this.execute.bind(this));
    this.timeout.onTrigger(this.execute.bind(this));
  }

  schedule(id: string, options: JobOptions) {
    const context = this.registry.getContext(id);
    if (!context || context.isStopped()) {
      console.log(`Job ${id} is stopped, skipping schedule`);
      return;
    }

    console.log(`Scheduling job ${id} with options:`, options);
    const when = this.getScheduleTime(options);

    const adapter = when - Date.now() < 60_000 ? this.timeout : this.alarm;
    const timerId = adapter.schedule(id, when);

    if (adapter === this.timeout) {
      this.registry.setTimeoutId(id, timerId as unknown as NodeJS.Timeout);
    }
  }

  pause(id: string): void {
    console.log(`Pausing job ${id}`);
    this.registry.pause(id);
  }

  resume(id: string): void {
    console.log(`Resuming job ${id}`);
    this.registry.resume(id);

    const options = this.registry.meta(id);

    if (options) {
      this.schedule(id, options);
    }
  }

  stop(id: string): void {
    console.log(`Stopping job ${id}`);
    this.registry.stop(id);
  }

  private async execute(id: string) {
    const job = this.registry.resolve(id);
    const context = this.registry.getContext(id);

    if (!job || !context) {
      console.log(`Job ${id} not found or no context`);
      return;
    }

    if (context.isPaused() || context.isStopped()) {
      console.log(`Job ${id} is paused or stopped, skipping execution`);
      return;
    }

    try {
      this.registry.updateState(id, JobState.RUNNING);
      console.log(`Executing job ${id}`);

      // get job instance from container
      const jobInstance = container.get(id) as IJob;

      console.log(jobInstance);
      await jobInstance.handle.bind(jobInstance).call(jobInstance, context);

      if (!context.isStopped() && !context.isPaused()) {
        this.registry.updateState(id, JobState.COMPLETED);

        const options = this.registry.meta(id);

        if (options?.cron) {
          this.registry.updateState(id, JobState.SCHEDULED);
          this.schedule(id, options);
        }
      }
    } catch (error) {
      console.error(`Job ${id} execution failed:`, error);
      context.fail(error as Error);
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
    const jobs: Array<{ id: string; state: JobState; options: JobOptions }> = [];
    return jobs;
  }
}
