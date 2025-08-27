import { container } from '../src/di/Container';
import { describe, it, expect } from 'vitest';
import { injectable, decorate } from 'inversify';

class Foo {}
// Apply @injectable() decorator before binding
decorate(injectable(), Foo);
container.bind(Foo).toSelf();

describe('container singleton', () => {
  it('returns same instance', () => {
    const a = container.get(Foo);
    const b = container.get(Foo);
    expect(a).toBe(b);
  });
});
