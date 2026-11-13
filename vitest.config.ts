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
    // Tests that assert on real log lines must not inherit a developer's
    // LOG_LEVEL or LOG_DIR, which would hide those lines or write to a real log folder.
    env: { LOG_LEVEL: "info", LOG_DIR: "none" },
    // The server logs thousands of lines across the suite. Its setup file
    // routes them into each test's console capture, which this setting
    // prints only for a failing test, so a run's output shows its failures.
    setupFiles: ["src/__tests__/helpers/route-log-lines-to-console.ts"],
    silent: "passed-only",
  },
})
