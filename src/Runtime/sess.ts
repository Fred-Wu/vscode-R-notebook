import * as vscode from "vscode";
import type { HiddenRProcess } from "./process";

export interface SessPreparation extends vscode.Disposable {
  readonly attachmentId: string;
  readonly command: string;
}

interface SessReference {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly attachmentId?: string;
}

interface SessConnectionChange {
  readonly kind: "connected" | "disconnected";
  readonly session: SessReference;
}

export interface VscodeRSessionApi {
  prepareAttachment(options?: { autoActivate?: boolean }): Promise<SessPreparation | undefined>;
  readonly onDidChangeSessionConnection: vscode.Event<SessConnectionChange>;
  getSessionReference(sessionId: string): SessReference | undefined;
  activate(sessionId: string, options?: { connectionId?: string; select?: boolean }): Promise<boolean>;
}

export async function getVscodeRSessionApi(): Promise<VscodeRSessionApi> {
  const extension = vscode.extensions.getExtension("REditorSupport.r");
  if (!extension) {
    throw new Error("vscode-R must be installed for notebook session integration.");
  }
  const exports = (extension.isActive ? extension.exports : await extension.activate()) as {
    session?: Partial<VscodeRSessionApi>;
  };
  const session = exports.session;
  if (!session ||
    typeof session.prepareAttachment !== "function" ||
    typeof session.getSessionReference !== "function" ||
    typeof session.onDidChangeSessionConnection !== "function" ||
    typeof session.activate !== "function") {
    throw new Error("The installed vscode-R does not expose the sess attachment API. Update vscode-R.");
  }
  return session as VscodeRSessionApi;
}

/** Track consumer-owned R processes by the sess attachment/connection IDs. */
export class InlineSessCoordinator implements vscode.Disposable {
  private readonly processes = new Set<HiddenRProcess>();
  private readonly connections = new Map<string, SessReference>();
  private preferred: HiddenRProcess | undefined;
  private suspended = false;
  private closed = false;
  private sessionApi?: Promise<VscodeRSessionApi>;
  private connectionEvents?: vscode.Disposable;

  private async api(): Promise<VscodeRSessionApi> {
    if (!this.sessionApi) {
      this.sessionApi = getVscodeRSessionApi().then((api) => {
        if (this.closed) return api;
        this.connectionEvents = api.onDidChangeSessionConnection((event) => {
          const attachmentId = event.session.attachmentId;
          if (!attachmentId) return;
          if (event.kind === "connected") {
            this.connections.set(attachmentId, event.session);
            if (this.preferred?.attachmentId === attachmentId && !this.suspended) {
              void this.activate(this.preferred).catch(() => undefined);
            }
          } else {
            const current = this.connections.get(attachmentId);
            if (current?.connectionId === event.session.connectionId) {
              this.connections.delete(attachmentId);
            }
          }
        });
        return api;
      }).catch((error: unknown) => {
        this.sessionApi = undefined;
        throw error;
      });
    }
    return this.sessionApi;
  }

  private async activate(process: HiddenRProcess): Promise<void> {
    if (this.closed || this.suspended || this.preferred !== process) return;
    const attachmentId = process.attachmentId;
    const reference = attachmentId ? this.connections.get(attachmentId) : undefined;
    if (!reference) return;
    const api = await this.api();
    const live = api.getSessionReference(reference.sessionId);
    if (!live || live.connectionId !== reference.connectionId ||
      live.attachmentId !== attachmentId) return;
    await api.activate(live.sessionId, { connectionId: live.connectionId });
  }

  async ensureAttached(process: HiddenRProcess, makePreferred: boolean): Promise<void> {
    await this.api(); // Subscribe before R sources the prepared attach command.
    this.processes.add(process);
    if (makePreferred) this.preferred = process;
    await process.start();
    await this.activate(process);
  }

  async select(process: HiddenRProcess | undefined): Promise<void> {
    this.preferred = process;
    if (process) {
      this.suspended = false;
      await this.activate(process);
    }
  }

  beginExecution(_process: HiddenRProcess): void {}

  async endExecution(_process: HiddenRProcess): Promise<void> {}

  async expectConsole(_process: HiddenRProcess | undefined): Promise<void> {
    this.suspended = true;
  }

  async observeConsole(): Promise<void> {
    this.suspended = true;
  }

  async restoreAfterConsole(): Promise<void> {
    this.suspended = false;
    if (this.preferred) await this.activate(this.preferred);
  }

  forget(process: HiddenRProcess): void {
    this.processes.delete(process);
    const id = process.attachmentId;
    if (id) this.connections.delete(id);
    if (this.preferred === process) this.preferred = undefined;
  }

  dispose(): void {
    this.closed = true;
    this.connectionEvents?.dispose();
    this.connections.clear();
    this.processes.clear();
  }
}
