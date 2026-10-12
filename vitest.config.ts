import { defineConfig } from "vitest/config"
import { stopRootTestRun } from "./scripts/root-test-guard.js"

// vitest sets VITEST before it loads this file. Other tools that load it,
// such as knip, don't, so the guard runs only for a real vitest run.
if (process.env.VITEST === "true") {
  stopRootTestRun({ checkoutRoot: import.meta.dirname, configPath: import.meta.filename })
}

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts", "cli/src/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["node_modules/**", "cli/src/__tests__/integration/**", "src/__tests__/docker/**"],
  },
})
