/**
 * Shared logger interface for consistent logging across the application
 */
export interface Logger {
  info(message: string, context?: Record<string, any>): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string, error?: Error): void;
  debug(message: string, context?: Record<string, any>): void;
  divider?(): void;
}
