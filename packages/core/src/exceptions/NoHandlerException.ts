export class NoHandlerException extends Error {
  constructor(key: string) {
    super(`No handler registered for "${key}"`);
    this.name = 'NoHandlerException';
    Object.setPrototypeOf(this, NoHandlerException.prototype);
  }
}
