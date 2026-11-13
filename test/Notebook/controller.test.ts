import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import type * as vscode from "vscode";

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
  const api = {
    NotebookCellKind: { Markup: 1, Code: 2 },
    CancellationTokenSource: Cancellation,
    EventEmitter: class {
      event = () => ({ dispose() {} });
      fire() {}
      dispose() {}
    },
    WorkspaceEdit: class { set() {} },
    NotebookEdit: { updateCellMetadata() {}, updateNotebookMetadata() {} },
    workspace: { isTrusted: true, applyEdit: async () => true },
    window: { setStatusBarMessage() {} },
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
        async renderText() { return "<div>Rendered</div>"; }
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
});
