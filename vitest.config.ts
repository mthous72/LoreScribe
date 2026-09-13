import { defineConfig } from 'vitest/config';

// The domain layer imports nothing platform-specific, by design (doc 01), so
// these run in plain Node with no browser and no database.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
