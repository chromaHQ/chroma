import { nodeResolve } from '@rollup/plugin-node-resolve';
import { dts } from 'rollup-plugin-dts';
import esbuild from 'rollup-plugin-esbuild';
import commonjs from '@rollup/plugin-commonjs';

export default [
  {
    input: 'src/index.ts',
    external: [
      'react',
      'react-dom',
      'zustand',
      'zustand/vanilla',
      '@inversifyjs/container',
      '@inversifyjs/core',
      '@inversifyjs/common',
      'reflect-metadata',
    ],
    output: [
      {
        file: 'dist/index.cjs.js',
        format: 'cjs',
      },
      {
        file: 'dist/index.es.js',
        format: 'es',
      },
    ],
    plugins: [
      nodeResolve({ browser: true, preferBuiltins: false }),
      commonjs(),
      esbuild({
        target: 'es2020',
        jsx: 'automatic',
      }),
    ],
    treeshake: { moduleSideEffects: false },
  },
  {
    input: 'src/index.ts',
    plugins: [dts()],
    output: {
      file: 'dist/index.d.ts',
      format: 'es',
    },
  },
];
