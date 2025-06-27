import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chroma } from '@chroma/manifest';
import path from 'node:path';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  esbuild: {
    minifyIdentifiers: false,
  },

  plugins: [react(), tailwindcss(), chroma(), nodePolyfills({})],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/popup'),
    },
  },
});
