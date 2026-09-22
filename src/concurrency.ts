/**
 * Run `fn` over `items` with at most `limit` calls in flight, results in input order.
 *
 * Fan-out and council start one session per agent. They used to start them all
 * at once, which the session cap never saw (see SessionManager._startsInFlight);
 * with the cap enforced, the agents past the free slots would fail on it instead
 * of waiting for a slot.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}
