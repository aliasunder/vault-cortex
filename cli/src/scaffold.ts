import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export type Mode = "local" | "remote"

export type FileToWrite = {
  /** Filename inside the target directory (e.g. "docker-compose.yml"). */
  name: string
  content: string
  /** Unix permission bits for files holding secrets (e.g. 0o600 for .env). */
  mode?: number
}

export type FileWriteResult = {
  name: string
  status: "created" | "unchanged" | "overwritten" | "kept"
}

/** Default host port — matches the compose templates' `${PORT:-8000}`. */
export const DEFAULT_PORT = 8000

/** Matches an active (uncommented) PORT line in a .env file. */
const ENV_PORT_LINE = /^PORT=(\d+)\s*$/m

/**
 * Reads the bundled docker-compose template for a mode. The templates are
 * verbatim copies of deploy/<mode>/docker-compose.yml, shipped inside the
 * npm package (kept in sync by cli/src/__tests__/templates.test.ts).
 */
export const readComposeTemplate = (mode: Mode): string =>
  readFileSync(
    fileURLToPath(
      new URL(`../templates/${mode}/docker-compose.yml`, import.meta.url),
    ),
    "utf8",
  )

export const buildFilesToWrite = (
  mode: Mode,
  envContent: string,
): FileToWrite[] => [
  { name: "docker-compose.yml", content: readComposeTemplate(mode) },
  // .env holds the bearer token (and possibly a vault password) — owner-only.
  { name: ".env", content: envContent, mode: 0o600 },
]

/**
 * Reads the host port from the .env that is actually on disk — which may be
 * a pre-existing file this run chose to keep, with a PORT override the
 * generated default doesn't have. Falls back to DEFAULT_PORT when the file
 * or an uncommented PORT line is absent.
 */
export const readEnvPort = (envFilePath: string): number => {
  if (!existsSync(envFilePath)) return DEFAULT_PORT
  const match = ENV_PORT_LINE.exec(readFileSync(envFilePath, "utf8"))
  return match === null ? DEFAULT_PORT : Number(match[1])
}

/**
 * Writes the files into targetDir (created if missing). Existing files
 * are never overwritten silently: identical content is skipped, and differing
 * content defers to the resolveConflict callback (interactive prompt, or a
 * constant `false` in non-interactive mode).
 */
export const writeFiles = async (
  params: { targetDir: string; files: FileToWrite[] },
  resolveConflict: (name: string) => Promise<boolean>,
): Promise<FileWriteResult[]> => {
  const { targetDir, files } = params
  mkdirSync(targetDir, { recursive: true })

  const results: FileWriteResult[] = []
  for (const file of files) {
    const filePath = join(targetDir, file.name)
    if (!existsSync(filePath)) {
      writeFileSync(filePath, file.content, { mode: file.mode })
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
    // writeFileSync's mode only applies on creation — tighten explicitly
    // when replacing an existing file.
    writeFileSync(filePath, file.content)
    if (file.mode !== undefined) chmodSync(filePath, file.mode)
    results.push({ name: file.name, status: "overwritten" })
  }
  return results
}
