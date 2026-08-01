import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HiddenRLaunchOptions } from "./process";

export interface VscodeRSessionRequest {
  command: "attach" | "detach";
  pid: number;
  workingDirectory: string;
  lockToken: string;
}

interface RequestRecord {
  command?: unknown;
  pid?: unknown;
  wd?: unknown;
}

interface ObservedVscodeRSessionRequest {
  lockToken: string;
  request?: VscodeRSessionRequest;
}

interface AttachmentWaiter {
  afterGeneration: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

export function createVscodeRAttachmentInitialization(): NonNullable<
  HiddenRLaunchOptions["initialization"]
> {
  const token = randomUUID();
  const successMarker = `__R_NOTEBOOK_ATTACHED_${token}__:`;
  const failureMarker = `__R_NOTEBOOK_ATTACH_ERROR_${token}__:`;
  const command = [
    "local({",
    "  tryCatch({",
    '    session_wd <- base::Sys.getenv("VSCODE_R_NOTEBOOK_SESSION_WD")',
    "    if (base::nzchar(session_wd)) {",
    "      if (!base::dir.exists(session_wd)) {",
    '        base::stop("The vscode-R session working directory no longer exists.")',
    "      }",
    "      base::setwd(session_wd)",
    "    }",
    "    base::options(",
    "      vsc.plot = FALSE,",
    "      vsc.use_httpgd = FALSE,",
    "      vsc.rstudioapi = FALSE,",
    "      device = function(...) grDevices::pdf(NULL)",
    "    )",
    "    initialized_now <- FALSE",
    '    if (!"tools:vscode" %in% base::search()) {',
    '      init_file <- base::Sys.getenv("VSCODE_INIT_R")',
    "      if (!base::nzchar(init_file)) {",
    '        init_file <- base::Sys.getenv("VSCODE_R_NOTEBOOK_INIT_R")',
    "        if (base::nzchar(init_file)) {",
    "          base::Sys.setenv(VSCODE_INIT_R = init_file)",
    "        }",
    "      }",
    "      if (!base::nzchar(init_file) || !base::file.exists(init_file)) {",
    '        base::stop("Cannot find the installed vscode-R session initialiser.")',
    "      }",
    "      bootstrap <- base::new.env(parent = .GlobalEnv)",
    "      base::sys.source(init_file, envir = bootstrap, chdir = TRUE)",
    '      finish_startup <- base::get0("init_last", envir = bootstrap, mode = "function", inherits = FALSE)',
    "      if (base::is.null(finish_startup)) {",
    '        base::stop("vscode-R session initialisation did not provide its startup hook.")',
    "      }",
    "      finish_startup()",
    "      initialized_now <- TRUE",
    "    }",
    '    if (!"tools:vscode" %in% base::search()) {',
    '      base::stop("vscode-R session tools could not be initialised.")',
    "    }",
    '    vscode_tools <- base::as.environment("tools:vscode")',
    '    attach_session <- base::get0(".vsc.attach", envir = vscode_tools, mode = "function", inherits = FALSE)',
    "    if (base::is.null(attach_session)) {",
    '      base::stop("vscode-R did not provide its session attachment function.")',
    "    }",
    "    if (!initialized_now) {",
    "      attach_session()",
    "    }",
    `    base::cat(${JSON.stringify(successMarker)}, base::Sys.getpid(), "\\n", sep = "")`,
    "  }, error = function(error) {",
    '    message <- base::gsub("[\\r\\n]+", " ", base::conditionMessage(error))',
    `    base::cat(${JSON.stringify(failureMarker)}, message, "\\n", sep = "")`,
    "  })",
    "})",
  ].join("\n");
  return { command, successMarker, failureMarker };
}

export async function readVscodeRSessionRequest(
  watcherDirectory: string,
  previousLockToken?: string
): Promise<ObservedVscodeRSessionRequest | undefined> {
  const lockPath = path.join(watcherDirectory, "request.lock");
  const requestPath = path.join(watcherDirectory, "request.log");
  const lockToken = await fs.promises.readFile(lockPath, "utf8");
  if (lockToken === previousLockToken) {
    return undefined;
  }
  const content = await fs.promises.readFile(requestPath, "utf8");
  const confirmedLockToken = await fs.promises.readFile(lockPath, "utf8");
  if (lockToken !== confirmedLockToken) {
    return await readVscodeRSessionRequest(watcherDirectory, previousLockToken);
  }

  const record = JSON.parse(content) as RequestRecord;
  if (record.command !== "attach" && record.command !== "detach") {
    return { lockToken };
  }
  if (
    typeof record.pid !== "number" ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    typeof record.wd !== "string" ||
    record.wd.length === 0
  ) {
    return undefined;
  }
  return {
    lockToken,
    request: {
      command: record.command,
      pid: record.pid,
      workingDirectory: record.wd,
      lockToken,
    },
  };
}

export function isVscodeRWorkingDirectoryAccepted(
  directory: string,
  workspaceDirectories: readonly string[] | undefined,
  homeDirectory = os.homedir()
): boolean {
  if (!workspaceDirectories) {
    if (path.relative(homeDirectory, directory) === "") {
      return true;
    }
    try {
      return path.relative(fs.realpathSync(homeDirectory), directory) === "";
    } catch {
      return false;
    }
  }

  for (const workspaceDirectory of workspaceDirectories) {
    let relative = path.relative(workspaceDirectory, directory);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      return true;
    }
    try {
      relative = path.relative(fs.realpathSync(workspaceDirectory), directory);
      if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
        return true;
      }
    } catch {
      // Ignore workspace folders that no longer exist on disk.
    }
  }
  return false;
}

