import { injectable } from '@inversifyjs/core';

export abstract class IMessage {
  handle(...args: any[]): Promise<void> | void {
    throw new Error('Method not implemented.');
  }
}

export function Message(name: string) {
  return function (constructor: any) {
    injectable()(constructor);
    Reflect.defineMetadata('name', name, constructor);
    return constructor;
  };
}
