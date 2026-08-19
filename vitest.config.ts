import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "cli/src/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    exclude: ["node_modules/**", "cli/src/__tests__/integration/**"],
  },
})
