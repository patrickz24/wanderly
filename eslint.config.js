// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';

/** Infrastructure SDKs that must never leak into the domain or application layers. */
const INFRA_PACKAGES = [
  'fastify',
  '@fastify/*',
  'pg',
  'pgvector',
  'pgvector/*',
  '@anthropic-ai/*',
  '@langfuse/*',
  'langfuse*',
  '@huggingface/*',
  '@opentelemetry/*',
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'evals/results/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  // Layering: the domain is pure TypeScript (no framework, DB, network or SDK).
  {
    files: ['services/api/src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/application/**', '**/infrastructure/**', '**/api/**', '**/config*'],
              message: 'The domain layer must not depend on outer layers.',
            },
            { group: INFRA_PACKAGES, message: 'The domain layer must stay framework-free.' },
            {
              group: ['node:fs*', 'node:net', 'node:http*', 'node:child_process'],
              message: 'The domain layer must not perform I/O.',
            },
          ],
        },
      ],
    },
  },
  // Layering: use cases depend on the domain and on ports, never on adapters.
  {
    files: ['services/api/src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/infrastructure/**', '**/api/**'],
              message: 'Use cases depend on ports, not on adapters or HTTP.',
            },
            { group: INFRA_PACKAGES, message: 'Use cases must not import infrastructure SDKs.' },
          ],
        },
      ],
    },
  },
  // Web client.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  // Scripts and CLIs may log to stdout.
  {
    files: ['**/scripts/**', 'evals/**', 'services/api/src/cli/**'],
    rules: { 'no-console': 'off' },
  },
  // Tests may use non-null assertions.
  {
    files: ['**/*.test.{ts,tsx}', '**/test/**'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  prettier,
);
