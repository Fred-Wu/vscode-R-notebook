import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import * as vscode from "vscode";
import { CloseAction, ErrorAction, LanguageClient, type StreamInfo } from "vscode-languageclient/node";
import { resolveRExecutable } from "../Runtime/launch";
import { NOTEBOOK_TYPE, R_CELL_LANGUAGE } from "./document";

// Keep each cell's identity and positions, but prevent languageserver from
// interpreting its .rmd/.qmd path as Markdown or trying to lint a real file.
const CELL_SCHEME = "r-notebook-lsp";

export function toLanguageServerUri(uri: vscode.Uri): string {
  return (uri.scheme === "vscode-notebook-cell"
    ? uri.with({ scheme: CELL_SCHEME, path: `${uri.path}.R` })
    : uri).toString();
}

export function fromLanguageServerUri(value: string): vscode.Uri {
  const uri = vscode.Uri.parse(value);
  return uri.scheme === CELL_SCHEME && uri.path.endsWith(".R")
    ? uri.with({ scheme: "vscode-notebook-cell", path: uri.path.slice(0, -2) })
    : uri;
}

class NotebookLanguageClient {
  private client?: LanguageClient;
  private process?: ChildProcess;
  private socket?: net.Socket;
  private cancelConnection?: () => void;
  private closed = false;
  private readonly starting: Promise<void>;

  constructor(
    private readonly notebook: vscode.NotebookDocument,
    private readonly script: string,
    private readonly output: vscode.OutputChannel
  ) {
    this.starting = this.start().catch((error: unknown) => {
      this.process?.kill();
      this.socket?.destroy();
      if (!this.closed) this.output.appendLine(`[${path.basename(notebook.uri.fsPath)}] ${String(error)}`);
    });
  }

  private async start(): Promise<void> {
    const uri = this.notebook.uri;
    const extension = vscode.extensions.getExtension("REditorSupport.r");
    const api = (extension?.isActive ? extension.exports : await extension?.activate()) as {
      getRExecutablePath?: (resource?: vscode.Uri) => Promise<string | undefined>;
    } | undefined;
    const executable = await api?.getRExecutablePath?.(uri) || resolveRExecutable(uri);
    if (this.closed || this.notebook.isClosed) return;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const cwd = path.dirname(uri.fsPath);
    const config = vscode.workspace.getConfiguration("r");
    const substitute = (value: string): string => value
      .replaceAll("${workspaceFolder}", folder?.uri.fsPath ?? cwd)
      .replaceAll("${fileWorkspaceFolder}", folder?.uri.fsPath ?? cwd)
      .replaceAll("${fileDirname}", cwd)
      .replaceAll("${userHome}", os.homedir());
    const env = { ...process.env };
    for (const key of ["VSCODE_INIT_R", "VSCODE_WATCHER_DIR", "SESS_ENDPOINT", "SESS_DISCOVERY_FILE"]) delete env[key];
    env.R_NOTEBOOK_LSP_LIB_PATHS = config.get<string[]>("libPaths", []).map(substitute).join("\n");
    env.R_NOTEBOOK_LSP_RENV = String(config.get<boolean>("useRenvLibPath", false));
    env.R_NOTEBOOK_LSP_INDEX = folder ? "true" : "false";
    env.R_NOTEBOOK_LSP_DEBUG = String(config.get<boolean>("lsp.debug", false));
    const lang = config.get<string>("lsp.lang", "");
    if (lang) env.LANG = lang;
    const args = [...config.get<string[]>("lsp.args", []).map(substitute),
      "--silent", "--no-echo", "--no-save", "--no-restore", "-e",
      "base::source(base::commandArgs(TRUE)[[1L]])", "--args", this.script];
    this.client = new LanguageClient("r-notebook", "R Notebook Language Server",
      () => this.connect(executable, args, cwd, env), {
        // Match cells directly. Some VS Code registries (e.g. call hierarchy)
        // do not resolve notebookType selectors. Cell paths retain the notebook
        // filename; escape glob metacharacters to keep clients isolated.
        documentSelector: [{ scheme: "vscode-notebook-cell", language: R_CELL_LANGUAGE,
          pattern: uri.fsPath.replaceAll("\\", "/").replace(/[\[\]?*{}]/g, character => `[${character}]`) }],
        uriConverters: { code2Protocol: toLanguageServerUri, protocol2Code: fromLanguageServerUri },
        workspaceFolder: folder ?? { uri: vscode.Uri.file(cwd), name: path.basename(cwd), index: 0 },
        outputChannel: this.output,
        synchronize: { configurationSection: "r.lsp" },
        middleware: {
          workspace: {
            didChangeConfiguration: (sections, next) => this.closed ? Promise.resolve() : next(sections),
          },
        },
        errorHandler: {
          error: () => ({ action: ErrorAction.Continue }),
          closed: () => ({ action: CloseAction.DoNotRestart }),
        },
      });
    await this.client.start();
    this.output.appendLine(`[${path.basename(uri.fsPath)}] Language server ready.`);
  }

