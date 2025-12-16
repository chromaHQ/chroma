/**
 * @fileoverview Chroma Core - Chrome extension framework with dependency injection.
 *
 * Provides a powerful foundation for building Chrome extensions with:
 * - Dependency injection via InversifyJS
 * - Message handling with decorators
 * - Service lifecycle management (bootable/destroyable)
 * - Job scheduling (cron, intervals, delays)
 * - Nonce-based idempotency for critical operations
 *
 * @module @chromahq/core
 *
 * @example
 * ```typescript
 * import { Service, Message, Use, bootstrap } from '@chromahq/core';
 *
 * @Service()
 * class WalletService {
 *   async getBalance(walletId: string) { ... }
 * }
 *
 * @Message('get-balance')
 * class GetBalanceHandler {
 *   constructor(@Use(WalletService) private wallet: WalletService) {}
 *   async handle(req: { walletId: string }) {
 *     return this.wallet.getBalance(req.walletId);
 *   }
 * }
 *
 * bootstrap([WalletService, GetBalanceHandler]);
 * ```
 */

/**
 *
 *  ██████╗██╗  ██╗██████╗  ██████╗ ███╗   ███╗ █████╗
 * ██╔════╝██║  ██║██╔══██╗██╔═══██╗████╗ ████║██╔══██╗
 * ██║     ███████║██████╔╝██║   ██║██╔████╔██║███████║
 * ██║     ██╔══██║██╔══██╗██║   ██║██║╚██╔╝██║██╔══██║
 * ╚██████╗██║  ██║██║  ██║╚██████╔╝██║ ╚═╝ ██║██║  ██║
 *  ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═╝     ╚═╝╚═╝  ╚═╝
 *
 * Powerful chrome extension framework
 */
import 'reflect-metadata';

export { Service, Use, Store } from './decorators/Service';
export { Message, IMessage } from './decorators/Message';

export * from './scheduler/core/Job';
export * from './scheduler/decorators/Delay';
export * from './scheduler/decorators/Every';
export * from './scheduler/decorators/EverySeconds';

export { Booteable, isBooteable, isDestroyable } from './services/booteable';
export {
  NonceService,
  getNonceService,
  type CriticalPayload,
  type NonceCheckResult,
} from './services/NonceService';
export {
  setupEarlyListener,
  claimEarlyPorts,
  isEarlyListenerSetup,
  arePortsClaimed,
} from './runtime/EarlyListener';

export { container } from './di/Container';

export * from './scheduler/core/IJob';
export * from './scheduler/core/Job';
export * from './scheduler/decorators/Delay';
export * from './scheduler/decorators/Every';
export * from './scheduler/decorators/EverySeconds';

export { create, bootstrap } from './Bootstrap';
