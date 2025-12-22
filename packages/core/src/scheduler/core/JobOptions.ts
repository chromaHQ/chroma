export interface JobOptions {
  id?: string;
  delay?: number;
  cron?: string;
  persistent?: boolean;
  recurring?: boolean; // For second-based intervals using delay
  startPaused?: boolean; // If true, job starts paused and must be resumed manually
}
