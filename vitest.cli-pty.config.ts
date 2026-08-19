import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    testTimeout: 60_000,
    fileParallelism: false,
    include: ["cli/src/__tests__/integration/**/*.test.ts"],
  },
})
