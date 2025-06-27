import { defineConfig } from 'vite';
import { chroma } from '@chroma/manifest';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss(), chroma(), nodePolyfills()],
  build: {
    target: 'es2020',
    sourcemap: true,
    outDir: 'dist',
  },
});
