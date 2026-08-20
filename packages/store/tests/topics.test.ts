/**
 * @fileoverview Scoping decides how much of a broadcast a given context has to
 * receive and clone, so what survives the filter — and what must survive it for
 * the receiver to stay in sync — is worth pinning.
 */

import { describe, expect, it } from 'vitest';
import { filterDeltaToTopics, scopeMarkerTopic, sliceTopic } from '../src/topics';

const topics = (...names: string[]) => new Set(names);

describe('filterDeltaToTopics', () => {
  it('keeps only the slices the port registered', () => {
    const delta = {
      changed: { wallets: { a: 1 }, subnets: { 1: 1 } },
      sequence: 4,
    };

    const scoped = filterDeltaToTopics(delta, 'app', topics(sliceTopic('app', 'wallets')));

    expect(scoped.changed).toEqual({ wallets: { a: 1 } });
  });

  it('preserves the sequence even when nothing relevant changed', () => {
    const delta = { changed: { subnets: { 1: 1 } }, sequence: 9 };

    const scoped = filterDeltaToTopics(delta, 'app', topics(sliceTopic('app', 'wallets')));

    expect(scoped.changed).toEqual({});
    // A gap would make the receiver treat this as a missed broadcast and
    // refetch the entire state, which is what scoping exists to avoid.
    expect(scoped.sequence).toBe(9);
  });

  it('filters removals the same way', () => {
    const delta = { changed: {}, removed: ['wallets', 'subnets'], sequence: 1 };

    const scoped = filterDeltaToTopics(delta, 'app', topics(sliceTopic('app', 'subnets')));

    expect(scoped.removed).toEqual(['subnets']);
  });

  it('namespaces topics per store', () => {
    expect(sliceTopic('app', 'wallets')).not.toBe(sliceTopic('other', 'wallets'));
    expect(scopeMarkerTopic('app')).not.toBe(scopeMarkerTopic('other'));
  });
});
