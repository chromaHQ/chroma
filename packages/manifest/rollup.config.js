import typescript from '@rollup/plugin-typescript';

export default {
  input: './src/index.ts',
  output: [
    {
      file: 'dist/manifest.cjs.js',
      format: 'cjs',
    },
    {
      file: 'dist/manifest.es.js',
      format: 'es',
    },
  ],
  plugins: [typescript()],
};
