import { nodeResolve } from '@rollup/plugin-node-resolve';
import esbuild from 'rollup-plugin-esbuild';
import dts from 'rollup-plugin-dts';

export default [
  {
    input: 'src/index.tsx',
    output: [{ file: 'dist/index.js', format: 'esm', sourcemap: false }],
    external: ['react', 'react/jsx-runtime', '@chroma/bridge'],
    plugins: [nodeResolve(), esbuild({ target: 'es2020', minify: false, jsx: 'automatic' })],
  },
  {
    input: 'src/index.ts', // only types
    output: { file: 'dist/index.d.ts', format: 'es' },
    plugins: [dts()],
  },
];