  private connect(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<StreamInfo> {
    if (this.closed) return Promise.reject(new Error("Notebook language server closed."));
    // TCP also works with Windows Rterm, whose console stdin is not LSP stdio.
    return new Promise((resolve, reject) => {
      let connected = false;
      const server = net.createServer(socket => {
        connected = true;
        this.socket = socket;
        clearTimeout(timeout);
        this.cancelConnection = undefined;
        server.close();
        resolve({ reader: socket, writer: socket });
      });
      const fail = (error: Error): void => {
        if (connected) return;
        connected = true;
        clearTimeout(timeout);
        this.cancelConnection = undefined;
        server.close();
        this.process?.kill();
        reject(error);
      };
      const timeout = setTimeout(() => fail(new Error("R language server startup timed out. See R Notebook Language Server output.")), 60000);
      this.cancelConnection = () => fail(new Error("Notebook closed during language server startup."));
      server.once("error", fail);
      server.listen(0, "127.0.0.1", () => {
        if (this.closed) { this.cancelConnection?.(); return; }
        const address = server.address() as net.AddressInfo;
        const child = spawn(executable, args, { cwd, env: { ...env, R_NOTEBOOK_LSP_PORT: String(address.port) }, windowsHide: true });
        this.process = child;
        child.stdin.end();
        child.stdout.on("data", data => this.output.append(data.toString()));
        child.stderr.on("data", data => this.output.append(data.toString()));
        child.once("error", fail);
        child.once("exit", code => fail(new Error(`R language server exited (${code}) before connecting. Install the R package 'languageserver' in the configured R library.`)));
      });
    });
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.cancelConnection?.();
    await this.starting;
    try {
      if (this.client?.needsStop()) await this.client.stop();
    } finally {
      this.socket?.destroy();
      this.process?.kill();
    }
  }
}

export class RNotebookLanguageService implements vscode.Disposable {
  private readonly clients = new Map<vscode.NotebookDocument, NotebookLanguageClient>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly stopping = new Set<Promise<void>>();
  private readonly output = vscode.window.createOutputChannel("R Notebook Language Server");
  private closed = false;
  private shutdown?: Promise<void>;

  constructor(private readonly script: string) {
    this.subscriptions.push(
      vscode.workspace.onDidOpenNotebookDocument(notebook => this.open(notebook)),
      vscode.workspace.onDidChangeNotebookDocument(event => this.prepareCells(event.notebook)),
      vscode.workspace.onDidCloseNotebookDocument(notebook => this.close(notebook)),
      vscode.window.tabGroups.onDidChangeTabs(() => {
        for (const notebook of vscode.workspace.notebookDocuments) {
          if (this.hasTab(notebook)) this.open(notebook);
          else void this.close(notebook);
        }
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => vscode.workspace.notebookDocuments.forEach(notebook => this.open(notebook))),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (["r.lsp.enabled", "r.lsp.args", "r.lsp.lang", "r.lsp.debug", "r.executablePath", "r.rpath", "r.libPaths", "r.useRenvLibPath"]
          .some(key => event.affectsConfiguration(key))) {
          for (const notebook of vscode.workspace.notebookDocuments) {
            void this.close(notebook).then(() => this.open(notebook));
          }
        }
      })
    );
    vscode.workspace.notebookDocuments.forEach(notebook => this.open(notebook));
  }

  private open(notebook: vscode.NotebookDocument): void {
    this.prepareCells(notebook);
    if (this.closed || notebook.isClosed || this.clients.has(notebook) || !this.hasTab(notebook) || !vscode.workspace.isTrusted ||
      notebook.notebookType !== NOTEBOOK_TYPE || notebook.uri.scheme !== "file" ||
      !vscode.workspace.getConfiguration("r").get<boolean>("lsp.enabled", true)) return;
    this.clients.set(notebook, new NotebookLanguageClient(notebook, this.script, this.output));
  }

  private hasTab(notebook: vscode.NotebookDocument): boolean {
    return vscode.window.tabGroups.all.some(group => group.tabs.some(tab =>
      tab.input instanceof vscode.TabInputNotebook &&
      tab.input.notebookType === NOTEBOOK_TYPE &&
      tab.input.uri.toString() === notebook.uri.toString()));
  }

  private prepareCells(notebook: vscode.NotebookDocument): void {
    if (this.closed || notebook.isClosed || notebook.notebookType !== NOTEBOOK_TYPE) return;
    for (const cell of notebook.getCells()) {
      if (cell.kind === vscode.NotebookCellKind.Code && cell.document.languageId === "r") {
        void vscode.languages.setTextDocumentLanguage(cell.document, R_CELL_LANGUAGE)
          .then(undefined, (error: unknown) => this.output.appendLine(String(error)));
      }
    }
  }

  private close(notebook: vscode.NotebookDocument): Promise<void> {
    const client = this.clients.get(notebook);
    this.clients.delete(notebook);
    if (!client) return Promise.resolve();
    const stop = client.stop().catch((error: unknown) => this.output.appendLine(String(error)));
    this.stopping.add(stop);
    void stop.then(() => this.stopping.delete(stop));
    return stop;
  }

  stop(): Promise<void> {
    this.shutdown ??= this.stopAll();
    return this.shutdown;
  }

  private async stopAll(): Promise<void> {
    this.closed = true;
    this.subscriptions.forEach(subscription => subscription.dispose());
    await Promise.all([...this.clients.keys()].map(notebook => this.close(notebook)));
    await Promise.all(this.stopping);
  }

  dispose(): void {
    void this.stop().finally(() => this.output.dispose());
  }
}
