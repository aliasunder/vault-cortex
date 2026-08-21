import { defineConfig } from "vitest/config"

// Remote-boot tier: boots the built `:remote` Docker image with a stubbed
// Sync client. Excluded from `npm test` (needs Docker + a prior image build);
// run via `npm run test:remote-boot` — locally and from arch_smoke.yml.
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
