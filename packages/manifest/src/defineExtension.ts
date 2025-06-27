export interface ExtensionConfig {
  /** Visible name (dev overrides add suffix) */
  name: string;
  description?: string;
  version?: string; // default from pkg.json
  popup?: boolean; // path to popup.html
  icons?: 'auto' | Record<string, string>;
  permissions?: string[];
  hostPermissions?: string[];
  background?: { service_worker: string }; // default 'sw.js'
  contentScripts?: { js: string[]; matches: string[] }[];
  dev?: Partial<ExtensionConfig>;
  content_security_policy?: {
    extension_pages?: string;
    sandbox?: string;
  };
}

export function defineExtension(config: ExtensionConfig): ExtensionConfig {
  return config;
}
