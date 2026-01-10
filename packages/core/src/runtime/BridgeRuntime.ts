import type { Container } from '@inversifyjs/container';
import { MiddlewareFn, MiddlewareRegistry } from '../internal/MiddlewareRegistry';
import { DEFAULT_PORT_NAME } from '../internal/constants';
import { getNonceService, type CriticalPayload } from '../services/NonceService';
import { PopupVisibilityService } from '../services/PopupVisibilityService';
import { claimEarlyPorts, isEarlyListenerSetup } from './EarlyListener';

const DIRECT_MESSAGE_FLAG = '__CHROMA_BRIDGE_DIRECT_MESSAGE__' as const;

interface BridgeRuntimeDiagnosticsInternal {
  keepAliveIntervalPings: number;
  lastKeepAliveIntervalAt?: number;
  alarmPings: number;
  lastAlarmPingAt?: number;
  portDisconnects: number;
  lastPortDisconnectAt?: number;
  lastPortDisconnectError?: string;
  directMessageRequests: number;
  directMessageErrors: number;
}

interface BridgeRuntimeDiagnostics extends BridgeRuntimeDiagnosticsInternal {
  connectedPorts: number;
}

/**
 * Configuration options for the Bridge Runtime
 */
interface BridgeRuntimeOptions {
  readonly container: Container;
  readonly portName?: string;
  readonly enableLogging?: boolean;
  readonly errorHandler?: ErrorHandler;
  readonly keepAlive?: boolean; // If true, keep service worker alive
}

/**
 * Message request structure for bridge communication
 */
interface BridgeRequest {
  readonly id: string;
  readonly key: string;
  readonly payload: unknown;
  readonly metadata?: Record<string, any>;
  readonly [DIRECT_MESSAGE_FLAG]?: true;
}

/**
 * Broadcast message structure for event communication
 */
interface BroadcastMessage {
  readonly type: 'broadcast';
  readonly key: string;
  readonly payload: unknown;
  readonly metadata?: Record<string, any>;
}

/**
 * Message response structure for bridge communication
 */
interface BridgeResponse {
  readonly id: string;
  readonly data?: unknown;
  readonly error?: string;
  readonly timestamp?: number;
}

/**
 * Handler interface for message processing
 */
interface MessageHandler {
  handle(payload: unknown): Promise<unknown>;
}

/**
 * Pipeline execution context
 */
interface PipelineContext {
  readonly request: BridgeRequest;
  readonly startTime: number;
  metadata: Record<string, any>;
}

/**
 * Error handler interface for custom error processing
 */
interface ErrorHandler {
  handle(error: Error, context: PipelineContext): Promise<BridgeResponse> | BridgeResponse;
}

/**
 * Default error handler implementation
 */
class DefaultErrorHandler implements ErrorHandler {
  handle(error: Error, context: PipelineContext): BridgeResponse {
    return {
      id: context.request.id,
      error: error?.message ?? 'UNKNOWN_ERROR',
      timestamp: Date.now(),
    };
  }
}

/**
 * Elegant Bridge Runtime Manager
 * Handles Chrome extension message bridge with middleware pipeline support
 */
class BridgeRuntimeManager {
  private readonly container: Container;
  private readonly portName: string;
  private readonly enableLogging: boolean;
  private readonly errorHandler: ErrorHandler;
  private readonly logger: BridgeLogger;
  private readonly keepAlive: boolean;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly KEEP_ALIVE_INTERVAL_MS = 50000; // 50 seconds (increased from 25s to reduce wake-ups)
  private static readonly KEEP_ALIVE_ALARM_NAME = 'chroma-bridge-keep-alive';
  private static readonly KEEP_ALIVE_ALARM_PERIOD_MINUTES = 1;
  private isInitialized = false;
  private connectedPorts = new Set<chrome.runtime.Port>();
  private keepAliveAlarmRegistered = false;
  private readonly diagnostics: BridgeRuntimeDiagnosticsInternal = {
    keepAliveIntervalPings: 0,
    alarmPings: 0,
    portDisconnects: 0,
    directMessageRequests: 0,
    directMessageErrors: 0,
  };

  constructor(options: BridgeRuntimeOptions) {
    this.container = options.container;
    this.portName = options.portName ?? DEFAULT_PORT_NAME;
    this.enableLogging = options.enableLogging ?? false;
    this.errorHandler = options.errorHandler ?? new DefaultErrorHandler();
    this.logger = new BridgeLogger(this.enableLogging);
    this.keepAlive = options.keepAlive ?? false;
  }