export class VscodeRSessionRequestWatcher {
  private watcher: fs.FSWatcher | undefined;
  private requestQueue: Promise<void> = Promise.resolve();
  private requestHandlingQueue: Promise<void> = Promise.resolve();
  private lastObservedLockToken: string | undefined;
  private lastOwnershipLockToken: string | undefined;
  private attachmentGeneration = 0;
  private observedAttachment:
    | { processId: number; generation: number }
    | undefined;
  private readonly attachmentWaiters = new Map<number, Set<AttachmentWaiter>>();
  private disposed = false;

  constructor(
    private readonly onRequest: (request: VscodeRSessionRequest) => Promise<boolean>,
    private readonly log: (message: string) => void,
    private readonly watcherDirectory = path.join(os.homedir(), ".vscode-R")
  ) {
    try {
      const lockPath = path.join(this.watcherDirectory, "request.lock");
      this.watcher = fs.watch(lockPath, () => {
        void this.observeLatestRequest().catch(() => undefined);
      });
      this.watcher.on("error", (error) => {
        this.log(`vscode-R session change watcher stopped: ${error.message}`);
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Could not start the vscode-R session change watcher: ${message}`);
    }
  }

  private async readLatestRequest(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const observed = await readVscodeRSessionRequest(
      this.watcherDirectory,
      this.lastObservedLockToken
    );
    if (!observed) {
      return;
    }
    if (observed.request?.command === "attach") {
      this.attachmentGeneration += 1;
      this.observedAttachment = {
        processId: observed.request.pid,
        generation: this.attachmentGeneration,
      };
      for (const [processId, waiters] of this.attachmentWaiters) {
        if (processId === observed.request.pid) {
          for (const waiter of waiters) {
            if (this.attachmentGeneration > waiter.afterGeneration) {
              waiter.resolve();
              waiters.delete(waiter);
            }
          }
        } else {
          const error = new Error(
            `vscode-R attached R process ${observed.request.pid} while waiting for process ${processId}.`
          );
          for (const waiter of waiters) {
            waiter.reject(error);
          }
          waiters.clear();
        }
        if (waiters.size === 0) {
          this.attachmentWaiters.delete(processId);
        }
      }
    } else if (
      observed.request?.command === "detach" &&
      observed.request.pid === this.observedAttachment?.processId
    ) {
      this.observedAttachment = undefined;
    }
    this.lastObservedLockToken = observed.lockToken;
    if (observed.request) {
      const request = observed.request;
      const handling = this.requestHandlingQueue.then(async () => {
        if (await this.onRequest(request)) {
          this.lastOwnershipLockToken = observed.lockToken;
        }
      });
      this.requestHandlingQueue = handling.catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`Could not handle a vscode-R session change: ${message}`);
      });
    }
  }

  private observeLatestRequest(): Promise<void> {
    const request = this.requestQueue.then(() => this.readLatestRequest());
    this.requestQueue = request.catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Could not observe a vscode-R session change: ${message}`);
    });
    return request;
  }

  async synchronize(): Promise<string | undefined> {
    try {
      await this.observeLatestRequest();
      await this.requestHandlingQueue;
    } catch {
      return undefined;
    }
    return this.disposed ? undefined : this.lastOwnershipLockToken;
  }

  attachmentCheckpoint(): number {
    return this.attachmentGeneration;
  }

  waitForAttachment(processId: number, afterGeneration: number): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error("The vscode-R session watcher has stopped."));
    }
    if (
      this.observedAttachment?.processId === processId &&
      this.observedAttachment.generation > afterGeneration
    ) {
      return Promise.resolve();
    }

    const wait = new Promise<void>((resolve, reject) => {
      const waiter = { afterGeneration, resolve, reject };
      let waiters = this.attachmentWaiters.get(processId);
      if (!waiters) {
        waiters = new Set<AttachmentWaiter>();
        this.attachmentWaiters.set(processId, waiters);
      }
      waiters.add(waiter);
    });
    void this.observeLatestRequest().catch((error: unknown) => {
      const waiters = this.attachmentWaiters.get(processId);
      if (!waiters) {
        return;
      }
      this.attachmentWaiters.delete(processId);
      const result = error instanceof Error ? error : new Error(String(error));
      for (const waiter of waiters) {
        waiter.reject(result);
      }
    });
    return wait;
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.close();
    this.watcher = undefined;
    const error = new Error("The vscode-R session watcher has stopped.");
    for (const waiters of this.attachmentWaiters.values()) {
      for (const waiter of waiters) {
        waiter.reject(error);
      }
    }
    this.attachmentWaiters.clear();
  }
}
