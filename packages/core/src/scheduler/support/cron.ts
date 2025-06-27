import { parseCronExpression } from 'cron-schedule';

export function getNextCronDate(expr: string): Date {
  try {
    const interval = parseCronExpression(expr);
    return interval.getNextDate();
  } catch (error) {
    console.error('Invalid cron expression:', expr, error);
    throw new Error('Invalid cron expression');
  }
}
