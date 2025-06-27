import { container } from '../src/di/Container';
import { describe, it, expect } from 'vitest';

class Foo {}
container.bind(Foo).toSelf();

describe('container singleton', () => {
  it('returns same instance', () => {
    const a = container.get(Foo);
    const b = container.get(Foo);
    expect(a).toBe(b);
  });
});
