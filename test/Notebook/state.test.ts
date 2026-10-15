import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import {
  notebookSourceHash,
  readNotebookStateFile,
  reconcileNotebookState,
  storedCells,
  writeNotebookStateFile,
  type NotebookState,
} from "../../src/Notebook/state";

test("writes compressed notebook state to the deterministic sidecar", async (t) => {
  const directory = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "r-notebook-state-test-")
  );
  t.after(() => fsPromises.rm(directory, { recursive: true, force: true }));
  const documentPath = path.join(directory, "report.qmd");
  const source = "# Report\n";
  const state: NotebookState = {
    version: 1,
    sourceHash: notebookSourceHash(source),
    cells: storedCells(source),
    cellOutputs: [],
  };

  await writeNotebookStateFile(documentPath, state);
  const stateFile = "report.qmd.r-notebook";
  const stored = gunzipSync(await fsPromises.readFile(
    path.join(directory, stateFile)
  )).toString("utf8");
  assert.deepEqual(JSON.parse(stored), state);
  assert.equal(stored.includes(source), false);
  assert.deepEqual(
    await readNotebookStateFile(documentPath),
    state
  );
  const copiedDirectory = path.join(directory, "copy");
  await fsPromises.mkdir(copiedDirectory);
  const copiedDocumentPath = path.join(copiedDirectory, "report.qmd");
  await fsPromises.copyFile(
    path.join(directory, stateFile),
    `${copiedDocumentPath}.r-notebook`
  );
  assert.deepEqual(await readNotebookStateFile(copiedDocumentPath), state);
});

test("reconciles text edits and marks retained output from edited code as stale", () => {
  const before = [
    "# Report",
    "",
    "```{r first}",
    "x <- 1",
    "x",
    "```",
    "",
    "Text",
    "",
    "```{r}",
    "y <- 2",
    "y",
    "```",
    "",
  ].join("\n");
  const after = before.replace("x <- 1", "x <- 10").replace("Text", "Updated text");
  const cells = storedCells(before);
  const state: NotebookState = {
    version: 1,
    sourceHash: notebookSourceHash(before),
    cells,
    cellOutputs: [
      {
        cell: 1,
        sourceHash: cells[1]!.sourceHash,
        outputs: [{ items: [{ mime: "text/plain", data: "MQ==" }] }],
      },
      {
        cell: 3,
        sourceHash: cells[3]!.sourceHash,
        outputs: [{ items: [{ mime: "text/plain", data: "Mg==" }] }],
      },
    ],
  };

  const reconciled = reconcileNotebookState(after, state);
  assert.equal(reconciled.sourceHash, notebookSourceHash(after));
  assert.deepEqual(reconciled.cells, storedCells(after));
  assert.equal(reconciled.cellOutputs.length, 2);
  assert.deepEqual(
    reconciled.cellOutputs.map(({ cell, sourceHash }) => ({ cell, sourceHash })),
    [
      { cell: 1, sourceHash: cells[1]?.sourceHash },
      { cell: 3, sourceHash: cells[3]?.sourceHash },
    ]
  );
  const reverted = reconcileNotebookState(before, reconciled);
  assert.deepEqual(
    reverted.cellOutputs.map(({ cell, sourceHash }) => ({ cell, sourceHash })),
    [
      { cell: 1, sourceHash: cells[1]?.sourceHash },
      { cell: 3, sourceHash: cells[3]?.sourceHash },
    ]
  );
});

