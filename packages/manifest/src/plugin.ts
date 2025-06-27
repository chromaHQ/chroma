import { createVitePlugin } from 'unplugin';
import fs from 'node:fs';
import path from 'node:path';
import { inferPermissions } from './inferPermissions';
import { ExtensionConfig } from './defineExtension';

const bootstrapPath = path.join('src', 'bootstrap.ts');
const popupPath = path.resolve(process.cwd(), 'index.html');
const configFilePath = path.resolve(process.cwd(), 'chroma.config.ts');

export const chroma = createVitePlugin((options?: { configFile?: string }) => {
  let config: ExtensionConfig;
  let backgroundAbs: string;
  let popupAbs: string;

  return {
    name: 'chroma-manifest',

    async buildStart(this: any) {},

    async options(this: any, rollupOpts: any) {
      const configPath = options?.configFile ?? configFilePath;
      const userConfig = await import(configPath);

      config = { ...(userConfig.default ?? userConfig) };

      backgroundAbs = path.resolve(path.join(path.dirname(configPath), bootstrapPath));
      popupAbs = popupPath;

      rollupOpts.input = { sw: backgroundAbs, popup: popupAbs };

      return rollupOpts;
    },

    generateBundle(
      this: any,
      _outOpts: any,
      bundle: { [s: string]: unknown } | ArrayLike<unknown>,
    ) {
      let iconMap: Record<string, string> = {};
      if (config.icons) {
        const icons =
          typeof config.icons === 'string' ? [config.icons] : Object.values(config.icons);

        icons.forEach((icon: string) => {
          const iconPath = path.resolve(process.cwd(), icon);

          if (fs.existsSync(iconPath)) {
            const iconName = path.basename(iconPath);
            iconMap[icon] = `icons/${iconName}`;

            this.emitFile({
              type: 'asset',
              fileName: `icons/${iconName}`,
              source: fs.readFileSync(iconPath),
            });
          }
        });
      }

      Object.values(bundle).forEach((chunk: any) => {
        if ('facadeModuleId' in chunk && chunk.facadeModuleId === backgroundAbs) {
          chunk.fileName = 'sw.js';
        }

        if ('facadeModuleId' in chunk && chunk.facadeModuleId === popupAbs) {
          chunk.fileName = 'popup.js';
        }
      });

      const pkgPath = path.resolve(process.cwd(), 'package.json');
      const pkg = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) : {};

      config.version = config.version ? config.version : (pkg.version ?? '0.0.1');

      const manifest = {
        manifest_version: 3,
        name: config.name,
        version: config.version,
        description: config.description,
        content_security_policy: config.content_security_policy ?? undefined,
        action: config.popup ? { default_popup: 'index.html' } : undefined,

        icons: Object.fromEntries(
          Object.entries(config.icons ?? {}).map(([size, icon]) => [size, iconMap[icon] || icon]),
        ),

        background: { type: 'module', service_worker: 'sw.js' },
        permissions: inferPermissions(config),
      };

      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: JSON.stringify(manifest, null, 2),
      });
    },
  };
});
