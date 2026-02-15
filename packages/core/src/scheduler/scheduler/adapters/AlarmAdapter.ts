/**
 * Alarm Adapter for scheduling jobs using Chrome Alarms API
 *
 * Chrome Alarms API benefits for Service Workers:
 * - Alarms survive SW termination and wake it up when they fire
 * - Browser manages them independently of JS event loop
 * - More reliable for periodic tasks than setTimeout/setInterval
 *
 * Limitations:
 * - Minimum granularity is ~1 minute (delayInMinutes must be >= 0.5 in dev, >= 1 in prod)
 * - Falls back to setTimeout if Chrome Alarms API is unavailable
 */
export class AlarmAdapter {
  private static readonly ALARM_PREFIX = 'chroma_job_';
  private callbacks = new Map<string, () => void>();
  private listenerRegistered = false;
  private triggerCallback?: (id: string) => void;

  /** Resolves when stale alarms from previous SW instances have been cleared */
  public readonly ready: Promise<void>;

  constructor() {
    this.ready = this.initializeAlarmListener();
  }

  /**
   * Initialize the Chrome Alarms listener (once)
   */
  private initializeAlarmListener = async (): Promise<void> => {
    if (this.listenerRegistered) return;

    if (this.isChromeAlarmsAvailable()) {
      // Clear any stale alarms from previous SW instances BEFORE registering listener
      await this.clearStaleAlarms();

      chrome.alarms.onAlarm.addListener(this.handleAlarm);
      this.listenerRegistered = true;
      console.log('[AlarmAdapter] ✅ Chrome Alarms API available and listener registered');
    } else {
      console.log(
        '[AlarmAdapter] ⚠️ Chrome Alarms API not available - will use setTimeout fallback',
      );
    }
  };

  /**
   * Clear any stale chroma alarms from previous SW instances.
   * Returns a promise that resolves once all stale alarms are cleared.
   */
  private clearStaleAlarms = (): Promise<void> => {
    if (!this.isChromeAlarmsAvailable()) return Promise.resolve();

    return new Promise<void>((resolve) => {
      chrome.alarms.getAll((alarms) => {
        const staleAlarms = alarms.filter((a) => a.name.startsWith(AlarmAdapter.ALARM_PREFIX));
        if (staleAlarms.length > 0) {
          console.log(
            `[AlarmAdapter] 🧹 Clearing ${staleAlarms.length} stale alarms from previous session`,
          );
          let cleared = 0;
          staleAlarms.forEach((alarm) => {
            chrome.alarms.clear(alarm.name, () => {
              cleared++;
              if (cleared === staleAlarms.length) {
                resolve();
              }
            });
          });
        } else {
          resolve();
        }
      });
    });
  };

  /**
   * Check if Chrome Alarms API is available
   */
  private isChromeAlarmsAvailable = (): boolean => {
    return !!(
      typeof chrome !== 'undefined' &&
      chrome.alarms &&
      typeof chrome.alarms.create === 'function' &&
      typeof chrome.alarms.clear === 'function' &&
      chrome.alarms.onAlarm?.addListener
    );
  };

  /**
   * Handle alarm trigger from Chrome
   */
  private handleAlarm = (alarm: chrome.alarms.Alarm): void => {
    // Only handle our alarms (prefixed)
    if (!alarm.name.startsWith(AlarmAdapter.ALARM_PREFIX)) {
      return;
    }

    const jobId = alarm.name.slice(AlarmAdapter.ALARM_PREFIX.length);
    console.log(`[AlarmAdapter] 🔔 Chrome Alarm fired: ${jobId}`);
    this.callbacks.delete(jobId);
    this.triggerCallback?.(jobId);
  };

  onTrigger = (callback: (id: string) => void): void => {
    this.triggerCallback = callback;
  };

  schedule = (id: string, when: number): NodeJS.Timeout | null => {
    // Cancel any existing alarm for this id to prevent leaks
    this.cancel(id);

    const delay = Math.max(0, when - Date.now());
    const delayInMinutes = delay / 60000;

    // Use Chrome Alarms API if available and delay is at least 30 seconds
    // Chrome requires minimum ~0.5 minutes in dev, 1 minute in production
    if (this.isChromeAlarmsAvailable() && delayInMinutes >= 0.5) {
      const alarmName = `${AlarmAdapter.ALARM_PREFIX}${id}`;

      chrome.alarms.create(alarmName, {
        when,
      });

      console.log(
        `[AlarmAdapter] ⏰ Chrome Alarm scheduled: ${id} in ${Math.round(delay / 1000)}s`,
      );

      // Store a no-op callback just to track active alarms
      this.callbacks.set(id, () => {
        chrome.alarms.clear(alarmName);
      });

      return null; // No timeout ID for Chrome alarms
    }

    console.log(
      `[AlarmAdapter] ⏱️ setTimeout fallback: ${id} in ${Math.round(delay / 1000)}s (Chrome Alarms: ${this.isChromeAlarmsAvailable() ? 'available but delay too short' : 'unavailable'})`,
    );

    // Fall back to setTimeout for very short delays or if Chrome Alarms unavailable
    const timeoutId = setTimeout(() => {
      this.callbacks.delete(id);
      this.triggerCallback?.(id);
    }, delay);

    this.callbacks.set(id, () => clearTimeout(timeoutId));
    return timeoutId;
  };

  cancel = (id: string): void => {
    const callback = this.callbacks.get(id);
    if (callback) {
      callback();
      this.callbacks.delete(id);
    }

    // Also try to clear Chrome alarm directly (in case callback wasn't set)
    if (this.isChromeAlarmsAvailable()) {
      const alarmName = `${AlarmAdapter.ALARM_PREFIX}${id}`;
      chrome.alarms.clear(alarmName);
    }
  };

  /**
   * Get the number of active alarms (for debugging/monitoring)
   */
  size = (): number => {
    return this.callbacks.size;
  };

  /**
   * Clear all alarms (for shutdown)
   */
  clear = (): void => {
    for (const [id, callback] of this.callbacks.entries()) {
      callback();
    }
    this.callbacks.clear();

    // Clear all Chrome alarms with our prefix
    if (this.isChromeAlarmsAvailable()) {
      chrome.alarms.getAll((alarms) => {
        for (const alarm of alarms) {
          if (alarm.name.startsWith(AlarmAdapter.ALARM_PREFIX)) {
            chrome.alarms.clear(alarm.name);
          }
        }
      });
    }
  };

  /**
   * Get diagnostic info about active alarms
   */
  getDiagnostics = async (): Promise<{
    trackedAlarms: number;
    chromeAlarms: chrome.alarms.Alarm[];
    usingChromeApi: boolean;
  }> => {
    const chromeAlarms: chrome.alarms.Alarm[] = [];

    if (this.isChromeAlarmsAvailable()) {
      await new Promise<void>((resolve) => {
        chrome.alarms.getAll((alarms) => {
          chromeAlarms.push(...alarms.filter((a) => a.name.startsWith(AlarmAdapter.ALARM_PREFIX)));
          resolve();
        });
      });
    }

    return {
      trackedAlarms: this.callbacks.size,
      chromeAlarms,
      usingChromeApi: this.isChromeAlarmsAvailable(),
    };
  };
}
