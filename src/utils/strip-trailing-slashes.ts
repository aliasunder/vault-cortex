/** Matches the run of slashes at the end of a path. The lookbehind lets a
 *  match start only at the first slash of a run, so a long run of slashes
 *  followed by another character is not rescanned from each of its slashes,
 *  which takes time quadratic in the run's length. */
const TRAILING_SLASH_RUN_PATTERN = /(?<!\/)\/+$/

/** Strips every trailing slash from a path (`"Projects/"` → `"Projects"`); a
 *  path of slashes alone becomes `""`. */
export const stripTrailingSlashes = (path: string): string => {
  return path.replace(TRAILING_SLASH_RUN_PATTERN, "")
}
