import type { ExtensionConfig } from './defineExtension';

export function inferPermissions(base: ExtensionConfig): string[] {
  const perms = new Set(base.permissions ?? []);
  return Array.from(perms);
}
