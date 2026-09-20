import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['homebridge-ui/public/**/*.js'],
    languageOptions: {
      globals: { document: 'readonly', homebridge: 'readonly' },
    },
  },
  {
    files: ['homebridge-ui/*.js'],
    languageOptions: {
      globals: { process: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly' },
    },
  },
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      'quotes': ['error', 'single', { avoidEscape: true }],
      'indent': ['error', 2, { SwitchCase: 1 }],
      'linebreak-style': ['error', 'unix'],
      'semi': ['error', 'always'],
      'comma-dangle': ['error', 'always-multiline'],
      'dot-notation': 'error',
      'eqeqeq': ['error', 'smart'],
      'curly': ['error', 'all'],
      'brace-style': ['error'],
      'prefer-arrow-callback': 'warn',
      'prefer-const': 'error',
      'max-len': ['warn', 140],
      'object-curly-spacing': ['error', 'always'],
      'no-console': 'error',
      'no-use-before-define': 'off',
      '@typescript-eslint/no-use-before-define': ['error', { classes: false, enums: false, functions: false }],
      '@typescript-eslint/no-unused-vars': ['error', { caughtErrors: 'none', argsIgnorePattern: '^_' }],
    },
  },
);
