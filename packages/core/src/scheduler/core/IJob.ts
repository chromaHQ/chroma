import { JobOptions } from './JobOptions';

export interface IJob<T = unknown> {
  readonly data?: T;
  handle(context?: JobContext): Promise<void> | void;
  pause?(): Promise<void> | void;
  resume?(): Promise<void> | void;
  stop?(): Promise<void> | void;
}

export enum JobState {
  SCHEDULED = 'scheduled',
  RUNNING = 'running',
  PAUSED = 'paused',
  STOPPED = 'stopped',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export interface JobContext {
  id: string;
  options?: JobOptions;
  state: JobState;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  pausedAt?: Date;
  stoppedAt?: Date;
  completedAt?: Date;
  error?: Error;
  retryCount?: number;

  /**
   *  Pause the job execution.
   * @returns Promise<void> | void
   */
  pause: () => Promise<void> | void;
  resume: () => Promise<void> | void;
  stop: () => Promise<void> | void;
  complete: () => Promise<void> | void;
  fail: (error: Error) => Promise<void> | void;
  retry: () => Promise<void> | void;

  isRunning: () => boolean;
  isPaused: () => boolean;
  isStopped: () => boolean;
  isCompleted: () => boolean;
  isFailed: () => boolean;
  isRetrying: () => boolean;
  isScheduled: () => boolean;
  isDelayed: () => boolean;
  isRecurring: () => boolean;
  isCron: () => boolean;
  isTimeout: () => boolean;
  isAlarm: () => boolean;
}
