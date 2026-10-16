import { defineConfig } from 'vite-plus';

export default defineConfig({
  fmt: { singleQuote: true, printWidth: 120 },
  lint: {
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: { 'vite-plus/prefer-vite-plus-imports': 'error' },
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    include: ['src/**/*.test.ts'],
    // Les tests de bout en bout lancent le binaire dans un sous-processus.
    testTimeout: 30_000,
  },
  run: { cache: true },
});
