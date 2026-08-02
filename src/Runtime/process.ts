import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface InlineDispatch {
  failure: Promise<never>;
  dispose(): void;
}

export interface InlineRTransport {
  send(command: string): Promise<InlineDispatch>;
  interrupt(): Promise<void>;
}

export interface HiddenRLaunchOptions {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  interrupt?: (processId: number) => Promise<void>;
  initialization?: {
    command: string;
    successMarker: string;
    failureMarker: string;
  };
}

async function interruptWindowsRProcess(
  options: HiddenRLaunchOptions,
  processId: number
): Promise<void> {
  try {
    await execFileAsync(
      options.executable,
      [
        "--slave",
        "--no-site-file",
        "--no-init-file",
        "-e",
        "if (!requireNamespace('ps', quietly = TRUE)) stop(\"The R package 'ps' is required to cancel notebook execution on Windows.\"); "
          + `ps::ps_interrupt(ps::ps_handle(${processId}))`,
      ],
      {
        cwd: options.cwd,
        env: options.env,
        timeout: 10_000,
        windowsHide: true,
      }
    );
  } catch (error) {
    const result = error as Error & { stderr?: string };
    const detail = result.stderr?.trim() || result.message;
    throw new Error(`Could not interrupt the inline R process: ${detail}`);
  }
}

function exitError(code: number | null, signal: NodeJS.Signals | null): Error {
  if (signal) {
    return new Error(`The inline R process stopped after receiving ${signal}.`);
  }
  if (code !== null) {
    return new Error(`The inline R process exited with code ${code}.`);
  }
  return new Error("The inline R process stopped before the notebook cell finished.");
}

function isRunning(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode === null && child.signalCode === null;
}

export class HiddenRProcess implements InlineRTransport {
  private child: ChildProcessWithoutNullStreams | undefined;
  private starting: Promise<ChildProcessWithoutNullStreams> | undefined;
  private currentInterruption: Promise<void> | undefined;
  private currentLaunchOptions: HiddenRLaunchOptions | undefined;
  private currentInitialization: HiddenRLaunchOptions["initialization"] | undefined;
  private rProcessId: number | undefined;
  private ready = false;
  private disposed = false;

  constructor(
    private readonly launchOptions: () => Promise<HiddenRLaunchOptions>,
    private readonly log: (message: string) => void,
    private readonly runningChanged: (running: boolean) => void = () => undefined
  ) {}

  get processId(): number | undefined {
    const child = this.child;
    return child && isRunning(child)
      ? this.rProcessId
      : undefined;
  }

  get running(): boolean {
    return this.ready && !!this.child && isRunning(this.child);
  }

  private clearProcess(child: ChildProcessWithoutNullStreams): void {
    if (this.child === child) {
      const wasRunning = this.ready;
      this.child = undefined;
      this.currentInterruption = undefined;
      this.currentLaunchOptions = undefined;
      this.currentInitialization = undefined;
      this.rProcessId = undefined;
      this.ready = false;
      if (wasRunning) {
        this.runningChanged(false);
      }
    }
  }

