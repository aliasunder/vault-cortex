import { posix } from "node:path"
import { links } from "./links.js"

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
 * document structure: spatial grouping becomes heading nesting (up to a size
 * limit, see CANVAS_GROUP_PAIR_LIMIT), canvas position becomes reading order
 * (top-to-bottom, left-to-right), and edges become an `A → B (label)` list
 * with ids resolved to display names. Geometry is dropped entirely — it is
 * presentation, and the rendition is a reading surface, not a round-trippable
 * format (callers wanting fidelity request the raw source instead).
 *
 * The canvas-to-document idea has community precedent — e.g. the
 * Canvas2Document plugin (https://github.com/slnsys/obsidian-canvas2document)
 * converts canvases to long-form documents for humans; this rendition is
 * purpose-built for model reading, where token economy and explicit
 * relationships matter more than layout.
 *
 * Lenient by design: real Obsidian canvases carry extra properties and
 * occasionally partial entries, so unknown props are ignored and entries
 * missing their required fields are skipped rather than thrown.
 *
 * The module also extracts and rewrites the links a canvas holds, for the
 * search index and the note mover. Obsidian calls nodes "cards": a text card
 * is a `text` node, and a file card is a `file` node.
 */

/** The JSON Canvas 1.0 node shape this module reads. parseNode drops every
 *  other property; rewriteCanvasLinks keeps them by spreading the raw entry. */
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

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const optionalString = (value: unknown): string | undefined => {
  return typeof value === "string" ? value : undefined
}

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
const isContainedIn = (inner: CanvasNode, outer: CanvasNode): boolean => {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  )
}

/** The group that owns a node: the smallest-area group, other than the node
 *  itself, whose rectangle contains it, edges included (groups nest, so the
 *  smallest container is the innermost). */
const smallestContainingGroup = (
  node: CanvasNode,
  groups: readonly CanvasNode[],
): CanvasNode | undefined => {
  const containing = groups.filter((group) => {
    // The node is compared by object because IDs can repeat, and a card that
    // shares its group's ID still belongs in that group.
    if (group === node || !isContainedIn(node, group)) return false
    // Two groups with identical rectangles contain each other; without a
    // tiebreak each would claim the other as parent, neither would be
    // top-level, and both would drop out of the render entirely. Give the
    // containment one deterministic direction (higher id contains lower)
    // so one nests under the other. Content nodes are exempt — they never
    // become parents, so mutual containment is harmless there.
    const mutuallyContained = node.type === "group" && isContainedIn(group, node)

    if (!mutuallyContained) return true
    return group.id > node.id
  })

  if (containing.length === 0) return undefined
  // Equal-area ties break on the lower id so ownership is a property of the
  // canvas content, not of JSON array order.
  return containing.reduce((smallest, candidate) => {
    const candidateArea = candidate.width * candidate.height
    const smallestArea = smallest.width * smallest.height

    if (candidateArea < smallestArea) return candidate
    if (candidateArea === smallestArea && candidate.id < smallest.id) return candidate
    return smallest
  })
}

/** Spatial reading order: top-to-bottom, then left-to-right. */
const byReadingOrder = (a: CanvasNode, b: CanvasNode): number => a.y - b.y || a.x - b.x

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

// Nesting needs each node's owning group, so every node is tested against
// every group: groups × (content nodes + groups) pairs in all. A pair costs at
// most two containment checks, because a group inside another group is also
// checked the other way. 16 million pairs covers 4,000 groups alone, or 2,000
// groups beside 6,000 cards, far past a hand-made canvas, while a crafted
// canvas with more cannot stall indexing.
const CANVAS_GROUP_PAIR_LIMIT = 16_000_000

/** True when a canvas with these counts is small enough to render with its
 *  group nesting; a larger one renders flat, in reading order. */
export const canNestCanvasGroups = (counts: { contentNodes: number; groups: number }): boolean => {
  return counts.groups * (counts.contentNodes + counts.groups) <= CANVAS_GROUP_PAIR_LIMIT
}

const groupHeading = (group: CanvasNode, depth: number): string => {
  // H1 is the overview, so groups start at H2 and deeper groups cap at H6.
  const heading = "#".repeat(Math.min(2 + depth, 6))
  return `${heading} Group: ${group.label ?? "(unlabeled)"}`
}

/** The node sections with group nesting: ungrouped content first, then each
 *  top-level group's heading, its content and its child groups, depth first,
 *  all in reading order. Every node appears once, even when IDs repeat,
 *  because ownership is keyed by node object, not by ID. */
