import assert from "node:assert/strict";
import test from "node:test";
import { shutdownNotebookRuntime } from "../../src/Runtime/shutdown";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const synchronousFailure of [false, true]) {
  test(`shutdown drains processes and queued sidecar saves after ${synchronousFailure ? "synchronous" : "asynchronous"} failure`, async () => {
    const language = deferred();
    const firstSave = deferred();
    const lastSave = deferred();
    const saves = new Map<string, Promise<void>>();
    let languageStarted = false;
    let settled = false;
    const failure = new Error("process termination failed");
    const shutdown = shutdownNotebookRuntime([
      () => {
        if (synchronousFailure) throw failure;
        return Promise.reject(failure);
      },
      async () => {
        languageStarted = true;
        await language.promise;
        // Shutdown can enqueue a save after deactivation has already begun.
        const first = firstSave.promise.then(() => {
          const last = lastSave.promise.then(() => { saves.delete("notebook"); });
          saves.set("notebook", last);
        });
        saves.set("notebook", first);
      },
    ], saves);
    const checked = assert.rejects(shutdown, (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [failure]);
      return true;
    }).then(() => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(languageStarted, true);
    assert.equal(settled, false);
    language.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    firstSave.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "A successor sidecar save was not awaited");
    lastSave.resolve();
    await checked;
    assert.equal(saves.size, 0);
  });
}

test("shutdown waits for every independent failure and reports them together", async () => {
  const last = deferred();
  const errors = [new Error("R"), new Error("LSP")];
  const shutdown = shutdownNotebookRuntime([
    async () => { throw errors[0]; },
    async () => { await last.promise; throw errors[1]; },
  ], new Map());
  const checked = assert.rejects(shutdown, (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, errors);
    return true;
  });
  last.resolve();
  await checked;
});
