/**
 * @fileoverview Scoping decides how much of a broadcast a given context has to
 * receive and clone, so what survives the filter — and what must survive it for
 * the receiver to stay in sync — is worth pinning.
 */

import { describe, expect, it } from 'vitest';
import { isStateDelta } from '../src/stateDelta';
import { filterDeltaToTopics, scopeMarkerTopic, sliceTopic } from '../src/topics';

const topics = (...names: string[]) => new Set(names);

const deltaOf = <T>(changed: Partial<T>, sequence: number, removed?: string[]) =>
  ({
    __chromaStateDelta: true as const,
    changed,
    ...(removed ? { removed } : {}),
    sequence,
  }) as never;

describe('filterDeltaToTopics', () => {
  it('keeps only the slices the port registered', () => {
    const delta = deltaOf({ wallets: { a: 1 }, subnets: { 1: 1 } }, 4);

    const scoped = filterDeltaToTopics(delta, 'app', topics(sliceTopic('app', 'wallets')));

    expect(scoped.changed).toEqual({ wallets: { a: 1 } });
  });

  it('preserves the sequence even when nothing relevant changed', () => {
    const delta = deltaOf({ subnets: { 1: 1 } }, 9);

    const scoped = filterDeltaToTopics(delta, 'app', topics(sliceTopic('app', 'wallets')));

    expect(scoped.changed).toEqual({});
    // A gap would make the receiver treat this as a missed broadcast and
    // refetch the entire state, which is what scoping exists to avoid.
    expect(scoped.sequence).toBe(9);
  });

  it('filters removals the same way', () => {
    const delta = deltaOf({}, 1, ['wallets', 'subnets']);

    const scoped = filterDeltaToTopics(delta, 'app', topics(sliceTopic('app', 'subnets')));

    expect(scoped.removed).toEqual(['subnets']);
  });

  it('stays recognizable as a delta after filtering', () => {
    const filtered = filterDeltaToTopics(
      deltaOf({ wallets: { a: 1 } }, 2),
      'app',
      topics(sliceTopic('app', 'wallets')),
    );

    // Losing the marker makes the receiver treat the payload as a whole state
    // and replace everything it holds with just the changed slices.
    expect(isStateDelta(filtered)).toBe(true);
  });

  it('namespaces topics per store', () => {
    expect(sliceTopic('app', 'wallets')).not.toBe(sliceTopic('other', 'wallets'));
    expect(scopeMarkerTopic('app')).not.toBe(scopeMarkerTopic('other'));
  });
});
