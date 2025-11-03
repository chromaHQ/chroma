import { IJob } from '../core/IJob';
import { JobOptions } from '../core/JobOptions';
import { JobState, JobContext } from '../core/IJob';

interface JobEntry {
  job: IJob;
  context: JobContext;
  options: JobOptions;
  timeoutId?: NodeJS.Timeout;
  intervalId?: NodeJS.Timeout;
}

export class JobRegistry {
  static instance = new JobRegistry();
  private jobs = new Map<string, JobEntry>();

  register(id: string, job: IJob, options: JobOptions) {
    const context = this.createJobContext(id, options);

    this.jobs.set(id, {
      job,
      context,
      options,
    });
  }

  resolve(id: string): IJob | undefined {
    const entry = this.jobs.get(id);
    return entry?.job;
  }

  meta(id: string): JobOptions | undefined {
    const entry = this.jobs.get(id);
    return entry?.options;
  }

  getContext(id: string): JobContext | undefined {
    const entry = this.jobs.get(id);
    return entry?.context;
  }

  updateState(id: string, state: JobState): void {
    const entry = this.jobs.get(id);

    if (entry) {
      entry.context.state = state;
      entry.context.updatedAt = new Date();

      switch (state) {
        case JobState.RUNNING:
          entry.context.startedAt = new Date();
          break;
        case JobState.PAUSED:
          entry.context.pausedAt = new Date();
          break;
        case JobState.STOPPED:
          entry.context.stoppedAt = new Date();
          break;
        case JobState.COMPLETED:
          entry.context.completedAt = new Date();
          break;
      }
    }
  }

  setTimeoutId(id: string, timeoutId: NodeJS.Timeout): void {
    const entry = this.jobs.get(id);
    if (entry) {
      entry.timeoutId = timeoutId;
    }
  }

  setIntervalId(id: string, intervalId: NodeJS.Timeout): void {
    const entry = this.jobs.get(id);
    if (entry) {
      entry.intervalId = intervalId;
    }
  }

  clearTimers(id: string): void {
    const entry = this.jobs.get(id);
    if (entry) {
      if (entry.timeoutId) {
        clearTimeout(entry.timeoutId);
        entry.timeoutId = undefined;
      }
      if (entry.intervalId) {
        clearInterval(entry.intervalId);
        entry.intervalId = undefined;
      }
    }
  }

  pause(id: string): void {
    const entry = this.jobs.get(id);
    if (entry && entry.context.state === JobState.RUNNING) {
      this.updateState(id, JobState.PAUSED);
      this.clearTimers(id);
      entry.job.pause?.();
    }
  }

  resume(id: string): void {
    const entry = this.jobs.get(id);
    if (entry && entry.context.state === JobState.PAUSED) {
      this.updateState(id, JobState.SCHEDULED);
      entry.job.resume?.();
    }
  }

  stop(id: string): void {
    const entry = this.jobs.get(id);
    if (entry && entry.context.state !== JobState.STOPPED) {
      this.updateState(id, JobState.STOPPED);
      this.clearTimers(id);
      entry.job.stop?.();
    }
  }

  listAll(): Array<{ id: string; state: JobState; options: JobOptions }> {
    const jobs: Array<{ id: string; state: JobState; options: JobOptions }> = [];
    this.jobs.forEach((entry, id) => {
      jobs.push({
        id,
        state: entry.context.state,
        options: entry.options,
      });
    });
    return jobs;
  }

  private createJobContext(id: string, options: JobOptions): JobContext {
    const now = new Date();

    return {
      id,
      options,
      state: JobState.SCHEDULED,
      createdAt: now,
      updatedAt: now,
      retryCount: 0,

      pause: () => this.pause(id),
      resume: () => this.resume(id),
      stop: () => this.stop(id),
      complete: () => this.updateState(id, JobState.COMPLETED),
      fail: (error: Error) => {
        this.updateState(id, JobState.FAILED);
        const entry = this.jobs.get(id);
        if (entry) entry.context.error = error;
      },
      retry: () => {
        const entry = this.jobs.get(id);
        if (entry) {
          entry.context.retryCount = (entry.context.retryCount || 0) + 1;
          this.updateState(id, JobState.SCHEDULED);
        }
      },

      isRunning: () => this.getContext(id)?.state === JobState.RUNNING,
      isPaused: () => this.getContext(id)?.state === JobState.PAUSED,
      isStopped: () => this.getContext(id)?.state === JobState.STOPPED,
      isCompleted: () => this.getContext(id)?.state === JobState.COMPLETED,
      isFailed: () => this.getContext(id)?.state === JobState.FAILED,
      isRetrying: () => (this.getContext(id)?.retryCount || 0) > 0,
      isScheduled: () => this.getContext(id)?.state === JobState.SCHEDULED,
      isDelayed: () => !!options.delay,
      isRecurring: () => !!options.cron || !!options.recurring,
      isCron: () => !!options.cron,
      isTimeout: () => !!options.delay && !options.cron && !options.recurring,
      isAlarm: () => !!options.cron || (!!options.delay && options.delay > 60000),
    };
  }
}
