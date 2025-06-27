module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint', 'prettier'],
  extends: ['airbnb-base', 'plugin:@typescript-eslint/recommended', 'plugin:prettier/recommended'],
  parserOptions: {
    project: './tsconfig.base.json',
  },
  ignorePatterns: ['dist/', 'node_modules/'],
  rules: {
    'prettier/prettier': 'error',
    'no-console': 'warn',
    'import/extensions': 'off',
    'import/no-extraneous-dependencies': 'off',
  },
  settings: {
    'import/resolver': { typescript: {} },
  },
}
