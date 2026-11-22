import { defineConfig } from "vitest/config"

// The remote-boot tier boots the built `:remote` Docker image with a stubbed
// Sync client, so it is excluded from `npm test` (it needs Docker). The global setup
// builds an image for each run unless REMOTE_IMAGE names one (arch_smoke.yml
// builds via buildx and sets it), and removes what the run created.
export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    globalSetup: ["src/__tests__/docker/helpers/remote-boot-global-setup.ts"],
    testTimeout: 30_000,
    // Container boots (and the restart) live in beforeAll hooks.
    hookTimeout: 180_000,
    // When watch mode quits, Vitest exits the process once closing passes this
    // limit (10 seconds by default), which would cut the global teardown's removals short.
    teardownTimeout: 120_000,
    fileParallelism: false,
    include: ["src/__tests__/docker/**/*.test.ts"],
  },
})
