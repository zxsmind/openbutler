import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'release/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain Node.js helper scripts: TypeScript-aware rules do not apply, but
    // the Node.js runtime globals must be known to `no-undef`.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      // ANSI escape parsing and clipboard sequences legitimately match control characters.
      'no-control-regex': 'off',
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
);
