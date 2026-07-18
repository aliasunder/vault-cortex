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
  // Layering boundaries (see AGENTS.md → Module layering): lower layers never
  // import upward or sideways at runtime. Type-only imports are allowed — they
  // are erased at compile time. Tests are exempt (they may compose layers to
  // build fixtures).
  {
    // obsidian-markdown/ is a leaf layer of pure parsers: no I/O, no SDKs, no
    // runtime imports of other internal modules.
    files: ["src/vault-mcp/obsidian-markdown/**/*.ts"],
    ignores: ["**/__tests__/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/vault-operations/**",
                "**/search/**",
                "**/mcp-core/**",
                "**/oauth/**",
                "**/utils/**",
                "**/logger.js",
              ],
              allowTypeImports: true,
              message:
                "obsidian-markdown/ is a leaf layer — no runtime imports of other internal modules (AGENTS.md → Module layering)",
            },
            {
              group: [
                "node:fs",
                "node:fs/**",
                "better-sqlite3",
                "sqlite-vec",
                "@modelcontextprotocol/**",
              ],
              allowTypeImports: true,
              message:
                "pure parsers do no I/O — no fs, SQLite, or MCP SDK in obsidian-markdown/ (AGENTS.md → Module layering)",
            },
          ],
        },
      ],
    },
  },
  {
    // utils/ is generic with zero domain knowledge; type-only imports from
    // infrastructure modules (Logger, config types) are fine.
    files: ["src/utils/**/*.ts"],
    ignores: ["**/__tests__/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/vault-mcp/**", "**/logger.js"],
              allowTypeImports: true,
              message:
                "utils/ has zero domain knowledge — no runtime imports of domain or infrastructure modules (AGENTS.md → utils/ admission)",
            },
          ],
        },
      ],
    },
  },
  {
    // vault-operations/ builds on the parsers and utils only.
    files: ["src/vault-mcp/vault-operations/**/*.ts"],
    ignores: ["**/__tests__/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/search/**", "**/mcp-core/**", "**/oauth/**"],
              allowTypeImports: true,
              message:
                "vault-operations/ builds on parsers and utils only — no runtime imports of search/, mcp-core/, or oauth/ (AGENTS.md → Module layering)",
            },
          ],
        },
      ],
    },
  },
  {
    // search/ uses the shared parsers — it never reaches sideways into
    // vault-operations/ or up into the protocol layer.
    files: ["src/vault-mcp/search/**/*.ts"],
    ignores: ["**/__tests__/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/vault-operations/**",
                "**/mcp-core/**",
                "**/oauth/**",
              ],
              allowTypeImports: true,
              message:
                "search/ builds on parsers and utils only — never reaches sideways into vault-operations/ or up into mcp-core/ (AGENTS.md → Module layering)",
            },
          ],
        },
      ],
    },
  },
  {
    ignores: ["dist/", "cli/dist/", ".sst/", "sst-env.d.ts"],
  },
)
