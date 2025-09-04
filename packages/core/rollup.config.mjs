import base from '../../rollup.config.base.mjs';
import { dts } from 'rollup-plugin-dts';

export default [
  {
    ...base[0],
    input: {
      index: 'src/index.ts',
      boot: 'src/boot.ts',
    },
    output: [
      {
        dir: 'dist',
        format: 'es',
        entryFileNames: '[name].es.js',
        sourcemap: true,
      },
      {
        dir: 'dist',
        format: 'cjs',
        entryFileNames: '[name].cjs.js',
        sourcemap: true,
      },
    ],
  },
  base[1],
  {
    input: 'src/boot.ts',
    plugins: [dts()],
    output: {
      file: 'dist/boot.d.ts',
      format: 'es',
    },
  },
];
