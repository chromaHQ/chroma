export class AlarmAdapter {
  private callbacks = new Map<string, () => void>();

  onTrigger(callback: (id: string) => void): void {
    this.triggerCallback = callback;
  }

  private triggerCallback?: (id: string) => void;

  schedule(id: string, when: number): NodeJS.Timeout {
    // Cancel any existing alarm for this id to prevent leaks
    this.cancel(id);

    const delay = Math.max(0, when - Date.now());

    // For alarms, we'll use setTimeout as well but could be extended for other mechanisms
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

  /**
   * Get the number of active alarms (for debugging/monitoring)
   */
  size(): number {
    return this.callbacks.size;
  }

  /**
   * Clear all alarms (for shutdown)
   */
  clear(): void {
    for (const callback of this.callbacks.values()) {
      callback();
    }
    this.callbacks.clear();
  }
}
