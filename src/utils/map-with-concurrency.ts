/** Maps an async function over items with bounded concurrency, returning the
 *  results in input order.
 *
 *  Batch-based, not a sliding-window pool: items are processed in fixed-size
 *  batches of `concurrency`, and each batch is awaited in full before the next
 *  starts. This caps the number of in-flight operations (e.g. open file handles)
 *  at `concurrency`. The trade-off is head-of-line blocking — the slowest item in
 *  a batch delays the start of the next batch — so prefer a dedicated pool if
 *  per-item latency varies widely and throughput matters.
 *
 *  Rejection propagates: if any mapper call rejects, the returned promise rejects.
 *  The other already-started calls in the same batch still settle, but no further
 *  batch is started. */
export const mapWithConcurrency = async <Item, Result>(params: {
  items: readonly Item[]
  concurrency: number
  mapper: (item: Item) => Promise<Result>
}): Promise<Result[]> => {
  const { items, concurrency, mapper } = params
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(
      `concurrency must be a positive integer, got ${concurrency}`,
    )
  }

  const batchStarts = Array.from(
    { length: Math.ceil(items.length / concurrency) },
    (_unused, batchIndex) => batchIndex * concurrency,
  )

  // Sequential over batches (the await in the loop is intentional — it bounds the
  // concurrency); the items within each batch run together via Promise.all. The
  // const accumulator is pushed into rather than spread to avoid O(n^2) copying.
  const results: Result[] = []
  for (const start of batchStarts) {
    const batch = items.slice(start, start + concurrency)
    results.push(...(await Promise.all(batch.map(mapper))))
  }
  return results
}
