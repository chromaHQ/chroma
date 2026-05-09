import { IJob, JobContext } from './IJob';

export abstract class Job<T = unknown> implements IJob<T> {
  constructor(public readonly data?: T) {}

  abstract handle(context?: JobContext): Promise<void> | void;

  pause?(): Promise<void> | void {}

  resume?(): Promise<void> | void {}

  stop?(): Promise<void> | void {}
}
