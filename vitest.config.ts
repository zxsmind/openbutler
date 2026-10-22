import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'web/src/**/*.test.ts'],
    environment: 'node',
  },
});
