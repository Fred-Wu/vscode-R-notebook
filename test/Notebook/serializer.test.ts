import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";

type CommonJsLoad = (
  request: string,
  parent: NodeModule | undefined,
  isMain: boolean
) => unknown;

test("prepares a new code cell with a native chunk header", async () => {
  let appliedEdits: unknown[] = [];
  const vscode = {
    NotebookCellKind: { Markup: 1, Code: 2 },
    NotebookEdit: {
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
      applyEdit: async () => true,
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
});
