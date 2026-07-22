import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { HiddenRProcess, type HiddenRLaunchOptions } from "./process";
import { createVscodeRAttachmentInitialization } from "./vscodeR";

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
  output: vscode.OutputChannel
): Promise<HiddenRLaunchOptions> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const sessionWatcher = vscode.workspace
    .getConfiguration("r")
    .get<boolean>("sessionWatcher", true);
  if (!sessionWatcher) {
    throw new Error(
      "Inline R requires r.sessionWatcher to be enabled. Enable it and reload VS Code."
    );
  }

  const rExtension = vscode.extensions.getExtension(VSCODE_R_EXTENSION_ID);
  if (!rExtension) {
    throw new Error("vscode-R is required to attach the inline notebook R session.");
  }
  await rExtension.activate();
  const profilePath = path.join(rExtension.extensionPath, "R", "session", "profile.R");
  const initPath = path.join(rExtension.extensionPath, "R", "session", "init.R");
  if (!fs.existsSync(profilePath) || !fs.existsSync(initPath)) {
    throw new Error("The installed vscode-R session bootstrap files could not be found.");
  }
  const fileWorkspace = vscode.workspace.getWorkspaceFolder(notebookUri);
  const startupDirectory = fileWorkspace
    ? path.dirname(notebookUri.fsPath)
    : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();

  env.R_PROFILE_USER_OLD = process.env.R_PROFILE_USER ?? "";
  env.R_PROFILE_USER = profilePath;
  env.VSCODE_INIT_R = "";
  env.VSCODE_R_NOTEBOOK_INIT_R = initPath;
  env.VSCODE_WATCHER_DIR = path.join(os.homedir(), ".vscode-R");
  env.VSCODE_R_NOTEBOOK_SESSION_WD = startupDirectory;
  env.TERM_PROGRAM = "vscode";
  output.appendLine(
    `[${path.basename(notebookUri.fsPath)}] Starting automatic vscode-R session attachment.`
  );

  return {
    executable: resolveRExecutable(notebookUri),
    args: ["--quiet", "--no-save", "--no-restore", "--interactive"],
    cwd: startupDirectory,
    env,
    initialization: createVscodeRAttachmentInitialization(),
  };
}

export function createInlineRProcess(
  notebookUri: vscode.Uri,
  output: vscode.OutputChannel
): HiddenRProcess {
  const notebookName = path.basename(notebookUri.fsPath);
  return new HiddenRProcess(
    () => launchOptions(notebookUri, output),
    (message) => output.appendLine(`[${notebookName}] ${message}`)
  );
}
