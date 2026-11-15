import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import type * as vscode from "vscode";
import { RInterruptError } from "../../src/Runtime/process";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class Cancellation {
  private listeners = new Set<() => void>();
  token = {
    isCancellationRequested: false,
    onCancellationRequested: (listener: () => void) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    },
  };
  cancel() {
    if (this.token.isCancellationRequested) return;
    this.token.isCancellationRequested = true;
    this.listeners.forEach((listener) => listener());
  }
  dispose() { this.listeners.clear(); }
}

test("notebook controller execution and shutdown lifecycle", async (t) => {
  const executions: Array<Cancellation & { ended: number; started: boolean }> = [];
  const processes: Array<{ running: boolean; starts: number; dispose(): void; start(): Promise<void> }> = [];
  let execute!: (cells: readonly vscode.NotebookCell[]) => Promise<void>;
  let executeBridge = async (_source: string, _token: vscode.CancellationToken) => {};
  let configuration = async () => true;
  let selectAttachment = async () => {};
  const metadataUpdates: unknown[] = [];
  let textRenders = 0;
  let renderFailure: Error | undefined;
  const shownErrors: string[] = [];
  type Edit = { edits: Array<{ notebookMetadata?: object } | undefined> };
  let applyEdit = async (_edit: Edit) => true;
  const api = {
    NotebookCellKind: { Markup: 1, Code: 2 },
    CancellationTokenSource: Cancellation,
    EventEmitter: class {
      private readonly listeners = new Set<(value: unknown) => void>();
      event = (listener: (value: unknown) => void) => {
        this.listeners.add(listener);
        return { dispose: () => { this.listeners.delete(listener); } };
      };
      fire(value: unknown) { this.listeners.forEach((listener) => listener(value)); }
      dispose() { this.listeners.clear(); }
    },
    WorkspaceEdit: class {
      edits: Edit["edits"] = [];
      set(_uri: unknown, edits: Edit["edits"]) { this.edits = edits; }
    },
    NotebookEdit: {
      updateCellMetadata() {},
      updateNotebookMetadata(metadata: object) {
        metadataUpdates.push(metadata);
        return { notebookMetadata: metadata };
      },
    },
    workspace: { isTrusted: true, applyEdit: (edit: Edit) => applyEdit(edit),
      getConfiguration: () => ({ get: () => 0 }) },
    window: { setStatusBarMessage() {}, showErrorMessage(message: string) { shownErrors.push(message); } },
    notebooks: {
      createNotebookController: () => ({
        set executeHandler(handler: typeof execute) { execute = handler; },
        createNotebookCellExecution: () => {
          const cancellation = new Cancellation();
          const execution = Object.assign(cancellation, {
            ended: 0, started: false,
            start() { this.started = true; },
            end() { this.ended++; },
            async clearOutput() {},
            async replaceOutput() {},
          });
          executions.push(execution);
          return execution;
        },
        dispose() {},
      }),
    },
  };
  class TextRenderCancelledError extends Error {}
  const replacements: Record<string, unknown> = {
    vscode: api,
    "./renderDependencies": { hasQuartoProjectConfiguration: () => configuration() },
    "../Runtime/bridge": {
      TextRenderCancelledError,
      RExecutionBridge: class {
        async execute(source: string, _path: string, token: vscode.CancellationToken) {
          await executeBridge(source, token);
          return { success: !token.isCancellationRequested, outputs: [] };
        }
        async renderText() {
          if (renderFailure) throw renderFailure;
          return `<div id="r-notebook-markdown-text">Render ${++textRenders}</div>`;
        }
      },
    },
    "../Runtime/launch": {
      quartoExecutableSetting: () => "",
      createInlineRProcess: () => {
        const process = {
          running: false, starts: 0,
          async start() { this.running = true; this.starts++; },
          async dispose() { this.running = false; },
        };
        processes.push(process);
        return process;
      },
    },
    "../Runtime/sess": {
      InlineSessCoordinator: class {
        select() { return selectAttachment(); }
        beginExecution() {}
        async endExecution() {}
        forget() {}
        dispose() {}
      },
    },
  };
  const loader = Module as unknown as {
    _load(request: string, parent: NodeModule | undefined, isMain: boolean): unknown;
  };
  const originalLoad = loader._load;
  loader._load = function(request, parent, isMain) {
    return replacements[request] ?? originalLoad.call(this, request, parent, isMain);
  };
  let Controller: typeof import("../../src/Notebook/controller").RNotebookController;
  try {
    ({ RNotebookController: Controller } = await import("../../src/Notebook/controller"));
  } finally {
    loader._load = originalLoad;
  }
  const notebook = (kind: "code" | "markup") => {
    const uri = { scheme: "file", fsPath: "/test.qmd", toString: () => "file:///test.qmd" };
    const document = { uri, notebookType: "r-notebook", isClosed: false, metadata: {} };
    const cells = (kind === "code" ? ["first", "second"] : ["Plain text"]).map((source, index) => ({
      kind: kind === "code" ? 2 : 1, index, notebook: document,
      metadata: kind === "code" ? {} : { rNotebookMarkdown: { id: "text" } },
      document: { languageId: kind === "code" ? "r" : "markdown", getText: () => source,
        uri: { toString: () => `cell:${index}` } },
    }));
    return Object.assign(document, { getCells: () => cells }) as unknown as vscode.NotebookDocument;
  };
  const controller = () => new Controller("helper.R", { appendLine() {} } as unknown as vscode.OutputChannel, false);

  for (const action of ["shutdown", "close tab", "change selection", "dispose"] as const) {
    await t.test(`pending selection cannot undo ${action}`, async () => {
      const c = controller();
      const document = notebook("code");
      await c.selectNotebook(document);
      const count = processes.length;
      const selected = deferred<void>();
      selectAttachment = () => selected.promise;
      const pending = c.selectNotebook(document);
      selectAttachment = async () => {};
      try {
        if (action === "shutdown") await c.shutdownSession(document.uri);
        else if (action === "close tab") c.notebookTabClosed(document.uri);
        else if (action === "change selection") await c.selectNotebook(undefined);
        else await c.dispose();
        selected.resolve();
        await pending;
        assert.equal(processes.length, count, "A stale selection recreated the session");
        assert.equal(processes.at(-1)!.starts, 1, "A stale selection restarted R");
        if (action === "close tab") assert.equal(c.retainedNotebookSessions().length, 1);
        if (action === "shutdown") {
          assert.equal(c.hasSession(document.uri), false);
          await c.selectNotebook(document);
          assert.equal(processes.length, count + 1, "A fresh selection should start R");
        }
      } finally { selected.resolve(); await c.dispose(); }
    });
  }

  await t.test("shutdown invalidates selection before its first session exists", async () => {
    const c = controller();
    const document = notebook("code");
    const selected = deferred<void>();
    const count = processes.length;
    selectAttachment = () => selected.promise;
    const pending = c.selectNotebook(document);
    selectAttachment = async () => {};
    await c.shutdownSession(document.uri);
    selected.resolve();
    await pending;
    assert.equal(processes.length, count);
    await c.dispose();
  });

  for (const action of ["shutdown", "close tab", "dispose"] as const) {
    await t.test(`pending restart cannot undo ${action}`, async () => {
      const c = controller();
      const document = notebook("code");
      await c.selectNotebook(document);
      const count = processes.length;
      const terminated = deferred<void>();
      processes.at(-1)!.dispose = () => terminated.promise;
      const restarting = c.restartSession(document);
      let shutdown: Promise<void> | undefined;
      try {
        if (action === "shutdown") shutdown = c.shutdownSession(document.uri);
        else if (action === "close tab") c.notebookTabClosed(document.uri);
        else shutdown = c.dispose();
        terminated.resolve();
        assert.equal(await restarting, false);
        await shutdown;
        assert.equal(processes.length, count, "A stale restart created another process");
        assert.equal(c.hasSession(document.uri), false);
      } finally { terminated.resolve(); await c.dispose(); }
    });
  }

  await t.test("repeated shutdown waits for the same outstanding termination", async () => {
    const c = controller();
    const document = notebook("code");
    await c.selectNotebook(document);
    const terminated = deferred<void>();
    processes.at(-1)!.dispose = () => terminated.promise;
    try {
      const first = c.shutdownSession(document.uri);
      let finished = false;
      const second = c.shutdownSession(document.uri).then(() => { finished = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(finished, false, "Shutdown returned while its process was still stopping");
      terminated.resolve();
      await Promise.all([first, second]);
    } finally { terminated.resolve(); await c.dispose(); }
  });

  await t.test("only the latest restart starts a replacement after termination", async () => {
    const c = controller();
    const document = notebook("code");
    await c.selectNotebook(document);
    const count = processes.length;
    const terminated = deferred<void>();
    processes.at(-1)!.dispose = () => terminated.promise;
    const first = c.restartSession(document);
    const second = c.restartSession(document);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(processes.length, count, "Restart overlapped the old process");
      terminated.resolve();
      assert.deepEqual(await Promise.all([first, second]), [false, true]);
      assert.equal(processes.length, count + 1);
      assert.equal(processes.at(-1)!.starts, 1);
    } finally {
      terminated.resolve();
      await Promise.allSettled([first, second]);
      await c.dispose();
    }
  });

  for (const stopAgain of [false, true]) {
    await t.test(`selection waits for prior termination (shutdown again=${stopAgain})`, async () => {
      const c = controller();
      const document = notebook("code");
      await c.selectNotebook(document);
      const terminated = deferred<void>();
      processes.at(-1)!.dispose = () => terminated.promise;
      const first = c.shutdownSession(document.uri);
      const selected = c.selectNotebook(document);
      const selectionResult = stopAgain ? assert.rejects(selected, /session has closed/) : selected;
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        const replacement = processes.at(-1)!;
        assert.equal(replacement.starts, 0, "Selection started R before its predecessor exited");
        let finished = false;
        const second = stopAgain
          ? c.shutdownSession(document.uri).then(() => { finished = true; })
          : undefined;
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(finished, false);
        terminated.resolve();
        await Promise.all([first, second, selectionResult]);
        assert.equal(replacement.starts, stopAgain ? 0 : 1);
        assert.equal(c.hasSession(document.uri), !stopAgain);
      } finally {
        terminated.resolve();
        await Promise.allSettled([first, selectionResult]);
        await c.dispose();
      }
    });
  }

  await t.test("a failed shutdown prevents the pending restart from launching R", async () => {
    const c = controller();
    const document = notebook("code");
    await c.selectNotebook(document);
    const count = processes.length;
    const failure = new Error("Could not terminate R");
    processes.at(-1)!.dispose = async () => { throw failure; };
    try {
      await assert.rejects(c.restartSession(document), (error: unknown) => error === failure);
      assert.equal(processes.length, count);
      assert.equal(c.hasSession(document.uri), false);
    } finally { await c.dispose(); }
  });

  await t.test("Stop All cancels running and queued cells without poisoning subsequent execution", async () => {
    executions.length = 0;
    const c = controller();
    const document = notebook("code");
    const started = deferred<void>();
    const dispatched: string[] = [];
    executeBridge = async (source, token) => {
      dispatched.push(source);
      started.resolve();
      await new Promise<void>((resolve) => token.onCancellationRequested(resolve));
    };
    try {
      const running = execute(document.getCells());
      await started.promise;
      assert.equal(executions.length, 2, "All queued cells need cancellation tokens");
      executions.forEach((execution) => execution.cancel());
      await running;
      assert.equal(dispatched.length, 1);
      assert.deepEqual(executions.map((execution) => [execution.started, execution.ended]), [[true, 1], [false, 1]]);
      executeBridge = async (source) => { dispatched.push(source); };
      await execute([document.getCells()[0]!]);
      assert.equal(dispatched.length, 2);
    } finally { c.dispose(); }
  });

  for (const operation of ["code cell", "native text"] as const) {
    await t.test(`${operation} interruption failure drops the stopped session and allows a fresh run`, async () => {
      const c = controller();
      const document = notebook(operation === "code cell" ? "code" : "markup");
      const failure = new RInterruptError("Interruption failed; R was stopped.");
      executions.length = 0;
      shownErrors.length = 0;
      configuration = async () => true;
      let dispatched = 0;
      try {
        if (operation === "code cell") {
          executeBridge = async () => {
            dispatched++;
            executions[0]!.cancel();
            throw failure;
          };
          await execute(document.getCells());
          assert.deepEqual(shownErrors, [failure.message], "Cancellation hid the interrupt failure");
          assert.equal(dispatched, 1, "A queued cell ran on the failed session");
          assert.deepEqual(executions.map((execution) => [execution.started, execution.ended]), [[true, 1], [false, 1]]);
        } else {
          renderFailure = failure;
          await assert.rejects(c.renderText(document, "text"), (error: unknown) => error === failure);
        }
        assert.equal(c.hasSession(document.uri), false);
        assert.equal(processes.at(-1)!.running, false);
        const count = processes.length;
        executeBridge = async () => {};
        renderFailure = undefined;
        if (operation === "code cell") await execute([document.getCells()[0]!]);
        else await c.renderText(document, "text");
        assert.equal(processes.length, count + 1);
        assert.equal(processes.at(-1)!.starts, 1);
      } finally {
        executeBridge = async () => {};
        renderFailure = undefined;
        await c.dispose();
      }
    });
  }

  for (const hasProject of [true, false]) {
    await t.test(`shutdown during project lookup cannot recreate a session (project=${hasProject})`, async () => {
      const c = controller();
      const document = notebook("markup");
      const lookup = deferred<boolean>();
      configuration = () => lookup.promise;
      try {
        const rendering = c.renderText(document, "text");
        const process = processes.at(-1)!;
        c.shutdownSession(document.uri);
        lookup.resolve(hasProject);
        await assert.rejects(rendering, TextRenderCancelledError);
        assert.equal(c.hasSession(document.uri), false);
        assert.equal(process.starts, 0);
        // An intentional later request can create a new session normally.
        configuration = async () => true;
        await c.renderText(document, "text");
        assert.equal(processes.at(-1)!.starts, 1);
      } finally { c.dispose(); }
    });
  }

  await t.test("disposal invalidates pending renders and rejects subsequent session creation", async () => {
    const c = controller();
    const document = notebook("markup");
    const lookup = deferred<boolean>();
    configuration = () => lookup.promise;
    const rendering = c.renderText(document, "text");
    c.dispose();
    lookup.resolve(true);
    await assert.rejects(rendering, TextRenderCancelledError);
    assert.equal(c.hasSession(document.uri), false);
    await assert.rejects(c.renderText(document, "text"), /session has closed/);
  });

  for (const { name, source, invalidates } of [
    { name: "static text", source: "---\ntitle: Report\n---\nStatic text.", invalidates: false },
    { name: "embedded image", source: "---\ntitle: Report\n---\n![Latest plot](plot.png)", invalidates: true },
    { name: "YAML expression", source: "---\noutput:\n  html_document:\n    toc: !expr get0('notebook_toc', ifnotfound = FALSE)\n---\n# Heading", invalidates: true },
  ]) {
    await t.test(`execution refreshes dependent previews and preserves static caches (${name})`, async () => {
      const c = controller();
      const document = notebook("code");
      if (name === "YAML expression") {
        Object.assign(document, { uri: { scheme: "file", fsPath: "/outline.Rmd", toString: () => "file:///outline.Rmd" } });
      }
      const code = document.getCells()[0]!;
      const markup = notebook("markup").getCells()[0]!;
      const cells = [{ ...markup, notebook: document, index: 0,
        document: { ...markup.document, getText: () => source } },
        Object.assign(code, { index: 1 })];
      Object.assign(document, {
        getCells: () => cells,
      });
      applyEdit = async (edit) => {
        for (const change of edit.edits) {
          if (change?.notebookMetadata) {
            // Match ExtHostNotebookDocument.acceptDocumentPropertiesChanged:
            // omitting a metadata key does not delete the extension host value.
            Object.assign(document, { metadata: { ...document.metadata, ...change.notebookMetadata } });
          }
        }
        return true;
      };
      const refreshed: unknown[] = [];
      c.onDidChangeMarkdownState((value) => refreshed.push(value));
      executeBridge = async () => {};
      try {
        const original = await c.renderText(document, "text");
        const previousRenders = textRenders;
        metadataUpdates.length = 0;
        await execute([code]);
        assert.deepEqual(refreshed, invalidates ? [document] : []);
        assert.deepEqual(metadataUpdates, invalidates ? [{ rNotebookTextCache: null }] : []);
        const next = await c.renderText(document, "text");
        assert.equal(textRenders, previousRenders + (invalidates ? 1 : 0));
        assert.equal(next.html === original.html, !invalidates);
        // Watcher invalidation must also clear a cache when source is unchanged.
        await c.refreshMarkdown(document);
        const changedResource = await c.renderText(document, "text");
        assert.notEqual(changedResource.html, next.html);
      } finally {
        applyEdit = async () => true;
        await c.dispose();
      }
    });
  }

  await t.test("one failed process shutdown does not finish disposal before other processes exit", async () => {
    const c = controller();
    const first = notebook("code");
    await c.selectNotebook(first);
    const failed = processes.at(-1)!;
    const second = notebook("code");
    Object.assign(second, { uri: { scheme: "file", fsPath: "/second.qmd", toString: () => "file:///second.qmd" } });
    await c.selectNotebook(second);
    const pending = deferred<void>();
    const failure = new Error("Could not terminate R");
    failed.dispose = async () => { throw failure; };
    processes.at(-1)!.dispose = () => pending.promise;
    let settled = false;
    const stopped = assert.rejects(c.dispose(), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [failure]);
      return true;
    }).then(() => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    pending.resolve();
    await stopped;
  });
});
