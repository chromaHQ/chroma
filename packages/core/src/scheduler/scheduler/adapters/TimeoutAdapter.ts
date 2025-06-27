export class TimeoutAdapter {
  private callbacks = new Map<string, () => void>();

  onTrigger(callback: (id: string) => void): void {
    this.triggerCallback = callback;
  }

  private triggerCallback?: (id: string) => void;

  schedule(id: string, when: number): NodeJS.Timeout {
    const delay = Math.max(0, when - Date.now());

    const timeoutId = setTimeout(() => {
      this.callbacks.delete(id);
      this.triggerCallback?.(id);
    }, delay);

    this.callbacks.set(id, () => clearTimeout(timeoutId));
    return timeoutId;
  }

  cancel(id: string): void {
    const callback = this.callbacks.get(id);
    if (callback) {
      callback();
      this.callbacks.delete(id);
    }
  }
}
