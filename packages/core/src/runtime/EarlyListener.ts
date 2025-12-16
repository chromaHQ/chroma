/**
 * @fileoverview Early Connection Listener for Chrome Extension Service Workers.
 *
 * This module captures port connections as early as possible during service worker
 * bootstrap, before the full BridgeRuntime is initialized. This prevents lost
 * connections when the popup opens before the SW has finished bootstrapping.
 *
 * Usage:
 * 1. Import and call `setupEarlyListener()` at the very top of your SW entry point
 * 2. Call `getEarlyPorts()` when BridgeRuntime initializes to wire up captured ports
 *
 * @module @chromahq/core/runtime/EarlyListener
 */

const DEFAULT_PORT_NAME = 'chroma-bridge';

/** Ports captured before BridgeRuntime was ready */
const earlyPorts: chrome.runtime.Port[] = [];

/** Whether the early listener has been set up */
let listenerSetup = false;

/** Whether BridgeRuntime has claimed the early ports */
let portsClaimed = false;

/** Callback to invoke when a new port connects (after BridgeRuntime is ready) */
let onPortConnectCallback: ((port: chrome.runtime.Port) => void) | null = null;

/**
 * Sets up an early connection listener to capture ports before BridgeRuntime is ready.
 *
 * Call this at the very top of your service worker entry point, before any async work.
 * This ensures connections aren't lost during bootstrap.
 *
 * @param portName - The port name to listen for (defaults to 'chroma-bridge')
 *
 * @example
 * ```typescript
 * // At the top of your service worker (before any await):
 * import { setupEarlyListener } from '@chromahq/core';
 *
 * setupEarlyListener('chroma-bridge');
 *
 * // Later, during bootstrap:
 * const runtime = bootstrap({ ... });
 * ```
 */
export function setupEarlyListener(portName: string = DEFAULT_PORT_NAME): void {
  if (listenerSetup) {
    return; // Already set up
  }

  listenerSetup = true;

  // Register listener immediately - this is synchronous and captures all connections
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== portName) {
      return; // Ignore ports with different names
    }

    if (portsClaimed && onPortConnectCallback) {
      // BridgeRuntime is ready, pass directly to it
      onPortConnectCallback(port);
    } else {
      // BridgeRuntime not ready yet, queue the port
      console.log(`[EarlyListener] Captured early port connection: ${port.name}`);
      earlyPorts.push(port);
    }
  });

  console.log(`[EarlyListener] Early connection listener registered for port: ${portName}`);
}

/**
 * Gets all ports captured before BridgeRuntime was ready.
 *
 * Call this once when BridgeRuntime initializes. After calling, new connections
 * will go directly to the provided callback.
 *
 * @param onConnect - Callback to invoke for future port connections
 * @returns Array of ports captured during bootstrap
 *
 * @example
 * ```typescript
 * // In BridgeRuntime.initialize():
 * const earlyPorts = claimEarlyPorts((port) => this.setupMessageHandler(port));
 * earlyPorts.forEach((port) => this.setupMessageHandler(port));
 * ```
 */
export function claimEarlyPorts(
  onConnect: (port: chrome.runtime.Port) => void,
): chrome.runtime.Port[] {
  if (portsClaimed) {
    console.warn('[EarlyListener] Ports already claimed, returning empty array');
    return [];
  }

  portsClaimed = true;
  onPortConnectCallback = onConnect;

  const captured = [...earlyPorts];
  earlyPorts.length = 0; // Clear the array

  if (captured.length > 0) {
    console.log(`[EarlyListener] Claimed ${captured.length} early port(s)`);
  }

  return captured;
}

/**
 * Check if the early listener has been set up.
 */
export function isEarlyListenerSetup(): boolean {
  return listenerSetup;
}

/**
 * Check if early ports have been claimed by BridgeRuntime.
 */
export function arePortsClaimed(): boolean {
  return portsClaimed;
}
