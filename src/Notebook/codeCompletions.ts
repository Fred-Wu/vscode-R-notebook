import * as vscode from "vscode";
import { NOTEBOOK_TYPE, type RNotebookCellMetadata } from "./document";
import { isQuartoNotebook } from "../notebookFile";
import { CellOptionCompletionProvider } from "./optionCompletions";

/** Chunk-option completions complement, rather than replace, vscode-R's language server. */
export class RNotebookCodeCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly options: CellOptionCompletionProvider) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.CompletionItem[]> {
    const notebook = vscode.workspace.notebookDocuments.find((candidate) =>
      candidate.notebookType === NOTEBOOK_TYPE &&
      candidate.getCells().some((cell) => cell.document.uri.toString() === document.uri.toString())
    );
    if (!notebook) return [];
    const cell = notebook.getCells().find((candidate) =>
      candidate.document.uri.toString() === document.uri.toString());
    if (!cell || cell.kind !== vscode.NotebookCellKind.Code ||
      (cell.metadata as RNotebookCellMetadata).rNotebook?.engine.toLowerCase() !== "r") return [];
    const before = document.lineAt(position.line).text.slice(0, position.character);
    const match = /^\s*#\|\s*([\w.-]*)$/.exec(before);
    if (match) {
      const kind = isQuartoNotebook(notebook.uri.fsPath) ? "quarto" : "rMarkdown";
      const completions = await this.options.load(notebook.uri, kind);
      if (token.isCancellationRequested) return [];
      const prefix = match[1] ?? "";
      const candidates = kind === "quarto" ? completions.quarto : completions.rMarkdown;
      return candidates.filter((item) => item.name.startsWith(prefix)).map((candidate) => {
        const item = new vscode.CompletionItem(candidate.name, vscode.CompletionItemKind.Property);
        item.range = new vscode.Range(position.line, position.character - prefix.length, position.line, position.character);
        item.insertText = `${candidate.name}: `;
        return item;
      });
    }
    // Normal R identifiers are served by vscode-R's R Language Server.
    return [];
  }
}
