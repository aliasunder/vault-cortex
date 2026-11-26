import { posix } from "node:path"
import { stripLeadingBom } from "./frontmatter.js"
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

/** A node with its id's rank: the id's position in the sorted list of distinct ids
 *  that the canvas's nodes and edges use (rankCanvasIds). */
type RankedNode = CanvasNode & Readonly<{ idRank: number }>

/** An edge with the ranks of its two endpoint ids (rankCanvasIds). */
type RankedEdge = CanvasEdge & Readonly<{ fromRank: number; toRank: number }>

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

/** Orders ids as JavaScript's `<` orders strings: by UTF-16 code unit. The id sort
 *  and findIdRank's binary search both use it, because the search must follow the sort. */
const compareIds = (left: string, right: string): number => {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/** The position of `id` in `rankedIds`, which holds each id once, in compareIds order.
 *  It searches instead of reading a Map, which slows on long ids as rankCanvasIds describes. */
const findIdRank = (rankedIds: readonly string[], id: string): number => {
  // A binary search narrows the half-open range [low, high) to the id's position.
  let low = 0
  let high = rankedIds.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    const middleId = rankedIds[middle]

    // middle lies in [low, high), inside the list, so an id is always there.
    if (middleId === undefined) throw new Error(`no ranked id at position ${middle}`)
    const order = compareIds(middleId, id)

    if (order === 0) return middle
    if (order < 0) {
      low = middle + 1
      continue
    }
    high = middle
  }
  throw new Error("a canvas id is missing from the ranked ids")
}

/**
 * Gives every node id and edge endpoint a rank: equal ids share a rank, and
 * ranks follow compareIds order, which smallestContainingGroup's tie-breaks rely
 * on. An endpoint id that no node has still gets a rank, which no node shares, so
 * the edge list names that endpoint as missing. Ranks run from 0 to `rankCount - 1`,
 * so later steps compare numbers and index arrays by rank instead of using ids:
 * - a crafted canvas can hold thousands of long ids that share a prefix, and
 *   nesting can compare ids once per group and node pair, so each of those
 *   comparisons would read the whole prefix;
 * - V8 hashes a string longer than 16,383 characters by its length alone, so a
 *   Map or Set keyed by such ids compares each new key with every earlier one.
 *
 * Ranking compares ids only in one sort, one pass over the sorted ids and one
 * binary search per id.
 */
