import { randomUUID } from "node:crypto";
import { TextDecoder, TextEncoder } from "node:util";
import * as vscode from "vscode";
import {
  NOTEBOOK_TYPE,
  R_CELL_LANGUAGE,
  codeCellSource,
  defaultChunk,
  parseDocument,
  serializeDocument,
  type ParsedCell,
  type RNotebookCellMetadata,
  type RNotebookDocumentMetadata,
} from "./document";
import {
  notebookSourceHash,
  outputCodeHash,
  readNotebookStateFile,
  reconcileNotebookState,
  storedCells,
  writeNotebookStateFile,
  type NotebookState,
  type StoredCellOutput,
} from "./state";
import { cellOptionsRequestId } from "./options";

interface NotebookStateSnapshot {
  uri: vscode.Uri;
  state: NotebookState;
}

function notebookSource(notebook: vscode.NotebookDocument): string {
  const metadata = notebook.metadata as RNotebookDocumentMetadata;
  const eol = metadata.rNotebook?.eol ?? "\n";
  return serializeDocument(notebook.getCells().map((cell) => {
    const cellMetadata = cell.metadata as RNotebookCellMetadata;
    return {
      kind: cell.kind === vscode.NotebookCellKind.Code ? "code" : "markup",
      value: cell.document.getText(),
      languageId: cell.document.languageId,
      chunk: cellMetadata.rNotebook,
    };
  }), eol);
}

function storedOutputs(
  stored: StoredCellOutput
): vscode.NotebookCellOutput[] {
  return stored.outputs
    .filter((output) => !cellOptionsRequestId(output.metadata))
    .map((output) => new vscode.NotebookCellOutput(
      output.items.map((item) => new vscode.NotebookCellOutputItem(
        Buffer.from(item.data, "base64"),
        item.mime
      )),
      output.metadata
    ));
}

export class RNotebookSerializer implements vscode.NotebookSerializer {
  private readonly restoring = new WeakMap<
    vscode.NotebookDocument, Promise<NotebookState | undefined>
  >();

  deserializeNotebook(content: Uint8Array): vscode.NotebookData {
    const parsed = parseDocument(new TextDecoder().decode(content));
    const cells = parsed.cells.map((cell) => {
      const data = new vscode.NotebookCellData(
        cell.kind === "code" ? vscode.NotebookCellKind.Code : vscode.NotebookCellKind.Markup,
        cell.value,
        cell.languageId === "r" ? R_CELL_LANGUAGE : cell.languageId
      );
      if (cell.chunk) {
        data.metadata = { rNotebook: cell.chunk } satisfies RNotebookCellMetadata;
      } else {
        data.metadata = {
          rNotebookMarkdown: {
            id: randomUUID(),
          },
        } satisfies RNotebookCellMetadata;
      }
      return data;
    });
    const notebook = new vscode.NotebookData(cells);
    notebook.metadata = {
      rNotebook: { eol: parsed.eol },
    } satisfies RNotebookDocumentMetadata;
    return notebook;
  }

