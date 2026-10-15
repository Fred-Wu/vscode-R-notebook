import * as vscode from "vscode";
import { needsPlainRCompletionProxy } from "./rCompletionSupport";

/**
 * vscode-R already runs an independent R language server. The notebook-cell
 * URI retains the .rmd/.qmd filename, so R languageserver treats the *plain-R
 * cell content* as a full R Markdown document and rejects completion outside
 * fenced chunks. Forward completion to an unsaved R text document instead.
 *
 * One shadow document is reused for all cells to avoid starting an R process
 * or creating on-disk files. Requests are serialized because its content is
 * replaced before each completion query.
 */
export class RNotebookCodeCompletionProvider implements vscode.CompletionItemProvider {
  private shadow?: Promise<vscode.TextDocument>;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly output: vscode.OutputChannel) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.CompletionContext
  ): Promise<vscode.CompletionList> {
    const pending = this.queue.then(async () => {
      if (token.isCancellationRequested ||
        !needsPlainRCompletionProxy(document.uri.scheme, document.uri.path, document.languageId)) {
        return new vscode.CompletionList();
      }
      const source = document.getText();
      if (!this.shadow) {
        this.shadow = Promise.resolve(vscode.workspace.openTextDocument({ language: "r", content: source }))
          .catch((error: unknown) => {
            this.shadow = undefined;
            throw error;
          });
      }
      const shadow = await this.shadow;
      if (token.isCancellationRequested) return new vscode.CompletionList();

      if (shadow.getText() !== source) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(shadow.uri, new vscode.Range(
          shadow.positionAt(0),
          shadow.positionAt(shadow.getText().length)
        ), source);
        if (!await vscode.workspace.applyEdit(edit)) {
          throw new Error("Could not update the temporary R completion document.");
        }
      }
      if (token.isCancellationRequested) return new vscode.CompletionList();

      // This URI is untitled: and language r, so languageserver parses it as
      // plain R. The unchanged source gives both documents identical positions.
      // The selector for this provider excludes untitled: to avoid recursion.
      const result = await vscode.commands.executeCommand<vscode.CompletionList>(
        "vscode.executeCompletionItemProvider",
        shadow.uri,
        position,
        context.triggerCharacter
      );
      return token.isCancellationRequested
        ? new vscode.CompletionList()
        : result ?? new vscode.CompletionList();
    }).catch((error: unknown) => {
      this.output.appendLine(`[R completion] ${String(error)}`);
      return new vscode.CompletionList();
    });
    this.queue = pending.then(() => undefined);
    return pending;
  }
}
