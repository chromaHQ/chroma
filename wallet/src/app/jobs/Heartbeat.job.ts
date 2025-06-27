import { Job, type JobContext } from '@chroma/core';
import { Every } from '@chroma/core';

import type BalanceService from '../services/balance.service';

@Every('*/20 * * * * *') // Every 20 seconds
export default class Heartbeat implements Job {
  constructor(private readonly balanceService: BalanceService) {}

  handle(job: JobContext): void {
    console.log('[Heartbeat] Running heartbeat job', this.balanceService);
    console.log('[Heartbeat] Tick at', new Date().toISOString());
    job.pause();
  }
}
