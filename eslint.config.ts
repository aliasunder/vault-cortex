import js from "@eslint/js"
import stylistic from "@stylistic/eslint-plugin"
import { defineConfig } from "eslint/config"
import tseslint from "typescript-eslint"
import eslintConfigPrettier from "eslint-config-prettier"

// no-restricted-syntax options replace rather than merge across overlapping
// config blocks, so any block that narrows the file set has to restate every
// selector it still wants. These shared arrays are spread into each such block
// so a new restriction can't silently lapse in the narrower one.

/** AGENTS.md → Code style: Luxon DateTime over the native Date API. */
const LUXON_OVER_DATE_RESTRICTIONS = [
  {
    selector: 'NewExpression[callee.name="Date"]',
    message: "Use Luxon DateTime over the native Date API (AGENTS.md → Code style)",
  },
  {
    selector: 'CallExpression[callee.object.name="Date"]',
    message:
      "Use Luxon (DateTime.now(), .toUnixInteger()) over Date static methods (AGENTS.md → Code style)",
  },
]

/** Bans direct use of `config.readOnlyMode` in tool/prompt modules —
 *  branching on the flag misses DISABLED_TOOLS and any future gating axis,
 *  so tool references must key on the enabled set instead. */
const ENABLED_SET_OVER_READONLY_FLAG_RESTRICTIONS = [
  {
    selector: 'MemberExpression[property.name="readOnlyMode"]',
    message:
      "Key tool references on the enabled set (isToolEnabled / whenToolEnabledText), not on config.readOnlyMode — the flag misses DISABLED_TOOLS (AGENTS.md → Module layering)",
  },
  {
    selector: 'ObjectPattern > Property[key.name="readOnlyMode"]',
    message:
      "Key tool references on the enabled set (isToolEnabled / whenToolEnabledText), not on config.readOnlyMode — the flag misses DISABLED_TOOLS (AGENTS.md → Module layering)",
  },
]

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
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      // AGENTS.md → Code style: arrow functions over `function` declarations.
      "func-style": ["error", "expression"],
      // AGENTS.md → Code style: `type` over `interface`.
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      // AGENTS.md → Code style: early returns over nested if/else.
      "no-else-return": "error",
      // AGENTS.md → Code style: no nested ternaries.
      "no-nested-ternary": "error",
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
    // AGENTS.md → Code style: blank lines separate logical sections — a
    // declaration never runs straight into the guard that consumes it.
    // Prettier does not manage blank lines, so this rule cannot conflict with it.
    plugins: { "@stylistic": stylistic },
    rules: {
      "@stylistic/padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: ["const", "let"], next: "if" },
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
      "no-restricted-syntax": ["error", ...LUXON_OVER_DATE_RESTRICTIONS],
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
          message: "Read env via the env-var package in config.ts — never raw process.env",
        },
      ],
    },
  },
  {
    files: ["**/__tests__/**/*.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/consistent-type-assertions": ["warn", { assertionStyle: "never" }],
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
                "**/setup/**",
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
              group: ["**/search/**", "**/mcp-core/**", "**/oauth/**", "**/setup/**"],
              allowTypeImports: true,
              message:
                "vault-operations/ builds on parsers and utils only — no runtime imports of search/, mcp-core/, oauth/, or setup/ (AGENTS.md → Module layering)",
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
              group: ["**/vault-operations/**", "**/mcp-core/**", "**/oauth/**", "**/setup/**"],
              allowTypeImports: true,
              message:
                "search/ builds on parsers and utils only — no runtime imports of vault-operations/, mcp-core/, oauth/, or setup/ (AGENTS.md → Module layering)",
            },
          ],
        },
      ],
    },
  },
  // CLI layering (see AGENTS.md → CLI layering): adapters → rules → steps →
  // commands, with bin, main and program at cli/src/ as wiring. Patterns match
  // the specifier as written, so a sibling import is "./x.js" and an import
  // from another layer carries that layer's folder ("../steps/x.js").
  {
    // Adapters wrap the outside world (Docker, the terminal, files) and import
    // nothing internal, not even another adapter.
    files: ["cli/src/adapters/**/*.ts"],
    ignores: ["**/__tests__/**", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^\\.\\.?/",
              allowTypeImports: true,
              message: "CLI adapters import nothing internal at runtime (AGENTS.md → CLI layering)",
            },
          ],
        },
      ],
    },
  },
  {
    // Rules are pure decisions and text: other rules at runtime, adapters for
    // their types only, and no I/O or prompt library.
    files: ["cli/src/rules/**/*.ts"],
    ignores: ["**/__tests__/**", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/adapters/**", "**/steps/**", "**/commands/**"],
              allowTypeImports: true,
              message:
                "CLI rules are pure — import other rules, and adapters for types only (AGENTS.md → CLI layering)",
            },
            {
              group: ["node:fs", "node:fs/**", "node:child_process", "@clack/prompts"],
              allowTypeImports: true,
              message:
                "CLI rules do no I/O and ask no questions — that belongs in an adapter or a step (AGENTS.md → CLI layering)",
            },
          ],
        },
      ],
    },
  },
  {
    // Steps are the shared workflow pieces commands compose; they never
    // reach up into a command.
    files: ["cli/src/steps/**/*.ts"],
    ignores: ["**/__tests__/**", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/commands/**"],
              allowTypeImports: true,
              message:
                "CLI steps never import a command — move what both need into a step (AGENTS.md → CLI layering)",
            },
          ],
        },
      ],
    },
  },
  {
    // A command never imports another command: shared logic moves down into
    // a step, so a fix lands in one place.
    files: ["cli/src/commands/**/*.ts"],
    ignores: ["**/__tests__/**", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // A sibling by "./" and the folder by any other spelling.
              regex: "^\\./",
              allowTypeImports: true,
              message:
                "CLI commands never import another command — move what both need into a step (AGENTS.md → CLI layering)",
            },
            {
              group: ["**/commands/**"],
              allowTypeImports: true,
              message:
                "CLI commands never import another command — move what both need into a step (AGENTS.md → CLI layering)",
            },
          ],
        },
      ],
    },
  },
  // Tool-surface boundaries (see AGENTS.md → Module layering): the registry
  // owns tool identity and annotations, and gating is derived from the enabled
  // set — not re-decided downstream.
  {
    // mcp-core outside the group modules: the router and prompt orchestrator
    // consume the enabled set. tool-definitions.ts is the sanctioned home of
    // the READONLY_MODE predicate, so it is exempt.
    files: ["src/vault-mcp/mcp-core/**/*.ts"],
    ignores: [
      "**/__tests__/**",
      "**/*.test.ts",
      "src/vault-mcp/mcp-core/tool-definitions.ts",
      "src/vault-mcp/mcp-core/tools/**",
      "src/vault-mcp/mcp-core/prompts/**",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...LUXON_OVER_DATE_RESTRICTIONS,
        ...ENABLED_SET_OVER_READONLY_FLAG_RESTRICTIONS,
      ],
    },
  },
  {
    // The tool and prompt group modules. Same enabled-set rule, plus: tool
    // names live in the registry alone. Per-group name constants were a real
    // duplicate source of truth before the registry replaced them — a local
    // TOOL_NAMES would compile and pass tests while drifting from it.
    files: ["src/vault-mcp/mcp-core/tools/**/*.ts", "src/vault-mcp/mcp-core/prompts/**/*.ts"],
    ignores: ["**/__tests__/**", "**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...LUXON_OVER_DATE_RESTRICTIONS,
        ...ENABLED_SET_OVER_READONLY_FLAG_RESTRICTIONS,
        {
          selector: 'VariableDeclarator[id.name="TOOL_NAMES"]',
          message:
            "Import TOOL_NAMES from tool-registry.js — the registry is the only source of tool names (AGENTS.md → Module layering)",
        },
      ],
    },
  },
  {
    // Tool and prompt group modules are sibling surfaces, not a layer stack:
    // neither builds on the other. A helper both need is generic enough for
    // utils/, or belongs in tool-helpers/prompt-helpers respectively.
    files: ["src/vault-mcp/mcp-core/prompts/**/*.ts"],
    ignores: ["**/__tests__/**", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // Patterns match the import string as written, not the resolved
              // path, so they key on the folder segment a sibling specifier
              // actually carries ("../tools/…") — not the mcp-core prefix.
              group: ["**/tools/**"],
              allowTypeImports: true,
              message:
                "prompts/ and tools/ are sibling surfaces — share via utils/ or the group's own helpers module (AGENTS.md → Module layering)",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/vault-mcp/mcp-core/tools/**/*.ts"],
    ignores: ["**/__tests__/**", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // See the sibling block: matched against the written specifier.
              group: ["**/prompts/**"],
              allowTypeImports: true,
              message:
                "prompts/ and tools/ are sibling surfaces — share via utils/ or the group's own helpers module (AGENTS.md → Module layering)",
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