const rankCanvasIds = (params: {
  nodes: readonly CanvasNode[]
  edges: readonly CanvasEdge[]
}): { nodes: RankedNode[]; edges: RankedEdge[]; rankCount: number } => {
  const endpointIds = params.edges.flatMap((edge) => [edge.fromNode, edge.toNode])
  const sortedIds = [...params.nodes.map((node) => node.id), ...endpointIds].toSorted(compareIds)

  // Sorting puts equal ids side by side, so keeping each id that differs from the
  // one before it removes duplicates without a Set.
  const rankedIds = sortedIds.filter((id, index) => index === 0 || id !== sortedIds[index - 1])

  return {
    nodes: params.nodes.map((node) => ({ ...node, idRank: findIdRank(rankedIds, node.id) })),
    edges: params.edges.map((edge) => ({
      ...edge,
      fromRank: findIdRank(rankedIds, edge.fromNode),
      toRank: findIdRank(rankedIds, edge.toNode),
    })),
    rankCount: rankedIds.length,
  }
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
  node: RankedNode,
  groups: readonly RankedNode[],
): RankedNode | undefined => {
  const containing = groups.filter((group) => {
    // The node is compared by object because IDs can repeat, and a card that
    // shares its group's ID still belongs in that group.
    if (group === node || !isContainedIn(node, group)) return false

    // Two groups with identical rectangles contain each other; without a
    // tiebreak each would claim the other as parent, neither would be
    // top-level, and both would drop out of the render entirely. Give the
    // containment one deterministic direction (the id later in string order
    // contains the earlier) so one nests under the other. Content nodes are
    // exempt — they never become parents, so mutual containment is harmless
    // there.
    const mutuallyContained = node.type === "group" && isContainedIn(group, node)

    if (!mutuallyContained) return true
    return group.idRank > node.idRank
  })

  if (containing.length === 0) return undefined

  // Equal-area ties break on the lower id so ownership is a property of the
  // canvas content, not of JSON array order, whenever the ids differ.
  return containing.reduce((smallest, candidate) => {
    const candidateArea = candidate.width * candidate.height
    const smallestArea = smallest.width * smallest.height

    if (candidateArea < smallestArea) return candidate
    if (candidateArea === smallestArea && candidate.idRank < smallest.idRank) return candidate
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

// An edge line names both of its endpoints, and one node can sit on every
// edge, so a long name would repeat into each line. 100 code points still
// tells cards apart in the list, and each node's own section keeps its full
// text.
const EDGE_NAME_CODE_POINT_LIMIT = 100

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** Cuts the node's display name to whole graphemes within
 *  EDGE_NAME_CODE_POINT_LIMIT code points, ending in an ellipsis when anything
 *  was cut. */
const edgeLineName = (node: CanvasNode): string => {
  const name = displayName(node)

  // A string never holds more code points than UTF-16 units.
  if (name.length <= EDGE_NAME_CODE_POINT_LIMIT) return name

  const codePointPrefix = name[Symbol.iterator]()
    .take(EDGE_NAME_CODE_POINT_LIMIT)
    .toArray()
    .join("")
  const cutIndex = codePointPrefix.length
  const nameFitsLimit = cutIndex === name.length

  if (nameFitsLimit) return name

  // Whether the cut splits a grapheme depends on the text before it and the
  // one code point after it, at most two UTF-16 units.
  const graphemeAtCut = graphemeSegmenter.segment(name.slice(0, cutIndex + 2)).containing(cutIndex)

  // cutIndex is inside the segmented text, so a segment always contains it.
  if (!graphemeAtCut) throw new Error(`no grapheme contains index ${cutIndex}`)
  return `${name.slice(0, graphemeAtCut.index)}…`
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

/** One node's section when groups are not nested: a group becomes a top-level heading. */
const renderFlatNode = (node: CanvasNode): string => {
  if (node.type === "group") return groupHeading(node, 0)
  return renderNode(node)
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

/** The node sections with group nesting: ungrouped content first, then each
 *  top-level group's heading, its content and its child groups, depth first,
 *  all in reading order. Every node appears once, even when IDs repeat,
 *  because ownership is keyed by node object, not by ID. */
const renderNestedNodes = ({
  contentNodes,
  groups,
}: {
  contentNodes: readonly RankedNode[]
  groups: readonly RankedNode[]
}): string[] => {
  const membersByGroup = groupBy(contentNodes, (node) => smallestContainingGroup(node, groups))
  const childGroupsByParent = groupBy(groups, (group) => smallestContainingGroup(group, groups))
  const ungroupedNodes = membersByGroup.get(undefined) ?? []
  const topLevelGroups = childGroupsByParent.get(undefined) ?? []
  const sections = ungroupedNodes.map(renderNode)
  const groupsToRender = topLevelGroups.toReversed().map((group) => ({ group, depth: 0 }))

  // A stack of groups still to render; the last one pushed renders next, so
  // groups are pushed in reverse to come out in reading order.
  for (let groupAtDepth = groupsToRender.pop(); groupAtDepth; groupAtDepth = groupsToRender.pop()) {
    const { group, depth } = groupAtDepth

    sections.push(groupHeading(group, depth))
    for (const member of membersByGroup.get(group) ?? []) sections.push(renderNode(member))
    for (const child of (childGroupsByParent.get(group) ?? []).toReversed()) {
      groupsToRender.push({ group: child, depth: depth + 1 })
    }
  }
  return sections
}

/** Parses canvas JSON with a contextual error message on failure. */
const parseCanvasJson = (canvasJson: string): unknown => {
  try {
    // Callers pass a Canvas's text as saved, so a leading byte-order mark from a Windows editor
    // reaches here. JSON.parse rejects the mark, and RFC 8259 §8.1 lets a JSON parser skip it:
    // https://www.rfc-editor.org/rfc/rfc8259#section-8.1
    return JSON.parse(stripLeadingBom(canvasJson))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`invalid .canvas JSON: ${message}`, { cause: error })
  }
}

/**
 * Throws unless the text parses as JSON Canvas 1.0's top level
 * (https://jsoncanvas.org/spec/1.0/), which is stricter than linearizeCanvas,
 * a reader that accepts any JSON:
 * - the top level is an object, and `{}` is an empty canvas;
 * - `nodes` and `edges` are arrays when present, as the spec makes both optional.
 */
export const assertCanvasTopLevel = (canvasJson: string): void => {
  const parsed = parseCanvasJson(canvasJson)

  if (!isRecord(parsed)) {
    throw new Error("invalid .canvas JSON: the top level must be an object")
  }
  for (const listKey of ["nodes", "edges"]) {
    // A null list is refused: the spec types each list as an array, and a
    // canvas without one leaves the key out instead of setting it to null
    if (parsed[listKey] !== undefined && !Array.isArray(parsed[listKey])) {
      throw new Error(`invalid .canvas JSON: "${listKey}" must be an array`)
    }
  }
}

/**
 * Linearizes .canvas JSON into readable markdown: an overview line, ungrouped
 * node content first, each group's content under a `Group:` heading (nested
 * groups one level deeper), then a `Connections` edge list in `A → B (label)`
 * form with ids resolved to display names, each cut at
 * EDGE_NAME_CODE_POINT_LIMIT code points. A canvas too large for nesting
 * (see canNestCanvasGroups) keeps node content and group headings flat, in
 * reading order. Throws on unparseable JSON. Every valid node is rendered
 * once, even when IDs repeat; an edge to a repeated ID names the last such
 * node in reading order.
 */
export const linearizeCanvas = (canvasJson: string): string => {
  const parsed = parseCanvasJson(canvasJson)

  const rawNodes = isRecord(parsed) && Array.isArray(parsed.nodes) ? parsed.nodes : []
  const rawEdges = isRecord(parsed) && Array.isArray(parsed.edges) ? parsed.edges : []
  const ranked = rankCanvasIds({
    nodes: rawNodes.map(parseNode).filter((node) => node !== null),
    edges: rawEdges.map(parseEdge).filter((edge) => edge !== null),
  })
  const nodes = ranked.nodes.toSorted(byReadingOrder)
  const { edges } = ranked

  const groups = nodes.filter((node) => node.type === "group")
  const contentNodes = nodes.filter((node) => node.type !== "group")
  const keepNesting = canNestCanvasGroups({
    contentNodes: contentNodes.length,
    groups: groups.length,
  })
  const nodeSections = keepNesting
    ? renderNestedNodes({ contentNodes, groups })
    : nodes.map(renderFlatNode)

  // Each node's name is worked out once, because an edge list can name the
  // same node on every line and a text card's name scans its whole text:
  // - The names sit in an array indexed by rank, not a Map. V8 hashes integer
  //   Map keys with a fixed function, so a canvas could pick ids whose ranks
  //   share one bucket and make every lookup walk it.
  // - The array is filled to its full length first, so V8 keeps it a plain
  //   array instead of a hash table keyed by index.
  // - A later node with a repeated ID replaces the earlier one's entry.
  const edgeNameByRank = Array.from<string | undefined>({ length: ranked.rankCount })
  for (const node of nodes) {
    edgeNameByRank[node.idRank] = edgeLineName(node)
  }
  const edgeEndpointName = (endpoint: { rank: number; id: string }): string => {
    return edgeNameByRank[endpoint.rank] ?? `(missing node "${endpoint.id}")`
  }

  const edgeLines = edges.map((edge) => {
    const label = edge.label ? ` (${edge.label})` : ""
    const fromName = edgeEndpointName({ rank: edge.fromRank, id: edge.fromNode })
    const toName = edgeEndpointName({ rank: edge.toRank, id: edge.toNode })
    return `${fromName} → ${toName}${label}`
  })

  const nodeWord = nodes.length === 1 ? "node" : "nodes"
  const edgeWord = edges.length === 1 ? "edge" : "edges"
  const sections = [
    `# Canvas: ${nodes.length} ${nodeWord}, ${edges.length} ${edgeWord}`,
    ...nodeSections,
    ...(edgeLines.length > 0 ? [["## Connections", ...edgeLines].join("\n\n")] : []),
  ]
  return sections.join("\n\n")
}

/** The two kinds of link a canvas holds, each deduplicated in JSON order. */
type CanvasLinks = {
  /** The `file` path of every file card within the link-target limit, an
   *  exact vault path. */
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
  // A file card holds an exact vault path, which always fits the link-target
  // limit, so a card over it names no file. Skipping such cards keeps the Set
  // below from slowing as links.isWithinLinkTargetLimit describes.
  const fileCardPaths = nodes
    .flatMap((node) => (node.type === "file" && node.file ? [node.file] : []))
    .filter(links.isWithinLinkTargetLimit)
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
  // so the rewrite reaches every card that function reads. It also reaches the
  // file cards over the link-target limit that extraction skips, which name no
  // file.
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

  // A trailing newline carries over, but a leading byte-order mark does not,
  // matching how a rewritten note is saved.
  const trailingNewline = params.canvasJson.endsWith("\n") ? "\n" : ""
  return { content: `${stringifyCanvas(rewrittenCanvas)}${trailingNewline}`, linksRewritten }
}
