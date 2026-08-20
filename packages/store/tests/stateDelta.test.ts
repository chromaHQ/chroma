/**
 * @fileoverview Deltas keep a broadcast proportional to what changed rather than
 * to the size of the whole store.
 */

import { describe, expect, it } from 'vitest';
import { applyStateDelta, createStateDelta, isStateDelta } from '../src/stateDelta';

describe('createStateDelta', () => {
  it('sends the whole state when there is no previous broadcast', () => {
    const delta = createStateDelta(null, { a: 1, b: 2 }, 0);

    expect(delta).not.toBeNull();
    expect(delta!.changed).toEqual({ a: 1, b: 2 });
  });

  it('includes only the keys whose identity changed', () => {
    const wallets = { a: 1 };
    const previous = { wallets, subnets: { 1: 1 } };
    const next = { wallets, subnets: { 1: 2 } };

    const delta = createStateDelta(previous, next, 1);

    expect(Object.keys(delta!.changed)).toEqual(['subnets']);
  });

  it('returns null when nothing changed, so no broadcast is sent', () => {
    const state = { a: {} };
    expect(createStateDelta(state, { ...state }, 1)).toBeNull();
  });

  it('reports removed keys', () => {
    const delta = createStateDelta({ a: 1, b: 2 }, { a: 1 }, 1);
    expect(delta!.removed).toEqual(['b']);
  });
});

describe('applyStateDelta', () => {
  it('merges changed keys onto the current state', () => {
    const current = { a: 1, b: 2 };
    const delta = createStateDelta({ a: 1, b: 9 }, { a: 1, b: 2 }, 1)!;

    expect(applyStateDelta(current, delta)).toEqual({ a: 1, b: 2 });
  });

  it('drops removed keys', () => {
    const delta = createStateDelta({ a: 1, b: 2 }, { a: 1 }, 1)!;
    expect(applyStateDelta({ a: 1, b: 2 }, delta)).toEqual({ a: 1 });
  });

  it('recognizes its own payloads and rejects plain state objects', () => {
    expect(isStateDelta(createStateDelta(null, { a: 1 }, 0))).toBe(true);
    expect(isStateDelta({ a: 1 })).toBe(false);
    expect(isStateDelta(null)).toBe(false);
  });
});
