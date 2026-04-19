import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Default runs exclude real-LLM suites — those cost API money, require
    // keys, and live behind a dedicated `npm run test:real` script that
    // targets them explicitly. Keeping them out of the default glob means
    // `npm test` shows "N passed" with no skipped noise.
    exclude: ['node_modules/**', '__tests__/real-*.test.ts'],
  },
});
