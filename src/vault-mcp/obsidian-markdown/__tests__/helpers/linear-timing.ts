/** How far a timing series may exceed linear growth before a test calls it superlinear, to allow for scheduling noise. */
export const LINEAR_GROWTH_ALLOWANCE = 2

/**
 * Stops a timing child that never finishes. The growth check is the speed
 * test, so this only has to outlast a slow CI runner: the slowest child takes
 * about 7 s on a fast laptop, and CI runners have taken over four times as long.
 */
export const CHILD_DEADLINE_MS = 60_000

/** Gives a killed child time to report its failure before vitest abandons the test. */
export const CHILD_TEST_TIMEOUT_MS = CHILD_DEADLINE_MS + 10_000
