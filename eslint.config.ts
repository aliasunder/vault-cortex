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
      // AGENTS.md → Code style: arrow functions over `function` declarations.
      "func-style": ["error", "expression"],
      // AGENTS.md → Code style: `type` over `interface`.
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      // AGENTS.md → Code style: early returns over nested if/else.
      "no-else-return": "error",
      // AGENTS.md → Code style: explicit names over abbreviations — no
      // single-char identifiers. Exceptions: `i` (loop index), `a`/`b`
      // (sort comparators), `k` (the RRF constant's literature name),
      // `_` (unused-param convention).
      "id-length": [
        "error",
        { min: 2, properties: "never", exceptions: ["i", "a", "b", "k", "_"] },
      ],
    },
  },
  {
    // Logging standard: console never ships in server code — the structured
    // logger is the only output channel. cli/ and scripts/ are exempt:
    // console IS their user interface.
    files: ["src/**/*.ts"],
    rules: {
      "no-console": "error",
    },
  },
  {
    // AGENTS.md → Code style: Luxon DateTime over the native Date API.
    // Tests are exempt — they build Date fixtures for fs interop (utimes)
    // and fake timers.
    files: ["src/**/*.ts"],
    ignores: ["**/__tests__/**", "**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: 'NewExpression[callee.name="Date"]',
          message:
            "Use Luxon DateTime over the native Date API (AGENTS.md → Code style)",
        },
        {
          selector: 'CallExpression[callee.object.name="Date"]',
          message:
            "Use Luxon (DateTime.now(), .toUnixInteger()) over Date static methods (AGENTS.md → Code style)",
        },
      ],
    },
  },
  {
    // Env access goes through the env-var package at the sanctioned read
    // site (config.ts) — never raw process.env scattered through the code.
    files: ["src/**/*.ts"],
    ignores: ["**/__tests__/**", "**/*.test.ts", "src/vault-mcp/config.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message:
            "Read env via the env-var package in config.ts — never raw process.env",
        },
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
    ignores: ["**/__tests__/**", "**/*.test.ts"],
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
    ignores: ["**/__tests__/**", "**/*.test.ts"],
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
    ignores: ["**/__tests__/**", "**/*.test.ts"],
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
    ignores: ["**/__tests__/**", "**/*.test.ts"],
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
