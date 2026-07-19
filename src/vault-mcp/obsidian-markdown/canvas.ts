import { posix } from "node:path"

/**
 * Linearizes an Obsidian .canvas file (JSON Canvas 1.0 —
 * https://jsoncanvas.org) into a readable markdown rendition.
 *
 * Why this exists: a canvas file is meaning buried in presentation. Its
 * content (card text, file references) and relationships (grouping,
 * labeled edges) are scattered through coordinate records and joined by
 * opaque node ids — a reader consuming the raw JSON spends most of its
 * attention on `x`/`y`/`width`/`height` noise and mental id-joins. This
 * transform keeps exactly what carries meaning and re-expresses it as
 * document structure: spatial grouping becomes heading nesting, canvas
 * position becomes reading order (top-to-bottom, left-to-right), and
 * edges become an `A → B (label)` list with ids resolved to display
 * names. Geometry is dropped entirely — it is presentation, and the
 * rendition is a reading surface, not a round-trippable format (callers
 * wanting fidelity request the raw source instead).
 *
 * The canvas-to-document idea has community precedent — e.g. the
 * Canvas2Document plugin (https://github.com/slnsys/obsidian-canvas2document)
 * converts canvases to long-form documents for humans; this rendition is
 * purpose-built for model reading, where token economy and explicit
 * relationships matter more than layout.
 *
 * Lenient by design: real Obsidian canvases carry extra properties and
 * occasionally partial entries, so unknown props are ignored and entries
 * missing their required fields are skipped rather than thrown. Only
 * unparseable JSON throws.
 */

/** The JSON Canvas 1.0 node shape this linearizer consumes. Only the fields
 *  it reads — unknown properties pass through untouched. */
type CanvasNode = Readonly<{
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  text?: string | undefined
  file?: string | undefined
  subpath?: string | undefined
  url?: string | undefined
  label?: string | undefined
}>

type CanvasEdge = Readonly<{
  fromNode: string
  toNode: string
  label?: string | undefined
}>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

/** Narrows one raw array entry to a node, or null when its required JSON
 *  Canvas fields are missing/mistyped (the entry is then skipped, not thrown). */
const parseNode = (raw: unknown): CanvasNode | null => {
  if (!isRecord(raw)) return null
  const { id, type, x, y, width, height } = raw
  if (typeof id !== "string" || typeof type !== "string") return null
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number"
  ) {
    return null
  }
  return {
    id,
    type,
    x,
    y,
    width,
    height,
    text: optionalString(raw.text),
    file: optionalString(raw.file),
    subpath: optionalString(raw.subpath),
    url: optionalString(raw.url),
    label: optionalString(raw.label),
  }
}

const parseEdge = (raw: unknown): CanvasEdge | null => {
  if (!isRecord(raw)) return null
  const { fromNode, toNode } = raw
  if (typeof fromNode !== "string" || typeof toNode !== "string") return null
  return { fromNode, toNode, label: optionalString(raw.label) }
}

/** True when `inner`'s rectangle lies fully inside `outer`'s — JSON Canvas
 *  group membership is spatial containment, not a structural parent field. */
const isContainedIn = (inner: CanvasNode, outer: CanvasNode): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height

/** The group that owns a node: the smallest-area group strictly containing
 *  it (groups nest, so the smallest container is the innermost). */
const smallestContainingGroup = (
  node: CanvasNode,
  groups: readonly CanvasNode[],
): CanvasNode | undefined => {
  const containing = groups.filter((group) => {
    if (group.id === node.id || !isContainedIn(node, group)) return false
    // Two groups with identical rectangles contain each other; without a
    // tiebreak each would claim the other as parent, neither would be
    // top-level, and both would drop out of the render entirely. Give the
    // containment one deterministic direction (higher id contains lower)
    // so one nests under the other. Content nodes are exempt — they never
    // become parents, so mutual containment is harmless there.
    const mutuallyContained =
      node.type === "group" && isContainedIn(group, node)
    return !mutuallyContained || group.id > node.id
  })
  if (containing.length === 0) return undefined
  // Equal-area ties break on the lower id so ownership is a property of the
  // canvas content, not of JSON array order.
  return containing.reduce((smallest, candidate) => {
    const candidateArea = candidate.width * candidate.height
    const smallestArea = smallest.width * smallest.height
    if (candidateArea < smallestArea) return candidate
    if (candidateArea === smallestArea && candidate.id < smallest.id)
      return candidate
    return smallest
  })
}

/** Spatial reading order: top-to-bottom, then left-to-right. */
const byReadingOrder = (a: CanvasNode, b: CanvasNode): number =>
  a.y - b.y || a.x - b.x

/** Display name for the edge list: first line of a text node, filename of a
 *  file node, a group's label, a link's url. */
