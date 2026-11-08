import ts from 'typescript-eslint';

export default [
  { ignores: ['**/node_modules/**', 'dist/**', '.wrangler/**'] },
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'vitest.config.ts'],
    languageOptions: { parser: ts.parser, parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname } },
    plugins: { '@typescript-eslint': ts.plugin },
    rules: {
      ...ts.configs.recommendedTypeChecked.at(-1).rules,
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
    },
  },
];
