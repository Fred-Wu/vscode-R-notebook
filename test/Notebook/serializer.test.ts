import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { defaultChunk } from "../../src/Notebook/document";
import { readNotebookStateFile } from "../../src/Notebook/state";

type CommonJsLoad = (
  request: string,
  parent: NodeModule | undefined,
  isMain: boolean
) => unknown;

test("notebook preparation and state snapshots", async (t) => {
  let appliedEdits: unknown[] = [];
  let applyEdit = async () => true;
  const vscode = {
    NotebookCellKind: { Markup: 1, Code: 2 },
    NotebookRange: class { constructor(readonly start: number, readonly end: number) {} },
    NotebookCellData: class {
      constructor(readonly kind: number, readonly value: string, readonly languageId: string) {}
    },
    NotebookCellOutput: class { constructor(readonly items: unknown[], readonly metadata: unknown) {} },
    NotebookCellOutputItem: class { constructor(readonly data: Uint8Array, readonly mime: string) {} },
    NotebookEdit: {
      replaceCells: (range: unknown, cells: unknown[]) => ({ range, cells }),
      updateCellMetadata: (index: number, metadata: unknown) => ({
        index,
        metadata,
      }),
    },
    WorkspaceEdit: class {
      set(_uri: unknown, edits: unknown[]): void {
        appliedEdits = edits;
      }
    },
    workspace: {
      applyEdit: () => applyEdit(),
    },
  };
  const loader = Module as unknown as { _load: CommonJsLoad };
  const originalLoad = loader._load;
  loader._load = function(request, parent, isMain) {
    return request === "vscode"
      ? vscode
      : originalLoad.call(this, request, parent, isMain);
  };

  let RNotebookSerializer: typeof import(
    "../../src/Notebook/serializer"
  ).RNotebookSerializer;
  try {
    ({ RNotebookSerializer } = await import("../../src/Notebook/serializer"));
  } finally {
    loader._load = originalLoad;
  }

  const cell = {
    index: 0,
    kind: vscode.NotebookCellKind.Code,
    metadata: {},
    outputs: [],
    document: { languageId: "r", getText: () => "1 + 1" },
  };
  await new RNotebookSerializer().prepareNotebook({
    notebookType: "r-notebook",
    uri: {},
    metadata: { rNotebook: { eol: "\n" } },
    getCells: () => [cell],
  } as never, false);

  assert.deepEqual(appliedEdits, [{
    index: 0,
    metadata: {
      rNotebook: {
        openingFence: "```{r}\n",
        closingFence: "```",
        engine: "r",
      },
    },
  }]);

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "notebook-restore-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fixture = async (name: string) => {
    const cells = ["1 + 1", "2 + 2"].map((value, index) => ({
      index, kind: 2, metadata: { rNotebook: defaultChunk("r", "\n") },
      outputs: [{ items: [{ mime: "text/plain", data: Buffer.from(`saved-${index}`) }] }],
      document: { languageId: "r", getText: () => value },
    }));
    const notebook = {
      notebookType: "r-notebook", isClosed: false,
      uri: { scheme: "file", fsPath: path.join(directory, `${name}.Rmd`) },
      metadata: {}, getCells: () => cells,
    };
    const serializer = new RNotebookSerializer();
    await serializer.saveState(serializer.captureState(notebook as never));
    cells.forEach((cell) => { cell.outputs = []; });
    return { cells, notebook, serializer };
  };

  for (const localOutput of [false, true]) {
    await t.test(`close before restoration preserves results (local output=${localOutput})`, async () => {
      const { cells, notebook, serializer } = await fixture(`closing-${localOutput}`);
      let release!: () => void;
      const ready = new Promise<void>((resolve) => { release = resolve; });
      const preparation = serializer.prepareNotebook(notebook as never, true, undefined, ready);
      if (localOutput) cells[0]!.outputs = [{ items: [{ mime: "text/plain", data: Buffer.from("new result") }] }];
      notebook.isClosed = true;
      const snapshot = serializer.captureState(notebook as never);
      notebook.getCells = () => { throw new Error("Closed document is no longer available"); };
      const saved = serializer.saveState(snapshot);
      release();
      await Promise.all([preparation, saved]);
      const state = await readNotebookStateFile(notebook.uri.fsPath);
      assert.deepEqual(state!.cellOutputs.map((output) =>
        Buffer.from(output.outputs[0]!.items[0]!.data, "base64").toString()
      ), [localOutput ? "new result" : "saved-0", "saved-1"]);
    });
  }

  await t.test("completed restoration does not resurrect subsequently cleared outputs", async () => {
    const { notebook, serializer } = await fixture("cleared");
    await serializer.prepareNotebook(notebook as never, true);
    // The mocked editor accepts restoration. Clearing all outputs afterward
    // must be saved as empty, without merging the old sidecar again.
    await serializer.saveState(serializer.captureState(notebook as never));
    assert.deepEqual((await readNotebookStateFile(notebook.uri.fsPath))!.cellOutputs, []);
  });

  await t.test("a failed restoration cannot overwrite the preceding sidecar", async () => {
    const { notebook, serializer } = await fixture("failure");
    const before = await fs.readFile(`${notebook.uri.fsPath}.r-notebook`);
    let reject!: (error: Error) => void;
    const ready = new Promise<void>((_resolve, fail) => { reject = fail; });
    const preparation = serializer.prepareNotebook(notebook as never, true, undefined, ready);
    const snapshot = serializer.captureState(notebook as never);
    const failedPreparation = assert.rejects(preparation, /restore failed/);
    reject(new Error("restore failed"));
    await failedPreparation;
    await assert.rejects(serializer.saveState(snapshot), /restore failed/);
    assert.deepEqual(await fs.readFile(`${notebook.uri.fsPath}.r-notebook`), before);
  });

  await t.test("close during restoration edit retains loaded outputs", async () => {
    const { notebook, serializer } = await fixture("edit-race");
    let entered!: () => void;
    const editing = new Promise<void>((resolve) => { entered = resolve; });
    let release!: (applied: boolean) => void;
    applyEdit = () => { entered(); return new Promise<boolean>((resolve) => { release = resolve; }); };
    try {
      const preparation = serializer.prepareNotebook(notebook as never, true);
      await editing;
      notebook.isClosed = true;
      const snapshot = serializer.captureState(notebook as never);
      release(false);
      await assert.rejects(preparation, /could not prepare/);
      await serializer.saveState(snapshot);
      assert.equal((await readNotebookStateFile(notebook.uri.fsPath))!.cellOutputs.length, 2);
    } finally { applyEdit = async () => true; }
  });
});