  async prepareNotebook(
    notebook: vscode.NotebookDocument,
    restoreSidecar: boolean,
    retainedState?: NotebookState | Promise<NotebookState>,
    ready: Promise<unknown> = Promise.resolve()
  ): Promise<void> {
    if (notebook.notebookType !== NOTEBOOK_TYPE) {
      return;
    }
    // Register restoration before awaiting prior saves/preparations. A close
    // can capture state at any point, including before the sidecar read starts.
    const restoration = retainedState || (restoreSidecar && notebook.uri.scheme === "file")
      ? ready.then(() => retainedState ?? readNotebookStateFile(notebook.uri.fsPath))
      : undefined;
    if (restoration) this.restoring.set(notebook, restoration);
    const state = await (restoration ?? ready.then(() => undefined));
    if (notebook.isClosed) return;
    const restored = state
      ? reconcileNotebookState(notebookSource(notebook), state)
      : undefined;
    const outputs = new Map(
      restored?.cellOutputs.map((output) => [output.cell, output]) ?? []
    );
    const metadata = notebook.metadata as RNotebookDocumentMetadata;
    const eol = metadata.rNotebook?.eol ?? "\n";
    const edits: vscode.NotebookEdit[] = [];
    for (const cell of notebook.getCells()) {
      let cellMetadata = cell.metadata as RNotebookCellMetadata;
      if (cell.kind === vscode.NotebookCellKind.Markup) {
        const id = cellMetadata.rNotebookMarkdown?.id ||
          randomUUID();
        if (cellMetadata.rNotebookMarkdown?.id !== id) {
          cellMetadata = {
            ...cellMetadata,
            rNotebookMarkdown: { id },
          };
        }
      } else if (!cellMetadata.rNotebook) {
        cellMetadata = {
          ...cellMetadata,
          rNotebook: defaultChunk(cell.document.languageId, eol),
        };
      }
      const stored = outputs.get(cell.index);
      const hasLocalOutput = cell.outputs.some(
        (output) => !cellOptionsRequestId(output.metadata)
      );
      if (stored && !hasLocalOutput) {
        // Older sidecars only recorded the full chunk hash. Recover a code
        // baseline when that chunk still matches; otherwise its code is unknown.
        const currentSourceHash = notebookSourceHash(codeCellSource({
          kind: "code", value: cell.document.getText(),
          languageId: cell.document.languageId, chunk: cellMetadata.rNotebook,
        }, eol));
        cellMetadata = {
          ...cellMetadata,
          rNotebookOutputSourceHash: stored.sourceHash,
          rNotebookOutputCodeHash: stored.codeHash ?? (stored.sourceHash === currentSourceHash
            ? outputCodeHash(cell.document.getText()) : undefined),
        };
        const replacement = new vscode.NotebookCellData(
          cell.kind,
          cell.document.getText(),
          cell.document.languageId
        );
        replacement.metadata = cellMetadata;
        replacement.outputs = storedOutputs(stored);
        replacement.executionSummary = stored.executionSummary;
        edits.push(vscode.NotebookEdit.replaceCells(
          new vscode.NotebookRange(cell.index, cell.index + 1),
          [replacement]
        ));
      } else if (cellMetadata !== cell.metadata) {
        edits.push(vscode.NotebookEdit.updateCellMetadata(
          cell.index,
          cellMetadata
        ));
      }
    }

    if (edits.length === 0) {
      if (this.restoring.get(notebook) === restoration) this.restoring.delete(notebook);
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.set(notebook.uri, edits);
    if (!await vscode.workspace.applyEdit(edit)) {
      throw new Error("VS Code could not prepare the R notebook state.");
    }
    if (this.restoring.get(notebook) === restoration) this.restoring.delete(notebook);
  }

  serializeNotebook(data: vscode.NotebookData): Uint8Array {
    const metadata = data.metadata as RNotebookDocumentMetadata | undefined;
    const eol = metadata?.rNotebook?.eol ?? "\n";
    const cells: ParsedCell[] = data.cells.map((cell) => {
      const cellMetadata = cell.metadata as RNotebookCellMetadata | undefined;
      return {
        kind: cell.kind === vscode.NotebookCellKind.Code ? "code" : "markup",
        value: cell.value,
        languageId: cell.languageId,
        chunk: cellMetadata?.rNotebook,
      };
    });
    const source = serializeDocument(cells, eol);
    return new TextEncoder().encode(source);
  }

  captureState(notebook: vscode.NotebookDocument): Promise<NotebookStateSnapshot> {
    // Capture live cells synchronously: a closed document may disappear while
    // its sidecar is still loading. Local outputs always win over restored ones.
    const source = notebookSource(notebook);
    const sourceHash = notebookSourceHash(source);
    const stateCells = storedCells(source);
    const codeCells = stateCells.flatMap((cell, index) =>
      cell.kind === "code" ? [{ ...cell, index }] : []
    );
    const cellOutputs: StoredCellOutput[] = [];
    let codeCellIndex = 0;
    for (const cell of notebook.getCells()) {
      if (cell.kind !== vscode.NotebookCellKind.Code) {
        continue;
      }
      const stateCell = codeCells[codeCellIndex++];
      if (!stateCell) {
        throw new Error("The R notebook cell state does not match its source.");
      }
      const outputs = cell.outputs.filter(
        (output) => !cellOptionsRequestId(output.metadata)
      );
      if (outputs.length === 0) {
        continue;
      }
      const cellMetadata = cell.metadata as RNotebookCellMetadata;
      const recordedSourceHash = cellMetadata.rNotebookOutputSourceHash;
      cellOutputs.push({
        cell: stateCell.index,
        sourceHash: recordedSourceHash ?? stateCell.sourceHash,
        codeHash: cellMetadata.rNotebookOutputCodeHash ?? (
          recordedSourceHash === undefined || recordedSourceHash === stateCell.sourceHash
            ? outputCodeHash(cell.document.getText()) : undefined
        ),
        outputs: outputs.map((output) => ({
          items: output.items.map((item) => ({
            mime: item.mime,
            data: Buffer.from(item.data).toString("base64"),
          })),
          metadata: output.metadata,
        })),
        executionSummary: cell.executionSummary,
      });
    }
    const snapshot: NotebookStateSnapshot = {
      uri: notebook.uri,
      state: {
        version: 1,
        sourceHash,
        cells: stateCells,
        cellOutputs,
      },
    };
    const captured = (this.restoring.get(notebook) ?? Promise.resolve(undefined))
      .then((state) => {
        if (state) {
          const localCells = new Set(cellOutputs.map((output) => output.cell));
          const restored = reconcileNotebookState(source, state);
          cellOutputs.push(...restored.cellOutputs.filter((output) => !localCells.has(output.cell)));
        }
        return snapshot;
      });
    // Saves are queued; a failed restoration may reject before its save runs.
    void captured.catch(() => undefined);
    return captured;
  }

  async saveState(pending: NotebookStateSnapshot | Promise<NotebookStateSnapshot>): Promise<void> {
    const snapshot = await pending;
    await writeNotebookStateFile(
      snapshot.uri.fsPath,
      snapshot.state
    );
  }
}
