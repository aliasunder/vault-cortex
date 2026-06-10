import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export type Mode = "local" | "remote"

export type PlannedFile = {
  /** Filename inside the target directory (e.g. "docker-compose.yml"). */
  name: string
  content: string
}

export type FileWriteResult = {
  name: string
  status: "created" | "unchanged" | "overwritten" | "kept"
}

/**
 * Reads the bundled docker-compose template for a mode. The templates are
 * verbatim copies of deploy/<mode>/docker-compose.yml, shipped inside the
 * npm package (kept in sync by cli/src/templates.test.ts).
 */
export const readComposeTemplate = (mode: Mode): string =>
  readFileSync(
    fileURLToPath(
      new URL(`../templates/${mode}/docker-compose.yml`, import.meta.url),
    ),
    "utf8",
  )

export const planFiles = (mode: Mode, envContent: string): PlannedFile[] => [
  { name: "docker-compose.yml", content: readComposeTemplate(mode) },
  { name: ".env", content: envContent },
]

/**
 * Writes planned files into targetDir (created if missing). Existing files
 * are never overwritten silently: identical content is skipped, and differing
 * content defers to the resolveConflict callback (interactive prompt, or a
 * constant `false` in non-interactive mode).
 */
export const writeFiles = async (
  targetDir: string,
  files: PlannedFile[],
  resolveConflict: (name: string) => Promise<boolean>,
): Promise<FileWriteResult[]> => {
  mkdirSync(targetDir, { recursive: true })

  const results: FileWriteResult[] = []
  for (const file of files) {
    const filePath = join(targetDir, file.name)
    if (!existsSync(filePath)) {
      writeFileSync(filePath, file.content)
      results.push({ name: file.name, status: "created" })
      continue
    }
    if (readFileSync(filePath, "utf8") === file.content) {
      results.push({ name: file.name, status: "unchanged" })
      continue
    }
    const overwrite = await resolveConflict(file.name)
    if (!overwrite) {
      results.push({ name: file.name, status: "kept" })
      continue
    }
    writeFileSync(filePath, file.content)
    results.push({ name: file.name, status: "overwritten" })
  }
  return results
}