const displayName = (node: CanvasNode): string => {
  if (node.type === "text") {
    const firstLine = (node.text ?? "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0)
    // Text nodes often open with a markdown heading — "# Title" reads as
    // "Title" in an edge list. Only ATX headings (hashes + whitespace) are
    // stripped; an Obsidian tag like "#project" keeps its hash.
    return firstLine ? firstLine.replace(/^#+\s+/, "") : "(empty text node)"
  }
  if (node.type === "file") {
    return node.file ? posix.basename(node.file) : "(file node)"
  }
  if (node.type === "link") return node.url ?? "(link node)"
  if (node.type === "group") return node.label ?? "(unlabeled group)"
  return `(${node.type} node)`
}

/** One node's rendition: a `[type]` marker, then its content. */
const renderNode = (node: CanvasNode): string => {
  if (node.type === "text") return `[text]\n${node.text ?? ""}`
  if (node.type === "file") {
    const subpath = node.subpath ?? ""
    return `[file] → ${node.file ?? "(missing file path)"}${subpath}`
  }
  if (node.type === "link") return `[link] → ${node.url ?? "(missing url)"}`
  return `[${node.type}]`
}

/** Renders a group section: heading, member nodes in reading order, then
 *  child groups recursively one heading level deeper (capped at H6). */
const renderGroup = (
  group: CanvasNode,
  depth: number,
  membersByGroupId: ReadonlyMap<string | undefined, CanvasNode[]>,
  childGroupsByParentId: ReadonlyMap<string | undefined, CanvasNode[]>,
): string => {
  const heading = "#".repeat(Math.min(2 + depth, 6))
  const members = membersByGroupId.get(group.id) ?? []
  const childGroups = childGroupsByParentId.get(group.id) ?? []
  return [
    `${heading} Group: ${group.label ?? "(unlabeled)"}`,
    ...members.map(renderNode),
    ...childGroups.map((child) =>
      renderGroup(child, depth + 1, membersByGroupId, childGroupsByParentId),
    ),
  ].join("\n\n")
}

/** Groups a list by a key function, preserving each bucket's insertion order. */
const groupBy = <Key, Item>(
  items: readonly Item[],
  keyOf: (item: Item) => Key,
): Map<Key, Item[]> => {
  // Plain loop with bucket mutation: building a multi-bucket Map immutably
  // would re-spread every bucket per item for no readability gain.
  const buckets = new Map<Key, Item[]>()
  for (const item of items) {
    const key = keyOf(item)
    const bucket = buckets.get(key)
    if (bucket) {
      bucket.push(item)
      continue
    }
    buckets.set(key, [item])
  }
  return buckets
}

/**
 * Linearizes .canvas JSON into readable markdown: an overview line, ungrouped
 * node content first, each group's content under a `Group:` heading (nested
 * groups one level deeper), then a `Connections` edge list in `A → B (label)`
 * form with ids resolved to display names. Throws only on unparseable JSON.
 */
export const linearizeCanvas = (canvasJson: string): string => {
  const parsed = ((): unknown => {
    try {
      return JSON.parse(canvasJson)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`invalid .canvas JSON: ${message}`, { cause: error })
    }
  })()

  const rawNodes =
    isRecord(parsed) && Array.isArray(parsed.nodes) ? parsed.nodes : []
  const rawEdges =
    isRecord(parsed) && Array.isArray(parsed.edges) ? parsed.edges : []
  const nodes = rawNodes
    .map(parseNode)
    .filter((node) => node !== null)
    .sort(byReadingOrder)
  const edges = rawEdges.map(parseEdge).filter((edge) => edge !== null)

  const groups = nodes.filter((node) => node.type === "group")
  const contentNodes = nodes.filter((node) => node.type !== "group")
  const membersByGroupId = groupBy(
    contentNodes,
    (node) => smallestContainingGroup(node, groups)?.id,
  )
  const childGroupsByParentId = groupBy(
    groups,
    (group) => smallestContainingGroup(group, groups)?.id,
  )

  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const edgeEndpointName = (id: string): string => {
    const node = nodeById.get(id)
    return node ? displayName(node) : `(missing node "${id}")`
  }

  const ungroupedNodes = membersByGroupId.get(undefined) ?? []
  const topLevelGroups = childGroupsByParentId.get(undefined) ?? []
  const edgeLines = edges.map((edge) => {
    const label = edge.label ? ` (${edge.label})` : ""
    return `${edgeEndpointName(edge.fromNode)} → ${edgeEndpointName(edge.toNode)}${label}`
  })

  const sections = [
    `# Canvas: ${nodes.length} ${nodes.length === 1 ? "node" : "nodes"}, ${edges.length} ${edges.length === 1 ? "edge" : "edges"}`,
    ...ungroupedNodes.map(renderNode),
    ...topLevelGroups.map((group) =>
      renderGroup(group, 0, membersByGroupId, childGroupsByParentId),
    ),
    ...(edgeLines.length > 0
      ? [["## Connections", ...edgeLines].join("\n\n")]
      : []),
  ]
  return sections.join("\n\n")
}
