import { defineExtension } from '@chroma/manifest';

export default defineExtension({
  name: 'Tensor Wallet',
  description: 'A secure and user-friendly wallet for managing your digital assets.',
  version: '1.0.0',
  icons: {
    '16': 'src/assets/logo_extension.png',
    '32': 'src/assets/logo_extension.png',
    '48': 'src/assets/logo_extension.png',
    '128': 'src/assets/logo_extension.png',
  },
  permissions: ['storage', 'alarms'],
  popup: true,
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
  },
});
