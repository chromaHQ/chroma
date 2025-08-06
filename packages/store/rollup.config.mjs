import { nodeResolve } from '@rollup/plugin-node-resolve';
import { dts } from 'rollup-plugin-dts';
import esbuild from 'rollup-plugin-esbuild';
import commonjs from '@rollup/plugin-commonjs';

// Main package config - externalize autoRegister and @chromahq/core
const mainConfig = [
  {
    input: 'src/index.ts',
    external: ['react', 'react-dom', 'zustand', 'zustand/vanilla', '@chromahq/core'],
    output: [
      {
        file: 'dist/index.cjs.js',
        format: 'cjs',
        inlineDynamicImports: true,
      },
      {
        file: 'dist/index.es.js',
        format: 'es',
        inlineDynamicImports: true,
      },
    ],
    plugins: [
      nodeResolve({ browser: true, preferBuiltins: false }), 
      commonjs(),
      esbuild({ 
        minify: false, 
        target: 'es2020',
        jsx: 'automatic'
      })
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
    external: ['@chromahq/core'],
  },
];

export default [...mainConfig];
