/** Strips Obsidian/Markdown syntax to produce plain text for embedding.
 *
 * Pure transform: string in, string out. The result preserves semantic content
 * (words, sentences) while removing markup that degrades embedding quality. */

/** Strips markdown and Obsidian syntax, keeping only the semantic text content.
 *  Wikilinks become their display text, comments are removed, formatting
 *  markers (bold, italic, headings, callouts, block quotes) are stripped. */
export const stripMarkdownSyntax = (text: string): string =>
  text
    // Wikilinks: [[target|display]] → display, [[target]] → target
    .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    // Markdown links: [text](url) → text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Obsidian comments: %% ... %% (single-line and multi-line)
    .replace(/%%[^]*?%%/g, "")
    // Heading markers: ## → removed (keep the text)
    .replace(/^#{1,6}\s+/gm, "")
    // Bold/italic markers
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
    // Callout markers: > [!type] Title → Title
    .replace(/^>\s*\[![^\]]*\]\s*/gm, "")
    // Block quotes: > text → text
    .replace(/^>\s?/gm, "")
