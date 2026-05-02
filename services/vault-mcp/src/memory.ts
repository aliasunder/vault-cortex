/**
 * About Me/ memory abstraction (R5).
 *
 * The memory layer reads and appends to files in the `About Me/` folder.
 * Each file represents a semantic category (career, principles, opinions,
 * routines, preferences). Entries are appended with a date prefix.
 *
 * This is the "who am I" layer that makes AI agents personalized —
 * any agent with vault-cortex connected knows who you are.
 */

import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const MEMORY_DIR = "About Me";

/** Read a memory file. If no file specified, concatenate all. */
export async function getMemory(
  vaultPath: string,
  file?: string,
): Promise<string> {
  if (file) {
    const filePath = join(vaultPath, MEMORY_DIR, `${file}.md`);
    return readFile(filePath, "utf8");
  }

  // Read all memory files
  const memoryDir = join(vaultPath, MEMORY_DIR);
  const entries = await readdir(memoryDir, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile() && e.name.endsWith(".md"));

  const contents = await Promise.all(
    files.map(async (f) => {
      const content = await readFile(join(memoryDir, f.name), "utf8");
      return `## ${f.name.replace(".md", "")}\n\n${content}`;
    }),
  );
  return contents.join("\n\n---\n\n");
}

/** Append a dated entry to a memory file. */
export async function updateMemory(
  vaultPath: string,
  file: string,
  entry: string,
): Promise<void> {
  const filePath = join(vaultPath, MEMORY_DIR, `${file}.md`);
  const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  const formatted = `\n\n### ${date}\n\n${entry}`;
  // TODO: Handle case where file doesn't exist yet (create with header)
  const existing = await readFile(filePath, "utf8").catch(() => `# ${file}\n`);
  await writeFile(filePath, existing + formatted, "utf8");
}

/** List memory files with their top-level headings. */
export async function listMemories(
  vaultPath: string,
): Promise<Array<{ file: string; headings: string[] }>> {
  const memoryDir = join(vaultPath, MEMORY_DIR);
  const entries = await readdir(memoryDir, { withFileTypes: true }).catch(
    () => [],
  );
  const files = entries.filter(
    (e) => e.isFile() && e.name.endsWith(".md"),
  );

  return Promise.all(
    files.map(async (f) => {
      const content = await readFile(join(memoryDir, f.name), "utf8");
      const headings = content
        .split("\n")
        .filter((line) => line.startsWith("#"))
        .map((line) => line.replace(/^#+\s*/, ""));
      return { file: f.name.replace(".md", ""), headings };
    }),
  );
}
