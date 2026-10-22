// Flat config for ESLint 9. Bot and tooling only: the site's scripts are inline in index.html.
export default [
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { console: 'readonly', process: 'readonly', fetch: 'readonly', WebSocket: 'readonly', AbortController: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', Buffer: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly', URL: 'readonly', globalThis: 'readonly', Intl: 'readonly', Response: 'readonly', Request: 'readonly', Headers: 'readonly' } },
    rules: {
      'no-undef': 'error', 'no-unreachable': 'error', 'no-dupe-keys': 'error', 'no-duplicate-case': 'error', 'no-unsafe-finally': 'error',
      'no-const-assign': 'error', 'no-self-assign': 'error', 'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }], 'eqeqeq': ['error', 'smart'],
      'no-var': 'error', 'prefer-const': 'off', 'no-eval': 'error', 'no-implied-eval': 'error',
    },
  },
  { files: ['tools/page-test.mjs'], languageOptions: { globals: { document: 'readonly', window: 'readonly', localStorage: 'readonly', Event: 'readonly' } } },
  { files: ['worker.js'], languageOptions: { globals: { Response: 'readonly', fetch: 'readonly', URL: 'readonly' } } },
];
