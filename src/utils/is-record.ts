/** True for a non-null object, so parsed JSON can be read by key. Arrays pass
 *  too, since they are objects whose named keys read as undefined. */
export const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null
}
