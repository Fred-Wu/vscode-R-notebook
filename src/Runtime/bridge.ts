import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";
import { normalizeNotebookExtension } from "../notebookFile";
import type { InlineDispatch, InlineRTransport } from "./process";
import { RStartupCancelledError } from "./startup";

export interface BridgeOutput {
  kind: "display" | "error";
  mime: string;
  data: Uint8Array;
  name?: string;
}

export class TextRenderCancelledError extends Error {}

export interface NotebookPackageStatus {
  library: string;
  missing: string[];
}

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

/** Install completion cleanup before acknowledging that R can be interrupted. */
function interruptibleRequest(requestDirectory: string, body: readonly string[]): string {
  return [
    "base::suspendInterrupts(base::local({",
    "  base::on.exit({",
    `    if (!base::file.exists(${rString(path.join(requestDirectory, "done"))})) {`,
    `      base::writeLines('false', ${rString(path.join(requestDirectory, ".done"))})`,
    `      base::file.rename(${rString(path.join(requestDirectory, ".done"))}, ${rString(path.join(requestDirectory, "done"))})`,
    "    }",
    // The helper's `done` file carries the result. Only this outer handler can
    // acknowledge that all helper on.exit handlers have finished using files.
    `    base::writeLines('finished', ${rString(path.join(requestDirectory, ".finished"))})`,
    `    base::file.rename(${rString(path.join(requestDirectory, ".finished"))}, ${rString(path.join(requestDirectory, "finished"))})`,
    "  }, add = TRUE)",
    `  base::writeLines('ready', ${rString(path.join(requestDirectory, "ready"))})`,
    "  base::allowInterrupts({",
    ...body,
    "  })",
    "}))",
    "",
  ].join("\n");
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

function waitForDone(requestDirectory: string, filename = "done"): { promise: Promise<void>; watcher: fs.FSWatcher } {
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
    fsPromises.access(path.join(requestDirectory, filename), fs.constants.F_OK).then(
      () => {
        settled = true;
        resolveDone?.();
      },
      () => undefined
    );
  };
  const watcher = fs.watch(requestDirectory, (event, changedName) => {
    if (event === "rename" && changedName?.toString() === filename) {
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
  const snapshotDirectory = path.join(requestDirectory, "document");
  await fsPromises.mkdir(snapshotDirectory, { recursive: true });
  const snapshotPath = path.join(snapshotDirectory, path.basename(documentPath));
  await fsPromises.writeFile(snapshotPath, documentSource, { encoding: "utf8", flag: "wx" });
  return snapshotPath;
}

export class RExecutionBridge {
  constructor(
    private readonly helperPath: string,
    private readonly transport: InlineRTransport
  ) {}

  async notebookPackages(install?: { packages: string[]; library: string }): Promise<NotebookPackageStatus> {
    const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "r-notebook-packages-"));
    const requestPath = path.join(directory, "request.R");
    let completion: ReturnType<typeof waitForDone> | undefined;
    let dispatch: InlineDispatch | undefined;
    try {
      await fsPromises.writeFile(requestPath, interruptibleRequest(directory, [
        "tryCatch({",
        "  bridge <- new.env(parent = baseenv())",
        `  base::sys.source(${rString(path.join(path.dirname(this.helperPath), "packages.R"))}, envir = bridge)`,
        `  bridge$r_notebook_packages(${rString(path.join(directory, "packages.txt"))}${install
          ? `, packages = c(${install.packages.map(rString).join(", ")}), library = ${rString(install.library)}`
          : ""})`,
        `  base::writeLines('true', ${rString(path.join(directory, ".done"))})`,
        `  base::file.rename(${rString(path.join(directory, ".done"))}, ${rString(path.join(directory, "done"))})`,
        "}, error = function(error) {",
        `  base::writeLines(base::conditionMessage(error), ${rString(path.join(directory, "error.txt"))}, useBytes = TRUE)`,
        "})",
      ]), "utf8");
      completion = waitForDone(directory, "finished");
      dispatch = await this.transport.send(`base::source(${rString(requestPath)}, echo = FALSE)`);
      await Promise.race([completion.promise, dispatch.failure]);
      await ensureRequestSucceeded(directory, "Could not check or install notebook R packages.");
      const [encodedLibraries, ...missing] = (await fsPromises.readFile(path.join(directory, "packages.txt"), "utf8"))
        .trimEnd().split(/\r?\n/);
      const libraries = encodedLibraries?.split("\t").map(decodeURIComponent) ?? [];
      const library = libraries[0];
      if (!library) throw new Error("R did not report its package library.");
      this.transport.setLibraryPaths?.(libraries);
      return { library, missing };
    } finally {
      dispatch?.dispose();
      completion?.watcher.close();
      await fsPromises.rm(directory, { recursive: true, force: true });
    }
  }

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
    let ready: ReturnType<typeof waitForDone> | undefined;
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
      await fsPromises.writeFile(
        requestPath,
        interruptibleRequest(requestDirectory, [
          "  bridge <- new.env(parent = baseenv())",
          `  base::sys.source(${rString(this.helperPath)}, envir = bridge)`,
          `  if (is.function(bridge$r_notebook_load)) bridge$r_notebook_load(${rString(path.dirname(this.helperPath))})`,
          `  bridge$r_notebook_math_assets <- ${rString(path.resolve(path.dirname(this.helperPath), "../../dist/katex"))}`,
          "  bridge$r_notebook_execute(",
          `    chunk_path = ${rString(chunkPath)},`,
          `    document_path = ${rString(documentPath)},`,
          `    native_document_path = ${rString(nativeDocumentPath)},`,
          `    document_id = ${rString(documentId)},`,
          `    cell_id = ${rString(cellId)},`,
          `    cell_key = ${rString(cellKey)},`,
          `    output_dir = ${rString(requestDirectory)},`,
          `    working_dir = ${rString(path.dirname(documentPath))},`,
          "    evaluation_env = .GlobalEnv",
          "  )",
        ]),
        "utf8"
      );
      completion = waitForDone(requestDirectory, "finished");
      ready = waitForDone(requestDirectory, "ready");
      if (token.isCancellationRequested) {
        return { success: false, outputs: [] };
      }
      dispatch = await this.transport.send(
        `base::source(${rString(requestPath)}, echo = FALSE)`, token
      );
      // Sending bytes does not mean R has accepted this request. In particular,
      // helper loading must be interruptible only after completion is guaranteed.
      const interruptible = Promise.race([
        ready.promise.then(() => true),
        completion.promise.then(() => false),
        dispatch.failure,
      ]);
      void interruptible.catch(() => undefined);
      const interrupt = (): void => {
        if (cancelled) {
          return;
        }
        cancelled = true;
        interruptCompletion = interruptible.then((started) =>
          started ? this.transport.interrupt() : undefined);
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
    } catch (error) {
      if (error instanceof RStartupCancelledError) return { success: false, outputs: [] };
      // A failed interrupt stops R. Await that shutdown even if its process-exit
      // notification wins the race, and preserve the actionable interrupt error.
      if (cancelled) await interruptCompletion;
      throw error;
    } finally {
      cancellation?.dispose();
      dispatch?.dispose();
      completion?.watcher.close();
      ready?.watcher.close();
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
    let ready: ReturnType<typeof waitForDone> | undefined;
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
      await fsPromises.writeFile(cellsPath, JSON.stringify(cells), "utf8");
      await fsPromises.writeFile(
        requestPath,
        interruptibleRequest(requestDirectory, [
          "  bridge <- new.env(parent = baseenv())",
          `  base::sys.source(${rString(this.helperPath)}, envir = bridge)`,
          `  if (is.function(bridge$r_notebook_load)) bridge$r_notebook_load(${rString(path.dirname(this.helperPath))})`,
          `  bridge$r_notebook_math_assets <- ${rString(path.resolve(path.dirname(this.helperPath), "../../dist/katex"))}`,
          "  bridge$r_notebook_render_text(",
          `    document_path = ${rString(documentPath)},`,
          `    cells_path = ${rString(cellsPath)},`,
          `    native_document_path = ${rString(snapshotPath)},`,
          `    output_dir = ${rString(requestDirectory)},`,
          `    working_dir = ${rString(path.dirname(documentPath))},`,
          "    evaluation_env = .GlobalEnv",
          "  )",
        ]),
        "utf8"
      );
      completion = waitForDone(requestDirectory, "finished");
      ready = waitForDone(requestDirectory, "ready");
      if (token?.isCancellationRequested) {
        throw new TextRenderCancelledError();
      }
      dispatch = await this.transport.send(
        `base::source(${rString(requestPath)}, echo = FALSE)`, token
      );
      const interruptible = Promise.race([
        ready.promise.then(() => true),
        completion.promise.then(() => false),
        dispatch.failure,
      ]);
      void interruptible.catch(() => undefined);
      const interrupt = (): void => {
        if (cancelled) {
          return;
        }
        cancelled = true;
        interruptCompletion = interruptible.then((started) =>
          started ? this.transport.interrupt() : undefined);
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
    } catch (error) {
      if (error instanceof RStartupCancelledError) throw new TextRenderCancelledError();
      if (cancelled) await interruptCompletion;
      throw error;
    } finally {
      cancellation?.dispose();
      dispatch?.dispose();
      completion?.watcher.close();
      ready?.watcher.close();
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
          // The managed sess attachment installs both viewers through utils::View.
          // Qualify the call so a user's global View function cannot mask it.
          "    utils::View(base::get(object_name, envir = .GlobalEnv, inherits = FALSE), title = object_name)",
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
