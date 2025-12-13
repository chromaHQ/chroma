/**
 * ServiceWorkerHealth - Single source of truth for service worker health status.
 *
 * This module provides a centralized health monitoring system that:
 * 1. Monitors the service worker connection via the bridge
 * 2. Broadcasts status changes to all subscribers (bridge, store, UI)
 * 3. Provides a simple `isHealthy` boolean for UI components
 *
 * Usage:
 * ```tsx
 * // In your app root, wrap with ServiceWorkerHealthProvider:
 * <BridgeProvider>
 *   <ServiceWorkerHealthProvider>
 *     <App />
 *   </ServiceWorkerHealthProvider>
 * </BridgeProvider>
 *
 * // In any component, use the hook (optionally pass your store instance):
 * import { appStore } from './stores/app';
 * const { isHealthy, isRecovering } = useServiceWorkerHealth({ store: appStore });
 *
 * if (!isHealthy) {
 *   return <Spinner message="Reconnecting..." />;
 * }
 * ```
 */

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
  type FC,
} from 'react';
import { BridgeContext, type BridgeContextValue } from './BridgeProvider';
import type { StoreReadyMethods } from './hooks/useConnectionStatus';

// ============================================================================
// Types
// ============================================================================

export type HealthStatus = 'healthy' | 'unhealthy' | 'recovering' | 'unknown';

export interface ServiceWorkerHealthContextValue {
  /** Current health status */
  status: HealthStatus;
  /** Simple boolean: true when SW is connected and responsive */
  isHealthy: boolean;
  /** True when actively trying to reconnect */
  isRecovering: boolean;
  /** True during initial connection or recovery */
  isLoading: boolean;
  /** Timestamp of last successful ping (ms) */
  lastHealthyAt: number | null;
  /** Force a reconnection attempt */
  forceReconnect: () => void;
}

export interface ServiceWorkerHealthResult extends ServiceWorkerHealthContextValue {
  /** Optional readiness state for attached store */
  storeReady: boolean;
}

interface ServiceWorkerHealthProviderProps {
  children: ReactNode;
  /**
   * Optional callback when health status changes.
   * Useful for stores to listen and react (e.g., pause operations).
   */
  onHealthChange?: (status: HealthStatus, isHealthy: boolean) => void;
}

interface ServiceWorkerHealthOptions {
  store?: StoreReadyMethods;
}

const noopSubscribe = () => () => {};
const alwaysTrue = () => true;
const ssrFallback = () => false;

function useStoreReady(store?: StoreReadyMethods): boolean {
  return useSyncExternalStore(
    store?.onReady ?? noopSubscribe,
    store?.isReady ?? alwaysTrue,
    ssrFallback,
  );
}

// Global subscribers for non-React consumers (like BridgeStore)
type HealthSubscriber = (status: HealthStatus, isHealthy: boolean) => void;
const globalSubscribers = new Set<HealthSubscriber>();

// ============================================================================
// Global API for non-React consumers
// ============================================================================

/**
 * Subscribe to health status changes from outside React.
 * Returns an unsubscribe function.
 *
 * @example
 * ```ts
 * // In BridgeStore
 * const unsubscribe = subscribeToHealth((status, isHealthy) => {
 *   if (!isHealthy) {
 *     // Pause operations, show loading state
 *   } else {
 *     // Resume operations
 *   }
 * });
 * ```
 */
export function subscribeToHealth(callback: HealthSubscriber): () => void {
  globalSubscribers.add(callback);
  return () => {
    globalSubscribers.delete(callback);
  };
}

// Current health state (for synchronous access)
let currentHealthStatus: HealthStatus = 'unknown';
let currentIsHealthy = false;

/**
 * Get current health status synchronously.
 * Useful for non-React code that needs immediate access.
 */
export function getHealthStatus(): { status: HealthStatus; isHealthy: boolean } {
  return { status: currentHealthStatus, isHealthy: currentIsHealthy };
}

// Broadcast to all global subscribers
function broadcastHealthChange(status: HealthStatus, isHealthy: boolean): void {
  currentHealthStatus = status;
  currentIsHealthy = isHealthy;
  globalSubscribers.forEach((callback) => {
    try {
      callback(status, isHealthy);
    } catch (e) {
      console.error('[ServiceWorkerHealth] Subscriber error:', e);
    }
  });
}

// ============================================================================
// Context
// ============================================================================

const ServiceWorkerHealthContext = createContext<ServiceWorkerHealthContextValue | null>(null);

// Grace period configuration - don't surface unhealthy status immediately
const HEALTH_GRACE_PERIOD_MS = 3000;

// ============================================================================
// Provider
// ============================================================================

