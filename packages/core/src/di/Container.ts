import { Container as Di } from '@inversifyjs/container';

export const METADATA_KEY = {
  PARAM_TYPES: 'design:paramtypes',
  TYPE: 'design:type',
  RETURN_TYPE: 'design:returntype',
};

export const container = new Di({
  defaultScope: 'Singleton',
});

(container as any).id = Math.random().toString(36).substring(2, 15);

export const bind = <T>(id: symbol | (new (...a: any[]) => T), cls: new (...a: any[]) => T) =>
  container
    .bind<T>(id as any)
    .to(cls)
    .inSingletonScope();

export const resolve = <T>(id: symbol | (new (...a: any[]) => T)): T => container.get<T>(id as any);

export function isInjectable(target: any): boolean {
  return !!Reflect.getMetadata(METADATA_KEY.PARAM_TYPES, target);
}
