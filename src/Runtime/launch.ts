import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { HiddenRProcess, type HiddenRLaunchOptions } from "./process";
import { getVscodeRSessionApi } from "./sess";

const VSCODE_R_EXTENSION_ID = "REditorSupport.r";

function rPathSetting(): string {
  if (process.platform === "win32") {
    return "rpath.windows";
  }
  if (process.platform === "darwin") {
    return "rpath.mac";
  }
  return "rpath.linux";
}

function substitutePathVariables(value: string, notebookUri: vscode.Uri): string {
  const fileWorkspaceFolder = vscode.workspace.getWorkspaceFolder(notebookUri);
  const workspaceFolder = fileWorkspaceFolder ?? vscode.workspace.workspaceFolders?.[0];
  const replacements: ReadonlyArray<[string, string | undefined]> = [
    ["${userHome}", os.homedir()],
    ["${workspaceFolder}", workspaceFolder?.uri.fsPath],
    ["${fileWorkspaceFolder}", fileWorkspaceFolder?.uri.fsPath],
    ["${fileDirname}", path.dirname(notebookUri.fsPath)],
  ];
  let result = value;
  for (const [variable, replacement] of replacements) {
    if (replacement) {
      result = result.split(variable).join(replacement);
    }
  }
  if (result.includes("${")) {
    throw new Error(`The R path contains an unresolved VS Code variable: ${result}`);
  }
  return result.replace(/^(["'])(.*)\1$/, "$2");
}

export function resolveRExecutable(notebookUri: vscode.Uri): string {
  const setting = rPathSetting();
  const configured = vscode.workspace
    .getConfiguration("r", notebookUri)
    .get<string>(setting, "")
    .trim();
  if (configured.length > 0) {
    const substituted = substitutePathVariables(configured, notebookUri);
    const hasPathSeparator = substituted.includes("/") || substituted.includes("\\");
    if (!path.isAbsolute(substituted) && !hasPathSeparator) {
      return substituted;
    }
    const executable = path.isAbsolute(substituted)
      ? substituted
      : path.resolve(path.dirname(notebookUri.fsPath), substituted);
    if (!fs.existsSync(executable)) {
      throw new Error(`Cannot find R at '${executable}'. Check the r.${setting} setting.`);
    }
    return executable;
  }

  const rHome = process.env.R_HOME;
  if (rHome) {
    const candidates = process.platform === "win32"
      ? [path.join(rHome, "bin", "R.exe"), path.join(rHome, "bin", "x64", "R.exe")]
      : [path.join(rHome, "bin", "R")];
    const executable = candidates.find((candidate) => fs.existsSync(candidate));
    if (executable) {
      return executable;
    }
  }
  return process.platform === "win32" ? "R.exe" : "R";
}

export function quartoExecutableSetting(notebookUri: vscode.Uri): string {
  return vscode.workspace
    .getConfiguration("r.notebook", notebookUri)
    .get<string>("quartoPath", "")
    .trim();
}

async function launchOptions(
  notebookUri: vscode.Uri,
  output: vscode.OutputChannel,
  sessionIntegrationEnabled: boolean
): Promise<HiddenRLaunchOptions> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const rExtension = vscode.extensions.getExtension(VSCODE_R_EXTENSION_ID);
  if (!rExtension) {
    throw new Error("vscode-R is required to start the inline notebook R session.");
  }
  const fileWorkspace = vscode.workspace.getWorkspaceFolder(notebookUri);
  const startupDirectory = fileWorkspace
    ? path.dirname(notebookUri.fsPath)
    : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();

  delete env.VSCODE_INIT_R;
  delete env.VSCODE_WATCHER_DIR;
  delete env.SESS_ENDPOINT;
  delete env.SESS_DISCOVERY_FILE;
  env.TERM_PROGRAM = "vscode";
  env.VSCODE_R_NOTEBOOK_R_EXTENSION_INTEGRATION = sessionIntegrationEnabled
    ? "1"
    : "0";

  let initialization: HiddenRLaunchOptions["initialization"];
  if (sessionIntegrationEnabled) {
    const session = await getVscodeRSessionApi();
    const preparation = await session.prepareAttachment({ autoActivate: false });
    if (!preparation) {
      throw new Error("Enable r.sessionWatcher in vscode-R to attach the notebook.");
    }
    const token = preparation.attachmentId;
    const successMarker = `__R_NOTEBOOK_READY_${token}__:`;
    const failureMarker = `__R_NOTEBOOK_ERROR_${token}__:`;
    initialization = {
      attachmentId: token,
      preparation,
      successMarker,
      failureMarker,
      command: [
        "local({",
        "  tryCatch({",
        `    connected <- isTRUE((${preparation.command})$value)`,
        `    if (!connected) stop("vscode-R sess did not connect.")`,
        `    cat(${JSON.stringify(successMarker)}, Sys.getpid(), "\\n", sep = "")`,
        "  }, error = function(error) {",
        `    cat(${JSON.stringify(failureMarker)}, gsub("[[:cntrl:]]+", " ", conditionMessage(error)), "\\n", sep = "")`,
        "  })",
        "})",
      ].join("\n"),
    };
    output.appendLine(`[${path.basename(notebookUri.fsPath)}] Using vscode-R managed sess attachment.`);
  }

  return {
    executable: resolveRExecutable(notebookUri),
    args: [
      "--quiet",
      "--no-save",
      "--no-restore",
      process.platform === "win32" ? "--ess" : "--interactive",
    ],
    cwd: startupDirectory,
    env,
    initialization,
  };
}

export function createInlineRProcess(
  notebookUri: vscode.Uri,
  output: vscode.OutputChannel,
  sessionIntegrationEnabled: boolean
): HiddenRProcess {
  const notebookName = path.basename(notebookUri.fsPath);
  return new HiddenRProcess(
    () => launchOptions(notebookUri, output, sessionIntegrationEnabled),
    (message) => output.appendLine(`[${notebookName}] ${message}`)
  );
}
