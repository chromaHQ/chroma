import { ServiceIdentifier } from 'inversify';
import { container } from './Container';

/**
 * Bind a concrete class to itself (auto DI resolution)
 */
export function bind<T>(token: ServiceIdentifier<T>, impl: new (...args: any[]) => T) {
  container.bind<T>(token).to(impl).inSingletonScope();
}

/**
 * Bind a token (interface or string) to a concrete implementation
 */
export function bindTo<T>(token: ServiceIdentifier<T>, impl: new (...args: any[]) => T) {
  container.bind<T>(token).to(impl).inSingletonScope();
}

/**
 * Bind a constant value to a token (for configs, strings, etc)
 */
export function bindConstant<T>(token: ServiceIdentifier<T>, value: T) {
  container.bind<T>(token).toConstantValue(value);
}
