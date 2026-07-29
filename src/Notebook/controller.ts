import * as path from "node:path";
import { TextDecoder } from "node:util";
import * as vscode from "vscode";
import {
  NOTEBOOK_TYPE,
  NATIVE_TEXT_VERSION,
  codeCellSource,
  serializeDocument,
  type NativeTextState,
  type ParsedCell,
  type RNotebookCellMetadata,
  type RNotebookDocumentMetadata,
} from "./document";
import { nativeCodeOptionSignature, nativeTextDocument } from "./markdown";
import { notebookSourceHash } from "./state";
import { RExecutionBridge, type BridgeOutput } from "../Runtime/bridge";
import { type HiddenRProcess } from "../Runtime/process";
import { InlineAttachmentCoordinator } from "../Runtime/attachment";
import {
  createInlineRProcess,
  quartoExecutableSetting,
} from "../Runtime/launch";
import type { RConsoleTransport } from "../Runtime/console";
import type { VscodeRSessionRequest } from "../Runtime/vscodeR";

interface NotebookSession {
  uri: vscode.Uri;
  process: HiddenRProcess;
  bridge: RExecutionBridge;
  queue: Promise<void>;
  startup?: Promise<void>;
  stopped: boolean;
  textRevision: number;
  closedAt?: number;
  shutdownAt?: number;
  shutdownTimer?: NodeJS.Timeout;
  pendingTextRender?: {
    key: string;
    promise: Promise<string>;
  };
}

type TextRenderResult = {
  html: string;
  marker: string;
  cells: Array<{ id: string; marker: string }>;
} | {
  waiting: string;
};

type SessionStartupMode = "background" | "onExecution" | "manual";

export function sessionStartupMode(notebookUri: vscode.Uri): SessionStartupMode {
  const configured = vscode.workspace
    .getConfiguration("r.notebook", notebookUri)
    .get<string>("sessionStartup", "background");
  return configured === "onExecution" || configured === "manual"
    ? configured
    : "background";
}

function assertRCell(cell: vscode.NotebookCell): void {
  const metadata = cell.metadata as RNotebookCellMetadata;
  const engine = metadata.rNotebook?.engine ?? cell.document.languageId;
  if (engine.toLowerCase() !== "r" || cell.document.languageId !== "r") {
    throw new Error(`The R notebook kernel cannot execute '${engine}' cells.`);
  }
}

function bridgeOutputToNotebook(output: BridgeOutput): vscode.NotebookCellOutput {
  const decoder = new TextDecoder();
  if (output.kind === "error") {
    const error = new Error(decoder.decode(output.data));
    error.name = output.name ?? "R Error";
    error.stack = error.message;
    return new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error(error)]);
  }
  return new vscode.NotebookCellOutput([
    new vscode.NotebookCellOutputItem(output.data, output.mime),
  ]);
}

export class RNotebookController implements vscode.Disposable {
  private readonly controller: vscode.NotebookController;
  private readonly sessions = new Map<string, NotebookSession>();
  private readonly attachment: InlineAttachmentCoordinator;
  private readonly markdownStateChanged = new vscode.EventEmitter<vscode.NotebookDocument>();
  readonly onDidChangeMarkdownState = this.markdownStateChanged.event;
  private readonly notebookStateChanged = new vscode.EventEmitter<vscode.NotebookDocument>();
  readonly onDidChangeNotebookState = this.notebookStateChanged.event;
  private readonly sessionShutdown = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidShutdownSession = this.sessionShutdown.event;
  private readonly markdownInputSignatures = new Map<string, string>();
  private selectedNotebookKey: string | undefined;
  private executionOrder = 0;

  constructor(
    private readonly helperPath: string,
    private readonly output: vscode.OutputChannel,
    private readonly synchronizeSessionRequests: () => Promise<string | undefined>,
    beginSessionAttachment: () => (processId: number) => Promise<void>
  ) {
    this.attachment = new InlineAttachmentCoordinator(beginSessionAttachment);
    this.controller = vscode.notebooks.createNotebookController(
      "r-notebook-inline",
      NOTEBOOK_TYPE,
      "R Notebook"
    );
    this.controller.supportedLanguages = ["r"];
    this.controller.supportsExecutionOrder = true;
    this.controller.executeHandler = (cells) => this.execute(cells);
  }

