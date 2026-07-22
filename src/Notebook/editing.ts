import * as vscode from "vscode";
import { NOTEBOOK_TYPE } from "./document";

interface Continuation {
  position: vscode.Position;
  text: string;
}

interface EnterArguments {
  acceptSuggestion?: boolean;
}

export class RNotebookEditing implements vscode.Disposable {
  private readonly command: vscode.Disposable;

  constructor() {
    this.command = vscode.commands.registerCommand(
      "r-notebook.enter",
      async (options?: EnterArguments) => this.enter(
        options?.acceptSuggestion === true
      )
    );
  }

  private continuations(editor: vscode.TextEditor | undefined): Continuation[] | undefined {
    if (!editor || editor.document.languageId !== "r" || !this.isNotebookCell(editor.document)) {
      return undefined;
    }

    const continuations: Continuation[] = [];
    for (const selection of editor.selections) {
      if (!selection.isEmpty) {
        return undefined;
      }
      const line = editor.document.lineAt(selection.active.line);
      const beforeCursor = line.text.slice(0, selection.active.character);
      const match = /^([ \t]*)#\|([ \t]*)(.*)$/.exec(beforeCursor);
      if (match?.[1] === undefined || match[3] === undefined) {
        return undefined;
      }
      const eol = editor.document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
      continuations.push({
        position: selection.active,
        text: match[3].trim().length > 0
          ? `${eol}${match[1]}#| `
          : eol,
      });
    }
    return continuations;
  }

  private isNotebookCell(document: vscode.TextDocument): boolean {
    const documentUri = document.uri.toString();
    return vscode.workspace.notebookDocuments.some(
      (notebook) =>
        notebook.notebookType === NOTEBOOK_TYPE &&
        notebook
          .getCells()
          .some(
            (cell) =>
              cell.kind === vscode.NotebookCellKind.Code &&
              cell.document.uri.toString() === documentUri
          )
    );
  }

  private async enter(acceptSuggestion: boolean): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const continuations = this.continuations(editor);
    if (!editor || !continuations) {
      if (acceptSuggestion) {
        await vscode.commands.executeCommand("acceptSelectedSuggestion");
        return;
      }
      await vscode.commands.executeCommand("type", { text: "\n" });
      return;
    }

    await editor.edit(
      (edit) => {
        for (const continuation of continuations) {
          edit.insert(continuation.position, continuation.text);
        }
      },
      { undoStopBefore: true, undoStopAfter: true }
    );
  }

  dispose(): void {
    this.command.dispose();
  }
}
