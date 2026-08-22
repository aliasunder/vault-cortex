import { defineConfig } from "vitest/config"

// Remote-boot tier: boots the built `:remote` Docker image with a stubbed
// Sync client. Excluded from `npm test` (needs Docker). Locally
// `npm run test:remote-boot` builds the image then runs this config;
// arch_smoke.yml builds via buildx and runs the config directly.
export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    testTimeout: 30_000,
    // Container boots (and the restart) live in beforeAll hooks.
    hookTimeout: 180_000,
    fileParallelism: false,
    include: ["src/__tests__/docker/**/*.test.ts"],
  },
})
