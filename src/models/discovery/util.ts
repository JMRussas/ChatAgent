/** Maps over items with at most `limit` concurrent in-flight calls to `fn`. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
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

/** Limits bytes before JSON parsing; one shared budget can cover every listing page. */
export async function readDiscoveryJson(
  response: Response,
  budget: { remaining: number }
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw Error("DISCOVERY_EMPTY_BODY");
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      budget.remaining -= value.byteLength;
      if (budget.remaining < 0) throw Error("DISCOVERY_RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
