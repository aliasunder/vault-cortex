import { describe, it, expect } from "vitest"
import { sanitizeFtsQuery } from "../fts-query.js"

describe("sanitizeFtsQuery", () => {
  const scenarios = [
    {
      name: "multi-word: unquoted terms joined with spaces",
      input: "burnout boundaries",
      expected: "burnout boundaries",
    },
    {
      name: "single word: passthrough unquoted for stemming",
      input: "single",
      expected: "single",
    },
    {
      name: "quoted phrase: preserved",
      input: '"machine learning"',
      expected: '"machine learning"',
    },
    {
      name: "phrase + unquoted term",
      input: '"machine learning" kubernetes',
      expected: '"machine learning" kubernetes',
    },
    {
      name: "FTS5 specials stripped, reserved words dropped",
      input: 'test "quoted" AND (grouped)',
      expected: '"quoted" test grouped',
    },
    {
      name: "wildcard stripped",
      input: "burn*",
      expected: "burn",
    },
    {
      name: "all reserved words: empty result",
      input: "AND OR NOT",
      expected: '""',
    },
    {
      name: "NEAR reserved word dropped from mixed input",
      input: "meeting NEAR fence",
      expected: "meeting fence",
    },
    {
      name: "NEAR alone: empty result",
      input: "NEAR",
      expected: '""',
    },
    {
      name: "empty string: empty result",
      input: "",
      expected: '""',
    },
    {
      name: "caret and colon stripped",
      input: "field:value ^boost",
      expected: "field value boost",
    },
    {
      name: "hyphenated compound → quoted phrase",
      input: "vault-cortex",
      expected: '"vault cortex"',
    },
    {
      name: "multi-hyphen compound → quoted phrase",
      input: "self-hosted-app",
      expected: '"self hosted app"',
    },
    {
      name: "hyphenated + bare terms",
      input: "vault-cortex search",
      expected: '"vault cortex" search',
    },
    {
      name: "multiple hyphenated terms",
      input: "vault-cortex self-hosted",
      expected: '"vault cortex" "self hosted"',
    },
    {
      name: "leading hyphen stripped",
      input: "-excluded term",
      expected: "excluded term",
    },
    {
      name: "hyphen inside quoted phrase preserved",
      input: '"vault-cortex"',
      expected: '"vault-cortex"',
    },
    {
      name: "mixed: quoted phrase + hyphenated + bare",
      input: 'search "exact-match" vault-cortex',
      expected: '"exact-match" "vault cortex" search',
    },
    {
      name: "dotted domain → quoted phrase",
      input: "mcpservers.org",
      expected: '"mcpservers org"',
    },
    {
      name: "dotted domain + bare terms (live failure 2026-06-09)",
      input: "mcpservers.org submission email",
      expected: '"mcpservers org" submission email',
    },
    {
      name: "dotted filename → quoted phrase",
      input: "server.json",
      expected: '"server json"',
    },
    {
      name: "slash path → quoted phrase",
      input: "deploy/local",
      expected: '"deploy local"',
    },
    {
      name: "email address → quoted phrase",
      input: "user@example.com",
      expected: '"user example com"',
    },
    {
      name: "comma-joined terms → quoted phrase",
      input: "foo,bar",
      expected: '"foo bar"',
    },
    {
      name: "apostrophe contraction → quoted phrase",
      input: "don't",
      expected: '"don t"',
    },
    {
      name: "mixed dot + hyphen compound → quoted phrase",
      input: "vault-cortex.test",
      expected: '"vault cortex test"',
    },
    {
      name: "word-edge punctuation stripped, term left bare",
      input: "email. really?!",
      expected: "email really",
    },
    {
      name: "punctuation-only input: empty result",
      input: "?!.,",
      expected: '""',
    },
    {
      name: "metachar adjoining compound: not a joiner",
      input: "vault-cortex: search",
      expected: '"vault cortex" search',
    },
    {
      name: "underscore is a bareword character, term left bare",
      input: "snake_case_name",
      expected: "snake_case_name",
    },
    {
      name: "non-ASCII term left bare",
      input: "café",
      expected: "café",
    },
    {
      name: "dot inside quoted phrase preserved",
      input: '"mcpservers.org"',
      expected: '"mcpservers.org"',
    },
  ]

  it.each(scenarios)("$name", ({ input, expected }) => {
    const result = sanitizeFtsQuery(input)
    expect(result).toBe(expected)
  })
})
