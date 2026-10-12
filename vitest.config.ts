import { defineConfig } from "vitest/config"
import { rerunRootTestRun } from "./scripts/root-test-guard.js"

// vitest sets VITEST before it loads this file. Tools that load it without
// running tests, such as knip, don't, so they never reach the guard. The
// rerun loads this file again, but not as root, so the guard returns at once.
if (process.env.VITEST === "true") {
  rerunRootTestRun({ checkoutRoot: import.meta.dirname, configPath: import.meta.filename })
}

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts", "cli/src/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["node_modules/**", "cli/src/__tests__/integration/**", "src/__tests__/docker/**"],
  },
})
