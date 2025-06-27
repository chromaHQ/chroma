export interface SchedulerAdapter {
  schedule(id: string, when: number): void;
  clear(id: string): void;
  onTrigger(cb: (id: string) => void): void;
}
