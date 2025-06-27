import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { chroma } from '@chroma/manifest';

export default defineConfig({
  plugins: [
    react(),
    chroma()
  ],
  build: {
    target: 'es2020',
    outDir: 'dist',
    sourcemap: false
  }
});
