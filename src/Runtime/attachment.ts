import type { VscodeRSessionRequest } from "./vscodeR";

export interface AttachableInlineProcess {
  readonly processId: number | undefined;
  reattach(): Promise<number>;
  reattachExisting(expectedProcessId: number): Promise<number>;
}

interface PendingRepair {
  process: AttachableInlineProcess;
  processId: number;
  lockToken: string;
}

interface AttachedProcess {
  process: AttachableInlineProcess;
  processId: number;
}

export class InlineAttachmentCoordinator {
  private attached: AttachedProcess | undefined;
  private preferredProcess: AttachableInlineProcess | undefined;
  private foreignAttachment: { processId?: number } | undefined;
  private pendingRepair: PendingRepair | undefined;
  private readonly busyProcesses = new Set<AttachableInlineProcess>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly beginAttachmentConfirmation: () => (
      processId: number
    ) => Promise<void> = () => async () => undefined
  ) {}

  private enqueue(task: () => void | Promise<void>): Promise<void> {
    const update = this.queue.then(task);
    this.queue = update.catch(() => undefined);
    return update;
  }

  select(process: AttachableInlineProcess | undefined): Promise<void> {
    return this.enqueue(async () => {
      this.preferredProcess = process;
      if (this.pendingRepair?.process !== process) {
        this.pendingRepair = undefined;
      }
      if (process) {
        this.foreignAttachment = undefined;
      }
      await this.restorePreferred();
    });
  }

  expectConsole(process: AttachableInlineProcess | undefined): Promise<void> {
    return this.enqueue(() => {
      this.preferredProcess = process;
      this.attached = undefined;
      this.foreignAttachment = {};
      this.pendingRepair = undefined;
    });
  }

  observeConsole(): Promise<void> {
    return this.enqueue(() => {
      this.attached = undefined;
      this.foreignAttachment = {};
      this.pendingRepair = undefined;
    });
  }

  restoreAfterConsole(): Promise<void> {
    return this.enqueue(async () => {
      this.foreignAttachment = undefined;
      await this.restorePreferred();
    });
  }

  forget(process: AttachableInlineProcess): void {
    if (this.attached?.process === process) {
      this.attached = undefined;
    }
    if (this.preferredProcess === process) {
      this.preferredProcess = undefined;
    }
    if (this.pendingRepair?.process === process) {
      this.pendingRepair = undefined;
    }
    this.busyProcesses.delete(process);
  }

  beginExecution(process: AttachableInlineProcess): void {
    this.busyProcesses.add(process);
  }

  async endExecution(
    process: AttachableInlineProcess,
    synchronizeSessionRequests: () => Promise<string | undefined>
  ): Promise<void> {
    let latestLockToken: string | undefined;
    try {
      latestLockToken = await synchronizeSessionRequests();
    } finally {
      this.busyProcesses.delete(process);
    }
    await this.enqueue(async () => {
      const repair = this.pendingRepair;
      if (repair?.process === process) {
        this.pendingRepair = undefined;
        if (latestLockToken !== repair.lockToken) {
          return;
        }
        if (
          this.preferredProcess === repair.process &&
          !this.foreignAttachment
        ) {
          await this.repairExisting(repair.process, repair.processId);
        }
      }
      await this.restorePreferred();
    });
  }

  ensureAttached(
    process: AttachableInlineProcess,
    makePreferred = true
  ): Promise<void> {
    return this.enqueue(async () => {
      if (makePreferred) {
        this.preferredProcess = process;
      }
      this.foreignAttachment = undefined;
      this.pendingRepair = undefined;
      if (
        this.attached?.process === process &&
        this.attached.processId === process.processId
      ) {
        return;
      }

      this.attached = undefined;
      const confirmAttachment = this.beginAttachmentConfirmation();
      const processId = await process.reattach();
      if (process.processId !== processId) {
        throw new Error("The inline R process changed during vscode-R attachment.");
      }
      await confirmAttachment(processId);
      this.attached = { process, processId };
    });
  }

  handleSessionRequest(request: VscodeRSessionRequest): Promise<void> {
    return this.enqueue(async () => {
      const attached = this.attached;
      const process = attached?.process;
      const expectedProcessId = attached?.processId;
      if (request.command === "attach") {
        this.pendingRepair = undefined;
        if (process && expectedProcessId === request.pid) {
          this.foreignAttachment = undefined;
          return;
        }
        if (this.preferredProcess?.processId === request.pid) {
          this.attached = { process: this.preferredProcess, processId: request.pid };
          this.foreignAttachment = undefined;
          return;
        }
        this.attached = undefined;
        this.foreignAttachment = { processId: request.pid };
        return;
      }

      if (process && expectedProcessId === request.pid) {
        this.attached = undefined;
        if (this.preferredProcess === process) {
          this.preferredProcess = undefined;
        }
        this.pendingRepair = undefined;
        return;
      }

      if (
        this.foreignAttachment &&
        (this.foreignAttachment.processId === undefined ||
          this.foreignAttachment.processId === request.pid)
      ) {
        this.foreignAttachment = undefined;
        await this.restorePreferred(request.lockToken);
        return;
      }

      if (!process || expectedProcessId === undefined) {
        const repair = this.pendingRepair;
        if (repair) {
          if (repair.processId === request.pid) {
            this.pendingRepair = undefined;
            if (this.preferredProcess === repair.process) {
              this.preferredProcess = undefined;
            }
          } else {
            this.pendingRepair = { ...repair, lockToken: request.lockToken };
          }
        }
        return;
      }

      this.attached = undefined;
      if (this.busyProcesses.size > 0) {
        this.pendingRepair = {
          process,
          processId: expectedProcessId,
          lockToken: request.lockToken,
        };
        return;
      }
      await this.repairExisting(process, expectedProcessId);
    });
  }

  private async restorePreferred(lockToken?: string): Promise<void> {
    if (this.foreignAttachment) {
      return;
    }
    const process = this.preferredProcess;
    const processId = process?.processId;
    if (!process || processId === undefined) {
      return;
    }
    if (
      this.attached?.process === process &&
      this.attached.processId === processId
    ) {
      return;
    }
    if (this.busyProcesses.size > 0) {
      if (lockToken) {
        this.pendingRepair = { process, processId, lockToken };
      }
      return;
    }
    await this.repairExisting(process, processId);
  }

  private async repairExisting(
    process: AttachableInlineProcess,
    expectedProcessId: number
  ): Promise<void> {
    this.attached = undefined;
    const confirmAttachment = this.beginAttachmentConfirmation();
    const processId = await process.reattachExisting(expectedProcessId);
    if (processId !== expectedProcessId || process.processId !== expectedProcessId) {
      throw new Error("The inline R process changed during vscode-R reattachment.");
    }
    await confirmAttachment(expectedProcessId);
    this.attached = { process, processId: expectedProcessId };
  }

  dispose(): void {
    this.attached = undefined;
    this.preferredProcess = undefined;
    this.foreignAttachment = undefined;
    this.pendingRepair = undefined;
    this.busyProcesses.clear();
  }
}
