/**
 * @fileoverview The headroom check is what keeps a migration from starting in
 * the one situation where it cannot finish: a store already close enough to the
 * quota that a second copy will not fit.
 */

import { describe, expect, it } from 'vitest';
import { approximateBytes, hasHeadroomForMigration, QUOTA_HEADROOM } from '../src/storageLayout';

const QUOTA = 10 * 1024 * 1024;

describe('hasHeadroomForMigration', () => {
  it('allows a migration with room for both copies', () => {
    expect(hasHeadroomForMigration(1024, QUOTA, { a: 'small' })).toBe(true);
  });

  it('refuses when the second copy would not fit', () => {
    expect(hasHeadroomForMigration(QUOTA * 0.95, QUOTA, { a: 'x'.repeat(1000) })).toBe(false);
  });

  it('leaves headroom rather than filling the quota exactly', () => {
    const snapshot = { a: 'x'.repeat(1000) };
    const justUnderQuota = QUOTA - approximateBytes(snapshot) - 1;

    // Fits arithmetically, but leaves nothing for the state to grow into
    // between this check and the write.
    expect(hasHeadroomForMigration(justUnderQuota, QUOTA, snapshot)).toBe(false);
    expect(QUOTA_HEADROOM).toBeLessThan(1);
  });

  it('does not block when the runtime reports no quota', () => {
    expect(hasHeadroomForMigration(Number.MAX_SAFE_INTEGER, 0, { a: 1 })).toBe(true);
  });

  it('treats an unserializable snapshot as too big to double', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(hasHeadroomForMigration(0, QUOTA, circular)).toBe(false);
  });
});
