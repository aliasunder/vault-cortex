/** Declarative tool registry — the single home of every tool's name, group,
 *  and MCP annotations. Gating derives from this data: the orchestrator
 *  filters the registry through the config predicates (group flags,
 *  read-only mode via `readOnlyHint`, DISABLED_TOOLS) to compute the enabled
 *  set, and the registration wrapper injects each tool's annotations so group
 *  modules never restate them. A pure leaf module with zero imports, so
 *  config validation and tests can consume it without loading the tool or
 *  vault-operations layers. */

export const TOOL_NAMES = {
  VAULT_READ_NOTE: "vault_read_note",
  VAULT_LIST_NOTES: "vault_list_notes",
  VAULT_WRITE_NOTE: "vault_write_note",
  VAULT_PATCH_NOTE: "vault_patch_note",
  VAULT_REPLACE_IN_NOTE: "vault_replace_in_note",
  VAULT_DELETE_SPAN: "vault_delete_span",
  VAULT_REPLACE_SPAN: "vault_replace_span",
  VAULT_INSERT_AT_ANCHOR: "vault_insert_at_anchor",
  VAULT_DELETE_NOTE: "vault_delete_note",
  VAULT_MOVE_NOTE: "vault_move_note",
  VAULT_UPDATE_PROPERTIES: "vault_update_properties",
  VAULT_SEARCH: "vault_search",
  VAULT_SEARCH_BY_TAG: "vault_search_by_tag",
  VAULT_LIST_TAGS: "vault_list_tags",
  VAULT_RECENT_NOTES: "vault_recent_notes",
  VAULT_SEARCH_BY_FOLDER: "vault_search_by_folder",
  VAULT_LIST_PROPERTY_KEYS: "vault_list_property_keys",
  VAULT_LIST_PROPERTY_VALUES: "vault_list_property_values",
  VAULT_SEARCH_BY_PROPERTY: "vault_search_by_property",
  VAULT_GET_BACKLINKS: "vault_get_backlinks",
  VAULT_GET_OUTGOING_LINKS: "vault_get_outgoing_links",
  VAULT_FIND_ORPHANS: "vault_find_orphans",
  VAULT_GET_MEMORY: "vault_get_memory",
  VAULT_LIST_MEMORY_FILES: "vault_list_memory_files",
  VAULT_MEMORY_RECALL: "vault_memory_recall",
  VAULT_UPDATE_MEMORY: "vault_update_memory",
  VAULT_DELETE_MEMORY: "vault_delete_memory",
  VAULT_GET_DAILY_NOTE: "vault_get_daily_note",
  VAULT_LIST_TASKS: "vault_list_tasks",
  VAULT_CREATE_TASK: "vault_create_task",
  VAULT_UPDATE_TASK: "vault_update_task",
  VAULT_READ_FILE: "vault_read_file",
  VAULT_LIST_FILES: "vault_list_files",
} as const

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES]

/** Feature group a tool registers under. "memory" and "asset" are the
 *  flag-gated groups (MEMORY_ENABLED, FILE_TOOLS_ENABLED); the rest are
 *  always on. */
export type ToolGroup =
  "vault-crud" | "search" | "memory" | "daily-note" | "task" | "asset"

type ToolAnnotations = {
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
}

export type RegistryEntry = {
  name: ToolName
  group: ToolGroup
  annotations: ToolAnnotations
}

/** Every read tool shares this shape: pure vault reads are idempotent, and
 *  no tool reaches beyond the vault (closed world). */
const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}

/** Write tools that can overwrite or remove existing content, where a replay
 *  is not safe (a second delete fails, a second patch double-applies). */
const DESTRUCTIVE_WRITE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
}

/** Write tools that only add lines to a note — never overwrite or remove
 *  existing content — where a replay duplicates the addition. */
const ADDITIVE_WRITE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
}

