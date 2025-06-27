import type { Container } from 'inversify';

export interface BridgeOptions {
  /**
   * The Container to use for dependency-injection.
   * You can supply an alternate container for testing.
   */
  container: Container;

  /**
   * Port name used by UIs to connect to the background runtime.
   * Defaults to 'chroma-bridge' but can be any string.
   */
  portName?: string;
}
