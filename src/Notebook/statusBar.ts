import * as vscode from "vscode";
import {
  NOTEBOOK_TYPE,
  codeCellSource,
  type RNotebookCellMetadata,
  type RNotebookDocumentMetadata,
} from "./document";
import { cellOptionsRequestId, rMarkdownStatusHeader } from "./options";
import { notebookSourceHash } from "./state";

export class RMarkdownCellStatusBarProvider implements
  vscode.NotebookCellStatusBarItemProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCellStatusBarItems = this.changed.event;

  provideCellStatusBarItems(
    cell: vscode.NotebookCell
  ): vscode.NotebookCellStatusBarItem[] | undefined {
    if (
      cell.notebook.notebookType !== NOTEBOOK_TYPE ||
      cell.kind !== vscode.NotebookCellKind.Code
    ) {
      return undefined;
    }
    const metadata = cell.metadata as RNotebookCellMetadata;
    const items: vscode.NotebookCellStatusBarItem[] = [];
    const outputSourceHash = metadata.rNotebookOutputSourceHash;
    const eol = (cell.notebook.metadata as RNotebookDocumentMetadata)
      .rNotebook?.eol ?? "\n";
    const outputIsStale = outputSourceHash !== undefined &&
      outputSourceHash !== notebookSourceHash(codeCellSource({
        kind: "code",
        value: cell.document.getText(),
        languageId: cell.document.languageId,
        chunk: metadata.rNotebook,
      }, eol));
    if (
      outputIsStale &&
      cell.outputs.some((output) => !cellOptionsRequestId(output.metadata))
    ) {
      const stale = new vscode.NotebookCellStatusBarItem(
        "⚠️ Output is from older codes",
        vscode.NotebookCellStatusBarAlignment.Right
      );
      stale.priority = 200;
      stale.tooltip = "This output was produced before the cell was edited. Run the cell to update it.";
      items.push(stale);
    }
    if (metadata.rNotebook) {
      const text = rMarkdownStatusHeader(
        cell.notebook.uri.fsPath,
        metadata.rNotebook,
        cell.document.getText()
      );
      if (text) {
        const options = new vscode.NotebookCellStatusBarItem(
          text,
          vscode.NotebookCellStatusBarAlignment.Right
        );
        options.priority = 100;
        options.tooltip = "R Markdown chunk header — click to edit cell options";
        options.command = "r-notebook.editCellOptions";
        items.push(options);
      }
    }
    return items.length > 0 ? items : undefined;
  }

  refresh(): void {
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }
}
