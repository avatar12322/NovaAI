import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '.data/**',
      'workers/windows/target/**',
      'apps/web/test-results/**',
      'apps/web/playwright-report/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'off',
    },
  },
  {
    files: ['apps/web/src/**/*.tsx', 'apps/web/src/**/*.ts'],
    rules: {
      // Efekt Reacta może zwrócić wyłącznie funkcję sprzątającą. Skrócona strzałka zwraca wynik wyrażenia
      // (np. Promise z scrollIntoView w nowszych przeglądarkach) i wywraca widok — TypeScript tego nie wykryje.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'CallExpression[callee.name=/^use(Layout)?Effect$/] > ArrowFunctionExpression[expression=true]:not([body.type="ArrowFunctionExpression"])',
          message:
            'useEffect: użyj bloku `() => { ... }` — efekt może zwrócić tylko funkcję sprzątającą.',
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/test/**/*.ts', '**/e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
