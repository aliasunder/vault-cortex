import js from "@eslint/js"
import { defineConfig } from "eslint/config"
import tseslint from "typescript-eslint"
import eslintConfigPrettier from "eslint-config-prettier"

export default defineConfig(
  js.configs.recommended,
  tseslint.configs.strict,
  eslintConfigPrettier,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "never" },
      ],
    },
  },
  {
    files: ["**/__tests__/**/*.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/consistent-type-assertions": [
        "warn",
        { assertionStyle: "never" },
      ],
      "@typescript-eslint/no-non-null-assertion": "warn",
    },
  },
  {
    files: ["sst.config.ts"],
    rules: {
      "@typescript-eslint/triple-slash-reference": "off",
    },
  },
  {
    ignores: ["dist/", "cli/dist/", ".sst/", "sst-env.d.ts"],
  },
)
