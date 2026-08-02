import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";
import { normalizeNotebookExtension } from "../notebookFile";
import type { InlineDispatch, InlineRTransport } from "./process";

export interface BridgeOutput {
  kind: "display" | "error";
  mime: string;
  data: Uint8Array;
  name?: string;
}

export class TextRenderCancelledError extends Error {}

interface BridgeResult {
  success: boolean;
  outputs: BridgeOutput[];
}

interface BridgeCellContext {
  documentSource: string;
  documentId: string;
  cellId: string;
}

interface OutputMetadata {
  kind: BridgeOutput["kind"];
  mime: string;
  file: string;
  name?: string;
}

function rString(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")}"`;
}

function parseMetadata(content: string): OutputMetadata {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator > 0) {
      values[line.slice(0, separator)] = line.slice(separator + 1).trimStart();
    }
  }
  const kind = values.kind;
  if (kind !== "display" && kind !== "error") {
    throw new Error("R returned an invalid notebook output kind.");
  }
  if (!values.mime || !values.file) {
    throw new Error("R returned incomplete notebook output metadata.");
  }
  return {
    kind,
    mime: values.mime,
    file: values.file,
    name: values.name,
  };
}

async function readResult(requestDirectory: string): Promise<BridgeResult> {
  const entries = (await fsPromises.readdir(requestDirectory))
    .filter((entry) => /^\d{6}\.meta$/.test(entry))
    .sort();
  const outputs: BridgeOutput[] = [];
  for (const entry of entries) {
    const metadata = parseMetadata(
      await fsPromises.readFile(path.join(requestDirectory, entry), "utf8")
    );
    const payloadPath = path.join(requestDirectory, metadata.file);
    if (path.dirname(payloadPath) !== requestDirectory) {
      throw new Error("R returned an unsafe notebook output path.");
    }
    outputs.push({
      kind: metadata.kind,
      mime: metadata.mime,
      data: await fsPromises.readFile(payloadPath),
      name: metadata.name,
    });
  }
  const done = (await fsPromises.readFile(path.join(requestDirectory, "done"), "utf8")).trim();
  return { success: done === "true", outputs };
}

async function ensureRequestSucceeded(
  requestDirectory: string,
  fallbackMessage: string
): Promise<void> {
  const succeeded = (await fsPromises.readFile(
    path.join(requestDirectory, "done"),
    "utf8"
  )).trim() === "true";
  if (succeeded) {
    return;
  }
  let message = fallbackMessage;
  try {
    message = await fsPromises.readFile(
      path.join(requestDirectory, "error.txt"),
      "utf8"
    );
  } catch {
    // Keep the protocol error when R could not write a more specific one.
  }
  throw new Error(message.trim());
}

async function readTextResult(requestDirectory: string): Promise<string> {
  await ensureRequestSucceeded(
    requestDirectory,
    "R could not render the notebook text."
  );
  return fsPromises.readFile(path.join(requestDirectory, "result.html"), "utf8");
}

function waitForDone(requestDirectory: string): { promise: Promise<void>; watcher: fs.FSWatcher } {
  let resolveDone: (() => void) | undefined;
  let rejectDone: ((error: Error) => void) | undefined;
  let settled = false;
  const promise = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const check = (): void => {
    if (settled) {
      return;
    }
    fsPromises.access(path.join(requestDirectory, "done"), fs.constants.F_OK).then(
      () => {
        settled = true;
        resolveDone?.();
      },
      () => undefined
    );
  };
  const watcher = fs.watch(requestDirectory, (event, filename) => {
    if (event === "rename" && filename?.toString() === "done") {
      check();
    }
  });
  watcher.on("error", (error) => {
    if (!settled) {
      settled = true;
      rejectDone?.(error);
    }
  });
  check();
  return { promise, watcher };
}

async function snapshotDocument(
  requestDirectory: string,
  documentPath: string,
  documentSource: string
): Promise<string> {
  let sourceRoot = path.dirname(documentPath);
  while (true) {
    const hasProject = await Promise.all(
      ["_quarto.yml", "_quarto.yaml"].map(async (name) => {
        try {
          await fsPromises.access(path.join(sourceRoot, name));
          return true;
        } catch {
          return false;
        }
      })
    ).then((results) => results.some(Boolean));
    if (hasProject) {
      break;
    }
    const parent = path.dirname(sourceRoot);
    if (parent === sourceRoot) {
      sourceRoot = path.dirname(documentPath);
      break;
    }
    sourceRoot = parent;
  }

  const relativeDocument = path.relative(sourceRoot, documentPath);
  const parts = relativeDocument.split(path.sep);
  const supportDirectory = `${path.parse(documentPath).name}_files`;
  let sourceDirectory = sourceRoot;
  let snapshotDirectory = path.join(requestDirectory, "document");
  for (const [index, part] of parts.entries()) {
    await fsPromises.mkdir(snapshotDirectory, { recursive: true });
    const entries = await fsPromises.readdir(sourceDirectory, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      if (
        entry.name === part ||
        entry.name === ".quarto" ||
        (index === parts.length - 1 && entry.name === supportDirectory)
      ) {
        return;
      }
      const source = path.join(sourceDirectory, entry.name);
      const target = path.join(snapshotDirectory, entry.name);
      const linkedDirectory = entry.isSymbolicLink()
        ? (await fsPromises.stat(source)).isDirectory()
        : entry.isDirectory();
      if (process.platform === "win32" && !linkedDirectory) {
        await fsPromises.copyFile(source, target);
      } else {
        await fsPromises.symlink(
          source,
          target,
          linkedDirectory ? (process.platform === "win32" ? "junction" : "dir") : "file"
        );
      }
    }));
    sourceDirectory = path.join(sourceDirectory, part);
    snapshotDirectory = path.join(snapshotDirectory, part);
  }
  await fsPromises.writeFile(snapshotDirectory, documentSource, {
    encoding: "utf8",
    flag: "wx",
  });
  return snapshotDirectory;
}

export class RExecutionBridge {
  constructor(
    private readonly helperPath: string,
    private readonly transport: InlineRTransport,
    private readonly configuredQuartoExecutable?: () => string
  ) {}

  async execute(
    chunkSource: string,
    documentPath: string,
    token: vscode.CancellationToken,
    context?: BridgeCellContext
  ): Promise<BridgeResult> {
    const requestDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "r-notebook-"));
    const documentExtension = normalizeNotebookExtension(documentPath);
    if (!documentExtension) {
      throw new Error("R notebook execution requires an .rmd or .qmd file.");
    }
    const chunkPath = path.join(requestDirectory, `chunk${documentExtension}`);
    const requestPath = path.join(requestDirectory, "request.R");
    let nativeDocumentPath = documentPath;
    let completion: ReturnType<typeof waitForDone> | undefined;
    let dispatch: InlineDispatch | undefined;
    let cancellation: vscode.Disposable | undefined;
    let cancelled = false;
    let interruptCompletion: Promise<void> | undefined;
    let reportInterruptFailure!: (reason?: unknown) => void;
    const interruptFailure = new Promise<never>((_resolve, reject) => {
      reportInterruptFailure = reject;
    });
    void interruptFailure.catch(() => undefined);
    try {
      await fsPromises.writeFile(chunkPath, chunkSource, "utf8");
      const documentSource = context?.documentSource
        ?? await fsPromises.readFile(documentPath, "utf8");
      let savedSource: string | undefined;
      try {
        savedSource = await fsPromises.readFile(documentPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      if (savedSource !== documentSource) {
        nativeDocumentPath = await snapshotDocument(
          requestDirectory,
          documentPath,
          documentSource
        );
      }

      const cellId = context?.cellId ?? chunkSource;
      const documentId = context?.documentId ?? documentPath;
      const cellKey = createHash("sha256").update(cellId).digest("hex");
      const quartoExecutable = this.configuredQuartoExecutable?.() ?? "";
      await fsPromises.writeFile(
        requestPath,
        [
          "local({",
          "  bridge <- new.env(parent = baseenv())",
          `  base::sys.source(${rString(this.helperPath)}, envir = bridge)`,
          "  bridge$r_notebook_execute(",
          `    chunk_path = ${rString(chunkPath)},`,
          `    document_path = ${rString(documentPath)},`,
          `    native_document_path = ${rString(nativeDocumentPath)},`,
          `    document_id = ${rString(documentId)},`,
          `    cell_id = ${rString(cellId)},`,
          `    cell_key = ${rString(cellKey)},`,
          `    output_dir = ${rString(requestDirectory)},`,
          `    working_dir = ${rString(path.dirname(documentPath))},`,
          "    evaluation_env = .GlobalEnv,",
          `    quarto_executable = ${rString(quartoExecutable)}`,
          "  )",
          "})",
          "",
        ].join("\n"),
        "utf8"
      );
      completion = waitForDone(requestDirectory);
      if (token.isCancellationRequested) {
        return { success: false, outputs: [] };
      }
      dispatch = await this.transport.send(
        `base::source(${rString(requestPath)}, echo = FALSE)`
      );
      const interrupt = (): void => {
        if (cancelled) {
          return;
        }
        cancelled = true;
        interruptCompletion = this.transport.interrupt();
        void interruptCompletion.catch(reportInterruptFailure);
      };
      cancellation = token.onCancellationRequested(interrupt);
      if (token.isCancellationRequested) {
        interrupt();
      }
      await Promise.race([completion.promise, dispatch.failure, interruptFailure]);
      if (cancelled) {
        await interruptCompletion;
        return { success: false, outputs: [] };
      }
      return await readResult(requestDirectory);
    } finally {
      cancellation?.dispose();
      dispatch?.dispose();
      completion?.watcher.close();
      await fsPromises.rm(requestDirectory, { recursive: true, force: true });
    }
  }

  async renderText(
    cells: readonly { token: string; source: string }[],
    documentSource: string,
    documentPath: string,
    token?: vscode.CancellationToken
  ): Promise<string> {
    const requestDirectory = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "r-notebook-text-")
    );
    const cellsPath = path.join(requestDirectory, "cells.json");
    const requestPath = path.join(requestDirectory, "request.R");
    let completion: ReturnType<typeof waitForDone> | undefined;
    let dispatch: InlineDispatch | undefined;
    let cancellation: vscode.Disposable | undefined;
    let cancelled = false;
    let interruptCompletion: Promise<void> | undefined;
    let reportInterruptFailure!: (reason?: unknown) => void;
    const interruptFailure = new Promise<never>((_resolve, reject) => {
      reportInterruptFailure = reject;
    });
    void interruptFailure.catch(() => undefined);
    try {
      const snapshotPath = await snapshotDocument(
        requestDirectory,
        documentPath,
        documentSource
      );
      const quartoExecutable = this.configuredQuartoExecutable?.() ?? "";
      await fsPromises.writeFile(cellsPath, JSON.stringify(cells), "utf8");
      await fsPromises.writeFile(
        requestPath,
        [
          "local({",
          "  bridge <- new.env(parent = baseenv())",
          `  base::sys.source(${rString(this.helperPath)}, envir = bridge)`,
          "  bridge$r_notebook_render_text(",
          `    cells_path = ${rString(cellsPath)},`,
          `    native_document_path = ${rString(snapshotPath)},`,
          `    output_dir = ${rString(requestDirectory)},`,
          `    working_dir = ${rString(path.dirname(documentPath))},`,
          "    evaluation_env = .GlobalEnv,",
          `    quarto_executable = ${rString(quartoExecutable)}`,
          "  )",
          "})",
          "",
        ].join("\n"),
        "utf8"
      );
      completion = waitForDone(requestDirectory);
      if (token?.isCancellationRequested) {
        throw new TextRenderCancelledError();
      }
      dispatch = await this.transport.send(
        `base::source(${rString(requestPath)}, echo = FALSE)`
      );
      const interrupt = (): void => {
        if (cancelled) {
          return;
        }
        cancelled = true;
        interruptCompletion = this.transport.interrupt();
        void interruptCompletion.catch(reportInterruptFailure);
      };
      cancellation = token?.onCancellationRequested(interrupt);
      if (token?.isCancellationRequested) {
        interrupt();
      }
      await Promise.race([completion.promise, dispatch.failure, interruptFailure]);
      if (cancelled) {
        await interruptCompletion;
        throw new TextRenderCancelledError();
      }
      return await readTextResult(requestDirectory);
    } finally {
      cancellation?.dispose();
      dispatch?.dispose();
      completion?.watcher.close();
      await fsPromises.rm(requestDirectory, { recursive: true, force: true });
    }
  }

  async viewObject(objectName: string): Promise<void> {
    const requestDirectory = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "r-notebook-view-")
    );
    const requestPath = path.join(requestDirectory, "request.R");
    let completion: ReturnType<typeof waitForDone> | undefined;
    let dispatch: InlineDispatch | undefined;
    try {
      await fsPromises.writeFile(
        requestPath,
        [
          "local({",
          "  bridge <- new.env(parent = baseenv())",
          `  base::sys.source(${rString(this.helperPath)}, envir = bridge)`,
          "  success <- FALSE",
          "  base::on.exit(",
          `    bridge$r_notebook_finish_request(${rString(requestDirectory)}, success, "data view"),`,
          "    add = TRUE",
          "  )",
          "  tryCatch({",
          `    object_name <- ${rString(objectName)}`,
          "    if (!base::exists(object_name, envir = .GlobalEnv, inherits = FALSE)) {",
          '      base::stop(base::paste("Cannot find", object_name, "in the notebook session."))',
          "    }",
          '    vscode_tools <- base::as.environment("tools:vscode")',
          '    view <- base::get0(".vsc.view", envir = vscode_tools, mode = "function", inherits = FALSE)',
          "    if (base::is.null(view)) {",
          '      base::stop("vscode-R Data Viewer is disabled for this session.")',
          "    }",
          "    view(base::get(object_name, envir = .GlobalEnv, inherits = FALSE), title = object_name)",
          "    success <- TRUE",
          "  }, error = function(error) {",
          "    base::writeLines(",
          "      base::conditionMessage(error),",
          `      base::file.path(${rString(requestDirectory)}, "error.txt"),`,
          "      useBytes = TRUE",
          "    )",
          "  })",
          "})",
          "",
        ].join("\n"),
        "utf8"
      );
      completion = waitForDone(requestDirectory);
      dispatch = await this.transport.send(
        `base::source(${rString(requestPath)}, echo = FALSE)`
      );
      await Promise.race([completion.promise, dispatch.failure]);
      await ensureRequestSucceeded(
        requestDirectory,
        "R could not open the selected object."
      );
    } finally {
      dispatch?.dispose();
      completion?.watcher.close();
      await fsPromises.rm(requestDirectory, { recursive: true, force: true });
    }
  }
}