test("drops deleted cell output while preserving an unchanged cell that moved", () => {
  const deleted = "```{r remove}\nremove <- 1\n```\n\n";
  const kept = "```{r keep}\nkeep <- 2\n```\n";
  const before = deleted + kept;
  const cells = storedCells(before);
  const state: NotebookState = {
    version: 1,
    sourceHash: notebookSourceHash(before),
    cells,
    cellOutputs: [
      {
        cell: 0,
        sourceHash: cells[0]!.sourceHash,
        outputs: [{ items: [{ mime: "text/plain", data: "MQ==" }] }],
      },
      {
        cell: 1,
        sourceHash: cells[1]!.sourceHash,
        outputs: [{ items: [{ mime: "text/plain", data: "Mg==" }] }],
      },
    ],
  };

  const reconciled = reconcileNotebookState(kept, state);
  assert.deepEqual(
    reconciled.cellOutputs.map(({ cell, sourceHash }) => ({ cell, sourceHash })),
    [{ cell: 0, sourceHash: storedCells(kept)[0]?.sourceHash }]
  );
});

test("remaps state saved before empty separator cells were removed", () => {
  const first = "```{r first}\nx <- 1\n```\n";
  const second = "```{r second}\nx + 1\n```\n";
  const source = `${first}\n${second}`;
  const state: NotebookState = {
    version: 1,
    sourceHash: notebookSourceHash(source),
    cells: [
      { kind: "code", label: "first", sourceHash: notebookSourceHash(first) },
      { kind: "markup", sourceHash: notebookSourceHash("\n") },
      { kind: "code", label: "second", sourceHash: notebookSourceHash(second) },
    ],
    cellOutputs: [{
      cell: 2,
      sourceHash: notebookSourceHash(second),
      outputs: [{ items: [{ mime: "text/plain", data: "Mg==" }] }],
    }],
  };

  const reconciled = reconcileNotebookState(source, state);
  assert.equal(reconciled.cells.length, 2);
  assert.equal(reconciled.cellOutputs[0]?.cell, 1);
});

test("uses Quarto pipe labels to match edited code cells", () => {
  const source = "```{r}\n#| label: fitted-model\nlm(y ~ x)\n```\n";
  assert.equal(storedCells(source)[0]?.label, "fitted-model");
});

test("does not reassign deleted-cell output to an inserted cell", () => {
  const before = [
    "```{r keep}",
    "keep <- 1",
    "```",
    "```{r removed}",
    "removed <- 2",
    "```",
  ].join("\n");
  const after = [
    "```{r keep}",
    "keep <- 1",
    "```",
    "```{r inserted}",
    "inserted <- 3",
    "```",
  ].join("\n");
  const cells = storedCells(before);
  const state: NotebookState = {
    version: 1,
    sourceHash: notebookSourceHash(before),
    cells,
    cellOutputs: [{
      cell: 1,
      sourceHash: cells[1]!.sourceHash,
      outputs: [{ items: [{ mime: "text/plain", data: "Mg==" }] }],
    }],
  };
  assert.equal(reconcileNotebookState(after, state).cellOutputs.length, 0);
});

test("externalizes large output assets and restores their bytes", async (t) => {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "r-notebook-large-output-"));
  t.after(() => fsPromises.rm(directory, { recursive: true, force: true }));
  const documentPath = path.join(directory, "plots.qmd");
  const source = "```{r}\nplot(1:10)\n```\n";
  const data = Buffer.alloc(160 * 1024, 71).toString("base64");
  const state: NotebookState = {
    version: 1,
    sourceHash: notebookSourceHash(source),
    cells: storedCells(source),
    cellOutputs: [{
      cell: 0,
      sourceHash: storedCells(source)[0]!.sourceHash,
      outputs: [{ items: [{ mime: "image/png", data }] }],
    }],
  };
  await writeNotebookStateFile(documentPath, state);
  const payload = JSON.parse(gunzipSync(await fsPromises.readFile(
    `${documentPath}.r-notebook`
  )).toString("utf8")) as NotebookState;
  assert.equal(payload.cellOutputs[0]?.outputs[0]?.items[0]?.data, "");
  const asset = payload.cellOutputs[0]?.outputs[0]?.items[0]?.asset;
  assert.match(asset ?? "", /^[a-f0-9]{64}\.bin$/);
  const restored = await readNotebookStateFile(documentPath);
  assert.equal(restored?.cellOutputs[0]?.outputs[0]?.items[0]?.data, data);
});
