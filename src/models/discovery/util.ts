/** Maps over items with at most `limit` concurrent in-flight calls to `fn`. */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const queue = items.map((item, index) => ({ item, index }));
  const workerCount = Math.max(1, Math.min(limit, queue.length || 1));

  const workers = Array.from({ length: workerCount }, async () => {
    let next: { item: T; index: number } | undefined;
    while ((next = queue.shift())) {
      results[next.index] = await fn(next.item);
    }
  });

  await Promise.all(workers);
  return results;
}