  /**
   * Initialize the bridge runtime and start listening for connections
   */
  public initialize(): void {
    if (this.isInitialized) {
      this.logger.warn('Bridge runtime already initialized');
      return;
    }

    this.setupPortListener();
    this.setupDirectMessageListener();
    this.initializeKeepAliveAlarm();

    // Note: keep-alive is started dynamically when first port connects
    // and stopped when all ports disconnect (see setupMessageHandler)

    this.isInitialized = true;
  }

  /**
   * Setup Chrome runtime port listener.
   *
   * If early listener was set up (via setupEarlyListener), this will claim
   * any ports captured during bootstrap and wire them up.
   */
  private setupPortListener(): void {
    // Handler for incoming port connections
    const handlePort = (port: chrome.runtime.Port) => {
      try {
        if (!this.isValidPort(port)) {
          return;
        }

        this.logger.info(`📡 Port connected: ${port.name}`);
        this.setupMessageHandler(port);

        if (chrome.runtime.lastError) {
          this.logger.warn(`Runtime error during port setup: ${chrome.runtime.lastError.message}`);
          chrome.runtime.lastError;
        }
      } catch (error) {
        this.logger.error('Error setting up port listener:', error);

        if (chrome.runtime.lastError) {
          this.logger.warn(`Additional runtime error: ${chrome.runtime.lastError.message}`);
          chrome.runtime.lastError;
        }
      }
    };

    // Check if early listener was set up - if so, claim captured ports
    if (isEarlyListenerSetup()) {
      const earlyPorts = claimEarlyPorts(handlePort);
      if (earlyPorts.length > 0) {
        this.logger.info(
          `📡 Processing ${earlyPorts.length} early port(s) captured during bootstrap`,
        );
        earlyPorts.forEach(handlePort);
      }
      // Future connections will go through handlePort via claimEarlyPorts callback
    } else {
      // No early listener - set up our own listener (backwards compatible)
      chrome.runtime.onConnect.addListener(handlePort);
    }
  }

  private setupDirectMessageListener(): void {
    if (!chrome?.runtime?.onMessage?.addListener) {
      this.logger.warn('Chrome runtime messaging unavailable; skipping direct message listener');
      return;
    }

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!this.isDirectBridgeMessage(message)) {
        return false;
      }

      const request = message as BridgeRequest;
      this.logger.debug('📮 Direct bridge message received:', {
        key: request.key,
        hasPayload: !!request.payload,
      });

      this.diagnostics.directMessageRequests++;

      const context = this.createPipelineContext(request);
      this.processMessage(context)
        .then((response) => {
          sendResponse(response);
        })
        .catch(async (error) => {
          this.diagnostics.directMessageErrors++;
          const errResponse = await this.handleError(error as Error, context);
          sendResponse(errResponse);
        });