  private initialize(
    child: ChildProcessWithoutNullStreams,
    initialization: NonNullable<HiddenRLaunchOptions["initialization"]>
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      let output = "";
      let settled = false;

      const stopListening = (): void => {
        child.stdout.off("data", onData);
        child.stdin.off("error", onInputError);
        child.off("error", onError);
        child.off("exit", onExit);
      };
      const finish = (processId?: number, error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        stopListening();
        if (error) {
          reject(error);
        } else if (processId !== undefined) {
          resolve(processId);
        } else {
          reject(new Error("vscode-R attachment did not report the R process ID."));
        }
      };
      const onData = (data: Buffer): void => {
        output += data.toString("utf8");
        const successStart = output.indexOf(initialization.successMarker);
        if (successStart >= 0) {
          const processIdStart = successStart + initialization.successMarker.length;
          const processIdEnd = output.indexOf("\n", processIdStart);
          if (processIdEnd >= 0) {
            const processId = Number(
              output.slice(processIdStart, processIdEnd).trim()
            );
            if (Number.isSafeInteger(processId) && processId > 0) {
              finish(processId);
            } else {
              finish(
                undefined,
                new Error("vscode-R attachment reported an invalid R process ID.")
              );
            }
            return;
          }
        }
        const failureStart = output.indexOf(initialization.failureMarker);
        if (failureStart >= 0) {
          const messageStart = failureStart + initialization.failureMarker.length;
          const messageEnd = output.indexOf("\n", messageStart);
          if (messageEnd >= 0) {
            const message = output.slice(messageStart, messageEnd).trim();
            finish(undefined, new Error(message || "vscode-R session attachment failed."));
          }
        }
      };
      const onInputError = (error: Error): void => {
        finish(undefined, new Error(`Could not initialise inline R: ${error.message}`));
      };
      const onError = (error: Error): void => {
        finish(undefined, new Error(`Inline R failed during initialisation: ${error.message}`));
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        finish(undefined, exitError(code, signal));
      };

      child.stdout.on("data", onData);
      child.stdin.once("error", onInputError);
      child.once("error", onError);
      child.once("exit", onExit);
      try {
        child.stdin.write(`${initialization.command}\n`, (error?: Error | null) => {
          if (error) {
            finish(undefined, new Error(`Could not initialise inline R: ${error.message}`));
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        finish(undefined, new Error(`Could not initialise inline R: ${message}`));
      }
    });
  }

  private async launch(): Promise<ChildProcessWithoutNullStreams> {
    const options = await this.launchOptions();
    if (this.disposed) {
      throw new Error("The notebook's inline R session has closed.");
    }

    this.log(`Starting ${options.executable}`);
    const child = spawn(options.executable, options.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: "pipe",
      windowsHide: true,
    });
    this.child = child;
    this.currentLaunchOptions = options;

    child.stdout.resume();
    child.stderr.on("data", (data: Buffer) => {
      const message = data.toString("utf8").trimEnd();
      if (message.length > 0) {
        this.log(message);
      }
    });
    child.stdin.on("error", (error) => {
      this.log(`R input error: ${error.message}`);
    });
    child.on("error", (error) => {
      this.log(`R process error: ${error.message}`);
    });
    child.on("exit", (code, signal) => {
      this.clearProcess(child);
      if (!this.disposed) {
        this.log(exitError(code, signal).message);
      }
    });

    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        child.off("error", onError);
        child.off("exit", onExit);
        resolve();
      };
      const onError = (error: Error): void => {
        child.off("spawn", onSpawn);
        child.off("exit", onExit);
        this.clearProcess(child);
        reject(new Error(`Could not start inline R: ${error.message}`));
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
        reject(exitError(code, signal));
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
      child.once("exit", onExit);
    });

    if (child.exitCode !== null || child.signalCode !== null) {
      throw exitError(child.exitCode, child.signalCode);
    }
    if (options.initialization) {
      this.currentInitialization = options.initialization;
      try {
        this.rProcessId = await this.initialize(child, options.initialization);
        this.log("Automatic vscode-R attachment request sent.");
      } catch (error) {
        this.clearProcess(child);
        if (isRunning(child)) {
          child.kill();
        }
        throw error;
      }
    }
    this.ready = true;
    this.runningChanged(true);
    return child;
  }

  private async getProcess(): Promise<ChildProcessWithoutNullStreams> {
    if (this.disposed) {
      throw new Error("The notebook's inline R session has closed.");
    }
    if (this.starting) {
      return await this.starting;
    }
    if (this.child && isRunning(this.child)) {
      return this.child;
    }
    this.starting = this.launch();
    const starting = this.starting;
    try {
      return await starting;
    } finally {
      if (this.starting === starting) {
        this.starting = undefined;
      }
    }
  }

  async start(): Promise<void> {
    await this.getProcess();
  }

  async reattach(): Promise<number> {
    const existing = !this.starting && this.child && isRunning(this.child)
      ? this.child
      : undefined;
    const child = await this.getProcess();
    const initialization = this.currentInitialization;
    if (!initialization) {
      throw new Error("The inline R process has no vscode-R attachment command.");
    }
    if (!existing || existing !== child) {
      const processId = this.processId;
      if (processId === undefined) {
        throw new Error("vscode-R attachment did not report the R process ID.");
      }
      return processId;
    }
    this.rProcessId = await this.initialize(child, initialization);
    this.log("Existing inline R process reattached to vscode-R.");
    return this.rProcessId;
  }

  async reattachExisting(expectedProcessId: number): Promise<number> {
    const child = this.child;
    const initialization = this.currentInitialization;
    if (
      this.disposed ||
      !child ||
      !isRunning(child) ||
      this.rProcessId !== expectedProcessId ||
      !initialization
    ) {
      throw new Error("The inline R process is no longer available for reattachment.");
    }

    const processId = await this.initialize(child, initialization);
    if (
      this.child !== child ||
      !isRunning(child) ||
      processId !== expectedProcessId
    ) {
      throw new Error("The inline R process changed during vscode-R reattachment.");
    }
    this.rProcessId = processId;
    this.log("Existing inline R process reattached to vscode-R.");
    return processId;
  }

  async send(command: string): Promise<InlineDispatch> {
    const child = await this.getProcess();
    if (child.exitCode !== null || child.signalCode !== null) {
      throw exitError(child.exitCode, child.signalCode);
    }
    this.currentInterruption = undefined;

    let rejectFailure: ((error: Error) => void) | undefined;
    let listening = true;
    const failure = new Promise<never>((_resolve, reject) => {
      rejectFailure = reject;
    });
    void failure.catch(() => undefined);

    const onError = (error: Error): void => {
      rejectFailure?.(new Error(`The inline R process failed: ${error.message}`));
    };
    const onInputError = (error: Error): void => {
      rejectFailure?.(new Error(`The inline R process rejected input: ${error.message}`));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      rejectFailure?.(exitError(code, signal));
    };
    const stopListening = (): void => {
      if (!listening) {
        return;
      }
      listening = false;
      child.off("error", onError);
      child.off("exit", onExit);
      child.stdin.off("error", onInputError);
    };
    child.once("error", onError);
    child.once("exit", onExit);
    child.stdin.once("error", onInputError);

    try {
      await new Promise<void>((resolve, reject) => {
        try {
          child.stdin.write(`${command}\n`, (error?: Error | null) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        } catch (error) {
          reject(error);
        }
      });
    } catch (error) {
      stopListening();
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not send the cell to inline R: ${message}`);
    }

    if (child.exitCode !== null || child.signalCode !== null) {
      stopListening();
      throw exitError(child.exitCode, child.signalCode);
    }
    return { failure, dispose: stopListening };
  }

  interrupt(): Promise<void> {
    const child = this.child;
    if (!child || !isRunning(child)) {
      return Promise.resolve();
    }
    if (this.currentInterruption) {
      return this.currentInterruption;
    }
    const options = this.currentLaunchOptions;
    const processId = child.pid;
    if (!options || processId === undefined) {
      return Promise.reject(new Error("Cannot interrupt inline R: its launch context is unavailable."));
    }
    if (options.interrupt) {
      this.currentInterruption = options.interrupt(processId);
    } else if (process.platform === "win32") {
      this.currentInterruption = interruptWindowsRProcess(options, processId);
    } else if (child.kill("SIGINT")) {
      this.currentInterruption = Promise.resolve();
    } else {
      this.currentInterruption = Promise.reject(
        new Error("Could not send SIGINT to the inline R process.")
      );
    }
    return this.currentInterruption;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const child = this.child;
    const wasRunning = this.ready;
    this.child = undefined;
    this.currentInterruption = undefined;
    this.currentLaunchOptions = undefined;
    this.currentInitialization = undefined;
    this.rProcessId = undefined;
    this.ready = false;
    if (wasRunning) {
      this.runningChanged(false);
    }
    if (child && isRunning(child)) {
      child.stdin.end();
      child.kill();
    }
  }
}