const renderNestedNodes = ({
  contentNodes,
  groups,
}: {
  contentNodes: readonly CanvasNode[]
  groups: readonly CanvasNode[]
}): string[] => {
  const membersByGroup = groupBy(contentNodes, (node) => smallestContainingGroup(node, groups))
  const childGroupsByParent = groupBy(groups, (group) => smallestContainingGroup(group, groups))
  const ungroupedNodes = membersByGroup.get(undefined) ?? []
  const topLevelGroups = childGroupsByParent.get(undefined) ?? []
  const sections = ungroupedNodes.map(renderNode)
  const frames = topLevelGroups.toReversed().map((group) => ({ group, depth: 0 }))

  // A stack of groups still to render; the last one pushed renders next, so
  // groups are pushed in reverse to come out in reading order.
  while (frames.length) {
    const frame = frames.pop()

    if (!frame) break
    const { group, depth } = frame

    sections.push(groupHeading(group, depth))
    for (const member of membersByGroup.get(group) ?? []) sections.push(renderNode(member))
    for (const child of (childGroupsByParent.get(group) ?? []).toReversed()) {
      frames.push({ group: child, depth: depth + 1 })
    }
  }
  return sections
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

/** Parses canvas JSON with a contextual error message on failure. */
const parseCanvasJson = (canvasJson: string): unknown => {
  try {
    return JSON.parse(canvasJson)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`invalid .canvas JSON: ${message}`, { cause: error })
  }
}

/**
 * Linearizes .canvas JSON into readable markdown: an overview line, ungrouped
 * node content first, each group's content under a `Group:` heading (nested
 * groups one level deeper), then a `Connections` edge list in `A → B (label)`
 * form with ids resolved to display names. A canvas too large for nesting
 * (see canNestCanvasGroups) keeps node content and group headings flat, in
 * reading order. Throws on unparseable JSON. Every valid node is rendered
 * once, even when IDs repeat; an edge to a repeated ID names the last such
 * node in reading order.
 */
export const linearizeCanvas = (canvasJson: string): string => {
  const parsed = parseCanvasJson(canvasJson)

  const rawNodes = isRecord(parsed) && Array.isArray(parsed.nodes) ? parsed.nodes : []
  const rawEdges = isRecord(parsed) && Array.isArray(parsed.edges) ? parsed.edges : []
  const nodes = rawNodes
    .map(parseNode)
    .filter((node) => node !== null)
    .toSorted(byReadingOrder)
  const edges = rawEdges.map(parseEdge).filter((edge) => edge !== null)

  const groups = nodes.filter((node) => node.type === "group")
  const contentNodes = nodes.filter((node) => node.type !== "group")
  const keepNesting = canNestCanvasGroups({
    contentNodes: contentNodes.length,
    groups: groups.length,
  })
  const nodeSections = keepNesting
    ? renderNestedNodes({ contentNodes, groups })
    : nodes.map((node) => (node.type === "group" ? groupHeading(node, 0) : renderNode(node)))

  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const edgeEndpointName = (id: string): string => {
    const node = nodeById.get(id)
    return node ? displayName(node) : `(missing node "${id}")`
  }

  const edgeLines = edges.map((edge) => {
    const label = edge.label ? ` (${edge.label})` : ""
    return `${edgeEndpointName(edge.fromNode)} → ${edgeEndpointName(edge.toNode)}${label}`
  })

  const sections = [
    `# Canvas: ${nodes.length} ${nodes.length === 1 ? "node" : "nodes"}, ${edges.length} ${edges.length === 1 ? "edge" : "edges"}`,
    ...nodeSections,
    ...(edgeLines.length > 0 ? [["## Connections", ...edgeLines].join("\n\n")] : []),
  ]
  return sections.join("\n\n")
}

/** The two kinds of link a canvas holds, each deduplicated in JSON order. */
type CanvasLinks = {
  /** The `file` path of every file card, an exact vault path. */
  fileCardPaths: string[]
  /** The targets of the links typed in text cards, without any heading or
   *  alias, before resolution. */
  textCardLinks: string[]
}

/** Extracts the links a canvas holds. A text card is read with the grammar a
 *  note body uses, so links in inline code or a fenced block are left out.
 *  Throws on unparseable JSON. */
