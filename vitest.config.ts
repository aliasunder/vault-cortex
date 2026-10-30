import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts", "cli/src/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["node_modules/**", "cli/src/__tests__/integration/**", "src/__tests__/docker/**"],
    // A worker thread started from a test loads the TypeScript sources itself,
    // outside vitest's transform, so it inherits this loader (body-tag-parser.ts)
    execArgv: ["--import", "tsx"],
  },
})
