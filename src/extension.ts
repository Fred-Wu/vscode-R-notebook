import * as vscode from "vscode";
import {
  NOTEBOOK_TYPE,
  type RNotebookCellMetadata,
} from "./Notebook/document";
import { RNotebookController } from "./Notebook/controller";
import { RNotebookEditing } from "./Notebook/editing";
import { CellOptionCompletionProvider } from "./Notebook/optionCompletions";
import { CellOptionsEditor } from "./Notebook/optionsEditor";
import { codeCellLabel } from "./Notebook/options";
import { RNotebookMarkdownCompletionProvider } from "./Notebook/markdownCompletions";
import { RMarkdownCellStatusBarProvider } from "./Notebook/statusBar";
import { RNotebookSerializer } from "./Notebook/serializer";
import {
  readNotebookStateFile,
  reconcileNotebookState,
  writeNotebookStateFile,
  type NotebookState,
} from "./Notebook/state";
import { RConsoleTransport } from "./Runtime/console";
import {
  isVscodeRWorkingDirectoryAccepted,
  VscodeRSessionRequestWatcher,
} from "./Runtime/vscodeR";

const stateSaves = new Map<string, Promise<void>>();

function isNotebookCell(value: unknown): value is vscode.NotebookCell {
  return Boolean(
    value &&
    typeof value === "object" &&
    "document" in value &&
    "notebook" in value &&
    "kind" in value
  );
}

function selectedCells(candidate?: unknown): vscode.NotebookCell[] {
  if (isNotebookCell(candidate)) {
    return [candidate];
  }
  const editor = vscode.window.activeNotebookEditor;
  if (!editor || editor.notebook.notebookType !== NOTEBOOK_TYPE) {
    return [];
  }
  const cells: vscode.NotebookCell[] = [];
  for (const selection of editor.selections) {
    for (let index = selection.start; index < selection.end; index += 1) {
      const cell = editor.notebook.cellAt(index);
      if (cell.kind === vscode.NotebookCellKind.Code) {
        cells.push(cell);
      }
    }
  }
  return cells;
}

