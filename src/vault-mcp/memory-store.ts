/**
 * About Me/ memory store (R5).
 *
 * Reads and appends to markdown files in the `About Me/` folder.
 * Each file represents a semantic category:
 *   Principles.md, Career.md, Opinions.md, Routines.md, Preferences.md, etc.
 *
 * About Me/ files have a specific structure that this module preserves:
 *
 *   ---
 *   title: Principles
 *   type: about-me
 *   tags: [principles, self]
 *   created: 2025-08-12T09:00:00-07:00
 *   related: [Routines, Career]
 *   ---
 *
 *   # Principles
 *
 *   ## Decision heuristics
 *   - **2026-05-03**: prefer reversible decisions when context is thin
 *   - **2026-04-21**: ship the smallest thing that proves the idea
 *
 *   ## Working style
 *   - **2026-05-01**: deep work in the morning, meetings after lunch
 *
 * Invariants:
 *   - Frontmatter is preserved verbatim (parse with gray-matter; never
 *     reserialize via raw string concat).
 *   - Sections are H2 (`##`).
 *   - Entries are bullet-list items: `- **YYYY-MM-DD**: {entry text}`.
 *   - Newest-first within each section by default.
 *
 * This is the "who am I" layer — any AI agent with vault-cortex
 * connected can read these files to understand who you are across
 * conversations and tools.
 */

// TODO: implement all functions below
//
// Key imports needed:
//   readFile, writeFile, readdir from "node:fs/promises"
//   join from "node:path"
//   matter from "gray-matter"

const MEMORY_DIR = "About Me";

export type MemoryHeading = {
  level: 1 | 2;          // H1 = file title, H2 = section
  text: string;          // heading text (no leading "#")
  entryCount?: number;   // number of `- **YYYY-MM-DD**: ...` bullets in section
};

export type MemoryFileOutline = {
  file: string;          // base name without .md (e.g. "Principles")
  title: string;         // from frontmatter `title` (falls back to file)
  headings: MemoryHeading[];
};

/**
 * Read a memory file (or all of them concatenated if `file` omitted).
 * If `section` is given, returns only the body under that H2 heading.
 *
 * Example call:
 *   getMemory("/vault", "Principles", "Decision heuristics")
 *
 * Example response (string):
 *   "- **2026-05-03**: prefer reversible decisions when context is thin\n
 *    - **2026-04-21**: ship the smallest thing that proves the idea"
 *
 * Example call (no args):
 *   getMemory("/vault")
 *
 * Example response (string): all About Me/*.md concatenated with
 *   `\n\n---\n\n` separators between files, frontmatter stripped.
 */
export const getMemory = async (
  _vaultPath: string,
  _file?: string,
  _section?: string,
): Promise<string> => {
  // TODO: implement
  // - If file:       read About Me/{file}.md, strip frontmatter
  //   - If section:  parse markdown, return body under matching H2
  // - If !file:      readdir, concat all files (frontmatter stripped),
  //                  separated by `\n\n---\n\n`
  // - Errors with a clear message if file or section not found
  throw new Error("Not implemented");
};

/**
 * Append a dated entry to a section of a memory file.
 *
 * Server prefixes the date — callers pass raw entry text only.
 * The server parses with gray-matter, locates the matching H2,
 * inserts `- **{date}**: {entry}` at the top of that section's
 * bullet list (newest-first), and re-serializes losslessly.
 *
 * Errors if file or section doesn't exist — agent must call
 * `listMemoryFiles` first to discover valid section names.
 *
 * Example call:
 *   updateMemory("/vault", "Principles", "Decision heuristics",
 *                "prefer reversible decisions when context is thin")
 *
 * Example file diff:
 *   ## Decision heuristics
 *  +- **2026-05-03**: prefer reversible decisions when context is thin
 *   - **2026-04-21**: ship the smallest thing that proves the idea
 */
