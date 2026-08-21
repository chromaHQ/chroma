/**
 * @fileoverview The queue exists so two writes can never be in flight together.
 * Tested with plain promises rather than through the debounce and fake timers
 * that sit above it, so the property is proven rather than choreographed.
 */

import { describe, expect, it, vi } from 'vitest';
import { createSerialQueue } from '../src/serialQueue';

/** A task whose completion the test controls. */
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createSerialQueue', () => {
  it('does not start a task while another is running', async () => {
    const queue = createSerialQueue();
    const first = deferred();
    let secondStarted = false;

    queue.run(() => first.promise);
    queue.run(async () => {
      secondStarted = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(secondStarted).toBe(false);

    first.resolve();
    await queue.drain();
    expect(secondStarted).toBe(true);
  });

  it('runs tasks in submission order', async () => {
    const queue = createSerialQueue();
    const order: number[] = [];

    queue.run(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push(1);
    });
    queue.run(async () => {
      order.push(2);
    });
    await queue.run(async () => {
      order.push(3);
    });

    expect(order).toEqual([1, 2, 3]);
  });

  it('keeps going after a task fails, and reports it', async () => {
    const onError = vi.fn();
    const queue = createSerialQueue(onError);
    let ranAfter = false;

    queue.run(async () => {
      throw new Error('write did not land');
    });
    await queue.run(async () => {
      ranAfter = true;
    });

    // One failed write must not stop every write after it.
    expect(ranAfter).toBe(true);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('survives a reporter that throws', async () => {
    const queue = createSerialQueue(() => {
      throw new Error('reporter exploded');
    });
    let ranAfter = false;

    queue.run(async () => {
      throw new Error('write did not land');
    });
    await queue.run(async () => {
      ranAfter = true;
    });

    expect(ranAfter).toBe(true);
  });

  it('drains everything submitted so far', async () => {
    const queue = createSerialQueue();
    let done = 0;

    for (let i = 0; i < 5; i += 1) {
      queue.run(async () => {
        await new Promise((r) => setTimeout(r, 1));
        done += 1;
      });
    }

    await queue.drain();
    expect(done).toBe(5);
  });
});
