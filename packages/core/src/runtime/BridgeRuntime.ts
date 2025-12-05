import type { Container } from '@inversifyjs/container';
import { MiddlewareFn, MiddlewareRegistry } from '../internal/MiddlewareRegistry';
import { DEFAULT_PORT_NAME } from '../internal/constants';

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
  private static readonly KEEP_ALIVE_INTERVAL_MS = 25000;
  private isInitialized = false;
  private connectedPorts = new Set<chrome.runtime.Port>();

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

    // Note: keep-alive is started dynamically when first port connects
    // and stopped when all ports disconnect (see setupMessageHandler)

    this.isInitialized = true;
  }

  /**
   * Setup Chrome runtime port listener
   */
  private setupPortListener(): void {
    chrome.runtime.onConnect.addListener((port) => {
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
    });
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

        const response = await this.processMessage(context);
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

      if (chrome.runtime.lastError) {
        this.logger.warn(`📴 Port disconnected with error: ${chrome.runtime.lastError.message}`);
        chrome.runtime.lastError;
      } else {
        this.logger.info(`📴 Port disconnected: ${port.name}`);
      }

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
  private async processMessage(context: PipelineContext): Promise<BridgeResponse> {
    const { request } = context;

    // Handle internal ping message for health checks
    if (request.key === '__ping__') {
      return {
        id: request.id,
        data: { pong: true, timestamp: Date.now() },
        timestamp: Date.now(),
      };
    }

    this.logger.debug(`Processing message: ${request.key} (id: ${request.id})`);

    const handler = this.resolveHandler(request.key);
    const middlewares = MiddlewareRegistry.pipeline(request.key);

    this.logger.debug(
      `Running pipeline for: ${request.key} with ${middlewares.length} middlewares`,
    );

    const data = await this.runPipeline(middlewares, context, async () => {
      this.logger.debug(`Executing handler for: ${request.key}`);
      const result = await handler.handle(request.payload);
      this.logger.debug(`Handler completed for: ${request.key}`, { resultType: typeof result });
      return result;
    });

    this.logger.debug(`Message processed: ${request.key} (id: ${request.id})`);

    return {
      id: request.id,
      data,
      timestamp: Date.now(),
    };
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
        // No-op, just to keep the worker alive
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