export const updateMemory = async (
  _vaultPath: string,
  _file: string,
  _section: string,
  _entry: string,
  _options?: {
    date?: string;                // ISO YYYY-MM-DD; defaults to today
    position?: "top" | "bottom";  // defaults to "top"
  },
): Promise<void> => {
  // TODO: implement
  // - Read About Me/{file}.md
  // - Parse with gray-matter → { data: frontmatter, content: body }
  // - Walk body lines, locate `## {section}` (case-insensitive trim match)
  //   - Throw if not found
  // - Find the bullet list directly under that heading (consecutive
  //   lines starting with `- `; stops at next heading or blank-then-non-bullet)
  // - Insert `- **{date}**: {entry}` at top (default) or bottom
  // - matter.stringify(newBody, frontmatter) → write back
  // - Frontmatter must round-trip verbatim (key order, quoting)
  throw new Error("Not implemented");
};

/**
 * Discovery / outline tool — does NOT return memory entries.
 * Returns one entry per About Me/ file with its title and heading
 * structure (H1 file title + H2 sections, with per-section entry
 * counts). Call this first to discover valid section names before
 * `updateMemory`, `getMemory`, or `deleteMemory`.
 *
 * Example call:
 *   listMemoryFiles("/vault")
 *
 * Example response:
 *   [
 *     {
 *       file: "Principles",
 *       title: "Principles",
 *       headings: [
 *         { level: 1, text: "Principles" },
 *         { level: 2, text: "Decision heuristics", entryCount: 12 },
 *         { level: 2, text: "Working style",       entryCount: 7  },
 *         { level: 2, text: "Communication",       entryCount: 4  }
 *       ]
 *     },
 *     { file: "Career", title: "Career", headings: [...] }
 *   ]
 */
export const listMemoryFiles = async (
  _vaultPath: string,
): Promise<MemoryFileOutline[]> => {
  // TODO: implement
  // - readdir About Me/, filter to .md
  // - For each: parse with gray-matter
  //   - title = frontmatter.title ?? base filename
  //   - Walk body lines:
  //     - `# X`  → push { level: 1, text: "X" }
  //     - `## X` → push { level: 2, text: "X", entryCount: <count of
  //                      `- **YYYY-MM-DD**:` bullets until next heading> }
  return [];
};

/**
 * Delete a single dated entry from a memory file's section.
 *
 * Identification is by exact `(date, entry)` pair to avoid ambiguity.
 * The agent should call `getMemory(file, section)` first to see what's
 * there, then pass the exact text back.
 *
 * Errors on:
 *   - file not found
 *   - section not found
 *   - no bullet matching `- **{date}**: {entry}`
 *   - more than one bullet matching (shouldn't happen given date+text,
 *     but guard anyway — surface "ambiguous match" rather than
 *     silently picking one)
 *
 * Example call:
 *   deleteMemory("/vault", "Principles", "Decision heuristics",
 *                "2026-04-21",
 *                "ship the smallest thing that proves the idea")
 *
 * Example file diff:
 *   ## Decision heuristics
 *   - **2026-05-03**: prefer reversible decisions when context is thin
 *  -- **2026-04-21**: ship the smallest thing that proves the idea
 *
 * Example error:
 *   deleteMemory(..., "2026-04-21", "nonexistent text")
 *   // → Error: no entry matching (2026-04-21, "nonexistent text")
 *   //   under ## Decision heuristics in About Me/Principles.md
 */
export const deleteMemory = async (
  _vaultPath: string,
  _file: string,
  _section: string,
  _date: string,        // ISO YYYY-MM-DD
  _entry: string,       // exact entry text (no date prefix)
): Promise<void> => {
  // TODO: implement
  // - Read About Me/{file}.md
  // - Parse with gray-matter
  // - Locate `## {section}` H2 (case-insensitive trim match)
  // - Find bullets matching `- **{date}**: {entry}` (exact text match)
  //   - 0 matches → throw "no entry matching ..."
  //   - >1 matches → throw "ambiguous: N entries match ..."
  //   - 1 match → remove that line
  // - matter.stringify(newBody, frontmatter) → write back
  // - Frontmatter must round-trip verbatim
  throw new Error("Not implemented");
};