function notebookForCommand(candidate?: unknown): vscode.NotebookDocument | undefined {
  let notebookUri: vscode.Uri | undefined;
  if (candidate instanceof vscode.Uri) {
    notebookUri = candidate;
  } else if (candidate && typeof candidate === "object") {
    const context = candidate as {
      uri?: unknown;
      notebookEditor?: { notebookUri?: unknown };
    };
    const contextUri = context.notebookEditor?.notebookUri ?? context.uri;
    if (contextUri instanceof vscode.Uri) {
      notebookUri = contextUri;
    }
  }

  const notebook = notebookUri
    ? vscode.workspace.notebookDocuments.find(
        (document) => document.uri.toString() === notebookUri.toString()
      )
    : vscode.window.activeNotebookEditor?.notebook;
  return notebook?.notebookType === NOTEBOOK_TYPE ? notebook : undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  const serializer = new RNotebookSerializer();
  const output = vscode.window.createOutputChannel("R Notebook Kernel");
  const closedNotebookStates = new Map<string, NotebookState>();
  const notebookPreparations = new Map<string, Promise<void>>();
  const prepareNotebook = (
    notebook: vscode.NotebookDocument,
    restoreSidecar = false,
    retainedState?: NotebookState
  ): Promise<void> => {
    const key = notebook.uri.toString();
    const task = (notebookPreparations.get(key) ?? Promise.resolve())
      .then(() => restoreSidecar && !retainedState
        ? stateSaves.get(key)
        : undefined)
      .then(() => serializer.prepareNotebook(
        notebook,
        restoreSidecar,
        retainedState
      ))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[Notebook] Could not prepare notebook state: ${message}`);
      });
    notebookPreparations.set(key, task);
    void task.finally(() => {
      if (notebookPreparations.get(key) === task) {
        notebookPreparations.delete(key);
      }
    });
    return task;
  };
  const stateEnabled = (uri: vscode.Uri): boolean => vscode.workspace
    .getConfiguration("r.notebook", uri)
    .get<boolean>("saveState", true);
  const textEditorDocuments = new Set<string>();
  const isNativeSource = (uri: vscode.Uri): boolean =>
    uri.scheme === "file" && /\.(?:qmd|rmd)$/i.test(uri.fsPath);
  const queueStateSave = (uri: vscode.Uri, save: () => Promise<void>): void => {
    const key = uri.toString();
    const task = (stateSaves.get(key) ?? Promise.resolve())
      .then(save)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[Notebook] Could not save state: ${message}`);
        void vscode.window.showErrorMessage(`Could not save R notebook state: ${message}`);
      });
    stateSaves.set(key, task);
    void task.finally(() => {
      if (stateSaves.get(key) === task) {
        stateSaves.delete(key);
      }
    });
  };
  const saveNotebookState = (notebook: vscode.NotebookDocument): void => {
    if (
      notebook.notebookType !== NOTEBOOK_TYPE ||
      notebook.uri.scheme !== "file" ||
      !stateEnabled(notebook.uri)
    ) {
      return;
    }
    const snapshot = serializer.captureState(notebook);
    queueStateSave(notebook.uri, () => serializer.saveState(snapshot));
  };
  const activeSourceEditorUri = (): vscode.Uri | undefined => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    const uri = input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom
      ? input.uri
      : undefined;
    return uri && isNativeSource(uri) ? uri : undefined;
  };
  let activeSourceEditorKey = activeSourceEditorUri()?.toString();
  if (activeSourceEditorKey) {
    textEditorDocuments.add(activeSourceEditorKey);
  }
  const observeSourceEditor = (): void => {
    const uri = activeSourceEditorUri();
    const key = uri?.toString();
    if (key === activeSourceEditorKey) {
      return;
    }
    activeSourceEditorKey = key;
    if (!uri || !key) {
      return;
    }
    textEditorDocuments.add(key);
    if (!stateEnabled(uri)) {
      return;
    }
    const notebook = vscode.workspace.notebookDocuments.find(
      (document) => document.notebookType === NOTEBOOK_TYPE &&
        document.uri.toString() === key
    );
    if (notebook) {
      saveNotebookState(notebook);
    }
  };
  let controller: RNotebookController;
  const sessionRequestWatcher = new VscodeRSessionRequestWatcher(
    async (request) => {
      const workspaceDirectories = vscode.workspace.workspaceFolders?.map(
        (folder) => folder.uri.fsPath
      );
      if (
        isVscodeRWorkingDirectoryAccepted(
          request.workingDirectory,
          workspaceDirectories
        )
      ) {
        await controller.handleVscodeRSessionRequest(request);
        return true;
      }
      return false;
    },
    (message) => output.appendLine(message)
  );
  controller = new RNotebookController(
    context.asAbsolutePath("resources/r/execute.R"),
    output,
    () => sessionRequestWatcher.synchronize(),
    () => {
      const attachmentCheckpoint = sessionRequestWatcher.attachmentCheckpoint();
      return (processId) => sessionRequestWatcher.waitForAttachment(
        processId,
        attachmentCheckpoint
      );
    }
  );
  const editing = new RNotebookEditing();
  const markdownMessaging = vscode.notebooks.createRendererMessaging(
    "r-notebook-markdown-renderer"
  );
  const cellOptionsMessaging = vscode.notebooks.createRendererMessaging(
    "r-notebook-cell-options-renderer"
  );
  const optionCompletions = new CellOptionCompletionProvider(output);
  const markdownCompletions = new RNotebookMarkdownCompletionProvider(output);
  const quartoConfigurationWatcher = vscode.workspace.createFileSystemWatcher(
    "**/*.{yml,yaml}"
  );
  const cellOptionsEditor = new CellOptionsEditor(
    cellOptionsMessaging,
    (notebookUri, documentKind) =>
      optionCompletions.load(notebookUri, documentKind)
  );
  const cellStatusBar = new RMarkdownCellStatusBarProvider();
  const consoleTransport = new RConsoleTransport();
  const refreshQuartoCompletions = (): void => {
    markdownCompletions.invalidateQuartoFormats();
    vscode.workspace.notebookDocuments.forEach((notebook) =>
      markdownCompletions.prepareQuarto(notebook)
    );
  };
  vscode.workspace.notebookDocuments.forEach((notebook) =>
    markdownCompletions.prepareQuarto(notebook)
  );

  context.subscriptions.push(
    vscode.workspace.registerNotebookSerializer(NOTEBOOK_TYPE, serializer, {
      transientOutputs: true,
      transientCellMetadata: {
        inputCollapsed: true,
        outputCollapsed: true,
        rNotebookMarkdown: true,
        rNotebookOutputSourceHash: true,
      },
      transientDocumentMetadata: {
        rNotebook: true,
        rNotebookState: true,
      },
    }),
    output,
    controller,
    controller.onDidChangeNotebookState(saveNotebookState),
    editing,
    cellOptionsEditor,
    cellStatusBar,
    markdownCompletions,
    quartoConfigurationWatcher,
    quartoConfigurationWatcher.onDidChange(refreshQuartoCompletions),
    quartoConfigurationWatcher.onDidCreate(refreshQuartoCompletions),
    quartoConfigurationWatcher.onDidDelete(refreshQuartoCompletions),
    vscode.languages.registerCompletionItemProvider(
      { language: "markdown", notebookType: NOTEBOOK_TYPE },
      markdownCompletions
    ),
    vscode.notebooks.registerNotebookCellStatusBarItemProvider(
      NOTEBOOK_TYPE,
      cellStatusBar
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("r.rpath") ||
        event.affectsConfiguration("r.notebook.quartoPath")
      ) {
        optionCompletions.clear();
        markdownCompletions.clear();
        vscode.workspace.notebookDocuments.forEach((notebook) =>
          markdownCompletions.prepareQuarto(notebook)
        );
      }
      if (event.affectsConfiguration("r.notebook.sessionStartup")) {
        const activeNotebook = vscode.window.activeNotebookEditor?.notebook;
        void controller.selectNotebook(activeNotebook)
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            output.appendLine(`[Session] Could not start the selected notebook: ${message}`);
          });
      }
    }),
    sessionRequestWatcher,
    controller.onDidChangeMarkdownState((notebook) => {
      for (const editor of vscode.window.visibleNotebookEditors) {
        if (editor.notebook === notebook) {
          void markdownMessaging.postMessage({
            type: "rNotebook.refreshText",
          }, editor);
        }
      }
    }),
    markdownMessaging.onDidReceiveMessage(async ({ editor, message }) => {
      const request = message as {
        type?: unknown;
        requestId?: unknown;
        markupId?: unknown;
        label?: unknown;
      };
      if (
        request.type === "rNotebook.revealReference" &&
        typeof request.label === "string"
      ) {
        const target = editor.notebook.getCells().find((cell) => {
          if (cell.kind !== vscode.NotebookCellKind.Code) {
            return false;
          }
          const chunk = (cell.metadata as RNotebookCellMetadata).rNotebook;
          return codeCellLabel(cell.document.getText(), chunk) === request.label;
        });
        if (target) {
          editor.revealRange(
            new vscode.NotebookRange(target.index, target.index + 1),
            vscode.NotebookEditorRevealType.InCenter
          );
        }
        return;
      }
      if (
        request.type !== "rNotebook.renderText" ||
        typeof request.requestId !== "string" ||
        typeof request.markupId !== "string" ||
        editor.notebook.notebookType !== NOTEBOOK_TYPE
      ) {
        return;
      }
      await notebookPreparations.get(editor.notebook.uri.toString());
      try {
        const result = await controller.renderText(
          editor.notebook,
          request.markupId
        );
        await markdownMessaging.postMessage({
          type: "rNotebook.textResult",
          requestId: request.requestId,
          ...result,
        }, editor);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[Markdown] ${message}`);
        await markdownMessaging.postMessage({
          type: "rNotebook.textResult",
          requestId: request.requestId,
          error: message,
        }, editor);
      }
    }),
    vscode.workspace.onDidOpenNotebookDocument((notebook) => {
      if (notebook.notebookType !== NOTEBOOK_TYPE) {
        return;
      }
      controller.prefer(notebook);
      const key = notebook.uri.toString();
      textEditorDocuments.delete(key);
      const retainedState = closedNotebookStates.get(key);
      closedNotebookStates.delete(key);
      prepareNotebook(
        notebook,
        stateEnabled(notebook.uri),
        retainedState
      );
      markdownCompletions.prepareQuarto(notebook);
    }),
    vscode.workspace.onDidCloseNotebookDocument((notebook) => {
      if (notebook.notebookType !== NOTEBOOK_TYPE) {
        return;
      }
      const snapshot = serializer.captureState(notebook);
      closedNotebookStates.set(notebook.uri.toString(), snapshot.state);
      if (
        notebook.uri.scheme === "file" &&
        stateEnabled(notebook.uri)
      ) {
        queueStateSave(notebook.uri, () => serializer.saveState(snapshot));
      }
    }),
    vscode.workspace.onDidSaveNotebookDocument(saveNotebookState),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (
        !isNativeSource(document.uri) ||
        !stateEnabled(document.uri)
      ) {
        return;
      }
      const source = document.getText();
      queueStateSave(document.uri, async () => {
        const existing = await readNotebookStateFile(
          document.uri.fsPath
        );
        if (!existing) {
          return;
        }
        await writeNotebookStateFile(
          document.uri.fsPath,
          reconcileNotebookState(source, existing)
        );
      });
    }),
    vscode.window.tabGroups.onDidChangeTabs(({ opened, closed }) => {
      observeSourceEditor();
      for (const tab of opened) {
        if (
          tab.input instanceof vscode.TabInputNotebook &&
          tab.input.notebookType === NOTEBOOK_TYPE
        ) {
          controller.notebookTabOpened(tab.input.uri);
        }
      }
      for (const tab of closed) {
        if (
          !(tab.input instanceof vscode.TabInputNotebook) ||
          tab.input.notebookType !== NOTEBOOK_TYPE
        ) {
          continue;
        }
        const notebookKey = tab.input.uri.toString();
        const remainsOpen = vscode.window.tabGroups.all.some((group) =>
          group.tabs.some((candidate) =>
            candidate.input instanceof vscode.TabInputNotebook &&
            candidate.input.notebookType === NOTEBOOK_TYPE &&
            candidate.input.uri.toString() === notebookKey
          )
        );
        if (!remainsOpen) {
          controller.notebookTabClosed(tab.input.uri);
        }
      }
    }),
    vscode.window.tabGroups.onDidChangeTabGroups(observeSourceEditor),
    vscode.window.onDidChangeActiveNotebookEditor((editor) => {
      void vscode.commands.executeCommand(
        "setContext",
        "r.notebook.activeEditor",
        editor?.notebook.notebookType === NOTEBOOK_TYPE
      );
      if (
        editor &&
        textEditorDocuments.delete(editor.notebook.uri.toString())
      ) {
        prepareNotebook(editor.notebook, stateEnabled(editor.notebook.uri));
      }
      void controller.selectNotebook(editor?.notebook).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[Session] Could not attach the selected notebook: ${message}`);
      });
    }),
    vscode.window.onDidCloseTerminal((terminal) => {
      if (consoleTransport.didCloseConsole(terminal)) {
        void controller.restoreAfterConsole().catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          output.appendLine(`[Session] Could not restore the notebook after R Console closed: ${message}`);
        });
      }
    }),
    vscode.window.onDidChangeActiveTerminal((terminal) => {
      if (terminal && consoleTransport.isConsole(terminal)) {
        void controller.observeConsole().catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          output.appendLine(`[Session] Could not observe R Console attachment: ${message}`);
        });
      }
    }),
    vscode.workspace.onDidChangeNotebookDocument(({
      notebook,
      contentChanges,
    }) => {
      if (notebook.notebookType !== NOTEBOOK_TYPE) {
        return;
      }
      const hasUnpreparedCell = contentChanges.some((change) =>
        change.addedCells.some((cell) =>
          cell.kind === vscode.NotebookCellKind.Markup
            ? !(cell.metadata as RNotebookCellMetadata).rNotebookMarkdown?.id
            : !(cell.metadata as RNotebookCellMetadata).rNotebook
        )
      );
      if (hasUnpreparedCell) {
        prepareNotebook(notebook);
      }
      const codeOptionsChanged = controller.markdownCodeOptionsChanged(notebook);
      if (contentChanges.length > 0 || codeOptionsChanged) {
        void controller.refreshMarkdown(notebook).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          output.appendLine(`[Markdown] Could not refresh changed notebook text: ${message}`);
        });
      }
      cellStatusBar.refresh();
    }),
    vscode.commands.registerCommand("r-notebook.openAsNotebook", async (resource?: vscode.Uri) => {
      const uri = resource ?? vscode.window.activeTextEditor?.document.uri;
      if (!uri) {
        void vscode.window.showInformationMessage("Choose an R Markdown or Quarto file to open.");
        return;
      }
      await vscode.commands.executeCommand("vscode.openWith", uri, NOTEBOOK_TYPE);
    }),
    vscode.commands.registerCommand("r-notebook.editCellOptions", async (candidate?: unknown) => {
      const cell = selectedCells(candidate)[0];
      if (!cell) {
        void vscode.window.showInformationMessage("Select an R notebook code cell first.");
        return;
      }
      try {
        await prepareNotebook(cell.notebook);
        await cellOptionsEditor.toggle(cell.notebook.cellAt(cell.index));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Could not edit cell options: ${message}`);
      }
    }),
    vscode.commands.registerCommand("r-notebook.runCellInConsole", async (candidate?: unknown) => {
      const cells = selectedCells(candidate);
      if (cells.length === 0) {
        void vscode.window.showInformationMessage("Select an R notebook code cell to run.");
        return;
      }
      try {
        await controller.sendToConsole(cells, consoleTransport);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(message);
      }
    }),
    vscode.commands.registerCommand("r-notebook.viewWorkspaceObject", async (candidate?: unknown) => {
      if (!candidate || typeof candidate !== "object") {
        void vscode.window.showInformationMessage(
          "Choose an object in the R Workspace Viewer first."
        );
        return;
      }
      const node = candidate as {
        label?: unknown;
      };
      if (typeof node.label !== "string" || !node.label) {
        void vscode.window.showInformationMessage(
          "Choose a top-level object in the R Workspace Viewer."
        );
        return;
      }
      try {
        await controller.viewWorkspaceObject(node.label);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Could not open R Data Viewer: ${message}`);
      }
    }),
    vscode.commands.registerCommand("r-notebook.restartSession", async (candidate?: unknown) => {
      const notebook = notebookForCommand(candidate);
      if (!notebook) {
        void vscode.window.showInformationMessage("Open an R Markdown or Quarto notebook first.");
        return;
      }
      try {
        if (await controller.restartSession(notebook)) {
          void vscode.window.showInformationMessage("R notebook session restarted.");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Could not restart the R session: ${message}`);
      }
    }),
    vscode.commands.registerCommand("r-notebook.startSession", async (candidate?: unknown) => {
      const notebook = notebookForCommand(candidate);
      if (!notebook) {
        void vscode.window.showInformationMessage("Open an R Markdown or Quarto notebook first.");
        return;
      }
      try {
        await controller.startSession(notebook, true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Could not start the R session: ${message}`);
      }
    }),
    vscode.commands.registerCommand("r-notebook.reopenRunningSession", async () => {
      const retained = controller.retainedNotebookSessions();
      if (retained.length === 0) {
        void vscode.window.showInformationMessage("No closed R notebooks have a running session.");
        return;
      }
      const now = Date.now();
      const selected = await vscode.window.showQuickPick(
        retained.map((session) => {
          const remaining = session.shutdownAt === undefined
            ? "Automatic shutdown disabled"
            : `Shuts down in ${Math.max(1, Math.ceil((session.shutdownAt - now) / 60_000))} min`;
          return {
            label: vscode.workspace.asRelativePath(session.uri, false),
            description: remaining,
            detail: session.uri.fsPath,
            session,
          };
        }),
        { placeHolder: "Select a running R notebook session to reopen" }
      );
      if (selected) {
        await vscode.commands.executeCommand(
          "vscode.openWith",
          selected.session.uri,
          NOTEBOOK_TYPE
        );
      }
    }),
    vscode.commands.registerCommand("r-notebook.closeSessionAndNotebook", async (candidate?: unknown) => {
      const notebook = notebookForCommand(candidate);
      if (!notebook) {
        void vscode.window.showInformationMessage("Open an R Markdown or Quarto notebook first.");
        return;
      }
      const notebookUri = notebook.uri;
      const matchesNotebook = (candidateTab: vscode.Tab): boolean =>
        candidateTab.input instanceof vscode.TabInputNotebook &&
        candidateTab.input.notebookType === NOTEBOOK_TYPE &&
        candidateTab.input.uri.toString() === notebookUri.toString();
      const tabs = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .filter(matchesNotebook);
      if (tabs.length === 0) {
        void vscode.window.showInformationMessage("The R notebook tab is no longer open.");
        return;
      }
      if (await vscode.window.tabGroups.close(tabs)) {
        controller.shutdownSession(notebookUri);
      }
    })
  );

  for (const notebook of vscode.workspace.notebookDocuments) {
    if (notebook.notebookType !== NOTEBOOK_TYPE) {
      continue;
    }
    controller.prefer(notebook);
    prepareNotebook(notebook, stateEnabled(notebook.uri));
  }
  void vscode.commands.executeCommand(
    "setContext",
    "r.notebook.activeEditor",
    vscode.window.activeNotebookEditor?.notebook.notebookType === NOTEBOOK_TYPE
  );
  void controller.selectNotebook(vscode.window.activeNotebookEditor?.notebook).catch(
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`[Session] Could not attach the selected notebook: ${message}`);
    }
  );
}

export async function deactivate(): Promise<void> {
  while (stateSaves.size > 0) {
    await Promise.all(stateSaves.values());
  }
}
