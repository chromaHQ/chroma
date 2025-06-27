import { injectable, inject } from 'inversify';

export function Injectable() {
  return function (constructor: new (...args: any[]) => any) {
    injectable()(constructor);
  };
}

export function Inject(serviceIdentifier: any) {
  return function (target: any, key: string | symbol) {
    inject(serviceIdentifier)(target, key);
  };
}
