import * as vscode from "vscode";
import type { RExecutionBridge, NotebookPackageStatus } from "./bridge";

/** Coordinate startup offers and avoid simultaneous installs into one library. */
export class NotebookPackageInstaller {
  private readonly pending = new Map<string, Promise<boolean>>();

  constructor(private readonly output: vscode.OutputChannel) {}

  async ensure(bridge: Pick<RExecutionBridge, "notebookPackages">, active: () => boolean): Promise<void> {
    try {
      if (!active()) return;
      let status = await bridge.notebookPackages();
      while (active() && status.missing.length) {
        const existing = this.pending.get(status.library);
        if (existing) {
          if (!await existing || !active()) return;
          status = await bridge.notebookPackages();
          continue;
        }
        const offer = this.offer(bridge, status, active);
        this.pending.set(status.library, offer);
        try { await offer; }
        finally { this.pending.delete(status.library); }
        return;
      }
    } catch (error) {
      if (!active()) return;
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[R packages] ${message}`);
      void vscode.window.showErrorMessage(`Could not prepare notebook R packages: ${message}`);
    }
  }

  private async offer(
    bridge: Pick<RExecutionBridge, "notebookPackages">,
    status: NotebookPackageStatus,
    active: () => boolean
  ): Promise<boolean> {
    const choice = await vscode.window.showInformationMessage(
      `R Notebook needs these packages installed or updated: ${status.missing.join(", ")}. Install into "${status.library}"?`,
      "Install", "Not Now"
    );
    if (choice !== "Install" || !active()) return false;
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Installing R notebook packages…",
    }, async () => {
      this.output.appendLine(`[R packages] Installing ${status.missing.join(", ")} into ${status.library}`);
      const result = await bridge.notebookPackages({ packages: status.missing, library: status.library });
      if (result.missing.length) {
        throw new Error(`Required packages are still missing or outdated: ${result.missing.join(", ")}.`);
      }
    });
    return true;
  }
}
