/**
 * @fileoverview A component must re-render when its own slice changes and stay
 * still when someone else's does. That is the whole payoff of structural
 * sharing, so it is asserted through the hook rather than the internals.
 */

import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { useCentralStore } from '../src/react';
import { shallow } from '../src/shallow';
import { replaceEqualDeep } from '../src/structuralShare';
import type { CentralStore } from '../src/types';

interface TestState extends Record<string, unknown> {
  wallets: { name: string };
  subnets: { price: number };
}

/**
 * Stands in for a bridge store: state arrives as a fresh object graph, and is
 * adopted through structural sharing exactly as `BridgeStore.applyState` does.
 */
function createMirrorStore() {
  const store = createStore<TestState>(() => ({
    wallets: { name: 'main' },
    subnets: { price: 1 },
  }));

  return {
    store: store as unknown as CentralStore<TestState>,
    receive(incoming: TestState) {
      store.setState(replaceEqualDeep(store.getState(), incoming), true);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useCentralStore', () => {
  it('does not re-render when an unrelated slice changes', () => {
    const mirror = createMirrorStore();
    const renderSpy = vi.fn();

    function WalletName() {
      const wallets = useCentralStore(mirror.store, (state) => state.wallets);
      renderSpy();
      return <span>{wallets.name}</span>;
    }

    render(<WalletName />);
    renderSpy.mockClear();

    act(() => {
      mirror.receive({ wallets: { name: 'main' }, subnets: { price: 2 } });
    });

    expect(renderSpy).not.toHaveBeenCalled();
  });

  it('re-renders when its own slice changes', () => {
    const mirror = createMirrorStore();
    const renderSpy = vi.fn();

    function WalletName() {
      const wallets = useCentralStore(mirror.store, (state) => state.wallets);
      renderSpy();
      return <span>{wallets.name}</span>;
    }

    const view = render(<WalletName />);
    renderSpy.mockClear();

    act(() => {
      mirror.receive({ wallets: { name: 'savings' }, subnets: { price: 1 } });
    });

    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(view.getByText('savings')).toBeTruthy();
  });

  it('holds a derived object steady when given a shallow comparison', () => {
    const mirror = createMirrorStore();
    const renderSpy = vi.fn();

    function Summary() {
      // A selector like this cannot return a stable reference on its own.
      const summary = useCentralStore(
        mirror.store,
        (state) => ({ name: state.wallets.name, price: state.subnets.price }),
        shallow,
      );
      renderSpy();
      return <span>{`${summary.name}:${summary.price}`}</span>;
    }

    const view = render(<Summary />);
    renderSpy.mockClear();

    act(() => {
      mirror.receive({ wallets: { name: 'main' }, subnets: { price: 1 } });
    });
    expect(renderSpy).not.toHaveBeenCalled();

    act(() => {
      mirror.receive({ wallets: { name: 'main' }, subnets: { price: 3 } });
    });
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(view.getByText('main:3')).toBeTruthy();
  });
});
