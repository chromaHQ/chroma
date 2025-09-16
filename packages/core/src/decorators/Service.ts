import { inject, injectable } from '@inversifyjs/core';

export function Service() {
  return injectable();
}

export const Use = (id: symbol | string | NewableFunction) => inject(id);
export const Store = () => Use(Symbol.for('Store'));
