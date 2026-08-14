/**
 * @fileoverview Tests Chrome alarm failures that must not stop service-worker startup.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlarmAdapter } from '../src/scheduler/scheduler/adapters/AlarmAdapter';

const originalChrome = globalThis.chrome;

interface AlarmApiFixture {
  adapter: AlarmAdapter;
  clear: ReturnType<typeof vi.fn>;
  getAll: ReturnType<typeof vi.fn>;
  onAlarmAddListener: ReturnType<typeof vi.fn>;
}

const createAlarmApiFixture = (
  getAllImplementation: (
    callback: (alarms?: chrome.alarms.Alarm[]) => void,
  ) => void,
): AlarmApiFixture => {
  const clear = vi.fn((_name: string, callback?: () => void) => callback?.());
  const getAll = vi.fn(getAllImplementation);
  const onAlarmAddListener = vi.fn();

  (globalThis as typeof globalThis & { chrome: typeof chrome }).chrome = {
    alarms: {
      clear,
      create: vi.fn(),
      getAll,
      onAlarm: {
        addListener: onAlarmAddListener,
      },
    },
    runtime: {},
  } as unknown as typeof chrome;

  return {
    adapter: new AlarmAdapter(),
    clear,
    getAll,
    onAlarmAddListener,
  };
};

describe('AlarmAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.chrome = originalChrome;
  });

  it('starts when Chrome returns no alarm list', async () => {
    const fixture = createAlarmApiFixture((callback) => callback(undefined));

    await expect(fixture.adapter.ready).resolves.toBeUndefined();
    expect(fixture.onAlarmAddListener).toHaveBeenCalledOnce();
    expect(fixture.clear).not.toHaveBeenCalled();
  });

  it('starts when Chrome reports an alarm read error', async () => {
    const fixture = createAlarmApiFixture((callback) => {
      Object.defineProperty(chrome.runtime, 'lastError', {
        configurable: true,
        value: { message: 'The message port closed.' },
      });
      callback(undefined);
    });

    await expect(fixture.adapter.ready).resolves.toBeUndefined();
    expect(fixture.onAlarmAddListener).toHaveBeenCalledOnce();
  });

  it('clears only Chroma alarms', async () => {
    const fixture = createAlarmApiFixture((callback) =>
      callback([
        { name: 'chroma_job_balance' },
        { name: 'another_extension_alarm' },
      ] as chrome.alarms.Alarm[]),
    );

    await fixture.adapter.ready;

    expect(fixture.clear).toHaveBeenCalledOnce();
    expect(fixture.clear).toHaveBeenCalledWith('chroma_job_balance', expect.any(Function));
  });

  it('returns empty diagnostics when Chrome returns no alarm list', async () => {
    const fixture = createAlarmApiFixture((callback) => callback(undefined));
    await fixture.adapter.ready;

    await expect(fixture.adapter.getDiagnostics()).resolves.toMatchObject({
      chromeAlarms: [],
      trackedAlarms: 0,
      usingChromeApi: true,
    });
  });
});
