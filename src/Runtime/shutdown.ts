/** Finish every shutdown and the saves it can enqueue before reporting errors. */
export async function shutdownNotebookRuntime(
  shutdowns: readonly (() => void | Promise<void>)[],
  stateSaves: ReadonlyMap<string, Promise<void>>
): Promise<void> {
  const results = await Promise.allSettled(
    shutdowns.map((shutdown) => Promise.resolve().then(shutdown))
  );
  // Saves are removed from this map by their owners. A preceding save can
  // enqueue a successor, so a single snapshot does not necessarily drain it.
  while (stateSaves.size > 0) {
    results.push(...await Promise.allSettled(stateSaves.values()));
  }
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []);
  if (errors.length > 0) {
    throw new AggregateError(errors, "Could not completely shut down R Notebook.");
  }
}
