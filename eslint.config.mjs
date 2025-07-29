export default [
  {
    files: ['packages/**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      'no-console': 'warn',
      'no-unused-vars': 'warn',
    },
  },
  {
    ignores: [
      'dist/', 
      'node_modules/', 
      'build/', 
      'lib/', 
      'out/', 
      '*.config.js', 
      '*.config.mjs',
      'demo/**',
      'wallet/**',
      'docs/**',
      'docs-site/**',
      'packages/*/dist/**',
      '**/*.d.ts'
    ],
  },
];
