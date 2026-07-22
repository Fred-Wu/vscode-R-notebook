import { randomUUID } from "node:crypto";
import { TextDecoder, TextEncoder } from "node:util";
import * as vscode from "vscode";
import {
  NOTEBOOK_TYPE,
  defaultChunk,
  parseDocument,
  serializeDocument,
  type ParsedCell,
  type RNotebookCellMetadata,
  type RNotebookDocumentMetadata,
} from "./document";
import {
  notebookSourceHash,
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
  deserializeNotebook(content: Uint8Array): vscode.NotebookData {
    const parsed = parseDocument(new TextDecoder().decode(content));
    const cells = parsed.cells.map((cell) => {
      const data = new vscode.NotebookCellData(
        cell.kind === "code" ? vscode.NotebookCellKind.Code : vscode.NotebookCellKind.Markup,
        cell.value,
        cell.languageId
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
    retainedState?: NotebookState
  ): Promise<void> {
    if (notebook.notebookType !== NOTEBOOK_TYPE) {
      return;
    }
    const state = retainedState ?? (restoreSidecar && notebook.uri.scheme === "file"
      ? await readNotebookStateFile(notebook.uri.fsPath)
      : undefined);
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
        cellMetadata = {
          ...cellMetadata,
          rNotebookOutputSourceHash: stored.sourceHash,
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
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.set(notebook.uri, edits);
    if (!await vscode.workspace.applyEdit(edit)) {
      throw new Error("VS Code could not prepare the R notebook state.");
    }
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

  captureState(notebook: vscode.NotebookDocument): NotebookStateSnapshot {
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
    return {
      uri: notebook.uri,
      state: {
        version: 1,
        sourceHash,
        cells: stateCells,
        cellOutputs,
      },
    };
  }

  async saveState(snapshot: NotebookStateSnapshot): Promise<void> {
    await writeNotebookStateFile(
      snapshot.uri.fsPath,
      snapshot.state
    );
  }
}
