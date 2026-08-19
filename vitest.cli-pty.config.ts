import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["cli/src/__tests__/integration/**/*.test.ts"],
  },
})
