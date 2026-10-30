import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts", "cli/src/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["node_modules/**", "cli/src/__tests__/integration/**", "src/__tests__/docker/**"],
    // A worker thread a test starts, such as body-tag-parser.ts's parser
    // worker, loads the TypeScript sources outside vitest's transform, so it
    // needs this loader
    execArgv: ["--import", "tsx"],
  },
})