      return true;
    });
  }

  private isDirectBridgeMessage(message: unknown): message is BridgeRequest {
    if (!message || typeof message !== 'object') {
      return false;
    }
    return (message as BridgeRequest)[DIRECT_MESSAGE_FLAG] === true;
  }

  private initializeKeepAliveAlarm(): void {
    if (!this.keepAlive || this.keepAliveAlarmRegistered) {
      return;
    }

    if (!chrome?.alarms?.create || !chrome.alarms.onAlarm?.addListener) {
      this.logger.warn('Chrome alarms API unavailable; keep-alive alarm disabled');
      return;
    }

    chrome.alarms.create(BridgeRuntimeManager.KEEP_ALIVE_ALARM_NAME, {
      periodInMinutes: BridgeRuntimeManager.KEEP_ALIVE_ALARM_PERIOD_MINUTES,
    });

    chrome.alarms.onAlarm.addListener(this.handleKeepAliveAlarm);
    this.keepAliveAlarmRegistered = true;
    this.logger.info('Registered keep-alive alarm for background wakeups');
  }

  private handleKeepAliveAlarm = (alarm: chrome.alarms.Alarm): void => {
    if (alarm.name !== BridgeRuntimeManager.KEEP_ALIVE_ALARM_NAME) {
      return;
    }

    chrome.runtime.getPlatformInfo(() => {
      this.recordKeepAlivePing('alarm');

      if (chrome.runtime.lastError) {
        this.logger.warn(
          `Chrome runtime error during keep-alive alarm: ${chrome.runtime.lastError.message}`,
        );
        chrome.runtime.lastError;
      }
    });
  };

  private recordKeepAlivePing(source: 'interval' | 'alarm'): void {
    const timestamp = Date.now();
    if (source === 'interval') {
      this.diagnostics.keepAliveIntervalPings++;
      this.diagnostics.lastKeepAliveIntervalAt = timestamp;
    } else {
      this.diagnostics.alarmPings++;
      this.diagnostics.lastAlarmPingAt = timestamp;
    }
  }

  /**
   * Validate incoming port connection
   */
  private isValidPort(port: chrome.runtime.Port): boolean {
    if (port.name !== this.portName) {
      this.logger.warn(`Ignoring port "${port.name}", expected "${this.portName}"`);
      return false;
    }
    const senderId = port.sender?.id;

    if (senderId !== chrome.runtime.id) {
      this.logger.warn(
        `Ignoring port from different extension (senderId: ${senderId}, expected: ${chrome.runtime.id})`,
      );

      return false;
    }

    return true;
  }

  /**
   * Setup message handler for connected port
   */
  private setupMessageHandler(port: chrome.runtime.Port): void {
    // Track connected ports for broadcasting
    this.connectedPorts.add(port);

    // Notify PopupVisibilityService that a port connected
    PopupVisibilityService.instance.onPortConnected();

    // Start keep-alive when first port connects
    if (this.keepAlive && this.connectedPorts.size === 1) {
      this.startKeepAlive();
    }

    port.onMessage.addListener(async (message: BridgeRequest | BroadcastMessage) => {
      try {
        // Handle broadcast messages
        if ('type' in message && message.type === 'broadcast') {
          this.logger.debug('📡 Received broadcast:', {
            key: message.key,
            hasPayload: !!message.payload,
          });

          this.handleBroadcast(message, port);
          return;
        }

        // Handle regular request/response messages
        const request = message as BridgeRequest;
        const context = this.createPipelineContext(request);

        this.logger.debug('📨 Received message:', {
          key: request.key,
          id: request.id,
          hasPayload: !!request.payload,
        });

        const response = await this.processMessage(context, port);
        this.sendResponse(port, response);
      } catch (error) {
        // Only send error response for regular requests, not broadcasts
        if (!('type' in message)) {
          const request = message as BridgeRequest;
          const context = this.createPipelineContext(request);
          const errorResponse = await this.handleError(error as Error, context);
          this.sendResponse(port, errorResponse);
        } else {
          this.logger.error('Error handling broadcast:', error);
        }
      }
    });

    port.onDisconnect.addListener(() => {
      // Remove from connected ports
      this.connectedPorts.delete(port);

      // Notify PopupVisibilityService that a port disconnected
      PopupVisibilityService.instance.onPortDisconnected();

      const runtimeErrorMessage = chrome.runtime.lastError?.message;

      if (runtimeErrorMessage) {
        this.logger.warn(`📴 Port disconnected with error: ${runtimeErrorMessage}`);
        void chrome.runtime.lastError;
        this.diagnostics.lastPortDisconnectError = runtimeErrorMessage;
      } else {
        this.logger.info(`📴 Port disconnected: ${port.name}`);
      }

      this.diagnostics.portDisconnects++;
      this.diagnostics.lastPortDisconnectAt = Date.now();

      // Stop keep-alive if no more connected ports (allow SW to sleep)
      if (this.keepAlive && this.connectedPorts.size === 0) {
        this.stopKeepAlive();
      }
    });
  }

  /**
   * Create pipeline context for request processing
   */
  private createPipelineContext(request: BridgeRequest): PipelineContext {
    return {
      request,
      startTime: Date.now(),
      metadata: { ...request.metadata },
    };
  }

  /**
   * Process message through middleware pipeline and handler
   */
  private async processMessage(
    context: PipelineContext,
    senderPort?: chrome.runtime.Port,
  ): Promise<BridgeResponse> {
    const { request } = context;

    // Handle internal ping message for health checks
    if (request.key === '__ping__') {
      return {
        id: request.id,
        data: { pong: true, timestamp: Date.now() },
        timestamp: Date.now(),
      };
    }

    if (request.key === '__bridge_diagnostics__') {
      return {
        id: request.id,
        data: this.getDiagnosticsSnapshot(),
        timestamp: Date.now(),
      };
    }

    this.logger.debug(`Processing message: ${request.key} (id: ${request.id})`);

    // Check if this is a critical operation with nonce
    const nonceService = getNonceService();
    const isCritical = nonceService.isCriticalPayload(request.payload);
    let nonce: string | undefined;
    let actualPayload = request.payload;

    if (isCritical) {
      const criticalPayload = request.payload as CriticalPayload;
      nonce = criticalPayload.__nonce__;
      actualPayload = criticalPayload.data;

      this.logger.debug(`Critical operation detected: ${request.key} (nonce: ${nonce})`);

      // Check for duplicate nonce
      const nonceCheck = await nonceService.checkNonce(nonce);
      if (nonceCheck.exists) {
        this.logger.debug(`Duplicate nonce detected: ${nonce} (status: ${nonceCheck.status})`);

        if (nonceCheck.status === 'completed') {
          // Return cached successful result
          return {
            id: request.id,
            data: nonceCheck.result,
            timestamp: Date.now(),
          };
        } else if (nonceCheck.status === 'failed') {
          // Return cached error
          return {
            id: request.id,
            error: nonceCheck.error || 'Operation previously failed',
            timestamp: Date.now(),
          };
        } else if (nonceCheck.status === 'pending') {
          // Operation is still in progress - reject duplicate
          return {
            id: request.id,
            error: 'Operation already in progress',
            timestamp: Date.now(),
          };
        }
      }

      // Mark as pending before processing
      await nonceService.markPending(nonce, criticalPayload.__timestamp__);

      // Send acknowledgment to UI immediately (before processing)
      if (senderPort) {
        try {
          senderPort.postMessage({
            type: 'broadcast',
            key: `__ack__:${nonce}`,
            payload: { received: true, timestamp: Date.now() },
          });
          this.logger.debug(`Sent acknowledgment for nonce: ${nonce}`);
        } catch (e) {
          this.logger.warn(`Failed to send acknowledgment for nonce: ${nonce} - ${e}`);
        }
      }
    }

    const handler = this.resolveHandler(request.key);
    const middlewares = MiddlewareRegistry.pipeline(request.key);

    this.logger.debug(
      `Running pipeline for: ${request.key} with ${middlewares.length} middlewares`,
    );

    // Create modified context with unwrapped payload for critical ops
    const handlerContext = isCritical
      ? { ...context, request: { ...request, payload: actualPayload } }
      : context;

    try {
      const data = await this.runPipeline(middlewares, handlerContext, async () => {
        this.logger.debug(`Executing handler for: ${request.key}`);
        const result = await handler.handle(actualPayload);
        this.logger.debug(`Handler completed for: ${request.key}`, { resultType: typeof result });
        return result;
      });

      // Store successful result for critical operations
      if (isCritical && nonce) {
        await nonceService.storeResult(nonce, data);
        this.logger.debug(`Stored result for nonce: ${nonce}`);
      }

      this.logger.debug(`Message processed: ${request.key} (id: ${request.id})`);

      return {
        id: request.id,
        data,
        timestamp: Date.now(),
      };
    } catch (error) {
      // Store error for critical operations
      if (isCritical && nonce) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await nonceService.storeError(nonce, errorMessage);
        this.logger.debug(`Stored error for nonce: ${nonce}`);
      }

      // Re-throw to be handled by caller
      throw error;
    }
  }

  /**
   * Resolve message handler from dependency injection container
   */
  private resolveHandler(key: string): MessageHandler {
    try {
      this.logger.debug(`Resolving handler for key: "${key}"`);

      if (!this.container.isBound(key)) {
        this.logger.error(`Handler "${key}" is not bound in container`);
        throw new Error(`Handler "${key}" is not registered`);
      }

      const handler = this.container.get(key) as MessageHandler;

      if (!handler || typeof handler.handle !== 'function') {
        this.logger.error(`Handler "${key}" does not have a handle method`, { handler });
        throw new Error(`Handler "${key}" does not implement MessageHandler interface`);
      }

      this.logger.debug(`Successfully resolved handler for key: "${key}"`);
      return handler;
    } catch (error) {
      this.logger.error(`Failed to resolve handler "${key}":`, error);
      throw new Error(`Failed to resolve handler "${key}": ${(error as Error).message}`);
    }
  }

  /**
   * Execute middleware pipeline with proper error handling
   */
  private async runPipeline(
    middlewares: readonly MiddlewareFn[],
    context: PipelineContext,
    finalHandler: () => Promise<unknown>,
  ): Promise<unknown> {
    let currentIndex = -1;

    const executeNext = async (): Promise<unknown> => {
      currentIndex++;

      if (currentIndex === middlewares.length) {
        return finalHandler();
      }

      if (currentIndex > middlewares.length) {
        throw new Error('next() called multiple times');
      }

      const middleware = middlewares[currentIndex];
      return middleware(context, executeNext);
    };

    return executeNext();
  }

  /**
   * Handle errors during message processing
   */
  private async handleError(error: Error, context: PipelineContext): Promise<BridgeResponse> {
    const duration = Date.now() - context.startTime;

    this.logger.error(`💥 Message processing failed after ${duration}ms:`, {
      key: context.request.key,
      id: context.request.id,
      error: error.message,
    });

    return this.errorHandler.handle(error, context);
  }

  /**
   * Handle broadcast messages from UI side
   */
  private handleBroadcast(message: BroadcastMessage, senderPort: chrome.runtime.Port): void {
    // Forward broadcast to all other connected ports (except sender)
    this.connectedPorts.forEach((port) => {
      if (port !== senderPort) {
        try {
          port.postMessage(message);
        } catch (error) {
          this.logger.error('Failed to forward broadcast to port', error);
          // Remove disconnected port
          this.connectedPorts.delete(port);
        }
      }
    });
  }

  private getDiagnosticsSnapshot(): BridgeRuntimeDiagnostics {
    return {
      ...this.diagnostics,
      connectedPorts: this.connectedPorts.size,
    };
  }

  /**
   * Broadcast message to all connected UI ports from service worker
   */
  public broadcast(key: string, payload: unknown): void {
    const message: BroadcastMessage = {
      type: 'broadcast',
      key,
      payload,
    };

    this.logger.debug('📡 Broadcasting from service worker:', {
      key,
      hasPayload: !!payload,
      connectedPorts: this.connectedPorts.size,
    });

    this.connectedPorts.forEach((port) => {
      try {
        port.postMessage(message);
      } catch (error) {
        this.logger.error('Failed to broadcast to port', error);
        // Remove disconnected port
        this.connectedPorts.delete(port);
      }
    });
  }

  /**
   * Send response back through the port
   */
  private sendResponse(port: chrome.runtime.Port, response: BridgeResponse): void {
    try {
      if (!port) {
        this.logger.warn(`Cannot send response: port is null (ID: ${response.id})`);
        return;
      }

      port.postMessage(response);

      if (chrome.runtime.lastError) {
        this.logger.warn(
          `Chrome runtime error during postMessage: ${chrome.runtime.lastError.message} (ID: ${response.id})`,
        );

        chrome.runtime.lastError;
        return;
      }

      this.logger.debug('📤 Response sent:', {
        id: response.id,
        hasData: !!response.data,
        hasError: !!response.error,
        data: response.data,
      });
    } catch (error) {
      this.logger.error('Failed to send response:', error);

      if (chrome.runtime.lastError) {
        this.logger.warn(`Additional Chrome runtime error: ${chrome.runtime.lastError.message}`);
        chrome.runtime.lastError;
      }
    }
  }

  /**
   * Get runtime statistics
   */
  public getStats(): { portName: string; initialized: boolean } {
    return {
      portName: this.portName,
      initialized: this.isInitialized,
    };
  }

  /**
   * Start keep-alive timer to keep service worker alive
   */
  private startKeepAlive(): void {
    if (this.keepAliveTimer) return;
    this.logger.info('Starting keep-alive timer to keep service worker alive');
    this.keepAliveTimer = setInterval(() => {
      chrome.runtime.getPlatformInfo(() => {
        this.recordKeepAlivePing('interval');
        if (chrome.runtime.lastError) {
          this.logger.warn(
            `Chrome runtime error during keep-alive ping: ${chrome.runtime.lastError.message}`,
          );
          chrome.runtime.lastError;
        }
      });
    }, BridgeRuntimeManager.KEEP_ALIVE_INTERVAL_MS);
  }

  /**
   * Stop keep-alive timer
   */
  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
      this.logger.info('Stopped keep-alive timer');
    }
  }
}

