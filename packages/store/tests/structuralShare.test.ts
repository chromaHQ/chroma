/**
 * @fileoverview Structural sharing is what keeps selectors from re-rendering on
 * state that arrived over the bridge but did not actually change.
 */

import { describe, expect, it } from 'vitest';
import { replaceEqualDeep } from '../src/structuralShare';

describe('replaceEqualDeep', () => {
  it('returns the held value when the incoming one is deeply equal', () => {
    const held = { wallets: { a: { balance: '1' } } };
    const incoming = { wallets: { a: { balance: '1' } } };

    expect(replaceEqualDeep(held, incoming)).toBe(held);
  });

  it('keeps references for branches that did not change', () => {
    const held = { wallets: { a: 1 }, subnets: { 1: { price: 1 } } };
    const incoming = { wallets: { a: 1 }, subnets: { 1: { price: 2 } } };

    const merged = replaceEqualDeep(held, incoming);

    expect(merged).not.toBe(held);
    expect(merged.wallets).toBe(held.wallets);
    expect(merged.subnets).not.toBe(held.subnets);
    expect(merged.subnets[1].price).toBe(2);
  });

  it('reuses unchanged array elements', () => {
    const held = { rows: [{ id: 1 }, { id: 2 }] };
    const incoming = { rows: [{ id: 1 }, { id: 3 }] };

    const merged = replaceEqualDeep(held, incoming);

    expect(merged.rows[0]).toBe(held.rows[0]);
    expect(merged.rows[1]).not.toBe(held.rows[1]);
  });

  it('detects added and removed keys', () => {
    const held = { a: 1, b: 2 };

    expect(replaceEqualDeep(held, { a: 1 })).toEqual({ a: 1 });
    expect(replaceEqualDeep(held, { a: 1, b: 2, c: 3 })).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('compares Sets, Maps and Dates by value', () => {
    const heldSet = new Set(['a', 'b']);
    expect(replaceEqualDeep(heldSet, new Set(['b', 'a']))).toBe(heldSet);
    expect(replaceEqualDeep(heldSet, new Set(['a']))).not.toBe(heldSet);

    const heldMap = new Map([['a', { v: 1 }]]);
    expect(replaceEqualDeep(heldMap, new Map([['a', { v: 1 }]]))).toBe(heldMap);

    const heldDate = new Date(0);
    expect(replaceEqualDeep(heldDate, new Date(0))).toBe(heldDate);
  });

  it('does not walk into class instances', () => {
    class Wallet {
      constructor(public id: string) {}
    }

    const held = new Wallet('a');
    const incoming = new Wallet('a');

    // Reusing `held` would hand back an object the producer no longer owns.
    expect(replaceEqualDeep(held, incoming)).toBe(incoming);
  });
});
