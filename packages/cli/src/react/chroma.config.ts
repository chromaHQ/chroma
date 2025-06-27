import { defineExtension } from '@chroma/manifest';

export default defineExtension({
  name: '<%= name %>',
  description: '<%= description %>',
  version: '0.0.1',
  permissions: ['storage', 'activeTab'],
  icons: {
    128: 'public/icon-128.png',
  },
  popup: {
    html: 'popup/index.html',
    entry: 'popup/main.tsx',
  },
  background: {
    entry: 'bootstrap.ts',
  },
});