class BridgeLogger {
  constructor(private readonly enabled: boolean = true) {}

  info(message: string, context?: Record<string, any>): void {
    if (!this.enabled) return;
    console.log(`[Bridge] ${message}`);
    if (context) console.log('  Context:', context);
  }

  success(message: string): void {
    if (!this.enabled) return;
    console.log(`[Bridge] ${message}`);
  }

  warn(message: string): void {
    if (!this.enabled) return;
    console.warn(`[Bridge] ${message}`);
  }

  error(message: string, error?: unknown): void {
    if (!this.enabled) return;
    console.error(`[Bridge] ${message}`);
    if (error) console.error('  Error:', error);
  }

  debug(message: string, context?: Record<string, any>): void {
    if (!this.enabled) return;
    console.debug(`[Bridge] ${message}`);
    if (context) console.debug('  Context:', context);
  }
}

export function bootstrap(options: BridgeRuntimeOptions): BridgeRuntimeManager {
  const runtime = new BridgeRuntimeManager(options);
  runtime.initialize();
  return runtime;
}

export {
  BridgeRuntimeManager,
  DefaultErrorHandler,
  type BridgeRuntimeOptions,
  type BridgeRequest,
  type BridgeResponse,
  type BroadcastMessage,
  type MessageHandler,
  type ErrorHandler,
  type PipelineContext,
};