export const ServiceWorkerHealthProvider: FC<ServiceWorkerHealthProviderProps> = ({
  children,
  onHealthChange,
}) => {
  const bridgeContext = useContext(BridgeContext);
  const [lastHealthyAt, setLastHealthyAt] = useState<number | null>(null);
  const [unhealthyStartedAt, setUnhealthyStartedAt] = useState<number | null>(null);
  const [graceExpired, setGraceExpired] = useState(false);
  const graceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Extract primitive values to avoid unnecessary re-renders from context object changes
  const bridgeStatus = bridgeContext?.status;
  const isServiceWorkerAlive = bridgeContext?.isServiceWorkerAlive ?? false;

  // Derive raw health status from bridge context (using primitives for stable deps)
  const rawStatus = useMemo((): HealthStatus => {
    if (!bridgeStatus) return 'unknown';

    // Connected and SW responding = healthy
    if (bridgeStatus === 'connected' && isServiceWorkerAlive) {
      return 'healthy';
    }

    // Actively reconnecting
    if (bridgeStatus === 'reconnecting' || bridgeStatus === 'connecting') {
      return 'recovering';
    }

    // Connected but SW not responding, or disconnected/error
    return 'unhealthy';
  }, [bridgeStatus, isServiceWorkerAlive]);

  // Track when we become unhealthy and set up grace period
  useEffect(() => {
    if (rawStatus === 'healthy') {
      // Clear grace period when healthy
      setUnhealthyStartedAt(null);
      setGraceExpired(false);
      if (graceTimeoutRef.current) {
        clearTimeout(graceTimeoutRef.current);
        graceTimeoutRef.current = null;
      }
    } else if (rawStatus !== 'healthy' && !unhealthyStartedAt) {
      // Just became unhealthy - start grace period
      setUnhealthyStartedAt(Date.now());
      graceTimeoutRef.current = setTimeout(() => {
        setGraceExpired(true);
      }, HEALTH_GRACE_PERIOD_MS);
    }

    return () => {
      if (graceTimeoutRef.current) {
        clearTimeout(graceTimeoutRef.current);
      }
    };
  }, [rawStatus, unhealthyStartedAt]);

  // Optimistic health status - show healthy during brief reconnections
  // Only surface unhealthy/recovering after grace period expires
  const derivedStatus = useMemo((): HealthStatus => {
    if (rawStatus === 'healthy') return 'healthy';

    // During grace period, report as healthy (optimistic)
    // This prevents UI flicker during brief reconnections
    if (!graceExpired && lastHealthyAt) {
      return 'healthy';
    }

    return rawStatus;
  }, [rawStatus, graceExpired, lastHealthyAt]);

  const isHealthy = derivedStatus === 'healthy';
  const isRecovering = derivedStatus === 'recovering';
  const isLoading = derivedStatus === 'recovering' || derivedStatus === 'unknown';

  // Track last healthy timestamp
  useEffect(() => {
    if (rawStatus === 'healthy') {
      setLastHealthyAt(Date.now());
    }
  }, [rawStatus]);

  // Broadcast changes to global subscribers and callback
  useEffect(() => {
    broadcastHealthChange(derivedStatus, isHealthy);
    onHealthChange?.(derivedStatus, isHealthy);
  }, [derivedStatus, isHealthy, onHealthChange]);

  // Force reconnect function
  const forceReconnect = useCallback(() => {
    bridgeContext?.reconnect();
  }, [bridgeContext]);

  const value = useMemo(
    (): ServiceWorkerHealthContextValue => ({
      status: derivedStatus,
      isHealthy,
      isRecovering,
      isLoading,
      lastHealthyAt,
      forceReconnect,
    }),
    [derivedStatus, isHealthy, isRecovering, isLoading, lastHealthyAt, forceReconnect],
  );

  return (
    <ServiceWorkerHealthContext.Provider value={value}>
      {children}
    </ServiceWorkerHealthContext.Provider>
  );
};

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook to access service worker health status.
 *
 * @returns Health status object with `isHealthy` boolean
 * @throws Error if used outside ServiceWorkerHealthProvider
 *
 * @example
 * ```tsx
 * function App() {
 *   const { isHealthy, isRecovering } = useServiceWorkerHealth({ store: appStore });
 *
 *   if (!isHealthy) {
 *     return (
 *       <div className="loading-overlay">
 *         <Spinner />
 *         <p>{isRecovering ? 'Reconnecting...' : 'Connection lost'}</p>
 *       </div>
 *     );
 *   }
 *
 *   return <MainApp />;
 * }
 * ```
 */
export function useServiceWorkerHealth(
  options?: ServiceWorkerHealthOptions,
): ServiceWorkerHealthResult {
  const context = useContext(ServiceWorkerHealthContext);

  if (!context) {
    throw new Error(
      'useServiceWorkerHealth must be used within a ServiceWorkerHealthProvider. ' +
        'Wrap your app with <ServiceWorkerHealthProvider> inside <BridgeProvider>.',
    );
  }

  const storeReady = useStoreReady(options?.store);
  const combinedHealthy = context.isHealthy && (options?.store ? storeReady : true);
  const combinedLoading = context.isLoading || (options?.store ? !storeReady : false);

  return {
    ...context,
    isHealthy: combinedHealthy,
    isLoading: combinedLoading,
    storeReady,
  };
}

// ============================================================================
// Optional: Standalone hook that doesn't require provider (for simpler setups)
// ============================================================================

/**
 * Lightweight hook that directly consumes BridgeContext without needing
 * ServiceWorkerHealthProvider. Use this for simple cases where you don't
 * need the global subscription API.
 *
 * @example
 * ```tsx
 * function App() {
 *   const { isHealthy } = useServiceWorkerHealthSimple();
 *   if (!isHealthy) return <Spinner />;
 *   return <MainApp />;
 * }
 * ```
 */
export function useServiceWorkerHealthSimple(options?: ServiceWorkerHealthOptions): {
  isHealthy: boolean;
  isRecovering: boolean;
  isLoading: boolean;
  reconnect: () => void;
  storeReady: boolean;
} {
  const bridgeContext = useContext(BridgeContext);
  const storeReady = useStoreReady(options?.store);

  const isHealthy =
    bridgeContext?.status === 'connected' &&
    bridgeContext?.isServiceWorkerAlive === true &&
    (options?.store ? storeReady : true);

  const isRecovering =
    bridgeContext?.status === 'reconnecting' || bridgeContext?.status === 'connecting';

  const isLoading =
    (!isHealthy && (isRecovering || !bridgeContext)) || (options?.store ? !storeReady : false);

  const reconnect = useCallback(() => {
    bridgeContext?.reconnect();
  }, [bridgeContext]);

  return { isHealthy, isRecovering, isLoading, reconnect, storeReady };
}
