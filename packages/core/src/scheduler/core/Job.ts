import { IJob, JobContext } from './IJob';

export abstract class Job<T = unknown> implements IJob<T> {
  constructor(public readonly data?: T) {}

  abstract handle(context?: JobContext): Promise<void> | void;

  pause?(): Promise<void> | void {
    console.log(`Job ${this.constructor.name} paused`);
  }

  resume?(): Promise<void> | void {
    console.log(`Job ${this.constructor.name} resumed`);
  }

  stop?(): Promise<void> | void {
    console.log(`Job ${this.constructor.name} stopped`);
  }
}
