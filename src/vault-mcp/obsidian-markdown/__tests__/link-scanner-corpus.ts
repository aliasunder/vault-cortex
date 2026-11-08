/** Frozen recognizers are independent compatibility oracles for the scanner rewrites. */
export const legacyWiki = /!?\[\[([^\]#|]+)(?:#[^\]|]*)?(?:\|[^\]]+)?\]\]/g
export const legacyMarkdown = /\[[^\]]*\]\((?![a-zA-Z][a-zA-Z0-9+.-]*:|#)([^)#\s]+)(?:#[^)\s]*)?\)/g
export const legacyTemplater = /<%[-+*_~]?.*?%>/g

export const legacyPlaintext = (text: string): string => {
  return text
    .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/%%[^]*?%%/g, "")
    .replace(/^ {0,3}#{1,6}(?:[ \t]+|$)/gm, "")
    .replace(/^ {0,3}(?:=+|-+)[ \t]*$/gm, "")
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
    .replace(/^>\s*\[![^\]]*\]\s*/gm, "")
    .replace(/^>\s?/gm, "")
}

export const scannerCorpora = [
  { label: "wikilinks", alphabet: ["[", "[", "]", "#", "|", "!", "a", " ", "\\", "😀", "\n"] },
  {
    label: "Markdown links",
    alphabet: ["[", "]", "(", ")", "#", ":", ".", "+", "a", "Z", "0", " ", "\u00a0", "😀", "\n"],
  },
  {
    label: "Templater",
    alphabet: [
      "<",
      "%",
      "%",
      ">",
      "-",
      "+",
      "*",
      "_",
      "~",
      "[",
      "]",
      "a",
      "\r",
      "\u2028",
      "\u2029",
      "\n",
    ],
  },
  { label: "plaintext aliases", alphabet: ["[", "[", "]", "|", "|", "a", "#", " ", "😀", "\n"] },
  { label: "plaintext wikilinks", alphabet: ["[", "[", "]", "a", "#", " ", "😀", "\n"] },
  { label: "plaintext Markdown", alphabet: ["[", "[", "]", "(", ")", "a", " ", "\n"] },
  {
    label: "plaintext callouts",
    alphabet: [">", ">", "[", "!", "]", " ", "\t", "\n", "\r", "\u2028", "\u2029", "a"],
  },
]

export const createScannerDocuments = (
  alphabet: ReadonlyArray<string>,
  count: number,
): string[] => {
  // A fixed LCG seed makes every failing document reproducible across runtimes.
  let state = 0x51ca77e2
  const draw = (limit: number): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return Math.floor((state / 0x1_0000_0000) * limit)
  }
  const documents: string[] = []

  for (let index = 0; index < count; index++) {
    const length = draw(160)
    const characters = Array.from({ length }, () => {
      const character = alphabet[draw(alphabet.length)]

      if (character === undefined) throw new Error("random character is out of bounds")
      return character
    })
    documents.push(characters.join(""))
  }
  return documents
}
