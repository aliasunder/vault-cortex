import { posix } from "node:path"

/** What a non-markdown vault file holds, which decides how it is read and
 *  indexed. "other" covers every extension the map below does not list, and
 *  files with no extension. */
export type FileKind = "image" | "canvas" | "pdf" | "text" | "html" | "script" | "other"

/** Keys are lowercase, and lookups lowercase the extension first, so a
 *  scanner's ".PDF" is a PDF. .svg is XML source; .base is Obsidian Bases
 *  YAML. */
const FILE_KINDS_BY_EXTENSION: ReadonlyMap<string, FileKind> = new Map([
  [".png", "image"],
  [".jpg", "image"],
  [".jpeg", "image"],
  [".gif", "image"],
  [".webp", "image"],
  [".canvas", "canvas"],
  [".pdf", "pdf"],
  [".txt", "text"],
  [".csv", "text"],
  [".json", "text"],
  [".xml", "text"],
  [".svg", "text"],
  [".log", "text"],
  [".yaml", "text"],
  [".yml", "text"],
  [".base", "text"],
  [".html", "html"],
  [".htm", "html"],
  [".py", "script"],
  [".sh", "script"],
  [".ps1", "script"],
])

export const getFileKind = (filePath: string): FileKind => {
  return FILE_KINDS_BY_EXTENSION.get(posix.extname(filePath).toLowerCase()) ?? "other"
}

export const isCanvasPath = (filePath: string): boolean => {
  return getFileKind(filePath) === "canvas"
}

/** The lowercase extensions mapped to `kind`, in the map's order. */
export const getExtensionsOfKind = (kind: FileKind): string[] => {
  return [...FILE_KINDS_BY_EXTENSION]
    .filter(([, mappedKind]) => mappedKind === kind)
    .map(([extension]) => extension)
}
