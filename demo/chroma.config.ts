import { defineExtension } from '@chroma/manifest';

export default defineExtension({
  name: 'Tao',
  description: 'Tao Wallet',
  permissions: ['storage'],
  hostPermissions: [],
  background: {
    service_worker: 'sw.js',
  },
});
