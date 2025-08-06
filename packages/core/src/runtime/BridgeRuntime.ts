import type { Container } from 'inversify';
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
    console.error('Error in bridge handler:', error);

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
  private isInitialized = false;

  constructor(options: BridgeRuntimeOptions) {
    this.container = options.container;
    this.portName = options.portName ?? DEFAULT_PORT_NAME;
    this.enableLogging = options.enableLogging ?? true;
    this.errorHandler = options.errorHandler ?? new DefaultErrorHandler();
    this.logger = new BridgeLogger(this.enableLogging);
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
    this.isInitialized = true;
    this.logger.success(`🌉 Bridge runtime initialized on port: ${this.portName}`);
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
      this.logger.warn(`🚫 Ignoring port "${port.name}", expected "${this.portName}"`);
      return false;
    }
    return true;
  }

  /**
   * Setup message handler for connected port
   */
  private setupMessageHandler(port: chrome.runtime.Port): void {
    port.onMessage.addListener(async (request: BridgeRequest) => {
      const context = this.createPipelineContext(request);

      try {
        this.logger.debug('📨 Received message:', {
          key: request.key,
          id: request.id,
          hasPayload: !!request.payload,
        });

        const response = await this.processMessage(context);
        this.sendResponse(port, response);
      } catch (error) {
        const errorResponse = await this.handleError(error as Error, context);
        this.sendResponse(port, errorResponse);
      }
    });

    port.onDisconnect.addListener(() => {
      if (chrome.runtime.lastError) {
        this.logger.warn(`📴 Port disconnected with error: ${chrome.runtime.lastError.message}`);
        chrome.runtime.lastError;
      } else {
        this.logger.info(`📴 Port disconnected: ${port.name}`);
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

    const handler = this.resolveHandler(request.key);
    const middlewares = MiddlewareRegistry.pipeline(request.key);

    const data = await this.runPipeline(middlewares, context, () =>
      handler.handle(request.payload),
    );

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
      const handler = this.container.get(key) as MessageHandler;

      if (!handler || typeof handler.handle !== 'function') {
        throw new Error(`Handler "${key}" does not implement MessageHandler interface`);
      }

      return handler;
    } catch (error) {
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

export function bootstrap(options: BridgeRuntimeOptions): void {
  const runtime = new BridgeRuntimeManager(options);
  console.debug('🌉 Initializing Bridge Runtime with options:', options);
  runtime.initialize();
}

export {
  BridgeRuntimeManager,
  DefaultErrorHandler,
  type BridgeRuntimeOptions,
  type BridgeRequest,
  type BridgeResponse,
  type MessageHandler,
  type ErrorHandler,
  type PipelineContext,
};