  private getSession(notebook: vscode.NotebookDocument): NotebookSession {
    const key = notebook.uri.toString();
    let session = this.sessions.get(key);
    if (!session) {
      const process = createInlineRProcess(notebook.uri, this.output);
      session = {
        uri: notebook.uri,
        process,
        bridge: new RExecutionBridge(
          this.helperPath,
          process,
          () => quartoExecutableSetting(notebook.uri)
        ),
        queue: Promise.resolve(),
        stopped: false,
        textRevision: 0,
      };
      this.sessions.set(key, session);
    }
    return session;
  }

  private ensureSessionStarted(
    session: NotebookSession,
    makePreferred: boolean
  ): Promise<void> {
    if (session.startup) {
      return session.startup;
    }
    if (session.process.processId !== undefined) {
      return this.attachment.ensureAttached(session.process, makePreferred);
    }
    const startup = this.attachment
      .ensureAttached(session.process, makePreferred)
      .finally(() => {
        if (session.startup === startup) {
          session.startup = undefined;
        }
      });
    session.startup = startup;
    void vscode.window.setStatusBarMessage(
      "$(sync~spin) Starting R session…",
      startup
    );
    return startup;
  }

  async startSession(
    notebook: vscode.NotebookDocument,
    refreshMarkdown = false
  ): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      throw new Error("Trust this workspace before starting an R notebook session.");
    }
    if (
      notebook.notebookType !== NOTEBOOK_TYPE ||
      notebook.uri.scheme !== "file"
    ) {
      throw new Error("R notebook execution requires a local file.");
    }
    const session = this.getSession(notebook);
    this.markSessionOpen(session);
    await this.ensureSessionStarted(
      session,
      this.selectedNotebookKey === notebook.uri.toString()
    );
    if (refreshMarkdown) {
      this.markdownStateChanged.fire(notebook);
    }
  }

  private markSessionOpen(session: NotebookSession): void {
    if (session.shutdownTimer) {
      clearTimeout(session.shutdownTimer);
      session.shutdownTimer = undefined;
    }
    session.closedAt = undefined;
    session.shutdownAt = undefined;
  }

  notebookTabOpened(notebookUri: vscode.Uri): void {
    const session = this.sessions.get(notebookUri.toString());
    if (session) {
      this.markSessionOpen(session);
    }
  }

  notebookTabClosed(notebookUri: vscode.Uri): void {
    const key = notebookUri.toString();
    this.markdownInputSignatures.delete(key);
    const session = this.sessions.get(key);
    if (!session || session.stopped) {
      return;
    }
    this.markSessionOpen(session);
    session.closedAt = Date.now();
    const delayMinutes = vscode.workspace
      .getConfiguration("r.notebook", notebookUri)
      .get<number>("sessionShutdownDelayMinutes", 15);
    if (!Number.isFinite(delayMinutes) || delayMinutes <= 0) {
      this.output.appendLine(
        `[${path.basename(notebookUri.fsPath)}] Notebook closed; R session retained until shutdown.`
      );
      return;
    }

    const delayMilliseconds = delayMinutes * 60_000;
    session.shutdownAt = session.closedAt + delayMilliseconds;
    session.shutdownTimer = setTimeout(() => {
      if (
        this.sessions.get(key) === session &&
        !session.stopped &&
        session.closedAt !== undefined
      ) {
        this.output.appendLine(
          `[${path.basename(notebookUri.fsPath)}] Closing retained R session after ${delayMinutes} minutes.`
        );
        this.shutdownSession(notebookUri);
      }
    }, delayMilliseconds);
    this.output.appendLine(
      `[${path.basename(notebookUri.fsPath)}] Notebook closed; R session retained for ${delayMinutes} minutes.`
    );
  }

  retainedNotebookSessions() {
    return [...this.sessions.values()]
      .filter((session): session is NotebookSession & { closedAt: number } =>
        session.closedAt !== undefined
      )
      .map((session) => ({
        uri: session.uri,
        shutdownAt: session.shutdownAt,
      }));
  }

  hasSession(notebookUri: vscode.Uri): boolean {
    return this.sessions.has(notebookUri.toString());
  }

  prefer(notebook: vscode.NotebookDocument): void {
    if (notebook.notebookType === NOTEBOOK_TYPE) {
      this.controller.updateNotebookAffinity(
        notebook,
        vscode.NotebookControllerAffinity.Preferred
      );
      this.markdownInputSignatures.set(
        notebook.uri.toString(),
        nativeCodeOptionSignature(this.notebookContext(notebook).cells)
      );
    }
  }

  markdownCodeOptionsChanged(notebook: vscode.NotebookDocument): boolean {
    const key = notebook.uri.toString();
    const signature = nativeCodeOptionSignature(this.notebookContext(notebook).cells);
    const previous = this.markdownInputSignatures.get(key);
    this.markdownInputSignatures.set(key, signature);
    return previous !== undefined && previous !== signature;
  }

  async selectNotebook(
    notebook: vscode.NotebookDocument | undefined
  ): Promise<void> {
    if (
      notebook?.notebookType !== NOTEBOOK_TYPE ||
      notebook.uri.scheme !== "file" ||
      !vscode.workspace.isTrusted
    ) {
      this.selectedNotebookKey = undefined;
      await this.attachment.select(undefined);
      return;
    }
    const key = notebook.uri.toString();
    this.selectedNotebookKey = key;
    const existingSession = this.sessions.get(key);
    if (existingSession) {
      this.markSessionOpen(existingSession);
    }
    await this.attachment.select(existingSession?.process);
    if (sessionStartupMode(notebook.uri) === "background") {
      await this.startSession(notebook, true);
    }
  }

  private async execute(cells: readonly vscode.NotebookCell[]): Promise<void> {
    const notebook = cells[0]?.notebook;
    const session = notebook
      ? this.sessions.get(notebook.uri.toString())
      : undefined;
    if (
      notebook &&
      sessionStartupMode(notebook.uri) === "manual" &&
      !session?.startup &&
      session?.process.processId === undefined
    ) {
      const start = "Start R Session";
      if (await vscode.window.showWarningMessage(
        "The R notebook session has not been started.",
        start
      ) !== start) {
        return;
      }
      try {
        await this.startSession(notebook);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(
          `Could not start the R notebook session: ${message}`
        );
        return;
      }
    }

    const tasks = cells.map((cell) => {
      const key = cell.notebook.uri.toString();
      const session = this.getSession(cell.notebook);
      const task = session.queue.then(async () => {
        if (!session.stopped && this.sessions.get(key) === session) {
          await this.executeCell(cell, session);
        }
      });
      session.queue = task.catch(() => undefined);
      return task;
    });
    await Promise.all(tasks);
  }

  private notebookContext(notebook: vscode.NotebookDocument): {
    cells: ParsedCell[];
    eol: string;
    source: string;
    markupIds: Map<number, string>;
  } {
    const documentMetadata = notebook.metadata as RNotebookDocumentMetadata;
    const metadataEol = documentMetadata.rNotebook?.eol;
    const eol = metadataEol === "\r\n" || metadataEol === "\r"
      ? metadataEol
      : "\n";
    const markupIds = new Map<number, string>();
    const cells: ParsedCell[] = notebook.getCells().map((cell, index) => {
      const metadata = cell.metadata as RNotebookCellMetadata;
      if (cell.kind === vscode.NotebookCellKind.Markup) {
        const id = metadata.rNotebookMarkdown?.id;
        if (id) {
          markupIds.set(index, id);
        }
      }
      return {
        kind: cell.kind === vscode.NotebookCellKind.Code ? "code" : "markup",
        value: cell.document.getText(),
        languageId: cell.document.languageId,
        chunk: metadata.rNotebook,
      };
    });
    return {
      cells,
      eol,
      source: serializeDocument(cells, eol),
      markupIds,
    };
  }

  private async updateNativeTextState(
    notebook: vscode.NotebookDocument,
    state?: NativeTextState
  ): Promise<void> {
    const metadata = notebook.metadata as RNotebookDocumentMetadata;
    const current = metadata.rNotebookState;
    if (
      (!state && !current) ||
      (state && current?.version === state.version &&
        current.sourceHash === state.sourceHash && current.html === state.html)
    ) {
      return;
    }
    const updated = { ...notebook.metadata } as RNotebookDocumentMetadata;
    if (state) {
      updated.rNotebookState = state;
    } else {
      delete updated.rNotebookState;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.set(notebook.uri, [vscode.NotebookEdit.updateNotebookMetadata(updated)]);
    if (!await vscode.workspace.applyEdit(edit)) {
      throw new Error("VS Code could not update the notebook's saved Markdown state.");
    }
  }

  renderText(
    notebook: vscode.NotebookDocument,
    markupId: string
  ): Promise<TextRenderResult> {
    if (!vscode.workspace.isTrusted) {
      return Promise.reject(new Error(
        "Trust this workspace before rendering R Markdown or Quarto text."
      ));
    }
    if (notebook.notebookType !== NOTEBOOK_TYPE || notebook.uri.scheme !== "file") {
      return Promise.reject(new Error("Native text rendering requires a local R notebook."));
    }

    const context = this.notebookContext(notebook);
    const sourceHash = notebookSourceHash(context.source);
    const nativeDocument = nativeTextDocument(
      context.cells,
      context.markupIds,
      context.eol,
      notebook.uri.path.toLowerCase().endsWith(".qmd")
        ? "quarto"
        : "rMarkdown"
    );
    const target = nativeDocument.cells.find((cell) => cell.id === markupId);
    if (!target) {
      return Promise.reject(new Error("The Markdown cell is no longer available."));
    }
    const cells = nativeDocument.cells.map(({ id, marker }) => ({ id, marker }));
    const savedText = (notebook.metadata as RNotebookDocumentMetadata).rNotebookState;
    if (
      savedText?.version === NATIVE_TEXT_VERSION &&
      savedText.sourceHash === sourceHash &&
      savedText.html.includes(`id="${target.marker}"`)
    ) {
      return Promise.resolve({ html: savedText.html, marker: target.marker, cells });
    }
    const sessionKey = notebook.uri.toString();
    let session = this.sessions.get(sessionKey);
    const startupMode = sessionStartupMode(notebook.uri);
    if (
      startupMode !== "background" &&
      !session?.startup &&
      session?.process.processId === undefined
    ) {
      return Promise.resolve({
        waiting: startupMode === "manual"
          ? "Start the R session to render this Markdown."
          : "Run a code cell to start the R session and render this Markdown.",
      });
    }
    if (!session) {
      session = this.getSession(notebook);
    }
    const renderKey = `${sourceHash}:${session.textRevision}`;
    if (session.pendingTextRender?.key === renderKey) {
      return session.pendingTextRender.promise.then((html) => ({
        html,
        marker: target.marker,
        cells,
      }));
    }
    const task = session.queue.then(async () => {
      if (session.stopped || this.sessions.get(sessionKey) !== session) {
        throw new Error("The notebook's R session has closed.");
      }
      this.attachment.beginExecution(session.process);
      try {
        await this.ensureSessionStarted(
          session,
          this.selectedNotebookKey === sessionKey
        );
        const html = await session.bridge.renderText(
          nativeDocument.replacements,
          nativeDocument.source,
          notebook.uri.fsPath
        );
        if (notebookSourceHash(this.notebookContext(notebook).source) === sourceHash) {
          await this.updateNativeTextState(notebook, {
            version: NATIVE_TEXT_VERSION,
            sourceHash,
            html,
          });
        }
        return html;
      } finally {
        if (!session.stopped) {
          await this.attachment.endExecution(
            session.process,
            this.synchronizeSessionRequests
          );
        }
      }
    });
    const settled = task.then(() => undefined, () => undefined);
    session.queue = settled;
    session.pendingTextRender = { key: renderKey, promise: task };
    void settled.then(() => {
      if (session.pendingTextRender?.promise === task) {
        session.pendingTextRender = undefined;
      }
    });
    return task.then((html) => ({
      html,
      marker: target.marker,
      cells,
    }));
  }

  async sendToConsole(
    cells: readonly vscode.NotebookCell[],
    transport: RConsoleTransport
  ): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      throw new Error("Trust this workspace before running R notebook cells.");
    }
    const runnable = cells.map((cell) => {
      assertRCell(cell);
      return {
        code: cell.document.getText(),
        notebook: cell.notebook,
      };
    }).filter(({ code }) => code.trim().length > 0);
    if (runnable.length === 0) {
      return;
    }

    const notebook = runnable[0]?.notebook;
    if (!notebook) {
      return;
    }
    const notebookKey = notebook.uri.toString();
    if (runnable.some(({ notebook: candidate }) =>
      candidate.uri.toString() !== notebookKey
    )) {
      throw new Error("Send cells from one R notebook to its console at a time.");
    }
    const session = this.selectedNotebookKey
      ? this.sessions.get(this.selectedNotebookKey)
      : this.sessions.get(notebookKey);
    await this.attachment.expectConsole(session?.process);
    try {
      await transport.attachAndSend(
        notebook.uri,
        runnable.map(({ code }) => code)
      );
    } catch (error) {
      await this.attachment.restoreAfterConsole();
      throw error;
    }
  }

  restoreAfterConsole(): Promise<void> {
    return this.attachment.restoreAfterConsole();
  }

  async refreshMarkdown(notebook: vscode.NotebookDocument): Promise<void> {
    await this.updateNativeTextState(notebook, undefined);
    this.markdownStateChanged.fire(notebook);
  }

  observeConsole(): Promise<void> {
    return this.attachment.observeConsole();
  }

  async viewWorkspaceObject(objectName: string): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      throw new Error(
        "Trust this workspace before viewing objects from an R notebook session."
      );
    }
    const sessionKey = this.selectedNotebookKey;
    if (!sessionKey) {
      throw new Error(
        "Select an open R notebook before viewing a workspace object."
      );
    }
    const session = this.sessions.get(sessionKey);
    if (!session || session.stopped) {
      throw new Error(
        "Select an open R notebook before viewing a workspace object."
      );
    }

    const task = session.queue.then(async () => {
      if (session.stopped || this.sessions.get(sessionKey) !== session) {
        throw new Error("The notebook's R session has closed.");
      }
      this.attachment.beginExecution(session.process);
      try {
        await this.ensureSessionStarted(session, true);
        await session.bridge.viewObject(objectName);
      } finally {
        if (!session.stopped) {
          await this.attachment.endExecution(
            session.process,
            this.synchronizeSessionRequests
          );
        }
      }
    });
    session.queue = task.catch(() => undefined);
    await task;
  }

  shutdownSession(notebookUri: vscode.Uri): void {
    const key = notebookUri.toString();
    const session = this.sessions.get(key);
    if (!session) {
      return;
    }
    this.sessions.delete(key);
    session.stopped = true;
    if (session.shutdownTimer) {
      clearTimeout(session.shutdownTimer);
      session.shutdownTimer = undefined;
    }
    this.attachment.forget(session.process);
    session.process.dispose();
    this.sessionShutdown.fire(notebookUri);
  }

  async restartSession(notebook: vscode.NotebookDocument): Promise<boolean> {
    if (!vscode.workspace.isTrusted) {
      throw new Error("Trust this workspace before starting an R notebook session.");
    }
    if (notebook.uri.scheme !== "file") {
      throw new Error("R notebook execution requires a local file.");
    }

    this.shutdownSession(notebook.uri);
    const session = this.getSession(notebook);
    try {
      await this.ensureSessionStarted(
        session,
        this.selectedNotebookKey === notebook.uri.toString()
      );
      await this.updateNativeTextState(notebook, undefined);
      const restarted = this.sessions.get(notebook.uri.toString()) === session;
      if (restarted) {
        this.markdownStateChanged.fire(notebook);
      }
      return restarted;
    } catch (error) {
      if (this.sessions.get(notebook.uri.toString()) === session) {
        this.shutdownSession(notebook.uri);
        throw error;
      }
      return false;
    } finally {
      if (this.selectedNotebookKey !== notebook.uri.toString()) {
        const selectedSession = this.selectedNotebookKey
          ? this.sessions.get(this.selectedNotebookKey)
          : undefined;
        await this.attachment.select(selectedSession?.process);
      }
    }
  }

  handleVscodeRSessionRequest(request: VscodeRSessionRequest): Promise<void> {
    return this.attachment.handleSessionRequest(request);
  }

  private async executeCell(
    cell: vscode.NotebookCell,
    session: NotebookSession
  ): Promise<void> {
    const execution = this.controller.createNotebookCellExecution(cell);
    execution.executionOrder = ++this.executionOrder;
    execution.start(Date.now());

    let success = false;
    try {
      await execution.clearOutput();
      if (!vscode.workspace.isTrusted) {
        throw new Error("Trust this workspace before running R notebook cells.");
      }
      const metadata = cell.metadata as RNotebookCellMetadata;
      if (cell.notebook.uri.scheme !== "file") {
        throw new Error("R notebook execution requires a local file.");
      }
      assertRCell(cell);

      const context = this.notebookContext(cell.notebook);
      const chunkSource = codeCellSource({
        kind: "code",
        value: cell.document.getText(),
        languageId: cell.document.languageId,
        chunk: metadata.rNotebook,
      }, context.eol);
      const edit = new vscode.WorkspaceEdit();
      edit.set(cell.notebook.uri, [
        vscode.NotebookEdit.updateCellMetadata(cell.index, {
          ...metadata,
          rNotebookOutputSourceHash: notebookSourceHash(chunkSource),
        }),
      ]);
      if (!await vscode.workspace.applyEdit(edit)) {
        throw new Error("VS Code could not record the cell execution state.");
      }

      this.attachment.beginExecution(session.process);
      try {
        await this.ensureSessionStarted(
          session,
          this.selectedNotebookKey === cell.notebook.uri.toString()
        );
        const result = await session.bridge.execute(
          chunkSource,
          cell.notebook.uri.fsPath,
          execution.token,
          {
            documentSource: context.source,
            documentId: cell.notebook.getCells()
              .map((notebookCell) => notebookCell.document.uri.toString())
              .join("\n"),
            cellId: cell.document.uri.toString(),
          }
        );
        if (session.stopped) {
          return;
        }
        session.textRevision += 1;
        await this.updateNativeTextState(cell.notebook, undefined);
        this.markdownStateChanged.fire(cell.notebook);
        await execution.replaceOutput(result.outputs.map(bridgeOutputToNotebook));
        success = result.success && !execution.token.isCancellationRequested;
      } finally {
        if (!session.stopped) {
          try {
            await this.attachment.endExecution(
              session.process,
              this.synchronizeSessionRequests
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.output.appendLine(
              `[${path.basename(cell.notebook.uri.fsPath)}] Could not restore vscode-R attachment: ${message}`
            );
          }
        }
      }
    } catch (error) {
      if (!session.stopped && !execution.token.isCancellationRequested) {
        const result = error instanceof Error ? error : new Error(String(error));
        await execution.replaceOutput([
          new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error(result)]),
        ]);
      }
    } finally {
      execution.end(success, Date.now());
      this.notebookStateChanged.fire(cell.notebook);
    }
  }

  dispose(): void {
    for (const session of [...this.sessions.values()]) {
      this.shutdownSession(session.uri);
    }
    this.attachment.dispose();
    this.markdownStateChanged.dispose();
    this.notebookStateChanged.dispose();
    this.sessionShutdown.dispose();
    this.controller.dispose();
  }
}
