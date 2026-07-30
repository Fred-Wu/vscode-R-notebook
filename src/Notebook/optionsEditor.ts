import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import type { RNotebookCellMetadata } from "./document";
import type { MergedCellOptions } from "./optionMerge";
import type { CellOptionCompletions } from "./optionSchema";
import {
  CELL_OPTIONS_MIME,
  cellOptionsRequestId,
  chunkHeader,
  chunkHeaderFields,
  quartoOptionFields,
  updateChunkHeaderFields,
  updateQuartoOptionFields,
  type CellOptionsFormData,
} from "./options";

interface RendererMessage {
  type?: unknown;
  requestId?: unknown;
  action?: unknown;
  label?: unknown;
  headerOptions?: unknown;
  quartoOptions?: unknown;
}

export class CellOptionsEditor implements vscode.Disposable {
  private readonly receiver: vscode.Disposable;

  constructor(
    private readonly messaging: vscode.NotebookRendererMessaging,
    private readonly loadCompletions: (
      notebookUri: vscode.Uri,
      documentKind: "quarto" | "rMarkdown"
    ) => Promise<CellOptionCompletions>,
    private readonly mergeOptions: (
      notebookUri: vscode.Uri,
      headerOptions: string,
      pipeOptions: string,
      target: "header" | "pipe"
    ) => Promise<MergedCellOptions>
  ) {
    this.receiver = messaging.onDidReceiveMessage(({ editor, message }) => {
      void this.receiveMessage(editor, message as RendererMessage);
    });
  }

  async toggle(cell: vscode.NotebookCell): Promise<void> {
    const openForm = cell.outputs.some(
      (output) => cellOptionsRequestId(output.metadata)
    );
    if (openForm) {
      await this.close(cell);
      return;
    }

    const chunk = (cell.metadata as RNotebookCellMetadata).rNotebook;
    if (!chunk) {
      throw new Error("This cell has no native R Markdown or Quarto chunk header.");
    }
    const header = chunkHeader(chunk.openingFence);
    if (header === undefined) {
      throw new Error("This cell has an invalid native chunk header.");
    }
    const fields = chunkHeaderFields(header, chunk.engine);
    const quartoFields = quartoOptionFields(cell.document.getText());
    const documentKind = path.extname(cell.notebook.uri.fsPath).toLowerCase() === ".qmd"
      ? "quarto"
      : "rMarkdown";
    const completions = await this.loadCompletions(
      cell.notebook.uri,
      documentKind
    );
    const formData: CellOptionsFormData = {
      requestId: randomUUID(),
      documentKind,
      label: quartoFields.label || fields.label,
      headerOptions: fields.options,
      quartoOptions: quartoFields.options,
      rMarkdownCompletions: completions.rMarkdown,
      quartoCompletions: completions.quarto,
    };
    const formOutput = new vscode.NotebookCellOutput(
      [vscode.NotebookCellOutputItem.json(formData, CELL_OPTIONS_MIME)],
      { rNotebookCellOptions: formData.requestId }
    );
    if (!await this.replaceCell(cell, [formOutput, ...cell.outputs])) {
      throw new Error("VS Code could not open the cell options editor.");
    }
  }

  private formCell(
    notebook: vscode.NotebookDocument,
    requestId: string
  ): vscode.NotebookCell | undefined {
    return notebook.getCells().find((cell) =>
      cell.outputs.some(
        (output) => cellOptionsRequestId(output.metadata) === requestId
      )
    );
  }

  private replaceCell(
    cell: vscode.NotebookCell,
    outputs: readonly vscode.NotebookCellOutput[]
  ): Thenable<boolean> {
    const replacement = new vscode.NotebookCellData(
      cell.kind,
      cell.document.getText(),
      cell.document.languageId
    );
    replacement.metadata = cell.metadata;
    replacement.outputs = [...outputs];
    replacement.executionSummary = cell.executionSummary;
    const edit = new vscode.WorkspaceEdit();
    edit.set(cell.notebook.uri, [
      vscode.NotebookEdit.replaceCells(
        new vscode.NotebookRange(cell.index, cell.index + 1),
        [replacement]
      ),
    ]);
    return vscode.workspace.applyEdit(edit);
  }