export const extractCanvasLinks = (canvasJson: string): CanvasLinks => {
  const parsed = parseCanvasJson(canvasJson)

  const rawNodes = isRecord(parsed) && Array.isArray(parsed.nodes) ? parsed.nodes : []
  const nodes = rawNodes.map(parseNode).filter((node) => node !== null)
  const fileCardPaths = nodes.flatMap((node) => {
    return node.type === "file" && node.file ? [node.file] : []
  })
  const cardTexts = nodes.flatMap((node) => (node.type === "text" && node.text ? [node.text] : []))
  // A text card is plain Markdown with no properties block.
  const noFrontmatter = {}
  const textCardLinks = cardTexts.flatMap((cardText) => links.extractAll(cardText, noFrontmatter))

  return {
    fileCardPaths: [...new Set(fileCardPaths)],
    textCardLinks: [...new Set(textCardLinks)],
  }
}

/**
 * Serializes canvas data the way Obsidian saves a .canvas file: tab
 * indentation, each top-level key on its own line, and each array entry (one
 * node or edge) as compact JSON on its own line. With the tabs shown as
 * spaces:
 *
 *     {
 *       "nodes":[
 *         {"id":"a1","type":"text","text":"Hi","x":0,"y":0,"width":250,"height":60},
 *         {"id":"b2","type":"file","file":"Plan.md","x":300,"y":0,"width":400,"height":400}
 *       ],
 *       "edges":[]
 *     }
 */
const stringifyCanvas = (canvasData: Readonly<Record<string, unknown>>): string => {
  const renderValue = (value: unknown): string => {
    if (!Array.isArray(value) || value.length === 0) return JSON.stringify(value)

    const entryLines = value.map((entry) => `\t\t${JSON.stringify(entry)}`)
    return `[\n${entryLines.join(",\n")}\n\t]`
  }

  const keyLines = Object.entries(canvasData).map(
    ([key, value]) => `\t${JSON.stringify(key)}:${renderValue(value)}`,
  )
  return `{\n${keyLines.join(",\n")}\n}`
}

/** A rewrite result for one node: the node to write back, and how many of its
 *  links changed (0 leaves the original node object in place). */
type NodeRewrite = { node: unknown; linksRewritten: number }

/**
 * Rewrites the links in a Canvas and re-serializes it in Obsidian's format:
 * - Text cards: the Markdown goes through `rewriteCardText`.
 * - File cards: the `file` path goes through `rewriteFilePath`; null keeps it.
 * - Every other node, edge, and property is written back as parsed.
 *
 * Returns null when no link changed, so an unaffected canvas keeps its exact
 * bytes. Throws on unparseable JSON.
 */
export const rewriteCanvasLinks = (params: {
  canvasJson: string
  rewriteCardText: (text: string) => { text: string; linksRewritten: number }
  rewriteFilePath: (filePath: string) => string | null
}): { content: string; linksRewritten: number } | null => {
  const parsed = parseCanvasJson(params.canvasJson)

  if (!isRecord(parsed) || !Array.isArray(parsed.nodes)) return null

  // Nodes pass through parseNode, the same check extractCanvasLinks applies,
  // so the rewrite touches exactly the cards that function reads.
  const rewriteNode = (rawNode: unknown): NodeRewrite => {
    const node = parseNode(rawNode)
    const unchanged = { node: rawNode, linksRewritten: 0 }

    // parseNode already returns null for a non-object; isRecord narrows
    // rawNode's type so the spreads below compile.
    if (node === null || !isRecord(rawNode)) return unchanged

    if (node.type === "text" && node.text) {
      const rewrite = params.rewriteCardText(node.text)

      if (rewrite.linksRewritten === 0) return unchanged
      return { node: { ...rawNode, text: rewrite.text }, linksRewritten: rewrite.linksRewritten }
    }

    if (node.type === "file" && node.file) {
      const newFilePath = params.rewriteFilePath(node.file)

      if (newFilePath === null) return unchanged
      return { node: { ...rawNode, file: newFilePath }, linksRewritten: 1 }
    }

    return unchanged
  }

  const nodeRewrites = parsed.nodes.map(rewriteNode)
  const linksRewritten = nodeRewrites.reduce(
    (runningTotal, nodeRewrite) => runningTotal + nodeRewrite.linksRewritten,
    0,
  )

  if (linksRewritten === 0) return null

  // Spreading keeps each key's position, nodes included. Only integer-like
  // keys ("10"), which JSON Canvas never defines, move to the front.
  const rewrittenCanvas = { ...parsed, nodes: nodeRewrites.map((nodeRewrite) => nodeRewrite.node) }
  const trailingNewline = params.canvasJson.endsWith("\n") ? "\n" : ""
  return { content: `${stringifyCanvas(rewrittenCanvas)}${trailingNewline}`, linksRewritten }
}
