import { defineConfig } from 'vitest/config'

// Standalone vitest config for the graph-native tooling under scripts/graph/.
// Kept separate from the app's vite.config.ts so the benchmark harness does not depend
// on the React/vite toolchain (it is pure Node).
export default defineConfig({
  test: {
    include: ['scripts/graph/**/*.test.mjs'],
    environment: 'node',
  },
})