  private async close(cell: vscode.NotebookCell): Promise<void> {
    const outputs = cell.outputs.filter(
      (output) => !cellOptionsRequestId(output.metadata)
    );
    if (!await this.replaceCell(cell, outputs)) {
      throw new Error("VS Code could not close the cell options editor.");
    }
  }

  private async receiveMessage(
    editor: vscode.NotebookEditor,
    message: RendererMessage
  ): Promise<void> {
    if (typeof message.requestId !== "string") {
      return;
    }
    const formCell = this.formCell(editor.notebook, message.requestId);
    if (!formCell) {
      return;
    }
    if (message.type === "rNotebook.cancelCellOptions") {
      await this.close(formCell);
      return;
    }
    if (message.type !== "rNotebook.applyCellOptions") {
      return;
    }

    try {
      if (
        (message.action !== "apply" &&
          message.action !== "mergeToHeader" &&
          message.action !== "mergeToPipe") ||
        typeof message.label !== "string" ||
        typeof message.headerOptions !== "string" ||
        typeof message.quartoOptions !== "string"
      ) {
        throw new Error("The cell options editor returned invalid values.");
      }
      const chunk = (formCell.metadata as RNotebookCellMetadata).rNotebook;
      if (!chunk) {
        throw new Error("The target code cell is no longer available.");
      }
      const rMarkdown = path.extname(formCell.notebook.uri.fsPath).toLowerCase() !== ".qmd";
      if (!rMarkdown && message.action !== "apply") {
        throw new Error("Quarto cells always use pipe options.");
      }
      let headerOptions = rMarkdown ? message.headerOptions : "";
      let pipeOptions = message.quartoOptions;
      let headerLabel = "";
      let pipeLabel = rMarkdown ? "" : message.label;
      if (message.action === "mergeToHeader" || message.action === "mergeToPipe") {
        const target = message.action === "mergeToHeader" ? "header" : "pipe";
        const merged = await this.mergeOptions(
          formCell.notebook.uri,
          headerOptions,
          pipeOptions,
          target
        );
        headerLabel = target === "header" ? message.label : "";
        headerOptions = merged.headerOptions;
        pipeLabel = target === "pipe" ? message.label : "";
        pipeOptions = merged.pipeOptions;
      } else if (rMarkdown && message.label.trim()) {
        const header = chunkHeader(chunk.openingFence);
        const currentHeaderLabel = header === undefined
          ? ""
          : chunkHeaderFields(header, chunk.engine).label;
        const currentPipeLabel = quartoOptionFields(
          formCell.document.getText()
        ).label;
        if (currentPipeLabel) {
          pipeLabel = message.label;
        } else if (
          currentHeaderLabel ||
          headerOptions.trim() ||
          !pipeOptions.trim()
        ) {
          headerLabel = message.label;
        } else {
          pipeLabel = message.label;
        }
      }
      const nextChunk = updateChunkHeaderFields(
        chunk,
        headerLabel,
        headerOptions
      );
      const source = formCell.document.getText();
      const nextSource = updateQuartoOptionFields(
        source,
        pipeLabel,
        pipeOptions
      );
      const edit = new vscode.WorkspaceEdit();
      edit.set(formCell.notebook.uri, [
        vscode.NotebookEdit.updateCellMetadata(formCell.index, {
          ...formCell.metadata,
          rNotebook: nextChunk,
        }),
      ]);
      if (nextSource !== source) {
        edit.replace(
          formCell.document.uri,
          new vscode.Range(
            formCell.document.positionAt(0),
            formCell.document.positionAt(source.length)
          ),
          nextSource
        );
      }
      if (!await vscode.workspace.applyEdit(edit)) {
        throw new Error("VS Code could not apply the cell option changes.");
      }
      const currentForm = this.formCell(editor.notebook, message.requestId);
      if (currentForm) {
        await this.close(currentForm);
      }
    } catch (error) {
      await this.messaging.postMessage({
        type: "rNotebook.cellOptionsError",
        requestId: message.requestId,
        message: error instanceof Error ? error.message : String(error),
      }, editor);
    }
  }

  dispose(): void {
    this.receiver.dispose();
  }
}
