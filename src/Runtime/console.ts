import * as vscode from "vscode";

const R_CONSOLE_EXTENSION_ID = "RConsole.vsc-r-console";
const ATTACH_VSCODE_R_SESSION = ".vsc.attach()";

function isRConsoleTerminal(terminal: vscode.Terminal): boolean {
  return /^R Console(?: \(\d+\))?$/.test(terminal.name);
}

export class RConsoleTransport {
  private readonly notebookConsoles = new Map<string, vscode.Terminal>();

  constructor(private readonly sessionIntegrationEnabled: boolean) {}

  private async activateConsole(): Promise<void> {
    const extension = vscode.extensions.getExtension(R_CONSOLE_EXTENSION_ID);
    if (!extension) {
      throw new Error("R Console for VS Code is not installed or enabled.");
    }
    await extension.activate();
  }

  private async getConsole(notebookUri: vscode.Uri): Promise<vscode.Terminal> {
    await this.activateConsole();
    const notebookKey = notebookUri.toString();
    let terminal = this.notebookConsoles.get(notebookKey);
    if (terminal && !vscode.window.terminals.includes(terminal)) {
      terminal = undefined;
      this.notebookConsoles.delete(notebookKey);
    }

    if (!terminal) {
      const existing = new Set(vscode.window.terminals);
      await vscode.commands.executeCommand("r-console.createTerminal");
      terminal = vscode.window.terminals.find((candidate) =>
        !existing.has(candidate) && isRConsoleTerminal(candidate)
      );
    }
    if (!terminal) {
      throw new Error("R Console could not create an R session. Check its R path configuration.");
    }
    this.notebookConsoles.set(notebookKey, terminal);
    terminal.show(false);
    return terminal;
  }

  async attachAndSend(
    notebookUri: vscode.Uri,
    codes: readonly string[]
  ): Promise<void> {
    const terminal = await this.getConsole(notebookUri);
    if (this.sessionIntegrationEnabled) {
      // vscode-R follows the most recently attached R process. Reclaim the
      // console session before submitting notebook code after inline execution.
      terminal.sendText(ATTACH_VSCODE_R_SESSION, true);
    }
    for (const source of codes) {
      terminal.sendText(source, true);
    }
  }

  isConsole(terminal: vscode.Terminal): boolean {
    return [...this.notebookConsoles.values()].includes(terminal) ||
      isRConsoleTerminal(terminal);
  }

  didCloseConsole(terminal: vscode.Terminal): boolean {
    let tracked = false;
    const assigned = new Set(this.notebookConsoles.values());
    for (const [notebookKey, candidate] of this.notebookConsoles) {
      if (candidate === terminal) {
        const replacement = vscode.window.terminals.find((openTerminal) =>
          openTerminal !== terminal &&
          openTerminal.name === terminal.name &&
          !assigned.has(openTerminal)
        );
        if (replacement) {
          this.notebookConsoles.set(notebookKey, replacement);
          continue;
        }
        this.notebookConsoles.delete(notebookKey);
        tracked = true;
      }
    }
    return tracked;
  }
}
