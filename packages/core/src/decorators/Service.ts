import { inject, injectable } from '@inversifyjs/core';
import { TOKENS } from './tokens';

export function Service() {
  return injectable();
}

export const Use = (id: symbol | string | NewableFunction) => inject(id);
export const Store = () => Use(TOKENS.Store);