export const TOOL_REGISTRY: readonly RegistryEntry[] = [
  {
    name: TOOL_NAMES.VAULT_READ_NOTE,
    group: "vault-crud",
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: TOOL_NAMES.VAULT_LIST_NOTES,
    group: "vault-crud",
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: TOOL_NAMES.VAULT_WRITE_NOTE,
    group: "vault-crud",
    annotations: DESTRUCTIVE_WRITE_ANNOTATIONS,
  },
  {
    name: TOOL_NAMES.VAULT_PATCH_NOTE,
    group: "vault-crud",
    annotations: DESTRUCTIVE_WRITE_ANNOTATIONS,
  },
  {
    name: TOOL_NAMES.VAULT_REPLACE_IN_NOTE,
    group: "vault-crud",
    annotations: DESTRUCTIVE_WRITE_ANNOTATIONS,
  },
  {
    name: TOOL_NAMES.VAULT_DELETE_SPAN,
    group: "vault-crud",
    annotations: DESTRUCTIVE_WRITE_ANNOTATIONS,
  },
  {
    name: TOOL_NAMES.VAULT_REPLACE_SPAN,
    group: "vault-crud",
    annotations: DESTRUCTIVE_WRITE_ANNOTATIONS,
  },
  {
    name: TOOL_NAMES.VAULT_INSERT_AT_ANCHOR,
    group: "vault-crud",
    annotations: ADDITIVE_WRITE_ANNOTATIONS,
  },
  {
    name: TOOL_NAMES.VAULT_DELETE_NOTE,
    group: "vault-crud",
    annotations: DESTRUCTIVE_WRITE_ANNOTATIONS,
  },
  {
    name: TOOL_NAMES.VAULT_MOVE_NOTE,
    group: "vault-crud",
    annotations: DESTRUCTIVE_WRITE_ANNOTATIONS,
  },
  {
    name: TOOL_NAMES.VAULT_UPDATE_PROPERTIES,
    group: "vault-crud",
    annotations: {
      readOnlyHint: false,
      // Shallow merge overwrites matching keys (destructive), but the same
      // merge replayed produces the same frontmatter (idempotent).
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: TOOL_NAMES.VAULT_SEARCH,
    group: "search",
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: TOOL_NAMES.VAULT_SEARCH_BY_TAG,
    group: "search",
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: TOOL_NAMES.VAULT_LIST_TAGS,
    group: "search",
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: TOOL_NAMES.VAULT_RECENT_NOTES,
    group: "search",
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: TOOL_NAMES.VAULT_SEARCH_BY_FOLDER,
    group: "search",
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: TOOL_NAMES.VAULT_LIST_PROPERTY_KEYS,
    group: "search",
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: TOOL_NAMES.VAULT_LIST_PROPERTY_VALUES,
    group: "search",
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: TOOL_NAMES.VAULT_SEARCH_BY_PROPERTY,
    group: "search",
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: TOOL_NAMES.VAULT_GET_BACKLINKS,
    group: "search",
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: TOOL_NAMES.VAULT_GET_OUTGOING_LINKS,
    group: "search",
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: TOOL_NAMES.VAULT_FIND_ORPHANS,
    group: "search",
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: TOOL_NAMES.VAULT_GET_MEMORY,
    group: "memory",
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: TOOL_NAMES.VAULT_LIST_MEMORY_FILES,
    group: "memory",
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: TOOL_NAMES.VAULT_MEMORY_RECALL,
    group: "memory",
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: TOOL_NAMES.VAULT_UPDATE_MEMORY,
    group: "memory",
    annotations: {
      readOnlyHint: false,
      // Append-only: entries are inserted, never overwritten or deleted
      // (see memoryStore.updateMemory) — additive, not destructive.
      destructiveHint: false,
      // An exact duplicate (same date + text in the same section) is a
      // no-op, so replayed calls are safe. Nuance: `date` defaults to
      // today, so identical args replayed across a date boundary append a
      // second, differently-dated entry — real client retries happen
      // within seconds, so the hint reflects the retry-safety contract.
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: TOOL_NAMES.VAULT_DELETE_MEMORY,
    group: "memory",
    annotations: DESTRUCTIVE_WRITE_ANNOTATIONS,
  },
  {
    name: TOOL_NAMES.VAULT_GET_DAILY_NOTE,
    group: "daily-note",
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: TOOL_NAMES.VAULT_LIST_TASKS,
    group: "task",
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: TOOL_NAMES.VAULT_CREATE_TASK,
    group: "task",
    annotations: ADDITIVE_WRITE_ANNOTATIONS,
  },
  {
    name: TOOL_NAMES.VAULT_UPDATE_TASK,
    group: "task",
    annotations: {
      readOnlyHint: false,
      // Status and priority changes remove existing signifiers, not just add
      // them: reopening a task strips its ✅/❌ date, `priority: null` strips
      // the priority marker, and a done/cancelled flip strips the other's date
      // (see updateTaskLineStatus / updateTaskLinePriority). Those are
      // user-authored fields the call cannot restore, so the update is
      // destructive in the annotation's sense, and not guaranteed replay-safe.
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: TOOL_NAMES.VAULT_READ_FILE,
    group: "asset",
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: TOOL_NAMES.VAULT_LIST_FILES,
    group: "asset",
    annotations: READ_ONLY_ANNOTATIONS,
  },
]

/** Registry lookup by wire name — the registration wrapper resolves each
 *  tool's annotations through this, and config validation checks
 *  DISABLED_TOOLS entries against its keys. */
export const TOOL_REGISTRY_BY_NAME: ReadonlyMap<ToolName, RegistryEntry> =
  new Map(TOOL_REGISTRY.map((entry) => [entry.name, entry]))

const TOOL_NAME_SET: ReadonlySet<string> = new Set(
  TOOL_REGISTRY.map((entry) => entry.name),
)

/** Type guard for a wire tool name — true exactly when the registry has an
 *  entry for it. Config validation uses this to reject DISABLED_TOOLS typos
 *  at boot. */
export const isToolName = (value: string): value is ToolName =>
  TOOL_NAME_SET.has(value)
