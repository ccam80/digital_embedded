import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': 'error',
      'no-console': 'warn',
    },
  },

  // Browser-dep fence: Headless, Core, Engine, IO, Testing modules cannot use browser APIs
  {
    files: [
      'src/headless/**/*.ts',
      'src/core/**/*.ts',
      'src/engine/**/*.ts',
      'src/io/**/*.ts',
      'src/testing/**/*.ts',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: ['*/editor/*', 'src/editor/*'],
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'window',
          message: 'window is not available in headless context',
        },
        {
          name: 'document',
          message: 'document is not available in headless context',
        },
        {
          name: 'HTMLCanvasElement',
          message: 'HTMLCanvasElement is not available in headless context',
        },
        {
          name: 'CanvasRenderingContext2D',
          message: 'CanvasRenderingContext2D is not available in headless context',
        },
        {
          name: 'HTMLElement',
          message: 'HTMLElement is not available in headless context',
        },
        {
          name: 'Element',
          message: 'Element is not available in headless context',
        },
        {
          name: 'navigator',
          message: 'navigator is not available in headless context',
        },
        {
          name: 'localStorage',
          message: 'localStorage is not available in headless context',
        },
        {
          name: 'sessionStorage',
          message: 'sessionStorage is not available in headless context',
        },
        {
          name: 'requestAnimationFrame',
          message: 'requestAnimationFrame is not available in headless context',
        },
        {
          name: 'cancelAnimationFrame',
          message: 'cancelAnimationFrame is not available in headless context',
        },
      ],
    },
  },
];
