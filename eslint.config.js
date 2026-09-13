import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import ts from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default ts.config(
  { ignores: ['dist/**', 'dist-pages/**', 'node_modules/**', 'spike-results/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    // Gate D2 asked for Prettier and got nothing. It is waived rather than
    // dropped ([D20](docs/10-decisions.md)): Prettier reflowed 62 files and
    // made the code worse in the places that matter — the tabular
    // ARCHIVE_TABLES became 90 lines of the same five keys repeated, and every
    // `catch { /* going anyway */ }` became a three-line block more prominent
    // than the code it guards.
    //
    // What the gate actually wanted is that formatting is machine-checked and
    // never argued about in review, so these rules enforce the things that do
    // vary between hands. Line *packing* stays with the author, because in this
    // codebase layout carries meaning.
    files: ['**/*.{ts,tsx,js,mjs}'],
    plugins: { '@stylistic': stylistic },
    rules: {
      '@stylistic/semi': ['error', 'always'],
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
      '@stylistic/indent': ['error', 2, { SwitchCase: 1, flatTernaryExpressions: false }],
      '@stylistic/comma-dangle': ['error', 'always-multiline'],
      '@stylistic/comma-spacing': 'error',
      '@stylistic/key-spacing': 'error',
      '@stylistic/keyword-spacing': 'error',
      '@stylistic/arrow-spacing': 'error',
      '@stylistic/space-before-blocks': 'error',
      '@stylistic/space-infix-ops': 'error',
      '@stylistic/object-curly-spacing': ['error', 'always'],
      '@stylistic/no-trailing-spaces': 'error',
      '@stylistic/no-multiple-empty-lines': ['error', { max: 1, maxBOF: 0, maxEOF: 0 }],
      '@stylistic/eol-last': ['error', 'always'],
      // Comments are not exempt: a 140-column comment is as unreadable on a
      // split screen as a 140-column expression, and this repository's comments
      // are load-bearing.
      '@stylistic/max-len': ['error', {
        code: 110, tabWidth: 2, ignoreUrls: true, ignoreStrings: true,
        ignoreTemplateLiterals: true, ignoreRegExpLiterals: true,
      }],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.worker } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'off', // sqlite-wasm ships no types
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    files: ['tests/**/*.ts', '*.ts', '*.js', 'tools/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-console': 'off' },
  },
);
