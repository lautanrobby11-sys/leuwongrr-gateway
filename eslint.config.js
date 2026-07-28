import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**','node_modules/**','data/**','logs/**','runtime/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts','tests/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.es2023 } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error',{ argsIgnorePattern:'^_', caughtErrorsIgnorePattern:'^_' }],
      'no-console': ['error',{ allow:['warn','error','log'] }],
      'eqeqeq': ['error','always']
    }
  },
  {
    files: ['scripts/**/*.mjs','eslint.config.js'],
    languageOptions: { globals: { ...globals.node } }
  }
);
